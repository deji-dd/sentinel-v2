import {
	db,
	elimsTeamPlayers,
	elimsTeamSnapshots,
	elimsTeams,
	eq,
	sql,
} from "@sentinel/database";
import {
	getElimsKeyPool,
	type ManagedApiKey,
	TornError,
	tornApi,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { ScheduledRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import { queueAttackAnalysis } from "./attack-analyzer";

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
 * Helper to reset in-memory state (used by test suites).
 */
export function _resetSimulationInMemoryState(): void {
	lastCode32CheckTime = 0;
}

/**
 * Fetches base tournament overview from /torn/elimination
 * Uses the key pool with failover to ensure authoritative team standings and participant counts are retrieved.
 * Returns array of teams if succeeded, or null on failure.
 */
async function syncEliminationBaseData(
	keys: ManagedApiKey[],
): Promise<TornEliminationTeamItem[] | null> {
	const maxTries = Math.min(3, keys.length);
	for (let i = 0; i < maxTries; i++) {
		const keyEntry = keys[i];
		if (!keyEntry) continue;

		try {
			const res = (await tornApi.get("/torn/elimination", {
				apiKey: keyEntry.apiKey,
				userId: keyEntry.userId,
			})) as TornEliminationTeamsResponse;

			if (res.elimination && Array.isArray(res.elimination)) {
				const teams = res.elimination;
				const now = new Date();

				for (const t of teams) {
					const teamId = t.id;
					const elimTimestamp = t.eliminated_timestamp
						? new Date(t.eliminated_timestamp * 1000)
						: null;

					const totalAttacks = (t.wins ?? 0) + (t.losses ?? 0);
					await db
						.insert(elimsTeams)
						.values({
							id: teamId,
							name: t.name ?? DEFAULT_TEAM_NAMES[teamId] ?? `Team ${teamId}`,
							membersCount: t.participants ?? 0,
							position: t.position ?? 1,
							score: t.score ?? 0,
							attacks: totalAttacks,
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
								membersCount: t.participants ?? 0,
								position: t.position ?? 1,
								score: t.eliminated
									? (t.score ?? 0)
									: t.score && t.score > 0
										? t.score
										: sql`CASE WHEN elims_teams.score > 0 THEN elims_teams.score ELSE ${t.score ?? 0} END`,
								attacks:
									totalAttacks > 0 ? totalAttacks : sql`elims_teams.attacks`,
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
				return teams;
			}
		} catch (err) {
			if (err instanceof TornError && err.code === 32) {
				throw err;
			}
			logger.warn(
				`Failed fetching /torn/elimination base standings with key (attempt ${i + 1}/${maxTries}):`,
				err,
			);
		}
	}
	return null;
}

/**
 * Main elimination tracking iteration.
 * Checks live Torn API; if closed with code 32, pauses for 5 minutes.
 * Performs base standings checks and live team player collection when open.
 */
export async function runElimsTrackingCycle(): Promise<number> {
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

	// 1. Sync authoritative base elimination team standings (/torn/elimination) BEFORE team collection
	let baseTeams: TornEliminationTeamItem[] | null = null;
	try {
		baseTeams = await syncEliminationBaseData(keys);
	} catch (err) {
		if (err instanceof TornError && err.code === 32) {
			lastCode32CheckTime = Date.now();
			logger.info(
				"Torn Elimination API is closed (Code 32: Closed until attacking period starts). Pausing live checks for 5m...",
			);
			return lastCode32CheckTime + CODE_32_BACKOFF_MS;
		}
	}

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

		// Probe succeeded without error: live API is active
	} catch (err) {
		if (err instanceof TornError && err.code === 32) {
			lastCode32CheckTime = Date.now();
			logger.info(
				"Torn Elimination API is closed (Code 32: Closed until attacking period starts). Pausing live checks for 5m...",
			);
			return lastCode32CheckTime + CODE_32_BACKOFF_MS;
		}

		// If it's a key error or other transient error, log and continue to live collection attempt
		logger.warn("Live API probe warning:", err);
	}

	// ─── LIVE PARALLEL BATCH COLLECTION ─────────────────────────────────────────
	const teamCountMap = new Map<number, number>();
	if (baseTeams && baseTeams.length > 0) {
		for (const t of baseTeams) {
			teamCountMap.set(t.id, t.participants);
		}
	}

	interface TeamPageQuery {
		teamId: number;
		offset: number;
	}

	const queries: TeamPageQuery[] = [];
	for (const teamId of ELIMS_TEAM_IDS) {
		let participants = teamCountMap.get(teamId);
		if (participants === undefined || participants <= 0) {
			const dbTeam = await db.query.elimsTeams.findFirst({
				where: eq(elimsTeams.id, teamId),
			});
			participants =
				dbTeam?.membersCount && dbTeam.membersCount > 0
					? dbTeam.membersCount
					: 2500;
		}

		// Dynamically calculate page count based on live participants count + 1 buffer page
		const pageCount = Math.ceil(participants / 100) + 1;
		for (let p = 0; p < pageCount; p++) {
			queries.push({
				teamId,
				offset: p * 100,
			});
		}
	}

	logger.info(
		`Dispatching ${queries.length} parallel requests across ${keys.length} keys for ${ELIMS_TEAM_IDS.length} elimination teams...`,
	);
	const startTime = Date.now();

	const results = await tornApi.executeBatchSettled(
		"/torn/{id}/eliminationteam",
		queries,
		(q) => ({
			pathParams: { id: q.teamId },
			queryParams: { limit: 100, offset: q.offset },
		}),
		keys,
	);

	// Detect Code 32 if attacking period closed mid-flight
	for (const r of results) {
		if (
			r.status === "rejected" &&
			r.reason instanceof TornError &&
			r.reason.code === 32
		) {
			lastCode32CheckTime = Date.now();
			logger.info(
				"Torn Elimination API closed during batch pagination (code 32). Pausing live checks for 5m.",
			);
			return lastCode32CheckTime + CODE_32_BACKOFF_MS;
		}
	}

	const teamPlayersMap = new Map<
		number,
		Map<number, TornEliminationPlayerApiItem>
	>();
	for (const teamId of ELIMS_TEAM_IDS) {
		teamPlayersMap.set(teamId, new Map());
	}

	let totalCallsExecuted = 0;
	for (let i = 0; i < queries.length; i++) {
		const query = queries[i];
		const result = results[i];
		if (!query || !result) continue;

		if (result.status === "fulfilled") {
			totalCallsExecuted++;
			const data = result.value as TornEliminationResponse;
			const players = data.eliminationteam ?? [];
			const map = teamPlayersMap.get(query.teamId);
			if (map) {
				for (const p of players) {
					map.set(p.id, p);
				}
			}
		} else {
			logger.warn(
				`Failed fetching page for team ${query.teamId} at offset ${query.offset}:`,
				result.reason,
			);
		}
	}

	const nowCapture = new Date();
	const currentHourTct = nowCapture.getUTCHours();

	// Asynchronously offload attack analysis without awaiting to keep team tracker non-blocking
	queueAttackAnalysis({
		capturedAt: nowCapture,
		teamPlayersMap,
	});

	for (const teamId of ELIMS_TEAM_IDS) {
		const playersMap = teamPlayersMap.get(teamId);
		const uniquePlayers = playersMap ? Array.from(playersMap.values()) : [];

		let teamTotalAttacks = 0;
		let teamActiveCount = 0;

		for (const p of uniquePlayers) {
			teamTotalAttacks += p.attacks ?? 0;
			if (
				p.last_action?.status === "Online" ||
				p.last_action?.status === "Idle"
			) {
				teamActiveCount++;
			}
		}

		// Bulk upsert players in chunks of 500
		if (uniquePlayers.length > 0) {
			const CHUNK_SIZE = 500;
			for (let c = 0; c < uniquePlayers.length; c += CHUNK_SIZE) {
				const chunk = uniquePlayers.slice(c, c + CHUNK_SIZE);
				await db
					.insert(elimsTeamPlayers)
					.values(
						chunk.map((p) => ({
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
						})),
					)
					.onConflictDoUpdate({
						target: elimsTeamPlayers.id,
						set: {
							name: sql`excluded.name`,
							level: sql`excluded.level`,
							score: sql`excluded.score`,
							attacks: sql`excluded.attacks`,
							lastAction: sql`excluded.last_action`,
							status: sql`excluded.status`,
							isMock: false,
							updatedAt: nowCapture,
						},
					});
			}
		}

		// Update team record
		await db
			.insert(elimsTeams)
			.values({
				id: teamId,
				name: DEFAULT_TEAM_NAMES[teamId] ?? `Team ${teamId}`,
				score: 0,
				attacks: teamTotalAttacks,
				membersCount: uniquePlayers.length,
				isMock: false,
				lastSyncedAt: nowCapture,
			})
			.onConflictDoUpdate({
				target: elimsTeams.id,
				set: {
					attacks: sql`CASE WHEN (elims_teams.wins + elims_teams.losses) > 0 THEN (elims_teams.wins + elims_teams.losses) ELSE ${teamTotalAttacks} END`,
					membersCount:
						uniquePlayers.length > 0
							? uniquePlayers.length
							: sql`elims_teams.members_count`,
					isMock: false,
					lastSyncedAt: nowCapture,
					updatedAt: nowCapture,
				},
			});

		const existingTeam = await db.query.elimsTeams.findFirst({
			where: eq(elimsTeams.id, teamId),
		});

		const totalAttacks =
			(existingTeam?.wins ?? 0) + (existingTeam?.losses ?? 0) > 0
				? (existingTeam?.wins ?? 0) + (existingTeam?.losses ?? 0)
				: teamTotalAttacks;

		// Insert snapshot for hourly distribution tracking
		await db.insert(elimsTeamSnapshots).values({
			teamId,
			score: existingTeam?.score ?? 0,
			attacks: totalAttacks,
			membersCount:
				uniquePlayers.length > 0
					? uniquePlayers.length
					: (existingTeam?.membersCount ?? 0),
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
	const dynamicCadenceMs = Math.max(3_000, Math.ceil(estimatedDurationMs));

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
