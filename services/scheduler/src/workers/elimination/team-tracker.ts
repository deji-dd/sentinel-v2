import {
	count,
	db,
	elimsTeamPlayers,
	elimsTeamSnapshots,
	elimsTeams,
	eq,
	inArray,
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
const CODE_32_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes backoff for live API
const MOCK_CADENCE_MS = 5 * 1000; // 5s cadence for mock cycle
let isMockMode = false;
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
 * Wipes all mock data from the database once live API is accessible.
 */
async function wipeMockData(): Promise<void> {
	try {
		await db
			.delete(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.isMock, true));
		await db.delete(elimsTeamPlayers).where(eq(elimsTeamPlayers.isMock, true));
		await db.delete(elimsTeams).where(eq(elimsTeams.isMock, true));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, ELIMS_SIMULATION_STATE_ID));
		mockPlayersSeeded = false;
		simulatedTeams.clear();
		mockCycleCount = 0;
		lastCode32CheckTime = 0;
		lastLifeDropTime = 0;
		logger.info(
			"Successfully purged mock elimination data after live API became active.",
		);
	} catch (err) {
		logger.error("Failed to purge mock elimination data:", err);
	}
}

/**
 * Helper to reset in-memory caches (used by test suites to simulate process restarts).
 */
export function _resetSimulationInMemoryState(): void {
	simulatedTeams.clear();
	mockPlayersSeeded = false;
	mockCycleCount = 0;
	lastCode32CheckTime = 0;
	lastLifeDropTime = 0;
}

const MEMBERS_PER_TEAM_MOCK = 2000;
let mockPlayersSeeded = false;
let mockCycleCount = 0;

/**
 * Fetches base tournament overview from /torn/elimination
 * Returns true if succeeded.
 */
