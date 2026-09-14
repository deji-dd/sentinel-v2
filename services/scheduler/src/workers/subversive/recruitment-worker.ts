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
	getNextSubversiveKey,
	getPlayerStats,
	type ManagedApiKey,
	tornApi,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	detectTermedWar,
	type RankedWarFactionReport,
} from "./termed-war-detector";

const logger = new Logger("Scheduler", "SubversiveRecruitment");

export const SUBVERSIVE_RECRUITMENT_CONFIG_ID = "subversive:recruitment_config";
export const SUBVERSIVE_RECRUITMENT_STATE_ID = "subversive:recruitment_state";

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
	// On initial run, look back to the start of the current UTC day (00:00:00 UTC)
	const startOfCurrentDayUtc = Math.floor(
		new Date().setUTCHours(0, 0, 0, 0) / 1000,
	);
	const minCompletedTimestamp = isInitialRun ? startOfCurrentDayUtc : 0;

	if (isInitialRun) {
		logger.info(
			`Initial recruitment run detected: filtering completed wars from start of today UTC (${new Date(startOfCurrentDayUtc * 1000).toISOString()}).`,
		);
	}

	// Resolve configured Subversive guild for key pool resolution
	const [subversiveConfigEntry] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, "subversive:guild_config"));

	const subversiveGuildId = (
		subversiveConfigEntry?.data as { guildId?: string } | undefined
	)?.guildId;

	if (!subversiveGuildId) {
		logger.warn(
			"Subversive guild is not configured. Skipping recruitment scan.",
		);
		return {
			scannedWars: 0,
			completedWars: 0,
			termedWars: 0,
			forfeitedWars: 0,
			candidatesFound: 0,
		};
	}

	const getApiKey = async (): Promise<ManagedApiKey | null> => {
		try {
			return await getNextSubversiveKey(subversiveGuildId);
		} catch {
			return null;
		}
	};

	const initialKey = await getApiKey();
	if (!initialKey) {
		logger.warn(
			`No active Torn API keys configured for Subversive guild (${subversiveGuildId}). Skipping recruitment scan (guild recruitment strictly requires configured guild keys, system keys are not used).`,
		);
		return {
			scannedWars: 0,
			completedWars: 0,
			termedWars: 0,
			forfeitedWars: 0,
			candidatesFound: 0,
		};
	}

	// 1. Fetch recent ranked wars using the Subversive guild key
	let warResponse: FactionWarfareRankedResponse;
	try {
		warResponse = (await tornApi.get("/faction/warfareranked", {
			apiKey: initialKey.apiKey,
			userId: initialKey.userId,
			queryParams: {
				limit: 100,
				sort: "DESC",
			},
		})) as FactionWarfareRankedResponse;
	} catch (err) {
		logger.error("Failed to fetch /faction/warfareranked from Torn API:", err);
		return {
			scannedWars: 0,
			completedWars: 0,
			termedWars: 0,
			forfeitedWars: 0,
			candidatesFound: 0,
		};
	}

	const rawWars: FactionRankedWarDetails[] = warResponse.warfareranked ?? [];
	if (rawWars.length === 0) {
		logger.info("No ranked wars returned from API.");
		return {
			scannedWars: 0,
			completedWars: 0,
			termedWars: 0,
			forfeitedWars: 0,
			candidatesFound: 0,
		};
	}

	// Filter for finished wars that haven't been evaluated yet
	const warsToEvaluate = rawWars.filter((w) => {
		if (!w.end || w.end === 0) return false; // Ongoing
		if (minCompletedTimestamp > 0 && w.end < minCompletedTimestamp)
			return false;
		if (evaluatedWarIds.has(w.id)) return false;
		return true;
	});

	logger.info(
		`Evaluating ${warsToEvaluate.length} newly completed ranked wars (out of ${rawWars.length} returned)...`,
	);

	let completedWars = 0;
	let termedWars = 0;
	let forfeitedWars = 0;
	let totalCandidatesFound = 0;

	const excludedFactionSet = new Set(config.excludedFactionIds ?? []);

	for (const war of warsToEvaluate) {
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
		try {
			const reportKey = (await getApiKey()) ?? initialKey;
			const reportResponse = (await tornApi.get(
				"/faction/{rankedWarId}/rankedwarreport",
				{
					apiKey: reportKey.apiKey,
					userId: reportKey.userId,
					pathParams: { rankedWarId: war.id },
				},
			)) as FactionRankedWarReportResponse;
			warReport = reportResponse.rankedwarreport;
		} catch (err) {
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

			// Batch fetch faction rosters to determine days_in_faction
			const daysInFactionMap = new Map<number, number>();
			const candidateFactionIds = [
				...new Set(prospectiveCandidates.map((c) => c.factionId)),
			];
			await Promise.all(
				candidateFactionIds.map(async (fid) => {
					try {
						const memberKey = (await getApiKey()) ?? initialKey;
						const factionRes = (await tornApi.get("/faction/{id}/members", {
							apiKey: memberKey.apiKey,
							userId: memberKey.userId,
							pathParams: { id: fid },
						})) as FactionMembersResponse;
						for (const member of factionRes.members ?? []) {
							daysInFactionMap.set(member.id, member.days_in_faction);
						}
					} catch (err) {
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

				// Filter by minimum stats if threshold is set (> 0)
				if (config.minStats > 0 && bsEstimate !== null) {
					if (bsEstimate < config.minStats) {
						continue; // Below target battle stats
					}
				}

				qualifiedCandidatesCount++;
				totalCandidatesFound++;

				const candidateUuid = crypto.randomUUID();

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
						notified: Boolean(
							config.notificationsEnabled && config.notificationChannelId,
						),
						notifiedAt:
							config.notificationsEnabled && config.notificationChannelId
								? new Date()
								: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoNothing();

				// Dispatch Discord alert via IPC if enabled
				if (config.notificationsEnabled && config.notificationChannelId) {
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
		scannedWars: rawWars.length,
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
