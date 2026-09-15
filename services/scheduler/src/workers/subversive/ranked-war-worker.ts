import { db, inArray, subversiveTargetFinderTargets } from "@sentinel/database";
import { getPlayerStats, TornApiClient, TornError } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	getNextSubversiveUserKey,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
} from "./subversive-key-pool";

const logger = new Logger("Scheduler", "SubversiveRankedWarWorker");

const SUBVERSIVE_FACTION_ID = 2013;

export type WarState = "no_war" | "scheduled" | "active";

export interface RankedWarOpponent {
	id: number;
	name: string;
	level: number;
	daysInFaction: number;
	position: string;
	isOnWall: boolean;
	isInOc: boolean;
	hasEarlyDischarge: boolean;
	lastAction: {
		status: string;
		timestamp: number;
		relative: string;
	};
	status: {
		description: string;
		details: string | null;
		state: string;
		color: string;
		until: number | null;
		planeImageType?: string;
	};
	estimatedBs: number;
	estimatedScore: number;
}

export interface CurrentWarInfo {
	state: WarState;
	warId: number | null;
	start: number | null;
	target: number | null;
	winner: number | null;
	opponent: {
		id: number;
		name: string;
		score: number;
		chain: number;
	} | null;
	subversive: {
		id: number;
		name: string;
		score: number;
		chain: number;
	} | null;
	lastUpdated: number;
}

interface TornFactionWarsResponse {
	wars?: {
		ranked?: {
			war_id: number;
			start: number;
			end: number | null;
			target: number;
			winner: number | null;
			factions: Array<{
				id: number;
				name: string;
				score: number;
				chain: number;
			}>;
		} | null;
	};
}

interface TornFactionMembersResponse {
	members?: Array<{
		id: number;
		name: string;
		level: number;
		days_in_faction: number;
		position: string;
		is_revivable: boolean;
		is_on_wall: boolean;
		is_in_oc: boolean;
		has_early_discharge: boolean;
		last_action: {
			status: string;
			timestamp: number;
			relative: string;
		};
		status: {
			description: string;
			details: string | null;
			state: string;
			color: string;
			until: number | null;
			plane_image_type?: string;
		};
	}>;
}

// In-memory stat cache for opponent members to avoid repeated DB/FFScouter lookups
const opponentStatsCache = new Map<
	number,
	{ estimatedBs: number; estimatedScore: number }
>();

async function batchResolveOpponentStats(
	members: Array<{ id: number; name: string; level: number }>,
	opponentFactionId: number,
): Promise<void> {
	const uncached = members.filter((m) => !opponentStatsCache.has(m.id));
	if (uncached.length === 0) return;

	const uncachedIds = uncached.map((m) => m.id);

	// 1. Batch lookup in database first
	try {
		const dbRows = await db
			.select({
				targetId: subversiveTargetFinderTargets.targetId,
				estimatedBs: subversiveTargetFinderTargets.estimatedBs,
				estimatedScore: subversiveTargetFinderTargets.estimatedScore,
			})
			.from(subversiveTargetFinderTargets)
			.where(inArray(subversiveTargetFinderTargets.targetId, uncachedIds));

		for (const row of dbRows) {
			if (row.estimatedScore > 0) {
				opponentStatsCache.set(row.targetId, {
					estimatedBs: row.estimatedBs,
					estimatedScore: row.estimatedScore,
				});
			}
		}
	} catch (err) {
		logger.warn(`Failed DB batch lookup for opponent stats: ${err}`);
	}

	// 2. For remaining uncached members, query FFScouter
	const stillMissing = uncached.filter((m) => !opponentStatsCache.has(m.id));
	if (stillMissing.length === 0) return;

	try {
		const memberMap = new Map(members.map((m) => [m.id, m]));
		const ffResults = await getPlayerStats(stillMissing.map((m) => m.id));
		const now = new Date();

		for (const res of ffResults) {
			if (res.player_id && res.bs_estimate && res.bs_estimate > 0) {
				const memberMeta = memberMap.get(res.player_id);
				let score = 2 * Math.sqrt(res.bs_estimate);
				if (res.distribution?.stats_percentage) {
					const str =
						res.bs_estimate *
						((res.distribution.stats_percentage.strength ?? 25) / 100);
					const spd =
						res.bs_estimate *
						((res.distribution.stats_percentage.speed ?? 25) / 100);
					const def =
						res.bs_estimate *
						((res.distribution.stats_percentage.defense ?? 25) / 100);
					const dex =
						res.bs_estimate *
						((res.distribution.stats_percentage.dexterity ?? 25) / 100);
					score =
						Math.sqrt(Math.max(0, str)) +
						Math.sqrt(Math.max(0, spd)) +
						Math.sqrt(Math.max(0, def)) +
						Math.sqrt(Math.max(0, dex));
				}

				opponentStatsCache.set(res.player_id, {
					estimatedBs: res.bs_estimate,
					estimatedScore: score,
				});

				// Upsert to DB cache
				await db
					.insert(subversiveTargetFinderTargets)
					.values({
						targetId: res.player_id,
						name: memberMeta?.name ?? `Player ${res.player_id}`,
						level: memberMeta?.level ?? 1,
						factionId: opponentFactionId,
						factionName: null,
						daysOld: 30,
						isInactive: false,
						isFactionless: false,
						inHospital: false,
						estimatedBs: res.bs_estimate,
						estimatedScore: score,
						status: "okay",
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: subversiveTargetFinderTargets.targetId,
						set: {
							estimatedBs: res.bs_estimate,
							estimatedScore: score,
							updatedAt: now,
						},
					})
					.catch(() => {});
			}
		}
	} catch (err) {
		logger.warn(`Failed fetching FFScouter stats for opponents: ${err}`);
	}
}

