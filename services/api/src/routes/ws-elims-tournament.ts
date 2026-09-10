import { db, elimsTeams, sql } from "@sentinel/database";
import { getElimsKeyPool } from "@sentinel/torn-api";
import { Elysia, t } from "elysia";
import { getElimsAttackMatrixSnapshot } from "../lib/elims-attack-stats";

export async function getElimsTournamentSnapshot() {
	const teams = await db
		.select()
		.from(elimsTeams)
		.orderBy(elimsTeams.position, elimsTeams.id);

	// 1. Current hourly activity (most recent snapshot per team per hour)
	const curRows = await db.execute<{
		team_id: number;
		hour_tct: number;
		current_activity: number;
	}>(sql`
		SELECT DISTINCT ON (team_id, hour_tct)
			team_id,
			hour_tct,
			(CASE WHEN eliminated THEN 0 WHEN active_count > 0 THEN active_count ELSE GREATEST(0, attacks / 10) END)::int as current_activity
		FROM elims_team_snapshots
		ORDER BY team_id, hour_tct, captured_at DESC
	`);

	// 2. Average hourly activity (mean across all historical snapshots per team per hour)
	const avgRows = await db.execute<{
		team_id: number;
		hour_tct: number;
		avg_activity: number;
	}>(sql`
		SELECT 
			team_id, 
			hour_tct, 
			ROUND(AVG(CASE WHEN eliminated THEN 0 WHEN active_count > 0 THEN active_count ELSE GREATEST(0, attacks / 10) END))::int as avg_activity
		FROM elims_team_snapshots
		GROUP BY team_id, hour_tct
	`);

	// 3. Latest active member count per team
	const latestActiveRows = await db.execute<{
		team_id: number;
		active_count: number;
	}>(sql`
		SELECT DISTINCT ON (team_id)
			team_id,
			active_count
		FROM elims_team_snapshots
		ORDER BY team_id, captured_at DESC
	`);

	const teamLatestActiveMap = new Map<number, number>();
	for (const row of latestActiveRows) {
		teamLatestActiveMap.set(row.team_id, row.active_count);
	}

	const teamCurrentMap = new Map<number, number[]>();
	const teamAverageMap = new Map<number, number[]>();

	for (const t of teams) {
		teamCurrentMap.set(t.id, new Array(24).fill(0));
		teamAverageMap.set(t.id, new Array(24).fill(0));
	}

	for (const row of curRows) {
		const arr = teamCurrentMap.get(row.team_id);
		if (arr && row.hour_tct >= 0 && row.hour_tct < 24) {
			arr[row.hour_tct] = row.current_activity;
		}
	}

	for (const row of avgRows) {
		const arr = teamAverageMap.get(row.team_id);
		if (arr && row.hour_tct >= 0 && row.hour_tct < 24) {
			arr[row.hour_tct] = row.avg_activity;
		}
	}

	const benchmarkHourly = new Array(24).fill(0);
	const benchmarkCounts = new Array(24).fill(0);

	for (const row of avgRows) {
		if (row.hour_tct >= 0 && row.hour_tct < 24) {
			benchmarkHourly[row.hour_tct] =
				(benchmarkHourly[row.hour_tct] ?? 0) + row.avg_activity;
			benchmarkCounts[row.hour_tct] = (benchmarkCounts[row.hour_tct] ?? 0) + 1;
		}
	}

	for (let h = 0; h < 24; h++) {
		const c = benchmarkCounts[h] ?? 0;
		if (c > 0) {
			benchmarkHourly[h] = Math.round((benchmarkHourly[h] ?? 0) / c);
		}
	}

	const keyPool = await getElimsKeyPool();

	let totalCirculation = 0;
	let burnedTickets = 0;

	const teamReports = teams.map((team) => {
		if (team.eliminated) {
			burnedTickets += 1000;
		} else {
			totalCirculation += team.score;
		}

		const currentHours = teamCurrentMap.get(team.id) ?? new Array(24).fill(0);
		const averageHours = teamAverageMap.get(team.id) ?? new Array(24).fill(0);

		let minHour = 0;
		let maxHour = 0;
		let minVal = Number.POSITIVE_INFINITY;
		let maxVal = Number.NEGATIVE_INFINITY;
		let total = 0;

		for (let h = 0; h < 24; h++) {
			const val = averageHours[h] ?? 0;
			total += val;
			if (val > 0 && val < minVal) {
				minVal = val;
				minHour = h;
			}
			if (val > maxVal) {
				maxVal = val;
				maxHour = h;
			}
		}

		return {
			teamId: team.id,
			name: team.name,
			score: team.score,
			attacks:
				team.wins + team.losses > 0 ? team.wins + team.losses : team.attacks,
			membersCount: team.membersCount,
			activeCount:
				teamLatestActiveMap.get(team.id) ??
				(team.eliminated ? 0 : Math.round(team.membersCount * 0.2)),
			lives: team.lives,
			wins: team.wins,
			losses: team.losses,
			position: team.position,
			eliminated: team.eliminated,
			eliminatedTimestamp: team.eliminatedTimestamp?.toISOString() ?? null,
			isMock: team.isMock,
			hourlyDistribution: averageHours,
			currentHourly: currentHours,
			averageHourly: averageHours,
			leastActiveHour: minVal === Number.POSITIVE_INFINITY ? 0 : minHour,
			mostActiveHour: maxVal === Number.NEGATIVE_INFINITY ? 0 : maxHour,
			totalActivity: total,
			lastSyncedAt: team.lastSyncedAt?.toISOString() ?? null,
		};
	});

	return {
		type: "elims_snapshot",
		data: {
			teams: teamReports,
			benchmarkHourly,
			totalCirculation,
			burnedTickets,
			keyCount: keyPool.length,
			isMock: teams.some((t) => t.isMock),
			lastSyncedAt: teams[0]?.lastSyncedAt?.toISOString() ?? null,
		},
	};
}

