import { and, db, eq, factionAttackLogs, gte, sql } from "@sentinel/database";
import { Logger, SUBVERSIVE_FAMILY_FACTION_IDS } from "@sentinel/utils";
import { ATTACK_FEED_CADENCE_MS } from "../../lib/attack-feed-cadence";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import type { FactionAttackEvent } from "../merc/faction-attack-feed-worker";
import { isLandedHit } from "../merc/merc-attack-validator-worker";
import { getEngagedWarContext } from "./ranked-war-worker";

const logger = new Logger("Scheduler", "HitCounter");

/** Counts broadcast on the fastest feed tier so the number stays current. */
const BROADCAST_INTERVAL_MS = ATTACK_FEED_CADENCE_MS.both;
/**
 * Re-send an unchanged tally at least this often. Covers an API restart or IPC
 * reconnect, which would otherwise lose the in-memory counts for good.
 */
const FORCED_REBROADCAST_INTERVAL_MS = 60_000;

/** Per faction: war the counts belong to, and each member's landed RW hits. */
interface FactionHitState {
	warId: number | null;
	counts: Map<number, number>;
}

const hitStateByFaction = new Map<number, FactionHitState>();
const lastBroadcastAtMs = new Map<number, number>();
const lastBroadcastSignature = new Map<number, string>();

function ensureState(factionId: number): FactionHitState {
	let state = hitStateByFaction.get(factionId);
	if (!state) {
		state = { warId: null, counts: new Map() };
		hitStateByFaction.set(factionId, state);
	}
	return state;
}

/**
 * Discards counts when the family faction rolls into a different ranked war, so
 * one war's totals can never bleed into the next.
 */
function resetIfNewWar(state: FactionHitState, warId: number | null): void {
	if (state.warId !== warId) {
		state.warId = warId;
		state.counts.clear();
	}
}

/**
 * Whether an ingested attack counts toward a member's ranked war hit total.
 *
 * Every condition must hold: we made the attack, it happened during a ranked
 * war, it landed on the opposing faction, it fell inside the current war, and
 * the result represents damage actually dealt. Incoming attacks, faction/raid
 * traffic and misses are all excluded.
 */
export function qualifiesAsRankedWarHit(
	attack: {
		direction: string;
		isRankedWar: boolean;
		attackerId: number | null;
		defenderFactionId: number | null;
		startedAt: number | null;
		endedAt?: number | null;
		result: string | null;
	},
	context: { start: number | null; opponentFactionId: number | null },
): boolean {
	if (attack.direction !== "outgoing") return false;
	if (!attack.isRankedWar) return false;
	if (attack.attackerId === null || attack.attackerId <= 0) return false;

	if (context.opponentFactionId === null) return false;
	if (attack.defenderFactionId !== context.opponentFactionId) return false;

	// Without a war start we cannot prove the attack belongs to this war.
	const attackTime = attack.endedAt ?? attack.startedAt ?? null;
	if (context.start === null || attackTime === null) return false;
	if (attackTime < context.start) return false;

	return isLandedHit(attack.result);
}

/** Applies an ingested batch to the in-memory counts. */
function recordAttacks(attacks: FactionAttackEvent[]): void {
	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const context = getEngagedWarContext(factionId);
		// No engaged war: reset so a finished war leaves nothing behind.
		const state = ensureState(factionId);
		resetIfNewWar(state, context?.warId ?? null);
		if (!context) continue;

		for (const attack of attacks) {
			if (attack.factionId !== factionId) continue;
			if (!qualifiesAsRankedWarHit(attack, context)) continue;
			const attackerId = attack.attackerId as number;
			state.counts.set(attackerId, (state.counts.get(attackerId) ?? 0) + 1);
		}
	}
}

/**
 * Rebuilds counts from `faction_attack_logs` for the currently engaged war, so
 * a scheduler restart mid-war does not zero every member's tally.
 *
 * The rebuild REPLACES the in-memory tally rather than adding to it. This runs
 * on a timer as well as at boot, and `recordAttacks` also folds in live feed
 * batches, so accumulating here would inflate every member's total once per
 * cycle.
 */
