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

import { SUBVERSIVE_FAMILY_FACTION_IDS } from "@sentinel/utils";

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

function createNoWarInfo(): CurrentWarInfo {
	return {
		state: "no_war",
		warId: null,
		start: null,
		target: null,
		winner: null,
		opponent: null,
		subversive: null,
		lastUpdated: 0,
	};
}

interface FactionWarCache {
	war: CurrentWarInfo;
	opponents: RankedWarOpponent[];
	lastWarsCheck: number;
}

// Cached war status per family faction to avoid hitting /faction/{id}/wars every second during active wars
const warCacheByFaction = new Map<number, FactionWarCache>();
const WARS_CACHE_TTL_MS = 10_000; // Cache war metadata for 10s during active wars

function getFactionCache(factionId: number): FactionWarCache {
	let entry = warCacheByFaction.get(factionId);
	if (!entry) {
		entry = { war: createNoWarInfo(), opponents: [], lastWarsCheck: 0 };
		warCacheByFaction.set(factionId, entry);
	}
	return entry;
}

function handleKeyError(err: unknown, apiKey: string): void {
	if (
		(err instanceof TornError &&
			(err.code === 13 || err.code === 10 || err.code === 18)) ||
		String(err).includes("Key temporarily disabled")
	) {
		const cooldownMs = markSubversiveKeyDisabled(apiKey);
		const durationStr =
			cooldownMs >= 60_000
				? `${Math.round(cooldownMs / 60_000)}m`
				: `${cooldownMs}ms`;
		logger.warn(
			`API key ending in '...${apiKey.slice(-4)}' marked temporarily disabled for ${durationStr}.`,
		);
	} else {
		logger.warn(
			`Failed to poll ranked war data: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Refreshes war metadata for a single family faction.
 * Returns the war info and the resolved opponent faction id.
 */
async function refreshFactionWar(
	client: TornApiClient,
	factionId: number,
	entry: FactionWarCache,
	nowSec: number,
): Promise<CurrentWarInfo> {
	const keyObj = await getNextSubversiveUserKey();
	if (!keyObj) {
		logger.debug(
			`No active API key available to check ranked war for faction ${factionId}.`,
		);
		return entry.war;
	}

	try {
		const warsRes = (await client.get("/faction/{id}/wars", {
			apiKey: keyObj.apiKey,
			pathParams: { id: factionId },
		})) as TornFactionWarsResponse;

		recordSubversiveKeySuccess(keyObj.apiKey);

		const ranked = warsRes.wars?.ranked;
		if (!ranked || ranked.end !== null || ranked.winner !== null) {
			const noWar: CurrentWarInfo = {
				...createNoWarInfo(),
				lastUpdated: Date.now(),
			};
			entry.war = noWar;
			entry.opponents = [];
			entry.lastWarsCheck = Date.now();
			return noWar;
		}

		const factions = ranked.factions ?? [];
		const ownFaction = factions.find((f) => f.id === factionId);
		const oppFaction = factions.find((f) => f.id !== factionId);

		const state: WarState = nowSec >= ranked.start ? "active" : "scheduled";

		const warInfo: CurrentWarInfo = {
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
			subversive: ownFaction
				? {
						id: ownFaction.id,
						name: ownFaction.name,
						score: ownFaction.score,
						chain: ownFaction.chain,
					}
				: null,
			lastUpdated: Date.now(),
		};

		entry.war = warInfo;
		entry.lastWarsCheck = Date.now();
		return warInfo;
	} catch (err) {
		handleKeyError(err, keyObj.apiKey);
		return entry.war;
	}
}

/**
 * Polls the opponent member roster for a family faction's ranked war.
 */
async function refreshFactionOpponents(
	client: TornApiClient,
	warInfo: CurrentWarInfo,
): Promise<RankedWarOpponent[]> {
	const oppFactionId = warInfo.opponent?.id ?? null;
	if (!oppFactionId) return [];

	if (warInfo.state !== "active" && warInfo.state !== "scheduled") {
		return [];
	}

	const oppKey = await getNextSubversiveUserKey();
	if (!oppKey) return [];

	try {
		const membersRes = (await client.get("/faction/{id}/members", {
			apiKey: oppKey.apiKey,
			pathParams: { id: oppFactionId },
		})) as TornFactionMembersResponse;

		recordSubversiveKeySuccess(oppKey.apiKey);

		const rawMembers = membersRes.members ?? [];
		if (rawMembers.length === 0) return [];

		await batchResolveOpponentStats(rawMembers, oppFactionId);

		const opponents: RankedWarOpponent[] = [];
		for (const m of rawMembers) {
			const stats = await resolveOpponentStats(m.id, m.level);
			opponents.push({
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
		return opponents;
	} catch (err) {
		handleKeyError(err, oppKey.apiKey);
		return [];
	}
}

/**
 * Checks ranked war status + opponent rosters for every faction in the Subversive
 * family (2013 Subversive Alliance, 27312 SA Succession). Each faction runs its own
 * ranked war, so state, opponents and cadence are tracked per faction.
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

	const wars: Record<
		string,
		{ war: CurrentWarInfo; opponents: RankedWarOpponent[] }
	> = {};
	let nextCadenceMs = 30_000;

	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const entry = getFactionCache(factionId);

		// 1. Refresh war metadata (cached for 10s during active wars)
		const shouldCheckWars =
			entry.war.state !== "active" ||
			Date.now() - entry.lastWarsCheck >= WARS_CACHE_TTL_MS;

		let warInfo: CurrentWarInfo;
		if (shouldCheckWars) {
			warInfo = await refreshFactionWar(client, factionId, entry, nowSec);
		} else {
			warInfo = { ...entry.war, lastUpdated: Date.now() };
			entry.war = warInfo;
		}

		// 2. Refresh opponent roster when engaged
		const opponents = await refreshFactionOpponents(client, warInfo);
		entry.opponents = opponents;

		wars[String(factionId)] = { war: warInfo, opponents };

		// 3. Dynamic cadence: fastest engaged faction wins
		if (warInfo.state === "active") {
			nextCadenceMs = 1_000;
		} else if (warInfo.state === "scheduled" && nextCadenceMs > 15_000) {
			nextCadenceMs = 15_000;
		}
	}

	// 4. Broadcast war updates to Sentinel API over Unix Domain Socket IPC
	const ipcServer = getActiveIpcServer();
	if (ipcServer) {
		ipcServer.broadcast({
			action: "subversive_war_updated",
			data: { wars },
		});
	}

	return Date.now() + nextCadenceMs;
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
