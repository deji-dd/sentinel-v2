import {
	db,
	desc,
	eq,
	subversiveRankedWars,
	subversiveRecruitmentCandidates,
	systemStates,
	workerSchedules,
} from "@sentinel/database";
import type {
	FactionMembersResponse,
	FactionRankedWarDetails,
	FactionRankedWarReportResponse,
	FactionWarfareRankedResponse,
} from "@sentinel/schemas";
import {
	getPlayerStats,
	type ManagedApiKey,
	TornError,
	tornApi,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	getNextSubversiveUserKey,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
} from "./subversive-key-pool";
import {
	detectTermedWar,
	type RankedWarFactionReport,
} from "./termed-war-detector";

const logger = new Logger("Scheduler", "SubversiveRecruitment");

export const SUBVERSIVE_RECRUITMENT_CONFIG_ID = "subversive:recruitment_config";
export const SUBVERSIVE_RECRUITMENT_STATE_ID = "subversive:recruitment_state";

export const MAX_RANKED_WAR_DURATION_SECONDS = 123 * 3600; // 123 hours theoretical max duration
export const MAX_RECRUITMENT_PAGES = 10;
export const RECRUITMENT_PAGE_LIMIT = 100;

function parseNextLinkParams(
	nextLink: string,
): Record<string, string | number> {
	const params: Record<string, string | number> = {
		limit: RECRUITMENT_PAGE_LIMIT,
		sort: "DESC",
	};
	try {
		const url = new URL(nextLink, "https://api.torn.com");
		for (const [key, val] of url.searchParams.entries()) {
			if (key === "key" || key === "comment" || key === "timestamp") continue;
			const num = Number(val);
			params[key] = !Number.isNaN(num) && String(num) === val ? num : val;
		}
	} catch {
		const toMatch = nextLink.match(/[?&]to=(\d+)/);
		const toVal = toMatch?.[1];
		if (toVal) {
			params.to = Number.parseInt(toVal, 10);
		}
	}
	return params;
}

function handleKeyError(key: ManagedApiKey, err: unknown): void {
	if (
		(err instanceof TornError &&
			(err.code === 2 ||
				err.code === 10 ||
				err.code === 13 ||
				err.code === 18)) ||
		String(err).includes("Key temporarily disabled")
	) {
		markSubversiveKeyDisabled(key.apiKey);
	}
}

export interface SubversiveRecruitmentConfig {
	minStats: number;
	minAttacks: number;
	minAttackPercentage: number;
	notificationChannelId: string | null;
	notificationsEnabled: boolean;
	termedClusterPercentage: number;
	autoScanEnabled: boolean;
	excludedFactionIds: number[];
}

export const DEFAULT_RECRUITMENT_CONFIG: SubversiveRecruitmentConfig = {
	minStats: 100_000_000, // 100M estimated BS
	minAttacks: 25,
	minAttackPercentage: 8.0, // 8% of faction attacks
	notificationChannelId: null,
	notificationsEnabled: false,
	termedClusterPercentage: 60,
	autoScanEnabled: false,
	excludedFactionIds: [],
};

// In-memory cache of evaluated war IDs to prevent redundant DB calls
const evaluatedWarIds = new Set<number>();
let isCacheHydrated = false;

async function hydrateEvaluatedWarsCache(): Promise<void> {
	if (isCacheHydrated) return;
	try {
		const wars = await db
			.select({ id: subversiveRankedWars.id })
			.from(subversiveRankedWars)
			.orderBy(desc(subversiveRankedWars.id))
			.limit(1000);

		for (const war of wars) {
			evaluatedWarIds.add(war.id);
		}
		isCacheHydrated = true;
		logger.debug(
			`Hydrated in-memory evaluated wars cache with ${wars.length} war IDs.`,
		);
	} catch (err) {
		logger.error("Failed to hydrate evaluated wars cache:", err);
	}
}

/**
 * Resets the in-memory cache of evaluated ranked war IDs so the worker can re-evaluate wars.
 */
export function resetRecruitmentCache(): void {
	evaluatedWarIds.clear();
	isCacheHydrated = false;
	logger.info("Cleared in-memory evaluated wars cache for recruitment worker.");
}

export async function getRecruitmentConfig(): Promise<SubversiveRecruitmentConfig> {
	try {
		const [entry] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, SUBVERSIVE_RECRUITMENT_CONFIG_ID));

		if (entry?.init && entry.data) {
			return {
				...DEFAULT_RECRUITMENT_CONFIG,
				...(entry.data as Partial<SubversiveRecruitmentConfig>),
			};
		}
	} catch (err) {
		logger.error("Failed to load recruitment config from database:", err);
	}
	return DEFAULT_RECRUITMENT_CONFIG;
}

