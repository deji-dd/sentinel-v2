import {
	db,
	elimsTeamPlayers,
	elimsTeamSnapshots,
	elimsTeams,
	eq,
	systemStates,
} from "@sentinel/database";
import { getElimsKeyPool, TornError, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { ScheduledRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";

const logger = new Logger("Scheduler", "ElimsTeamTracker");

export const ELIMS_TEAM_IDS = [70, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90];
export const ELIMS_SIMULATION_STATE_ID = "elims:simulation_state";

export const DEFAULT_TEAM_NAMES: Record<number, string> = {
	70: "Brain Surgeons",
	80: "Conspiracy Theorists",
	81: "Inanimate Objects",
	82: "Gold Dust",
	83: "Reptilians",
	84: "Rocket Scientists",
	85: "Sticks and Stones",
	86: "APEX",
	87: "Touching Grass",
	88: "Nine Lives",
	89: "High Voltage",
	90: "Loose Cannons",
};

export interface TornEliminationTeamItem {
	id: number;
	name: string;
	participants: number;
	position: number;
	score: number;
	lives: number;
	wins: number;
	losses: number;
	eliminated: boolean;
	eliminated_timestamp: number | null;
	leaders?: unknown;
}

export interface TornEliminationTeamsResponse {
	elimination?: TornEliminationTeamItem[];
}

let lastCode32CheckTime = 0;
export const CODE_32_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes backoff when API is closed
let lastTotalCalls = ELIMS_TEAM_IDS.length * 20; // estimate ~240 calls

export interface TornEliminationPlayerApiItem {
	id: number;
	name: string;
	level: number;
	last_action?: {
		status: "Online" | "Idle" | "Offline";
		timestamp: number;
		relative: string;
	};
	status?: {
		description: string;
		details: string | null;
		state: string;
		color: string;
		until: number | null;
		plane_image_type?: string;
	};
	attacks?: number;
	score?: number;
}

interface TornEliminationResponse {
	eliminationteam?: TornEliminationPlayerApiItem[];
	_metadata?: {
		links?: {
			next: string | null;
			prev: string | null;
		};
	};
}

/**
 * Wipes all mock data from the database once live API is accessible or during cleanups.
 */
export async function wipeMockData(): Promise<void> {
	try {
		await db
			.delete(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.isMock, true));
		await db.delete(elimsTeamPlayers).where(eq(elimsTeamPlayers.isMock, true));
		await db.delete(elimsTeams).where(eq(elimsTeams.isMock, true));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, ELIMS_SIMULATION_STATE_ID));
		logger.info("Successfully purged mock elimination data from database.");
	} catch (err) {
		logger.error("Failed to purge mock elimination data:", err);
	}
}

/**
 * Helper to reset in-memory state (used by test suites).
 */
export function _resetSimulationInMemoryState(): void {
	lastCode32CheckTime = 0;
}

/**
 * Fetches base tournament overview from /torn/elimination
 * Returns true if succeeded.
 */
async function syncEliminationBaseData(
	probeKey: string,
	probeUserId: number,
): Promise<boolean> {
	try {
		const res = (await tornApi.get("/torn/elimination", {
			apiKey: probeKey,
			userId: probeUserId,
		})) as TornEliminationTeamsResponse;

		if (res.elimination && Array.isArray(res.elimination)) {
			const teams = res.elimination;
			const now = new Date();

			for (const t of teams) {
				const teamId = t.id;
				const elimTimestamp = t.eliminated_timestamp
					? new Date(t.eliminated_timestamp * 1000)
					: null;

				await db
					.insert(elimsTeams)
					.values({
						id: teamId,
						name: t.name ?? DEFAULT_TEAM_NAMES[teamId] ?? `Team ${teamId}`,
						participants: t.participants ?? 0,
						position: t.position ?? 1,
						score: t.score ?? 0,
						lives: t.lives ?? 0,
						wins: t.wins ?? 0,
						losses: t.losses ?? 0,
						eliminated: t.eliminated ?? false,
						eliminatedTimestamp: elimTimestamp,
						isMock: false,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: elimsTeams.id,
						set: {
							name: t.name ?? DEFAULT_TEAM_NAMES[teamId] ?? `Team ${teamId}`,
							participants: t.participants ?? 0,
							position: t.position ?? 1,
							score: t.score ?? 0,
							lives: t.lives ?? 0,
							wins: t.wins ?? 0,
							losses: t.losses ?? 0,
							eliminated: t.eliminated ?? false,
							eliminatedTimestamp: elimTimestamp,
							isMock: false,
							updatedAt: now,
						},
					});
			}
			logger.info(
				`Synced base metadata for ${teams.length} elimination teams from /torn/elimination.`,
			);
			return true;
		}
	} catch (err) {
		logger.warn("Failed fetching /torn/elimination base standings:", err);
	}
	return false;
}