async function syncEliminationBaseData(
	apiKey: string,
	userId: number,
): Promise<boolean> {
	try {
		// biome-ignore lint/suspicious/noExplicitAny: /torn/elimination is a valid public OpenAPI route
		const res = (await tornApi.get("/torn/elimination" as any, {
			apiKey,
			userId,
		})) as TornEliminationTeamsResponse;

		const teams = res.elimination ?? [];
		if (teams.length > 0) {
			const now = new Date();
			for (const t of teams) {
				const officialName =
					t.name || DEFAULT_TEAM_NAMES[t.id] || `Team ${t.id}`;
				await db
					.insert(elimsTeams)
					.values({
						id: t.id,
						name: officialName,
						score: t.score ?? 0,
						attacks: 0,
						membersCount: t.participants ?? 0,
						lives: t.lives ?? 50,
						wins: t.wins ?? 0,
						losses: t.losses ?? 0,
						position: t.position ?? 0,
						eliminated: t.eliminated ?? false,
						eliminatedTimestamp: t.eliminated_timestamp
							? new Date(t.eliminated_timestamp * 1000)
							: null,
						leaders: t.leaders,
						isMock: false,
						lastSyncedAt: now,
					})
					.onConflictDoUpdate({
						target: elimsTeams.id,
						set: {
							name: officialName,
							membersCount: t.participants ?? 0,
							lives: t.lives ?? 50,
							wins: t.wins ?? 0,
							losses: t.losses ?? 0,
							position: t.position ?? 0,
							eliminated: t.eliminated ?? false,
							eliminatedTimestamp: t.eliminated_timestamp
								? new Date(t.eliminated_timestamp * 1000)
								: null,
							leaders: t.leaders,
							lastSyncedAt: now,
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

interface SimulatedTeamState {
	id: number;
	name: string;
	tickets: number; // 1,000 initial
	lives: number; // 50 initial
	wins: number;
	losses: number;
	attacks: number;
	eliminated: boolean;
	eliminatedTimestamp: Date | null;
	position: number;
}

const simulatedTeams = new Map<number, SimulatedTeamState>();
export const MOCK_LIFE_DROP_INTERVAL_MS = 15 * 60 * 1000; // Strictly 15 real minutes per Torn tournament rules
let lastLifeDropTime = 0;

/**
 * Initializes or loads stateful elimination tournament simulation data.
 * Survives restarts by restoring state from `systemStates` and `elimsTeams`.
 */
async function initializeSimulationState(): Promise<void> {
	if (simulatedTeams.size > 0) return;

	// 1. Restore simulation metadata (cycle count, probe backoff, life drop timer) from systemStates
	const [simState] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, ELIMS_SIMULATION_STATE_ID));

	if (simState?.data && typeof simState.data === "object") {
		const data = simState.data as Record<string, unknown>;
		if (typeof data.mockCycleCount === "number") {
			mockCycleCount = data.mockCycleCount;
		}
		if (typeof data.lastCode32CheckTime === "number") {
			lastCode32CheckTime = data.lastCode32CheckTime;
		}
		if (typeof data.lastLifeDropTime === "number") {
			lastLifeDropTime = data.lastLifeDropTime;
		}
	}

	if (lastLifeDropTime === 0) {
		lastLifeDropTime = Date.now();
	}

	// 2. Restore teams from database if previously persisted
	const existingTeams = await db
		.select()
		.from(elimsTeams)
		.where(inArray(elimsTeams.id, ELIMS_TEAM_IDS));

	if (existingTeams.length === ELIMS_TEAM_IDS.length) {
		let activeCount = 0;
		let elimCount = 0;
		for (const t of existingTeams) {
			if (t.eliminated) {
				elimCount++;
			} else {
				activeCount++;
			}
			simulatedTeams.set(t.id, {
				id: t.id,
				name: t.name || DEFAULT_TEAM_NAMES[t.id] || `Team ${t.id}`,
				tickets: t.score,
				lives: t.lives,
				wins: t.wins,
				losses: t.losses,
				attacks: t.attacks,
				eliminated: t.eliminated,
				eliminatedTimestamp: t.eliminatedTimestamp,
				position: t.position,
			});
		}
		logger.info(
			`[ElimsTeamTracker] Resumed simulation state from database (cycle #${mockCycleCount}: ${activeCount} active teams, ${elimCount} eliminated).`,
		);
		return;
	}

	// 3. Fallback: Initialize 12 fresh teams (1,000 tickets each, 50 lives)
	for (const teamId of ELIMS_TEAM_IDS) {
		simulatedTeams.set(teamId, {
			id: teamId,
			name: DEFAULT_TEAM_NAMES[teamId] ?? `Team ${teamId}`,
			tickets: 1000,
			lives: 50,
			wins: 0,
			losses: 0,
			attacks: 0,
			eliminated: false,
			eliminatedTimestamp: null,
			position: 1,
		});
	}
	logger.info(
		"Initialized simulation state: 12 teams with 1,000 tickets each (12,000 total pool) and 50 lives.",
	);
}

/**
 * Runs a mock-live tournament cycle matching Torn's official Elimination rules:
 * - 12,000 tickets total in circulation (1,000 per team initially).
 * - Each attack swaps 1 ticket from loser to winner.
 * - Every evaluation interval, the team with the lowest tickets loses 1 life based on strict tie-breakers:
 *   1. Fewest tickets -> 2. Fewest wins -> 3. Most losses -> 4. Fewest lives.
 * - When lives reach 0, team is eliminated and their tickets are removed from circulation.
 * - Snapshots accumulate live for the current moment (no fake 24-hour pre-seeding).
 */
async function runMockCycle(): Promise<number> {
	isMockMode = true;
	mockCycleCount++;
	const cycleStart = Date.now();
	const currentHourTct = new Date().getUTCHours();
	const now = new Date();

	await initializeSimulationState();

	// 1. Initial bulk seed of 2,000 member roster if not yet present
	if (!mockPlayersSeeded) {
		const [existingMockPlayers] = await db
			.select({ count: count() })
			.from(elimsTeamPlayers)
			.where(eq(elimsTeamPlayers.isMock, true));

		if (
			(existingMockPlayers?.count ?? 0) <
			ELIMS_TEAM_IDS.length * MEMBERS_PER_TEAM_MOCK
		) {
			logger.info(
				`Seeding ${MEMBERS_PER_TEAM_MOCK} mock members per team (${ELIMS_TEAM_IDS.length * MEMBERS_PER_TEAM_MOCK} total)...`,
			);

			const BATCH_SIZE = 1000;
			let batch: (typeof elimsTeamPlayers.$inferInsert)[] = [];

			for (const teamId of ELIMS_TEAM_IDS) {
				const baseTeamName = DEFAULT_TEAM_NAMES[teamId] ?? `Team ${teamId}`;

				for (let i = 1; i <= MEMBERS_PER_TEAM_MOCK; i++) {
					const playerId = teamId * 100000 + i;
					const isOnline = (playerId + currentHourTct) % 4 === 0;
					const isHospital = !isOnline && playerId % 7 === 0;
					const attacks = Math.max(0, (i % 25) + (currentHourTct % 5));

					batch.push({
						id: playerId,
						teamId,
						name: `${baseTeamName} #${i}`,
						level: 15 + (i % 85),
						score: attacks * 10,
						attacks,
						lastAction: {
							status: isOnline ? "Online" : i % 2 === 0 ? "Idle" : "Offline",
							timestamp: Math.floor(now.getTime() / 1000) - (i % 86400),
							relative: "recently",
						},
						status: {
							description: isHospital ? "Hospitalized" : "Okay",
							details: null,
							state: isHospital ? "Hospital" : "Okay",
							color: isHospital ? "red" : "green",
							until: isHospital
								? Math.floor(now.getTime() / 1000) + 1800
								: null,
						},
						isMock: true,
						updatedAt: now,
					});

					if (batch.length >= BATCH_SIZE) {
						await db
							.insert(elimsTeamPlayers)
							.values(batch)
							.onConflictDoNothing();
						batch = [];
					}
				}
			}

			if (batch.length > 0) {
				await db.insert(elimsTeamPlayers).values(batch).onConflictDoNothing();
			}
			logger.info("Mock members seeding complete.");
		}
		mockPlayersSeeded = true;
	}

	const aliveTeams = Array.from(simulatedTeams.values()).filter(
		(t) => !t.eliminated,
	);

	// 2. Simulate Attacks and Ticket Swapping between alive teams
	if (aliveTeams.length > 1) {
		for (const team of aliveTeams) {
			// Attack volume per team based on member count
			const attacksToRun = 3 + Math.floor(Math.random() * 5);
			for (let a = 0; a < attacksToRun; a++) {
				const availableOpponents = aliveTeams.filter(
					(opp) => opp.id !== team.id && opp.tickets > 0,
				);
				if (availableOpponents.length === 0) break;

				const target =
					availableOpponents[
						Math.floor(Math.random() * availableOpponents.length)
					];
				if (!target || target.tickets <= 0) continue;

				// 1 ticket stolen from losing team to winning team
				target.tickets -= 1;
				team.tickets += 1;
				team.wins += 1;
				target.losses += 1;
				team.attacks += 1;
			}
		}
	}

	// 3. Life Drop Evaluation: strictly once every 15 real minutes (per official Torn rules)
	if (
		lastLifeDropTime > 0 &&
		now.getTime() - lastLifeDropTime >= MOCK_LIFE_DROP_INTERVAL_MS &&
		aliveTeams.length > 1
	) {
		lastLifeDropTime = now.getTime();
		// Tie-Breaker Order: 1. Fewest tickets -> 2. Fewest wins -> 3. Most losses -> 4. Fewest lives
		const sortedForLoser = [...aliveTeams].sort((a, b) => {
			if (a.tickets !== b.tickets) return a.tickets - b.tickets;
			if (a.wins !== b.wins) return a.wins - b.wins;
			if (a.losses !== b.losses) return b.losses - a.losses;
			return a.lives - b.lives;
		});

		const bottomTeam = sortedForLoser[0];
		if (bottomTeam) {
			bottomTeam.lives -= 1;
			logger.info(
				`[Life Drop Evaluation (15m Interval)] Team '${bottomTeam.name}' has lowest standing (${bottomTeam.tickets} tickets, ${bottomTeam.wins}W/${bottomTeam.losses}L) and loses 1 life (${bottomTeam.lives}/50 remaining). Next evaluation in 15m.`,
			);

			if (bottomTeam.lives <= 0) {
				bottomTeam.lives = 0;
				bottomTeam.eliminated = true;
				bottomTeam.eliminatedTimestamp = now;
				const burnedTickets = bottomTeam.tickets;
				bottomTeam.tickets = 0; // Tickets burned upon elimination!
				logger.warn(
					`[TEAM ELIMINATED] '${bottomTeam.name}' reached 0 lives and is ELIMINATED! ${burnedTickets} tickets removed from circulation.`,
				);
			}
		}
	}

	// 4. Rank / Position calculation across all teams
	const allTeams = Array.from(simulatedTeams.values());
	const rankedAlive = allTeams
		.filter((t) => !t.eliminated)
		.sort((a, b) => {
			if (b.tickets !== a.tickets) return b.tickets - a.tickets;
			if (b.wins !== a.wins) return b.wins - a.wins;
			if (a.losses !== b.losses) return a.losses - b.losses;
			return b.lives - a.lives;
		});
	const rankedEliminated = allTeams
		.filter((t) => t.eliminated)
		.sort((a, b) => {
			const timeA = a.eliminatedTimestamp?.getTime() ?? 0;
			const timeB = b.eliminatedTimestamp?.getTime() ?? 0;
			return timeB - timeA;
		});

	const fullRankings = [...rankedAlive, ...rankedEliminated];
	for (let pos = 0; pos < fullRankings.length; pos++) {
		const item = fullRankings[pos];
		if (item) {
			item.position = pos + 1;
		}
	}

	// 5. Persist updated state to elimsTeams and record live snapshot for NOW
	for (const team of allTeams) {
		const activeCount = team.eliminated
			? 0
			: Math.round(MEMBERS_PER_TEAM_MOCK * (0.18 + (team.id % 4) * 0.04));

		await db
			.insert(elimsTeams)
			.values({
				id: team.id,
				name: team.name,
				score: team.tickets, // Score = Tickets
				attacks: team.attacks,
				membersCount: MEMBERS_PER_TEAM_MOCK,
				lives: team.lives,
				wins: team.wins,
				losses: team.losses,
				position: team.position,
				eliminated: team.eliminated,
				eliminatedTimestamp: team.eliminatedTimestamp,
				isMock: true,
				lastSyncedAt: now,
			})
			.onConflictDoUpdate({
				target: elimsTeams.id,
				set: {
					name: team.name,
					score: team.tickets,
					attacks: team.attacks,
					membersCount: MEMBERS_PER_TEAM_MOCK,
					lives: team.lives,
					wins: team.wins,
					losses: team.losses,
					position: team.position,
					eliminated: team.eliminated,
					eliminatedTimestamp: team.eliminatedTimestamp,
					isMock: true,
					lastSyncedAt: now,
					updatedAt: now,
				},
			});

		// Insert real-time snapshot for the current moment (no fake 24h baseline seeding)
		await db.insert(elimsTeamSnapshots).values({
			teamId: team.id,
			score: team.tickets,
			attacks: team.attacks,
			membersCount: MEMBERS_PER_TEAM_MOCK,
			activeCount,
			lives: team.lives,
			position: team.position,
			eliminated: team.eliminated,
			hourTct: currentHourTct,
			isMock: true,
			capturedAt: now,
		});
	}

	// Persist simulation state metadata so cycle count and timers survive process restarts
	await db
		.insert(systemStates)
		.values({
			id: ELIMS_SIMULATION_STATE_ID,
			init: true,
			data: {
				mockCycleCount,
				lastCode32CheckTime,
				lastLifeDropTime,
				updatedAt: now.toISOString(),
			},
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: systemStates.id,
			set: {
				data: {
					mockCycleCount,
					lastCode32CheckTime,
					lastLifeDropTime,
					updatedAt: now.toISOString(),
				},
				updatedAt: now,
			},
		});

	const totalCirculation = allTeams.reduce((sum, t) => sum + t.tickets, 0);
	const activeRemaining = allTeams.filter((t) => !t.eliminated).length;

	logger.info(
		`[Mock Cycle #${mockCycleCount}] Updated 12 teams in ${Date.now() - cycleStart}ms | Tickets in circulation: ${totalCirculation.toLocaleString()}/12,000 | Active teams: ${activeRemaining}/12. Next in 5s.`,
	);

	return Date.now() + MOCK_CADENCE_MS;
}

/**
 * Main elimination tracking iteration.
 * Checks live Torn API; if closed with code 32, falls back to 5-minute backoff for live calls
 * while running mock cycle on 5s cadence. When live API opens, clears mock data and stores live data.
 */
export async function runElimsTrackingCycle(): Promise<number> {
	await initializeSimulationState();
	const now = Date.now();
	const keys = await getElimsKeyPool();

	// If within Code 32 backoff period, run mock cycle on short cadence
	if (now - lastCode32CheckTime < CODE_32_BACKOFF_MS) {
		return runMockCycle();
	}

	// Probe live API to check if attacking period has started
	if (keys.length > 0) {
		const probeKey = keys[0]?.apiKey ?? "";
		const probeUserId = keys[0]?.userId ?? 0;

		// 1. Sync authoritative base elimination team standings (/torn/elimination)
		await syncEliminationBaseData(probeKey, probeUserId);

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

			// If probe succeeded without error, live API is active!
			if (isMockMode) {
				logger.info(
					"Live Torn Elimination API is OPEN! Purging mock data and starting live collection.",
				);
				await wipeMockData();
				isMockMode = false;
			}
		} catch (err) {
			if (err instanceof TornError && err.code === 32) {
				lastCode32CheckTime = Date.now();
				logger.info(
					"Torn Elimination API is closed (Code 32: Closed until attacking period starts). Backing off live checks for 5m. Running mock cycle (5s cadence)...",
				);
				return runMockCycle();
			}

			// If it's a key error or other transient error, log and continue to live collection attempt
			logger.warn("Live API probe warning:", err);
		}
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
						"Torn Elimination API closed during pagination (code 32). Switching to mock cycle.",
					);
					return runMockCycle();
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