/**
 * Runs a single cycle of the ranked war recruitment analyzer.
 */
export async function runRecruitmentCycle(options?: {
	force?: boolean;
}): Promise<{
	scannedWars: number;
	completedWars: number;
	termedWars: number;
	forfeitedWars: number;
	candidatesFound: number;
}> {
	await hydrateEvaluatedWarsCache();
	const config = await getRecruitmentConfig();

	if (!config.autoScanEnabled && !options?.force) {
		const [sched] = await db
			.select({ forceRun: workerSchedules.forceRun })
			.from(workerSchedules)
			.where(eq(workerSchedules.id, "subversive:recruitment_worker"));

		if (!sched?.forceRun) {
			logger.info(
				"Automated recruitment scanning is paused in settings. Skipping cycle.",
			);
			return {
				scannedWars: 0,
				completedWars: 0,
				termedWars: 0,
				forfeitedWars: 0,
				candidatesFound: 0,
			};
		}
	}

	// Determine if this is initial run
	const [stateEntry] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, SUBVERSIVE_RECRUITMENT_STATE_ID));

	const isInitialRun = !stateEntry?.init;
	const nowSec = Math.floor(Date.now() / 1000);
	const startOfCurrentDayUtc = Math.floor(
		new Date().setUTCHours(0, 0, 0, 0) / 1000,
	);

	// On initial run, look back to the start of today UTC.
	// On subsequent runs, look back to lastScanTimestamp (with a 1-hour grace window) or up to 7 days.
	const stateData = stateEntry?.data as
		| { lastScanTimestamp?: number }
		| undefined;
	const minCompletedTimestamp = isInitialRun
		? startOfCurrentDayUtc
		: stateData?.lastScanTimestamp
			? Math.max(stateData.lastScanTimestamp - 3600, nowSec - 7 * 86400)
			: startOfCurrentDayUtc;

	const startCutoffTimestamp =
		minCompletedTimestamp > 0
			? minCompletedTimestamp - MAX_RANKED_WAR_DURATION_SECONDS
			: 0;

	if (isInitialRun) {
		logger.info(
			`Initial recruitment run detected: filtering completed wars from start of today UTC (${new Date(startOfCurrentDayUtc * 1000).toISOString()}).`,
		);
	}

	const getApiKey = async (): Promise<ManagedApiKey | null> => {
		try {
			return await getNextSubversiveUserKey();
		} catch {
			return null;
		}
	};

	const initialKey = await getApiKey();
	if (!initialKey) {
		logger.warn(
			"No active Torn API keys available in the Subversive script key pool. Skipping recruitment scan.",
		);
		return {
			scannedWars: 0,
			completedWars: 0,
			termedWars: 0,
			forfeitedWars: 0,
			candidatesFound: 0,
		};
	}

	// 1. Fetch recent ranked wars across multiple pages using the Subversive script key pool
	const allWarsToEvaluate: FactionRankedWarDetails[] = [];
	const seenWarIds = new Set<number>();
	let totalScannedWars = 0;
	let currentQueryParams: Record<string, string | number> = {
		limit: RECRUITMENT_PAGE_LIMIT,
		sort: "DESC",
	};

	for (let page = 1; page <= MAX_RECRUITMENT_PAGES; page++) {
		const pageKey = (await getApiKey()) ?? initialKey;
		let warResponse: FactionWarfareRankedResponse;
		try {
			warResponse = (await tornApi.get("/faction/warfareranked", {
				apiKey: pageKey.apiKey,
				userId: pageKey.userId,
				queryParams: currentQueryParams as unknown as {
					limit?: number;
					sort?: "ASC" | "DESC";
					from?: number;
					to?: number;
				},
			})) as FactionWarfareRankedResponse;
			recordSubversiveKeySuccess(pageKey.apiKey);
		} catch (err) {
			handleKeyError(pageKey, err);
			logger.error(
				`Failed to fetch /faction/warfareranked page ${page} from Torn API:`,
				err,
			);
			break;
		}

		const rawWars: FactionRankedWarDetails[] = warResponse.warfareranked ?? [];
		if (rawWars.length === 0) {
			break;
		}

		totalScannedWars += rawWars.length;

		// Filter for finished wars that haven't been evaluated yet
		for (const w of rawWars) {
			if (!w.end || w.end === 0) continue; // Ongoing or scheduled
			if (minCompletedTimestamp > 0 && w.end < minCompletedTimestamp) continue;
			if (evaluatedWarIds.has(w.id)) continue;
			if (!seenWarIds.has(w.id)) {
				seenWarIds.add(w.id);
				allWarsToEvaluate.push(w);
			}
		}

		// Calculate oldest start timestamp on this page
		let oldestStartOnPage = 0;
		for (const w of rawWars) {
			if (w.start && w.start > 0) {
				if (oldestStartOnPage === 0 || w.start < oldestStartOnPage) {
					oldestStartOnPage = w.start;
				}
			}
		}

		// Stopping condition: if the oldest war on this page started before startCutoffTimestamp,
		// then because max ranked war duration is 123 hours, NO wars on subsequent pages could have completed >= minCompletedTimestamp.
		if (
			startCutoffTimestamp > 0 &&
			oldestStartOnPage > 0 &&
			oldestStartOnPage < startCutoffTimestamp
		) {
			logger.debug(
				`Page ${page} reached start timestamp cutoff (${oldestStartOnPage} < ${startCutoffTimestamp}). Stopping pagination.`,
			);
			break;
		}

		const nextLink = warResponse._metadata?.links?.next;
		if (!nextLink || rawWars.length === 0) {
			break;
		}

		currentQueryParams = parseNextLinkParams(nextLink);
	}

	if (totalScannedWars === 0) {
		logger.info("No ranked wars returned from API.");
		return {
			scannedWars: 0,
			completedWars: 0,
			termedWars: 0,
			forfeitedWars: 0,
			candidatesFound: 0,
		};
	}

	logger.info(
		`Pagination complete across ${totalScannedWars} raw wars scanned. Evaluating ${allWarsToEvaluate.length} newly completed ranked wars...`,
	);

	let completedWars = 0;
	let termedWars = 0;
	let forfeitedWars = 0;
	let totalCandidatesFound = 0;

	const excludedFactionSet = new Set(config.excludedFactionIds ?? []);

	for (const war of allWarsToEvaluate) {
		evaluatedWarIds.add(war.id);

		// Double-check DB in case of multiple replicas
		const [alreadyInDb] = await db
			.select({ id: subversiveRankedWars.id })
			.from(subversiveRankedWars)
			.where(eq(subversiveRankedWars.id, war.id));

		if (alreadyInDb) {
			continue;
		}

		completedWars++;

		// 2. Fetch detailed war report
		let warReport: FactionRankedWarReportResponse["rankedwarreport"] | null =
			null;
		const reportKey = (await getApiKey()) ?? initialKey;
		try {
			const reportResponse = (await tornApi.get(
				"/faction/{rankedWarId}/rankedwarreport",
				{
					apiKey: reportKey.apiKey,
					userId: reportKey.userId,
					pathParams: { rankedWarId: war.id },
				},
			)) as FactionRankedWarReportResponse;
			recordSubversiveKeySuccess(reportKey.apiKey);
			warReport = reportResponse.rankedwarreport;
		} catch (err) {
			handleKeyError(reportKey, err);
			logger.error(`Failed to fetch report for war #${war.id}:`, err);
			await db
				.insert(subversiveRankedWars)
				.values({
					id: war.id,
					start: war.start ? new Date(war.start * 1000) : null,
					end: war.end ? new Date(war.end * 1000) : null,
					target: war.target ?? 0,
					winnerFactionId: war.winner ?? null,
					forfeit: false,
					isTermed: false,
					status: "error",
					candidateCount: 0,
					evaluatedAt: new Date(),
				})
				.onConflictDoNothing();
			continue;
		}

		if (!warReport) continue;

		// 3. Check for forfeit
		if (warReport.forfeit) {
			forfeitedWars++;
			logger.info(`War #${war.id} dropped: Forfeited.`);
			await db
				.insert(subversiveRankedWars)
				.values({
					id: war.id,
					start: warReport.start ? new Date(warReport.start * 1000) : null,
					end: warReport.end ? new Date(warReport.end * 1000) : null,
					target: war.target ?? 0,
					winnerFactionId: warReport.winner ?? null,
					forfeit: true,
					isTermed: false,
					status: "dropped_forfeit",
					candidateCount: 0,
					evaluatedAt: new Date(),
				})
				.onConflictDoNothing();
			continue;
		}

		// 4. Check for termed war
		const factionReports: RankedWarFactionReport[] = warReport.factions.map(
			(f) => ({
				id: f.id,
				name: f.name,
				attacks: f.attacks,
				score: f.score,
				members: f.members.map((m) => ({
					id: m.id,
					name: m.name,
					level: m.level,
					attacks: m.attacks,
					score: m.score,
				})),
			}),
		);

		const termedCheck = detectTermedWar(factionReports, {
			clusterPercentageThreshold: config.termedClusterPercentage,
		});

		if (termedCheck.isTermed) {
			termedWars++;
			logger.info(`War #${war.id} dropped: Termed (${termedCheck.reason}).`);
			await db
				.insert(subversiveRankedWars)
				.values({
					id: war.id,
					start: warReport.start ? new Date(warReport.start * 1000) : null,
					end: warReport.end ? new Date(warReport.end * 1000) : null,
					target: war.target ?? 0,
					winnerFactionId: warReport.winner ?? null,
					forfeit: false,
					isTermed: true,
					termedReason: termedCheck.reason,
					status: "dropped_termed",
					candidateCount: 0,
					evaluatedAt: new Date(),
				})
				.onConflictDoNothing();
			continue;
		}

		// 5. War is competitive! Screen members for recruitment
		type ProspectiveCandidate = {
			playerId: number;
			playerName: string;
			playerLevel: number;
			factionId: number;
			factionName: string;
			attacks: number;
			factionTotalAttacks: number;
			attackPercentage: number;
			score: number;
		};

		const prospectiveCandidates: ProspectiveCandidate[] = [];

		for (const faction of warReport.factions) {
			if (excludedFactionSet.has(faction.id)) continue;
			const totalFactionAttacks = faction.attacks;
			if (totalFactionAttacks <= 0) continue;

			for (const member of faction.members) {
				if (member.attacks < config.minAttacks) continue;

				const attackPercentage = (member.attacks / totalFactionAttacks) * 100;
				if (attackPercentage < config.minAttackPercentage) continue;

				prospectiveCandidates.push({
					playerId: member.id,
					playerName: member.name,
					playerLevel: member.level,
					factionId: faction.id,
					factionName: faction.name,
					attacks: member.attacks,
					factionTotalAttacks: totalFactionAttacks,
					attackPercentage: Number(attackPercentage.toFixed(2)),
					score: member.score,
				});
			}
		}

		let qualifiedCandidatesCount = 0;

		if (prospectiveCandidates.length > 0) {
			const playerIds = prospectiveCandidates.map((c) => c.playerId);

			// Batch resolve battle stats via FFScouter cache
			let statsResults: Awaited<ReturnType<typeof getPlayerStats>> = [];
			try {
				statsResults = await getPlayerStats(playerIds);
			} catch (err) {
				logger.warn(
					`Failed to fetch FFScouter stats for war #${war.id} candidates:`,
					err,
				);
			}

			const statsMap = new Map(statsResults.map((s) => [s.player_id, s]));

			// Batch fetch faction rosters to determine days_in_faction and faction roles
			const daysInFactionMap = new Map<number, number>();
			const factionRoleMap = new Map<number, string>();
			const candidateFactionIds = [
				...new Set(prospectiveCandidates.map((c) => c.factionId)),
			];
			await Promise.all(
				candidateFactionIds.map(async (fid) => {
					const memberKey = (await getApiKey()) ?? initialKey;
					try {
						const factionRes = (await tornApi.get("/faction/{id}/members", {
							apiKey: memberKey.apiKey,
							userId: memberKey.userId,
							pathParams: { id: fid },
						})) as FactionMembersResponse;
						recordSubversiveKeySuccess(memberKey.apiKey);
						for (const member of factionRes.members ?? []) {
							daysInFactionMap.set(member.id, member.days_in_faction);
							if (member.position) {
								factionRoleMap.set(member.id, member.position);
							}
						}
					} catch (err) {
						handleKeyError(memberKey, err);
						logger.warn(
							`Failed to fetch member roster for faction ${fid}:`,
							err,
						);
					}
				}),
			);

			for (const candidate of prospectiveCandidates) {
				const statData = statsMap.get(candidate.playerId);
				const bsEstimate = statData?.bs_estimate ?? null;
				const fairFight = statData?.fair_fight ?? null;
				const daysInFaction = daysInFactionMap.get(candidate.playerId) ?? null;
				const factionRole = factionRoleMap.get(candidate.playerId) ?? null;

				// Filter by minimum stats if threshold is set (> 0)
				if (config.minStats > 0 && bsEstimate !== null) {
					if (bsEstimate < config.minStats) {
						continue; // Below target battle stats
					}
				}

				const normalizedRole = factionRole?.trim().toLowerCase();
				const isLeader =
					normalizedRole === "leader" ||
					normalizedRole === "co-leader" ||
					normalizedRole === "coleader";

				qualifiedCandidatesCount++;
				totalCandidatesFound++;

				const candidateUuid = crypto.randomUUID();

				const shouldAlert =
					Boolean(
						config.notificationsEnabled && config.notificationChannelId,
					) && !isLeader;

				await db
					.insert(subversiveRecruitmentCandidates)
					.values({
						id: candidateUuid,
						playerId: candidate.playerId,
						playerName: candidate.playerName,
						playerLevel: candidate.playerLevel,
						factionId: candidate.factionId,
						factionName: candidate.factionName,
						warId: war.id,
						attacks: candidate.attacks,
						factionTotalAttacks: candidate.factionTotalAttacks,
						attackPercentage: candidate.attackPercentage,
						score: candidate.score,
						estimatedStats: statData
							? {
									bsEstimate: statData.bs_estimate,
									fairFight: statData.fair_fight,
									source: statData.source,
									humanEstimate: statData.bs_estimate_human,
									lastUpdated: statData.last_updated,
									distribution: statData.distribution
										? (statData.distribution as unknown as Record<
												string,
												unknown
											>)
										: null,
								}
							: null,
						status: "new",
						notified: shouldAlert,
						notifiedAt: shouldAlert ? new Date() : null,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoNothing();

				// Dispatch Discord alert via IPC if enabled and candidate is not a leader/co-leader
				if (shouldAlert && config.notificationChannelId) {
					const ipcServer = getActiveIpcServer();
					if (ipcServer) {
						ipcServer.broadcast({
							action: "subversive_recruitment_alert",
							data: {
								candidateId: candidateUuid,
								playerId: candidate.playerId,
								playerName: candidate.playerName,
								playerLevel: candidate.playerLevel,
								factionId: candidate.factionId,
								factionName: candidate.factionName,
								warId: war.id,
								attacks: candidate.attacks,
								factionTotalAttacks: candidate.factionTotalAttacks,
								attackPercentage: candidate.attackPercentage,
								score: candidate.score,
								bsEstimate,
								fairFight,
								daysInFaction,
								factionRole,
								notificationChannelId: config.notificationChannelId,
							},
						});
					}
				}
			}
		}

		// Save processed war record
		await db
			.insert(subversiveRankedWars)
			.values({
				id: war.id,
				start: warReport.start ? new Date(warReport.start * 1000) : null,
				end: warReport.end ? new Date(warReport.end * 1000) : null,
				target: war.target ?? 0,
				winnerFactionId: warReport.winner ?? null,
				forfeit: false,
				isTermed: false,
				status: "processed",
				candidateCount: qualifiedCandidatesCount,
				evaluatedAt: new Date(),
			})
			.onConflictDoNothing();
	}

	// Update state
	await db
		.insert(systemStates)
		.values({
			id: SUBVERSIVE_RECRUITMENT_STATE_ID,
			init: true,
			data: {
				lastScanTimestamp: Math.floor(Date.now() / 1000),
				lastScanDate: new Date().toISOString(),
				evaluatedWarsCount: evaluatedWarIds.size,
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: systemStates.id,
			set: {
				init: true,
				data: {
					lastScanTimestamp: Math.floor(Date.now() / 1000),
					lastScanDate: new Date().toISOString(),
					evaluatedWarsCount: evaluatedWarIds.size,
				},
				updatedAt: new Date(),
			},
		});

	logger.info(
		`Recruitment cycle complete: ${completedWars} evaluated, ${termedWars} termed, ${forfeitedWars} forfeit, ${totalCandidatesFound} new candidate(s).`,
	);

	return {
		scannedWars: totalScannedWars,
		completedWars,
		termedWars,
		forfeitedWars,
		candidatesFound: totalCandidatesFound,
	};
}

export const startSubversiveRecruitmentWorker: WorkerStarter = (options?: {
	initialDelayMs?: number;
}) => {
	startEventDrivenRunner({
		worker: "subversive:recruitment_worker",
		defaultCadenceSeconds: 300, // 5 minutes
		initialDelayMs: options?.initialDelayMs ?? 10000,
		handler: async () => {
			await runRecruitmentCycle();
		},
	});
};