const activeSockets = new Set<{ send: (msg: unknown) => void }>();

export function broadcastElimsTournamentState(data: unknown) {
	for (const ws of activeSockets) {
		try {
			ws.send(data);
		} catch {
			activeSockets.delete(ws);
		}
	}
}

// Push live state every 3 seconds to active WebSocket subscribers
setInterval(async () => {
	if (activeSockets.size > 0) {
		try {
			const snapshot = await getElimsTournamentSnapshot();
			broadcastElimsTournamentState(snapshot);
			const attackSnapshot = await getElimsAttackMatrixSnapshot();
			broadcastElimsTournamentState({
				type: "elims_attack_matrix",
				data: attackSnapshot,
			});
		} catch {
			// ignore broadcast errors
		}
	}
}, 3000);

export const wsElimsTournamentRoutes = new Elysia().ws(
	"/api/ws/elims-tournament",
	{
		body: t.Object({
			type: t.String(),
			timestamp: t.Optional(t.Number()),
			timeframe: t.Optional(t.String()),
		}),
		async open(ws) {
			activeSockets.add(ws as unknown as { send: (msg: unknown) => void });
			const snapshot = await getElimsTournamentSnapshot();
			ws.send(snapshot);
			const attackSnapshot = await getElimsAttackMatrixSnapshot();
			ws.send({
				type: "elims_attack_matrix",
				data: attackSnapshot,
			});
		},
		close(ws) {
			activeSockets.delete(ws as unknown as { send: (msg: unknown) => void });
		},
		async message(ws, message) {
			if (message.type === "ping") {
				ws.send({
					type: "pong",
					timestamp: message.timestamp ?? Date.now(),
				});
			} else if (message.type === "refresh") {
				const snapshot = await getElimsTournamentSnapshot();
				ws.send(snapshot);
				const attackSnapshot = await getElimsAttackMatrixSnapshot();
				ws.send({
					type: "elims_attack_matrix",
					data: attackSnapshot,
				});
			} else if (message.type === "get_attack_matrix") {
				const tf = (message.timeframe as "all" | "24h" | "1h") ?? "all";
				const attackSnapshot = await getElimsAttackMatrixSnapshot(tf);
				ws.send({
					type: "elims_attack_matrix",
					data: attackSnapshot,
				});
			}
		},
	},
);