async function resolveOpponentStats(
	memberId: number,
	level: number,
): Promise<{ estimatedBs: number; estimatedScore: number }> {
	const cached = opponentStatsCache.get(memberId);
	if (cached) return cached;

	try {
		const [ffResult] = await getPlayerStats([memberId]);
		if (ffResult?.bs_estimate && ffResult.bs_estimate > 0) {
			const score = 2 * Math.sqrt(ffResult.bs_estimate);
			const res = {
				estimatedBs: ffResult.bs_estimate,
				estimatedScore: score,
			};
			opponentStatsCache.set(memberId, res);
			return res;
		}
	} catch {}

	const approxBs = Math.max(10_000, level * 50_000);
	const approxScore = 2 * Math.sqrt(approxBs);
	return {
		estimatedBs: approxBs,
		estimatedScore: approxScore,
	};
}

// Cached war status to avoid hitting /faction/{id}/wars every 1 second during active wars
let cachedWarInfo: CurrentWarInfo = {
	state: "no_war",
	warId: null,
	start: null,
	target: null,
	winner: null,
	opponent: null,
	subversive: null,
	lastUpdated: 0,
};
let lastWarsCheckTime = 0;
let cachedOppFactionId: number | null = null;
const WARS_CACHE_TTL_MS = 10_000; // Cache war metadata for 10s during active wars

/**
 * Checks the ranked war status and opponent roster for Subversive Alliance.
 * Broadcasts updates via Unix Domain Socket IPC to Sentinel API & WebSocket subscribers.
 * Returns the epoch ms timestamp for the next dynamic cadence.
 */
