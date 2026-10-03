import { and, db, eq, factionAttackLogs, gte } from "@sentinel/database";
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
	if (context.start === null || attack.startedAt === null) return false;
	if (attack.startedAt < context.start) return false;

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
			continue;
		}

		try {
			const rows = await db
				.select({
					attackerId: factionAttackLogs.attackerId,
					result: factionAttackLogs.result,
				})
				.from(factionAttackLogs)
				.where(
					and(
						eq(factionAttackLogs.factionId, factionId),
						eq(factionAttackLogs.direction, "outgoing"),
						eq(factionAttackLogs.isRankedWar, true),
						eq(factionAttackLogs.defenderFactionId, context.opponentFactionId),
						gte(factionAttackLogs.startedAt, context.start),
					),
				);

			for (const row of rows) {
				if (row.attackerId === null) continue;
				if (!isLandedHit(row.result)) continue;
				state.counts.set(
					row.attackerId,
					(state.counts.get(row.attackerId) ?? 0) + 1,
				);
			}

			logger.info(
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
 * Broadcasts per-member hit counts per faction over IPC. An unchanged set is
 * suppressed so a quiet war produces no traffic.
 */
export function broadcastHitCounts(): void {
	const ipcServer = getActiveIpcServer();
	if (!ipcServer) return;

	const nowMs = Date.now();

	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const state = ensureState(factionId);
		if (state.warId === null) continue;

		const counts: Record<string, number> = {};
		for (const [playerId, count] of state.counts) {
			counts[String(playerId)] = count;
		}
		const signature = JSON.stringify(counts);
		if (signature === lastBroadcastSignature.get(factionId)) continue;

		const lastAt = lastBroadcastAtMs.get(factionId) ?? 0;
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

	// The war worker learns about new wars on its own cycle, so re-check the
	// engaged war periodically to catch a war starting (or ending) mid-flight.
	void hydrateFromDatabase().then(() => broadcastHitCounts());

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
