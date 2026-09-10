import { db, elimsTeamAttacks, gt } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import type { TornEliminationPlayerApiItem } from "./team-tracker";

const logger = new Logger("Scheduler", "ElimsAttackAnalyzer");

// Regex to capture attacker name from status.details (handling plain text or HTML link)
// e.g. "Hospitalized by JohnDoe", "Hospitalized by <a href=...>JohnDoe</a>", "Attacked by Jane"
const ATTACKER_REGEX = /\bby\s+(?:<a\b[^>]*>)?([^<]+?)(?:<\/a>)?$/i;

export interface AttackAnalysisSnapshot {
	capturedAt: Date;
	teamPlayersMap: Map<number, Map<number, TornEliminationPlayerApiItem>>;
}

export interface ActiveHospitalStay {
	attackerName: string;
	initialUntil: number;
	lastSeenUntil: number;
}

export interface TournamentPlayerRef {
	id: number;
	teamId: number;
	name: string;
}

// In-memory active hospital stays: victimId -> ActiveHospitalStay
// Preserved across cycles and hydrated from DB on boot to survive service restarts
const activeHospitalStays = new Map<number, ActiveHospitalStay>();
let isHydrated = false;

/**
 * Hydrates active hospital stays from the database on startup.
 * Any recorded attack where hospital_until is still in the future (or within the last hour)
 * is registered as an active stay so restarts do not trigger duplicate attack counts.
 */
export async function hydrateActiveHospitalStays(): Promise<void> {
	if (isHydrated) return;

	try {
		const nowSec = Math.floor(Date.now() / 1000);
		// Fetch attacks recorded whose hospital timer is still active or recent (last 60 mins)
		const recentAttacks = await db
			.select({
				victimId: elimsTeamAttacks.victimId,
				attackerName: elimsTeamAttacks.attackerName,
				hospitalUntil: elimsTeamAttacks.hospitalUntil,
			})
			.from(elimsTeamAttacks)
			.where(gt(elimsTeamAttacks.hospitalUntil, nowSec - 3600));

		for (const att of recentAttacks) {
			const existing = activeHospitalStays.get(att.victimId);
			if (!existing || att.hospitalUntil > existing.lastSeenUntil) {
				activeHospitalStays.set(att.victimId, {
					attackerName: att.attackerName,
					initialUntil: att.hospitalUntil,
					lastSeenUntil: att.hospitalUntil,
				});
			}
		}

		isHydrated = true;
		logger.info(
			`Hydrated ${activeHospitalStays.size} active hospital stays from database.`,
		);
	} catch (err) {
		logger.error("Failed to hydrate active hospital stays from DB:", err);
		// Mark hydrated anyway so we don't spam DB queries on error
		isHydrated = true;
	}
}

/**
 * Parses attacker candidate name from player status details.
 * Discards stealth attacks ("by someone") or non-attack hospital details.
 */
export function extractAttackerName(
	details: string | null | undefined,
): string | null {
	if (!details) return null;

	const trimmed = details.trim();
	const match = trimmed.match(ATTACKER_REGEX);
	if (!match) return null;

	const candidate = match[1]?.trim();
	if (!candidate) return null;

	// Ignore stealth attacks ("by someone")
	if (candidate.toLowerCase() === "someone") {
		return null;
	}

	return candidate;
}

/**
 * Core processing function for an elimination snapshot.
 * Compares current states against active hospital tracking, detects new attacks,
 * and handles players medding down or leaving hospital.
 */
