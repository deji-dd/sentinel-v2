import { Logger, SUBVERSIVE_FAMILY_FACTION_IDS } from "@sentinel/utils";
import { ATTACK_FEED_CADENCE_MS } from "../../lib/attack-feed-cadence";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import type { FactionAttackEvent } from "../merc/faction-attack-feed-worker";
import { loadRecentAttacks } from "../merc/faction-attack-feed-worker";
import { isCurrentWarOpponent } from "./ranked-war-worker";

const logger = new Logger("Scheduler", "RetalTracker");

/** Strict window: an attacker must have struck us within the last 5 minutes. */
export const RETAL_WINDOW_SECONDS = 300;
/**
 * Retal state expires on its own cadence, independent of the attack feed. Kept
 * at the fastest feed tier so a badge disappears within one poll of its 5m
 * window closing, even when the feed itself has backed off.
 */
const RETAL_BROADCAST_INTERVAL_MS = ATTACK_FEED_CADENCE_MS.both;

/**
 * In-memory attacker -> most recent attack timestamp (unix seconds) per family
 * faction. Rebuilt from `faction_attack_logs` on boot so a restart does not lose
 * an in-flight retal window.
 */
const lastAttackByFaction = new Map<number, Map<number, number>>();
const lastBroadcastAtMs = new Map<number, number>();
const lastBroadcastSignature = new Map<number, string>();

function ensureMap(factionId: number): Map<number, number> {
	let map = lastAttackByFaction.get(factionId);
	if (!map) {
		map = new Map();
		lastAttackByFaction.set(factionId, map);
	}
	return map;
}

/**
 * The timestamp an attack counts as having landed. An attack still in progress
 * has no `endedAt`; its attacker is mid-retal right now, so `startedAt` is used.
 */
export function resolveRetalTimestamp(attack: {
	endedAt: number | null;
	startedAt: number | null;
}): number {
	return attack.endedAt ?? attack.startedAt ?? 0;
}

/**
 * Whether a single attack marks its attacker as a retal target.
 *
 * Scoping is enforced up front: only incoming attacks count, the defender must
 * belong to the family faction we track, and the attack must fall strictly
 * inside the window. Hitting someone is not being retaliated against.
 */
export function qualifiesAsRetal(
	attack: {
		direction: string;
		defenderFactionId: number | null;
		attackerId: number | null;
		endedAt: number | null;
		startedAt: number | null;
	},
	factionId: number,
	nowSec: number,
): boolean {
	if (attack.direction !== "incoming") return false;
	if (attack.attackerId === null || attack.attackerId <= 0) return false;
	if (attack.defenderFactionId !== factionId) return false;

	const timestamp = resolveRetalTimestamp(attack);
	if (timestamp <= 0) return false;

	const ageSec = nowSec - timestamp;
	// Strictly inside the window: an attack exactly 300s old has expired.
	return ageSec >= 0 && ageSec < RETAL_WINDOW_SECONDS;
}

function recordAttack(attack: FactionAttackEvent, nowSec: number): void {
	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		if (!qualifiesAsRetal(attack, factionId, nowSec)) continue;
		const map = ensureMap(factionId);
		const timestamp = resolveRetalTimestamp(attack);
		const attackerId = attack.attackerId as number;
		const existing = map.get(attackerId);
		// Keep the newest hit so a replayed page cannot age an attacker out.
		if (existing === undefined || timestamp > existing) {
			map.set(attackerId, timestamp);
		}
	}
}

/** Drops entries that have aged past the strict window. */
function pruneExpired(factionId: number, nowSec: number): Map<number, number> {
	const map = ensureMap(factionId);
	for (const [attackerId, timestamp] of map) {
		if (nowSec - timestamp >= RETAL_WINDOW_SECONDS) {
			map.delete(attackerId);
		}
	}
	return map;
}

/**
 * Resolves the live retal set for one faction: strictly-within-window attackers
 * that are also members of the faction's current ranked war opponent.
 *
 * The opponent intersection is what makes the badge meaningful — without it any
 * player who ever attacked a member would qualify.
 */
export function resolveRetalIds(factionId: number, nowSec: number): number[] {
	const map = pruneExpired(factionId, nowSec);
	if (map.size === 0) return [];

	const ids: number[] = [];
	for (const attackerId of map.keys()) {
		if (isCurrentWarOpponent(factionId, attackerId)) {
			ids.push(attackerId);
		}
	}
	return ids.sort((a, b) => a - b);
}