async function hydrateFromDatabase(): Promise<void> {
	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const context = getEngagedWarContext(factionId);
		const state = ensureState(factionId);
		resetIfNewWar(state, context?.warId ?? null);

		if (
			!context ||
			context.start === null ||
			context.opponentFactionId === null
		) {
			// Diagnostics: without an opponent id no attack can be attributed to the
			// opposing faction, so the tally would silently stay at zero.
			logger.warn(
				`Hit count hydration skipped for faction ${factionId}: context=${JSON.stringify(context)}.`,
			);
			continue;
		}

		try {
			// Aggregate in SQL rather than pulling every hit of the war into the
			// process. Grouping by (attacker, result) keeps the exact same
			// `isLandedHit` semantics while bounding the transferred rows to
			// attackers x distinct results instead of growing all war long.
			const rows = await db
				.select({
					attackerId: factionAttackLogs.attackerId,
					result: factionAttackLogs.result,
					hits: sql<number>`count(*)::int`,
				})
				.from(factionAttackLogs)
				.where(
					and(
						eq(factionAttackLogs.factionId, factionId),
						eq(factionAttackLogs.direction, "outgoing"),
						eq(factionAttackLogs.isRankedWar, true),
						eq(factionAttackLogs.defenderFactionId, context.opponentFactionId),
						// Resolve on when the attack finished, not when it began: a
						// long-running attack started just before the war still
						// lands inside it and must count.
						gte(
							sql`coalesce(${factionAttackLogs.endedAt}, ${factionAttackLogs.startedAt})`,
							context.start,
						),
					),
				)
				.groupBy(factionAttackLogs.attackerId, factionAttackLogs.result);

			// Rebuild from scratch: DB is the source of truth for this war.
			const rebuilt = new Map<number, number>();
			for (const row of rows) {
				if (row.attackerId === null) continue;
				if (!isLandedHit(row.result)) continue;
				const hits = Number(row.hits ?? 0);
				rebuilt.set(row.attackerId, (rebuilt.get(row.attackerId) ?? 0) + hits);
			}
			state.counts = rebuilt;

			logger.debug(
				`Hydrated ranked war hit counts for faction ${factionId}: ${state.counts.size} member(s), ${[...state.counts.values()].reduce((a, b) => a + b, 0)} total hit(s).`,
			);
		} catch (err) {
			logger.warn(
				`Failed hydrating hit counts for faction ${factionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

/**
 * Broadcasts per-member hit counts per faction over IPC.
 *
 * An unchanged set is normally suppressed so a quiet war produces no traffic,
 * but the suppression is lifted once `FORCED_REBROADCAST_INTERVAL_MS` elapses.
 * The API holds these counts in memory only, so a restarted or reconnecting API
 * starts from an empty map; without the heartbeat it would sit at zero until
 * some member happened to land a hit.
 */
export function broadcastHitCounts(): void {
	const ipcServer = getActiveIpcServer();
	if (!ipcServer) return;

	const nowMs = Date.now();

	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const state = ensureState(factionId);
		if (state.warId === null) {
			// Diagnostics: a null warId here means the war worker has not learned
			// about the engagement, so nothing can ever be counted or published.
			logger.warn(
				`Hit count broadcast skipped for faction ${factionId}: no engaged war id resolved.`,
			);
			continue;
		}

		const counts: Record<string, number> = {};
		for (const [playerId, count] of state.counts) {
			counts[String(playerId)] = count;
		}
		const signature = JSON.stringify(counts);
		const lastAt = lastBroadcastAtMs.get(factionId) ?? 0;
		const unchanged = signature === lastBroadcastSignature.get(factionId);
		const stale = nowMs - lastAt >= FORCED_REBROADCAST_INTERVAL_MS;

		// Nothing new to say, but the API may have missed the last one.
		if (unchanged && !stale) continue;

		if (lastAt > 0 && nowMs - lastAt < BROADCAST_INTERVAL_MS) continue;

		lastBroadcastAtMs.set(factionId, nowMs);
		lastBroadcastSignature.set(factionId, signature);

		ipcServer.broadcast({
			action: "subversive_hit_counts_updated",
			data: { factionId, warId: state.warId, counts, updatedAt: nowMs },
		});
	}
}

/** Test seam: clears all in-memory hit state. */
export function resetHitCounter(): void {
	hitStateByFaction.clear();
	lastBroadcastAtMs.clear();
	lastBroadcastSignature.clear();
}

/** Test seam: stops the broadcast timer. */
export function stopHitCounter(): void {
	if (broadcastTimer) {
		clearInterval(broadcastTimer);
		broadcastTimer = null;
	}
	isSubscriptionActive = false;
}

let isSubscriptionActive = false;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;
/** War ids already hydrated, so a 1 Hz war-state tick does not re-query. */
const hydratedWarIds = new Map<number, number | null>();

/** Hydrates only when the engaged war for a faction actually changed. */
function hydrateIfWarChanged(): void {
	let anyChanged = false;
	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const context = getEngagedWarContext(factionId);
		const warId = context?.warId ?? null;
		if (hydratedWarIds.get(factionId) !== warId) {
			hydratedWarIds.set(factionId, warId);
			anyChanged = true;
		}
	}

	if (anyChanged) {
		void hydrateFromDatabase().then(() => broadcastHitCounts());
	}
}

/**
 * Starts the ranked war hit counter: tracks how many landed ranked war hits each
 * member has made this war and publishes the counts to the userscript.
 */
export function startHitCounter(): void {
	if (isSubscriptionActive) return;
	isSubscriptionActive = true;

	schedulerEvents.on(
		"faction_attacks_ingested",
		(attacks: FactionAttackEvent[]) => {
			recordAttacks(attacks);
			broadcastHitCounts();
		},
	);

	// The war worker emits this every second while a war is active. The tally is
	// already incremented live by `recordAttacks`, so the DB rebuild is only a
	// restart/backfill safety net and does not need to re-run on every tick —
	// only when the engaged war actually changes.
	schedulerEvents.on("ranked_war_updated", () => {
		hydrateIfWarChanged();
	});

	// The war worker learns about new wars on its own cycle, so re-check the
	// engaged war periodically to catch a war starting (or ending) mid-flight.
	void hydrateFromDatabase().then(() => broadcastHitCounts());
	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		hydratedWarIds.set(
			factionId,
			getEngagedWarContext(factionId)?.warId ?? null,
		);
	}

	// Periodic full rebuild stays as a safety net in case live increments drift.
	broadcastTimer = setInterval(() => {
		void hydrateFromDatabase().then(() => broadcastHitCounts());
	}, 60_000);
	broadcastTimer.unref?.();

	logger.info("Ranked war hit counter started.");
}

/** Exposed for tests and diagnostics: current counts for a faction. */
export function getHitCounts(factionId: number): Map<number, number> {
	return ensureState(factionId).counts;
}