export async function processAttackSnapshot(
	snapshot: AttackAnalysisSnapshot,
): Promise<{ detectedCount: number; stealthCount: number }> {
	await hydrateActiveHospitalStays();

	// 1. Build fast case-insensitive participant lookup map: name.toLowerCase() -> TournamentPlayerRef
	const playerLookup = new Map<string, TournamentPlayerRef>();
	const allPlayers: Array<{
		player: TornEliminationPlayerApiItem;
		teamId: number;
	}> = [];

	for (const [teamId, playersMap] of snapshot.teamPlayersMap.entries()) {
		for (const player of playersMap.values()) {
			playerLookup.set(player.name.toLowerCase(), {
				id: player.id,
				teamId,
				name: player.name,
			});
			allPlayers.push({ player, teamId });
		}
	}

	let detectedCount = 0;
	let stealthCount = 0;
	const newAttacksToInsert: Array<{
		attackerId: number;
		attackerName: string;
		attackerTeamId: number;
		victimId: number;
		victimName: string;
		victimTeamId: number;
		hospitalUntil: number;
		details: string | null;
		detectedAt: Date;
	}> = [];

	// 2. Scan all players for hospital status changes
	for (const { player, teamId: victimTeamId } of allPlayers) {
		const victimId = player.id;
		const isHospital = player.status?.state === "Hospital";

		if (!isHospital) {
			// Player is NOT in hospital: clear active stay if they previously were hospitalized
			// (handles medding out, discharging, or revives)
			if (activeHospitalStays.has(victimId)) {
				activeHospitalStays.delete(victimId);
			}
			continue;
		}

		// Player IS in hospital
		const details = player.status?.details ?? null;
		const until = player.status?.until ?? 0;

		// Check if stealth attack
		if (details && /\bby\s+someone\b/i.test(details)) {
			stealthCount++;
			continue;
		}

		const attackerCandidate = extractAttackerName(details);
		if (!attackerCandidate) {
			continue;
		}

		// Look up attacker in tournament participants
		const attackerRef = playerLookup.get(attackerCandidate.toLowerCase());
		if (!attackerRef) {
			// Attacker is not in any elimination team (outsider, bounty hunter, etc.) -> discard
			continue;
		}

		// Discard friendly fire / self-inflicted if any
		if (attackerRef.teamId === victimTeamId) {
			continue;
		}

		const existingStay = activeHospitalStays.get(victimId);

		if (existingStay) {
			const isSameAttacker =
				existingStay.attackerName.toLowerCase() ===
				attackerCandidate.toLowerCase();

			// If same attacker and until <= lastSeenUntil:
			// The victim is still in hospital from the SAME attack, or used medical items (until decreased)
			if (isSameAttacker && until <= existingStay.lastSeenUntil) {
				// Update lastSeenUntil to track medical item reductions
				existingStay.lastSeenUntil = until;
				continue;
			}

			// If until increased significantly (> 60s higher) or attacker changed:
			// The player was discharged/revived and attacked again in between cycles!
			if (until > existingStay.lastSeenUntil + 60 || !isSameAttacker) {
				// Record new attack
				existingStay.attackerName = attackerRef.name;
				existingStay.initialUntil = until;
				existingStay.lastSeenUntil = until;

				newAttacksToInsert.push({
					attackerId: attackerRef.id,
					attackerName: attackerRef.name,
					attackerTeamId: attackerRef.teamId,
					victimId,
					victimName: player.name,
					victimTeamId,
					hospitalUntil: until,
					details,
					detectedAt: snapshot.capturedAt,
				});
				detectedCount++;
			}
		} else {
			// Brand new hospitalization
			activeHospitalStays.set(victimId, {
				attackerName: attackerRef.name,
				initialUntil: until,
				lastSeenUntil: until,
			});

			newAttacksToInsert.push({
				attackerId: attackerRef.id,
				attackerName: attackerRef.name,
				attackerTeamId: attackerRef.teamId,
				victimId,
				victimName: player.name,
				victimTeamId,
				hospitalUntil: until,
				details,
				detectedAt: snapshot.capturedAt,
			});
			detectedCount++;
		}
	}

	// 3. Batch insert newly detected attacks into Postgres
	if (newAttacksToInsert.length > 0) {
		try {
			const CHUNK_SIZE = 100;
			for (let i = 0; i < newAttacksToInsert.length; i += CHUNK_SIZE) {
				const chunk = newAttacksToInsert.slice(i, i + CHUNK_SIZE);
				await db
					.insert(elimsTeamAttacks)
					.values(chunk)
					.onConflictDoNothing({
						target: [elimsTeamAttacks.victimId, elimsTeamAttacks.hospitalUntil],
					});
			}

			logger.info(
				`Logged ${newAttacksToInsert.length} new elimination attacks to database.`,
			);
		} catch (err) {
			logger.error("Failed to insert elimination attacks to database:", err);
		}
	}

	return { detectedCount, stealthCount };
}

// ─── ASYNCHRONOUS NON-BLOCKING QUEUE RUNNER ─────────────────────────────────
let isProcessingQueue = false;
let pendingSnapshot: AttackAnalysisSnapshot | null = null;

async function drainQueue(): Promise<void> {
	if (isProcessingQueue) return;
	isProcessingQueue = true;

	try {
		while (pendingSnapshot !== null) {
			const current = pendingSnapshot;
			pendingSnapshot = null; // Clear so subsequent updates can queue up

			const start = Date.now();
			const result = await processAttackSnapshot(current);
			const duration = Date.now() - start;

			logger.debug(
				`Attack snapshot processed in ${duration}ms: ${result.detectedCount} new attacks detected, ${result.stealthCount} stealth ignored.`,
			);
		}
	} catch (err) {
		logger.error("Error processing queued attack snapshot:", err);
	} finally {
		isProcessingQueue = false;
	}
}

/**
 * Enqueues a tournament player snapshot for non-blocking asynchronous analysis.
 * team-tracker.ts calls this function and immediately continues without awaiting.
 */
export function queueAttackAnalysis(snapshot: AttackAnalysisSnapshot): void {
	// If a newer snapshot arrives while one is already processing, pendingSnapshot is updated
	// to the freshest live data, avoiding stale backlog builds.
	pendingSnapshot = snapshot;
	// Fire drainQueue asynchronously without blocking the caller
	queueMicrotask(() => {
		drainQueue().catch((err) => {
			logger.error("drainQueue background error:", err);
		});
	});
}

/**
 * Helper to reset in-memory state (used by test suites).
 */
export function _resetAttackAnalyzerState(): void {
	activeHospitalStays.clear();
	isHydrated = false;
	pendingSnapshot = null;
	isProcessingQueue = false;
}