/**
 * Broadcasts retal state per family faction over IPC. A repeat of the previous
 * set is suppressed so a quiet war produces no traffic, but an emptied set is
 * always broadcast because that is what clears existing badges.
 */
export function broadcastRetalState(nowSec: number): void {
	const ipcServer = getActiveIpcServer();
	if (!ipcServer) return;

	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		const retalIds = resolveRetalIds(factionId, nowSec);
		const signature = retalIds.join(",");
		const previousSignature = lastBroadcastSignature.get(factionId);
		const hasBroadcastBefore = lastBroadcastAtMs.has(factionId);
		const lastAt = lastBroadcastAtMs.get(factionId) ?? 0;

		if (retalIds.length === 0) {
			// Nothing to clear if we have never sent a non-empty set for this faction.
			if (!hasBroadcastBefore || previousSignature === "") continue;
		} else if (signature === previousSignature) {
			continue;
		} else if (
			hasBroadcastBefore &&
			nowSec * 1000 - lastAt < RETAL_BROADCAST_INTERVAL_MS
		) {
			continue;
		}

		lastBroadcastAtMs.set(factionId, nowSec * 1000);
		lastBroadcastSignature.set(factionId, signature);

		ipcServer.broadcast({
			action: "subversive_retal_updated",
			data: { factionId, retalIds, updatedAt: Date.now() },
		});
	}
}

/**
 * Warms the in-memory windows from durable history so a restarted scheduler
 * still knows about attacks that landed in the last 5 minutes.
 */
async function hydrateFromDatabase(): Promise<void> {
	const nowSec = Math.floor(Date.now() / 1000);
	const sinceSec = nowSec - RETAL_WINDOW_SECONDS;

	for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
		try {
			const rows = await loadRecentAttacks(factionId, sinceSec);
			for (const row of rows) {
				recordAttack(
					{
						attackId: row.attackId,
						factionId,
						direction: row.direction as FactionAttackEvent["direction"],
						attackerId: row.attackerId,
						attackerName: row.attackerName,
						attackerFactionId: row.attackerFactionId,
						attackerFactionName: row.attackerFactionName,
						defenderId: row.defenderId,
						defenderName: row.defenderName,
						defenderFactionId: row.defenderFactionId,
						defenderFactionName: row.defenderFactionName,
						result: row.result,
						attackCode: row.attackCode,
						isRankedWar: row.isRankedWar,
						isStricken: row.isStricken,
						startedAt: row.startedAt,
						endedAt: row.endedAt,
					},
					nowSec,
				);
			}
		} catch (err) {
			logger.warn(
				`Failed hydrating retal tracker for faction ${factionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	logger.info("Retal tracker hydrated from faction attack history.");
}

let isSubscriptionActive = false;
let expiryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the retal tracker: subscribes to the shared attack feed and publishes
 * which war opponents have struck a family member in the last 5 minutes.
 */
export function startRetalTracker(): void {
	if (isSubscriptionActive) return;
	isSubscriptionActive = true;

	schedulerEvents.on(
		"faction_attacks_ingested",
		(attacks: FactionAttackEvent[]) => {
			const nowSec = Math.floor(Date.now() / 1000);
			for (const attack of attacks) recordAttack(attack, nowSec);
			broadcastRetalState(nowSec);
		},
	);

	void hydrateFromDatabase().then(() => {
		broadcastRetalState(Math.floor(Date.now() / 1000));
	});

	// Expiry must keep running even with no new attacks, otherwise a stale
	// attacker would keep their badge until the next hit arrives.
	expiryTimer = setInterval(() => {
		broadcastRetalState(Math.floor(Date.now() / 1000));
	}, RETAL_BROADCAST_INTERVAL_MS);
	expiryTimer.unref?.();

	logger.info(
		`Retal tracker started with a ${RETAL_WINDOW_SECONDS}s strict window.`,
	);
}

/** Test seam: clears all in-memory retal state. */
export function resetRetalTracker(): void {
	lastAttackByFaction.clear();
	lastBroadcastAtMs.clear();
	lastBroadcastSignature.clear();
}

/** Test seam: stops the expiry timer and unsubscribes. */
export function stopRetalTracker(): void {
	if (expiryTimer) {
		clearInterval(expiryTimer);
		expiryTimer = null;
	}
	isSubscriptionActive = false;
}