export async function runRankedWarTrackingCycle(): Promise<number> {
	const keyObj = await getNextSubversiveUserKey();
	if (!keyObj) {
		logger.debug(
			"No active API key available for Subversive Ranked War cycle.",
		);
		return Date.now() + 30_000;
	}

	const client = new TornApiClient();
	const nowSec = Math.floor(Date.now() / 1000);

	let warInfo: CurrentWarInfo = {
		state: "no_war",
		warId: null,
		start: null,
		target: null,
		winner: null,
		opponent: null,
		subversive: null,
		lastUpdated: Date.now(),
	};

	let oppFactionId: number | null = null;

	// 1. Check Subversive Alliance war status (cached for 10s during active wars)
	const shouldCheckWars =
		cachedWarInfo.state !== "active" ||
		Date.now() - lastWarsCheckTime >= WARS_CACHE_TTL_MS;

	if (shouldCheckWars) {
		try {
			const warsRes = (await client.get("/faction/{id}/wars", {
				apiKey: keyObj.apiKey,
				pathParams: { id: SUBVERSIVE_FACTION_ID },
			})) as TornFactionWarsResponse;

			recordSubversiveKeySuccess(keyObj.apiKey);

			const ranked = warsRes.wars?.ranked;

			if (ranked && ranked.end === null && ranked.winner === null) {
				const factions = ranked.factions ?? [];
				const saFaction = factions.find((f) => f.id === SUBVERSIVE_FACTION_ID);
				const oppFaction = factions.find((f) => f.id !== SUBVERSIVE_FACTION_ID);

				let state: WarState = "scheduled";
				if (nowSec >= ranked.start) {
					state = "active";
				}

				warInfo = {
					state,
					warId: ranked.war_id,
					start: ranked.start,
					target: ranked.target,
					winner: ranked.winner,
					opponent: oppFaction
						? {
								id: oppFaction.id,
								name: oppFaction.name,
								score: oppFaction.score,
								chain: oppFaction.chain,
							}
						: null,
					subversive: saFaction
						? {
								id: saFaction.id,
								name: saFaction.name,
								score: saFaction.score,
								chain: saFaction.chain,
							}
						: null,
					lastUpdated: Date.now(),
				};

				if (oppFaction) {
					oppFactionId = oppFaction.id;
				}
			}

			cachedWarInfo = warInfo;
			cachedOppFactionId = oppFactionId;
			lastWarsCheckTime = Date.now();
		} catch (err) {
			if (
				(err instanceof TornError &&
					(err.code === 13 || err.code === 10 || err.code === 18)) ||
				String(err).includes("Key temporarily disabled")
			) {
				const cooldownMs = markSubversiveKeyDisabled(keyObj.apiKey);
				const durationStr =
					cooldownMs >= 60_000
						? `${Math.round(cooldownMs / 60_000)}m`
						: `${cooldownMs}ms`;
				logger.warn(
					`API key ending in '...${keyObj.apiKey.slice(-4)}' marked temporarily disabled for ${durationStr}.`,
				);
			} else {
				logger.warn(
					`Failed to check Subversive war status: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return Date.now() + 15_000;
		}
	} else {
		// Use cached war info
		warInfo = {
			...cachedWarInfo,
			lastUpdated: Date.now(),
		};
		oppFactionId = cachedOppFactionId;
	}

	// 2. Poll opponent members if in active or scheduled war
	const parsedOpponents: RankedWarOpponent[] = [];

	if (
		oppFactionId &&
		(warInfo.state === "active" || warInfo.state === "scheduled")
	) {
		const oppKey = await getNextSubversiveUserKey();
		if (oppKey) {
			try {
				const membersRes = (await client.get("/faction/{id}/members", {
					apiKey: oppKey.apiKey,
					pathParams: { id: oppFactionId },
				})) as TornFactionMembersResponse;

				recordSubversiveKeySuccess(oppKey.apiKey);

				const rawMembers = membersRes.members ?? [];
				if (rawMembers.length > 0) {
					await batchResolveOpponentStats(rawMembers, oppFactionId);

					for (const m of rawMembers) {
						const stats = await resolveOpponentStats(m.id, m.level);
						parsedOpponents.push({
							id: m.id,
							name: m.name,
							level: m.level,
							daysInFaction: m.days_in_faction,
							position: m.position,
							isOnWall: m.is_on_wall,
							isInOc: m.is_in_oc,
							hasEarlyDischarge: m.has_early_discharge,
							lastAction: {
								status: m.last_action?.status ?? "Offline",
								timestamp: m.last_action?.timestamp ?? 0,
								relative: m.last_action?.relative ?? "",
							},
							status: {
								description: m.status?.description ?? "",
								details: m.status?.details ?? null,
								state: m.status?.state ?? "Okay",
								color: m.status?.color ?? "green",
								until: m.status?.until ?? null,
								planeImageType: m.status?.plane_image_type,
							},
							estimatedBs: stats.estimatedBs,
							estimatedScore: stats.estimatedScore,
						});
					}
				}
			} catch (err) {
				if (
					(err instanceof TornError &&
						(err.code === 13 || err.code === 10 || err.code === 18)) ||
					String(err).includes("Key temporarily disabled")
				) {
					const cooldownMs = markSubversiveKeyDisabled(oppKey.apiKey);
					const durationStr =
						cooldownMs >= 60_000
							? `${Math.round(cooldownMs / 60_000)}m`
							: `${cooldownMs}ms`;
					logger.warn(
						`API key ending in '...${oppKey.apiKey.slice(-4)}' marked temporarily disabled for ${durationStr}.`,
					);
				} else {
					logger.warn(
						`Failed to poll opponent members for faction ${oppFactionId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	}

	// 3. Broadcast war update to Sentinel API over Unix Domain Socket IPC
	const ipcServer = getActiveIpcServer();
	if (ipcServer) {
		ipcServer.broadcast({
			action: "subversive_war_updated",
			data: {
				war: warInfo,
				opponents: parsedOpponents,
			},
		});
	}

	// 4. Dynamic cadence:
	// - Active war: every 1s (1,000ms)
	// - Scheduled war: every 15s
	// - Peacetime / No war: every 30s
	if (warInfo.state === "active") {
		return Date.now() + 1_000;
	}
	if (warInfo.state === "scheduled") {
		return Date.now() + 15_000;
	}
	return Date.now() + 30_000;
}

/**
 * Starts the periodic Subversive Ranked War worker in the scheduler.
 */
export const startSubversiveRankedWarWorker: WorkerStarter = (options) => {
	startEventDrivenRunner({
		worker: "subversive:ranked_war_worker",
		defaultCadenceSeconds: 30,
		initialDelayMs: options?.initialDelayMs ?? 1000,
		handler: runRankedWarTrackingCycle,
	});
};