/**
 * Main elimination tracking iteration.
 * Checks live Torn API; if closed with code 32, pauses for 5 minutes.
 * Performs base standings checks and live team player collection when open.
 */
export async function runElimsTrackingCycle(): Promise<number> {
	// 0. Auto-purge any residual mock or simulation data
	await wipeMockData();

	const now = Date.now();

	// If within Code 32 backoff period, pause checks
	if (now - lastCode32CheckTime < CODE_32_BACKOFF_MS) {
		return lastCode32CheckTime + CODE_32_BACKOFF_MS;
	}

	const keys = await getElimsKeyPool();

	if (keys.length === 0) {
		logger.warn(
			"No active elimination keys available. Pausing for 5 minutes...",
		);
		return Date.now() + CODE_32_BACKOFF_MS;
	}

	const probeKey = keys[0]?.apiKey ?? "";
	const probeUserId = keys[0]?.userId ?? 0;

	// 1. Sync authoritative base elimination team standings (/torn/elimination)
	await syncEliminationBaseData(probeKey, probeUserId);

	// 2. Probe live API to check if attacking period has started
	try {
		logger.info(
			"Probing live Torn API (/torn/70/eliminationteam) for attacking period status...",
		);
		await tornApi.get("/torn/{id}/eliminationteam", {
			pathParams: { id: 70 },
			queryParams: { limit: 1 },
			apiKey: probeKey,
			userId: probeUserId,
		});

		// If probe succeeded without error, live API is active! Purge any leftover mock data
		await wipeMockData();
	} catch (err) {
		if (err instanceof TornError && err.code === 32) {
			lastCode32CheckTime = Date.now();
			logger.info(
				"Torn Elimination API is closed (Code 32: Closed until attacking period starts). Pausing live checks for 5m...",
			);
			await wipeMockData();
			return lastCode32CheckTime + CODE_32_BACKOFF_MS;
		}

		// If it's a key error or other transient error, log and continue to live collection attempt
		logger.warn("Live API probe warning:", err);
	}

	// ─── LIVE COLLECTION ────────────────────────────────────────────────────────
	logger.info(
		`Beginning live collection across ${ELIMS_TEAM_IDS.length} elimination teams...`,
	);
	const startTime = Date.now();
	let totalCallsExecuted = 0;
	const currentHourTct = new Date().getUTCHours();

	for (const teamId of ELIMS_TEAM_IDS) {
		let offset = 0;
		let hasMore = true;
		let teamTotalScore = 0;
		let teamTotalAttacks = 0;
		let teamPlayerCount = 0;
		let teamActiveCount = 0;
		const nowCapture = new Date();

		while (hasMore) {
			try {
				const res = (await tornApi.get("/torn/{id}/eliminationteam", {
					pathParams: { id: teamId },
					queryParams: { limit: 100, offset },
				})) as TornEliminationResponse;

				totalCallsExecuted++;

				const players = res.eliminationteam ?? [];
				if (players.length === 0) {
					hasMore = false;
					break;
				}

				teamPlayerCount += players.length;

				for (const p of players) {
					teamTotalScore += p.score ?? 0;
					teamTotalAttacks += p.attacks ?? 0;
					if (
						p.last_action?.status === "Online" ||
						p.last_action?.status === "Idle"
					) {
						teamActiveCount++;
					}

					await db
						.insert(elimsTeamPlayers)
						.values({
							id: p.id,
							teamId,
							name: p.name,
							level: p.level,
							score: p.score ?? 0,
							attacks: p.attacks ?? 0,
							lastAction: p.last_action,
							status: p.status,
							isMock: false,
							updatedAt: nowCapture,
						})
						.onConflictDoUpdate({
							target: elimsTeamPlayers.id,
							set: {
								name: p.name,
								level: p.level,
								score: p.score ?? 0,
								attacks: p.attacks ?? 0,
								lastAction: p.last_action,
								status: p.status,
								isMock: false,
								updatedAt: nowCapture,
							},
						});
				}

				const nextLink = res._metadata?.links?.next;
				if (!nextLink || players.length < 100) {
					hasMore = false;
				} else {
					offset += players.length;
				}
			} catch (err) {
				if (err instanceof TornError && err.code === 32) {
					lastCode32CheckTime = Date.now();
					logger.info(
						"Torn Elimination API closed during pagination (code 32). Pausing live checks for 5m.",
					);
					return lastCode32CheckTime + CODE_32_BACKOFF_MS;
				}
				logger.error(
					`Failed fetching page for team ${teamId} at offset ${offset}:`,
					err,
				);
				hasMore = false;
			}
		}

		// Update team record
		await db
			.insert(elimsTeams)
			.values({
				id: teamId,
				name: DEFAULT_TEAM_NAMES[teamId] ?? `Team ${teamId}`,
				score: teamTotalScore,
				attacks: teamTotalAttacks,
				membersCount: teamPlayerCount,
				isMock: false,
				lastSyncedAt: nowCapture,
			})
			.onConflictDoUpdate({
				target: elimsTeams.id,
				set: {
					score: teamTotalScore,
					attacks: teamTotalAttacks,
					membersCount: teamPlayerCount,
					isMock: false,
					lastSyncedAt: nowCapture,
					updatedAt: nowCapture,
				},
			});

		const existingTeam = await db.query.elimsTeams.findFirst({
			where: eq(elimsTeams.id, teamId),
		});

		// Insert snapshot for hourly distribution tracking
		await db.insert(elimsTeamSnapshots).values({
			teamId,
			score: teamTotalScore,
			attacks: teamTotalAttacks,
			membersCount: teamPlayerCount,
			activeCount: teamActiveCount,
			lives: existingTeam?.lives ?? 50,
			position: existingTeam?.position ?? 0,
			eliminated: existingTeam?.eliminated ?? false,
			hourTct: currentHourTct,
			isMock: false,
			capturedAt: nowCapture,
		});
	}

	lastTotalCalls = Math.max(12, totalCallsExecuted);

	// ─── DYNAMIC CADENCE CALCULATION ───────────────────────────────────────────
	// Recalculates dynamically based on active key pool count and calls executed
	const activeKeys = await getElimsKeyPool();
	const keyCount = Math.max(1, activeKeys.length);
	const rateLimitPerKey = 50; // calls per minute per key
	const totalThroughputPerSec = (keyCount * rateLimitPerKey) / 60;
	const estimatedDurationMs = (lastTotalCalls / totalThroughputPerSec) * 1000;
	const dynamicCadenceMs = Math.max(15_000, Math.ceil(estimatedDurationMs));

	logger.info(
		`Live cycle complete in ${Date.now() - startTime}ms (${totalCallsExecuted} API calls across ${keyCount} keys). Next cadence: ${Math.round(dynamicCadenceMs / 1000)}s.`,
	);

	return Date.now() + dynamicCadenceMs;
}

export const startElimsTeamTracker: WorkerStarter = (options?: {
	initialDelayMs?: number;
}) => {
	const runner = new ScheduledRunner({
		worker: "elims_team_tracker",
		defaultCadenceSeconds: 30,
		initialDelayMs: options?.initialDelayMs ?? 1000,
		handler: runElimsTrackingCycle,
	});

	runner.start().catch((err) => {
		logger.error("Failed to start Elims Team Tracker worker:", err);
	});
};
