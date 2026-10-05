import { db, inArray, subversiveTargetFinderTargets } from "@sentinel/database";
import {
	emptyRwDisplayBuckets,
	emptyRwTravelingBuckets,
	type IpcMessage,
	type RwDisplaysUpdate,
	type RwTravelingUpdate,
} from "@sentinel/schemas";
import {
	getPlayerStats,
	TornApiClient,
	TornError,
	tornApi,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import type { IpcServer } from "@sentinel/utils/ipc";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import {
	resolvePrimaryDisplayChannels,
	resolveSecondaryDisplayChannels,
} from "../../lib/rw-channel-config";
import { classifyOpponentsIntoRwBuckets } from "../../lib/rw-opponent-buckets";
import {
	buildOpponentFingerprint,
	clearRwDisplaysBroadcastState,
	hasRwDisplaysBroadcastState,
	shouldBroadcastRwDisplays,
	shouldReclassifyRwDisplays,
} from "../../lib/rw-primary-displays";
import { classifyTravelingOpponents } from "../../lib/rw-traveling-buckets";
import {
	clearRwTravelingBroadcastState,
	hasRwTravelingBroadcastState,
	shouldBroadcastRwTraveling,
} from "../../lib/rw-traveling-displays";
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
	/**
	 * Torn's standing "this player allows revives" permission flag, NOT a live
	 * "is down right now" state. Only meaningful combined with a Hospital
	 * status: a player is actually revivable when this is true AND
	 * `status.state === "Hospital"`.
	 *
	 * Verified against the live API: a 99-member opposing roster returned 40
	 * members with this set while only 1 was in hospital, and zero overlapped.
	 */
	isRevivable: boolean;
	/**
	 * The player's revive opt-in preference. Torn only populates this for the
	 * key's own faction; it reads "Unknown" for every opponent member, so
	 * cross-faction logic must rely on `isRevivable` instead.
	 */
	reviveSetting: string;
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
		/**
		 * Torn only populates this for the key's own faction; it reads
		 * "Unknown" for every member of an opposing faction.
		 */
		revive_setting?: string;
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

// In-memory stat cache for opponent members to avoid repeated DB/FFScouter lookups.
// Bounded and evicted in insertion order: it previously grew for the process
// lifetime across every war ever seen, on a long-running scheduler.
const opponentStatsCache = new Map<
	number,
	{ estimatedBs: number; estimatedScore: number }
>();
const MAX_OPPONENT_STATS_ENTRIES = 5_000;

function setOpponentStats(
	memberId: number,
	value: { estimatedBs: number; estimatedScore: number },
): void {
	if (
		!opponentStatsCache.has(memberId) &&
		opponentStatsCache.size >= MAX_OPPONENT_STATS_ENTRIES
	) {
		const oldest = opponentStatsCache.keys().next().value;
		if (oldest !== undefined) opponentStatsCache.delete(oldest);
	}
	opponentStatsCache.set(memberId, value);
}

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
				setOpponentStats(row.targetId, {
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

				setOpponentStats(res.player_id, {
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
			setOpponentStats(memberId, res);
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

/**
 * Heartbeat for the war-state IPC broadcast, so a subscriber that restarted
 * mid-war still receives a full snapshot even if nothing changed.
 */
const WAR_BROADCAST_HEARTBEAT_MS = 30_000;
let lastWarBroadcastSignature = "";
let lastWarBroadcastAt = 0;
/**
 * Resolves the faction currently ranked-warred with a family faction.
 * Returns null when no war is engaged, which callers treat as "no retal set".
 */
export function getWarOpponentFactionId(factionId: number): number | null {
	const entry = warCacheByFaction.get(factionId);
	if (!entry) return null;
	const state = entry.war.state;
	if (state !== "active" && state !== "scheduled") return null;
	return entry.war.opponent?.id ?? null;
}

/**
 * Opponent-id index for the current roster, memoised per roster array instance.
 *
 * `isCurrentWarOpponent` is called once per live attacker when the retal tracker
 * rebuilds its set, so a linear `.some()` scan made that O(attackers x roster).
 * The cache is keyed by the array identity and the roster is replaced wholesale
 * on every refresh, so this rebuilds exactly once per refreshed roster and the
 * lookup becomes O(1). A WeakMap keeps the index from pinning old rosters.
 */
const opponentIdIndexCache = new WeakMap<
	readonly RankedWarOpponent[],
	Set<number>
>();

function getOpponentIdIndex(
	opponents: readonly RankedWarOpponent[],
): Set<number> {
	let index = opponentIdIndexCache.get(opponents);
	if (!index) {
		index = new Set<number>();
		for (const opp of opponents) index.add(opp.id);
		opponentIdIndexCache.set(opponents, index);
	}
	return index;
}

/**
 * Whether a player id is on the family faction's current ranked war opponent
 * roster. Used to keep Retal badges scoped to actual war opponents.
 */
export function isCurrentWarOpponent(
	factionId: number,
	playerId: number,
): boolean {
	const opponentFactionId = getWarOpponentFactionId(factionId);
	if (opponentFactionId === null) return false;
	const entry = warCacheByFaction.get(factionId);
	if (!entry) return false;
	return getOpponentIdIndex(entry.opponents).has(playerId);
}

/**
 * Whether any family faction currently has an engaged ranked war. Read from the
 * in-memory war cache, so it costs no API call. Drives the faction attack
 * feed's adaptive cadence.
 */
export function isAnyFamilyRankedWarEngaged(): boolean {
	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const state = warCacheByFaction.get(factionId)?.war.state;
		if (state === "active" || state === "scheduled") return true;
	}
	return false;
}

/** Identity and timing of a family faction's currently engaged ranked war. */
export interface EngagedWarContext {
	warId: number | null;
	/** Unix seconds the war began; hits before this belong to a previous war. */
	start: number | null;
	opponentFactionId: number | null;
}

/**
 * Returns the engaged war context for a family faction, or null when no ranked
 * war is running. Consumers use this to scope cumulative per-war counters.
 */
export function getEngagedWarContext(
	factionId: number,
): EngagedWarContext | null {
	const entry = warCacheByFaction.get(factionId);
	if (!entry) return null;
	const war = entry.war;
	if (war.state !== "active" && war.state !== "scheduled") return null;
	return {
		warId: war.warId,
		start: war.start,
		opponentFactionId: war.opponent?.id ?? null,
	};
}

function getFactionCache(factionId: number): FactionWarCache {
	let entry = warCacheByFaction.get(factionId);
	if (!entry) {
		entry = {
			war: createNoWarInfo(),
			opponents: [],
			lastWarsCheck: 0,
		};
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
			rateLimitKey: keyObj.userId,
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
 *
 * Deliberately uncached: the roster drives live hospital, online and revive
 * decisions, so it is refreshed on every cycle. Torn quota is handled by the
 * script key pool, which round-robins requests across keys so no single key
 * approaches its own limit.
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
			rateLimitKey: oppKey.userId,
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
				isRevivable: m.is_revivable ?? false,
				reviveSetting: m.revive_setting ?? "Unknown",
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

	// Shares the managed client's limiter so the 1s war cycle is counted against
	// the same per-key budget as every `tornApi.*` call. This is the highest-rate
	// consumer of the shared subversive key pool.
	const client = new TornApiClient({
		rateLimitTracker: tornApi.rateLimiter,
	});
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

		// 2. Refresh opponent roster when engaged (live, every cycle)
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

	// 4. Broadcast war updates to Sentinel API over Unix Domain Socket IPC.
	//
	// Change-gated: this cycle runs every second while a war is active and the
	// payload carries every opponent for every family faction. Previously it was
	// pushed unconditionally, which meant a full snapshot serialised and written
	// to every subscriber each second, and on the API side a full-roster
	// hospital-queue evaluation per message. Subscribers that need a guaranteed
	// repaint (a restarted API holds these counts in memory only) are covered by
	// the heartbeat, mirroring the display broadcasts below.
	const ipcServer = getActiveIpcServer();
	if (ipcServer) {
		const warPayloadSignature = JSON.stringify(wars);
		const warPayloadChanged = warPayloadSignature !== lastWarBroadcastSignature;
		const warPayloadStale =
			nowSec * 1000 - lastWarBroadcastAt >= WAR_BROADCAST_HEARTBEAT_MS;

		if (!lastWarBroadcastSignature || warPayloadChanged || warPayloadStale) {
			lastWarBroadcastSignature = warPayloadSignature;
			lastWarBroadcastAt = nowSec * 1000;
			ipcServer.broadcast({
				action: "subversive_war_updated",
				data: { wars },
			});
		}

		await broadcastRwPrimaryDisplays(ipcServer, wars, nowSec);
		await broadcastRwTravelingDisplays(ipcServer, wars);
	}

	schedulerEvents.emit("ranked_war_updated");

	return Date.now() + nextCadenceMs;
}

/**
 * Classifies each engaged faction's opposing roster and pushes the four
 * primary-display buckets to the Discord bot.
 *
 * Runs for factions with a `scheduled` or `active` war. A faction whose war has
 * ended is sent one `no_war` payload so the bot tears its embeds down; without
 * it the four embeds would sit in the channel showing a finished war forever.
 * The teardown only goes to a faction that previously rendered something, so a
 * permanently idle faction generates no traffic.
 */
async function broadcastRwPrimaryDisplays(
	ipcServer: IpcServer<IpcMessage>,
	wars: Record<string, { war: CurrentWarInfo; opponents: RankedWarOpponent[] }>,
	nowSec: number,
): Promise<void> {
	const engagedFactionIds: number[] = [];
	const idleFactionIds: number[] = [];

	for (const [factionId, snapshot] of Object.entries(wars)) {
		const state = snapshot.war.state;
		if (state === "active" || state === "scheduled") {
			engagedFactionIds.push(Number(factionId));
		} else {
			idleFactionIds.push(Number(factionId));
		}
	}

	const nowMs = Date.now();

	for (const factionId of idleFactionIds) {
		if (!hasRwDisplaysBroadcastState(factionId)) continue;

		ipcServer.broadcast({
			action: "subversive_rw_displays_update",
			data: {
				factionId,
				opponentFactionId: 0,
				opponentFactionName: "",
				warId: null,
				warState: "no_war",
				// Carry the last known channel so the bot can delete the messages
				// before forgetting where they lived.
				channelId: lastRenderedChannelByFaction.get(factionId) ?? null,
				buckets: emptyRwDisplayBuckets(),
				updatedAt: nowMs,
			},
		});

		clearRwDisplaysBroadcastState(factionId);
		lastRenderedChannelByFaction.delete(factionId);
	}

	if (engagedFactionIds.length === 0) return;

	const channelIdByFaction =
		await resolvePrimaryDisplayChannels(engagedFactionIds);

	for (const factionId of engagedFactionIds) {
		const snapshot = wars[String(factionId)];
		if (!snapshot) continue;

		const opponent = snapshot.war.opponent;
		// An engaged war with no resolvable opposing faction cannot be rendered;
		// the next cycle will refresh the war metadata and try again.
		if (!opponent) continue;

		// Skip the five-array-copy/sort classification when the roster fingerprint
		// is unchanged and the heartbeat has not elapsed; the result would only be
		// discarded by the broadcast gate below.
		if (
			!shouldReclassifyRwDisplays(
				factionId,
				buildOpponentFingerprint(snapshot.opponents),
				nowMs,
			)
		) {
			continue;
		}

		const buckets = classifyOpponentsIntoRwBuckets(snapshot.opponents, nowSec);

		if (!shouldBroadcastRwDisplays(factionId, buckets, nowMs)) continue;

		const channelId = channelIdByFaction.get(factionId) ?? null;
		lastRenderedChannelByFaction.set(factionId, channelId);

		const payload: RwDisplaysUpdate = {
			factionId,
			opponentFactionId: opponent.id,
			opponentFactionName: opponent.name,
			warId: snapshot.war.warId,
			warState: snapshot.war.state === "active" ? "active" : "scheduled",
			channelId,
			buckets,
			updatedAt: nowMs,
		};

		ipcServer.broadcast({
			action: "subversive_rw_displays_update",
			data: payload,
		});
	}
}

/**
 * Buckets each engaged faction's airborne roster by flight destination and
 * pushes it to the Discord bot.
 *
 * Reads the same already-polled member roster the primary displays use, so it
 * costs no additional Torn request. Runs alongside the primary broadcast rather
 * than inside it, with independent suppression state: travelers populate none
 * of the four primary buckets, so folding this into that payload would let a
 * departure be suppressed as "unchanged".
 *
 * Mirrors the primary lifecycle exactly, including the `no_war` teardown that
 * only goes to a faction that previously rendered.
 */
async function broadcastRwTravelingDisplays(
	ipcServer: IpcServer<IpcMessage>,
	wars: Record<string, { war: CurrentWarInfo; opponents: RankedWarOpponent[] }>,
): Promise<void> {
	const engagedFactionIds: number[] = [];
	const idleFactionIds: number[] = [];

	for (const [factionId, snapshot] of Object.entries(wars)) {
		const state = snapshot.war.state;
		if (state === "active" || state === "scheduled") {
			engagedFactionIds.push(Number(factionId));
		} else {
			idleFactionIds.push(Number(factionId));
		}
	}

	const nowMs = Date.now();

	for (const factionId of idleFactionIds) {
		if (!hasRwTravelingBroadcastState(factionId)) continue;

		ipcServer.broadcast({
			action: "subversive_rw_traveling_update",
			data: {
				factionId,
				opponentFactionId: 0,
				opponentFactionName: "",
				warId: null,
				warState: "no_war",
				channelId: lastTravelingChannelByFaction.get(factionId) ?? null,
				destinations: emptyRwTravelingBuckets(),
				updatedAt: nowMs,
			},
		});

		clearRwTravelingBroadcastState(factionId);
		lastTravelingChannelByFaction.delete(factionId);
	}

	if (engagedFactionIds.length === 0) return;

	const channelIdByFaction =
		await resolveSecondaryDisplayChannels(engagedFactionIds);

	for (const factionId of engagedFactionIds) {
		const snapshot = wars[String(factionId)];
		if (!snapshot) continue;

		const opponent = snapshot.war.opponent;
		if (!opponent) continue;

		const destinations = classifyTravelingOpponents(snapshot.opponents);

		if (!shouldBroadcastRwTraveling(factionId, destinations, nowMs)) continue;

		const channelId = channelIdByFaction.get(factionId) ?? null;
		lastTravelingChannelByFaction.set(factionId, channelId);

		const payload: RwTravelingUpdate = {
			factionId,
			opponentFactionId: opponent.id,
			opponentFactionName: opponent.name,
			warId: snapshot.war.warId,
			warState: snapshot.war.state === "active" ? "active" : "scheduled",
			channelId,
			destinations,
			updatedAt: nowMs,
		};

		ipcServer.broadcast({
			action: "subversive_rw_traveling_update",
			data: payload,
		});
	}
}

/**
 * The channel each faction was last rendered into, kept so a war-ended
 * teardown can carry it. The bot needs the id to delete the messages before it
 * drops them from the database.
 */
const lastRenderedChannelByFaction = new Map<number, string | null>();

/**
 * The secondary channel each faction's travel embed was last rendered into.
 * Kept separately from the primary so a channel change on one display cannot
 * misdirect the other's teardown.
 */
const lastTravelingChannelByFaction = new Map<number, string | null>();

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
