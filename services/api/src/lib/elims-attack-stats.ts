import {
	and,
	count,
	db,
	desc,
	elimsTeamAttacks,
	elimsTeams,
	gte,
} from "@sentinel/database";

export interface TeamAttackBreakdownItem {
	teamId: number;
	teamName: string;
	count: number;
	percentage: number;
}

export interface TeamAttackBreakdown {
	teamId: number;
	teamName: string;
	incoming: {
		total: number;
		byTeam: TeamAttackBreakdownItem[];
	};
	outgoing: {
		total: number;
		byTeam: TeamAttackBreakdownItem[];
	};
	topThreat: TeamAttackBreakdownItem | null;
	topTarget: TeamAttackBreakdownItem | null;
}

export interface RecentAttackItem {
	id: string;
	attackerId: number;
	attackerName: string;
	attackerTeamId: number;
	attackerTeamName: string;
	victimId: number;
	victimName: string;
	victimTeamId: number;
	victimTeamName: string;
	details: string | null;
	detectedAt: string;
}

export type ElimsAttackMatrixTimeframe = "all" | "24h" | "12h" | "1h";

export interface AttackMatrixSnapshot {
	teams: Array<{
		id: number;
		name: string;
		lives: number;
		score: number;
		position: number;
		eliminated: boolean;
	}>;
	matrix: Record<number, Record<number, number>>;
	teamBreakdowns: Record<number, TeamAttackBreakdown>;
	recentAttacks: RecentAttackItem[];
	totalRecordedAttacks: number;
	timeframe: ElimsAttackMatrixTimeframe;
}

export async function getElimsAttackMatrixSnapshot(
	timeframe: ElimsAttackMatrixTimeframe = "all",
): Promise<AttackMatrixSnapshot> {
	let minDate: Date | null = null;
	if (timeframe === "1h") {
		minDate = new Date(Date.now() - 60 * 60 * 1000);
	} else if (timeframe === "12h") {
		minDate = new Date(Date.now() - 12 * 60 * 60 * 1000);
	} else if (timeframe === "24h") {
		minDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
	}

	// 1. Fetch all teams
	const teams = await db.select().from(elimsTeams).orderBy(elimsTeams.id);
	const teamNameMap = new Map<number, string>();
	for (const t of teams) {
		teamNameMap.set(t.id, t.name);
	}

	// 2. Fetch attacks aggregation
	const conditions = minDate ? [gte(elimsTeamAttacks.detectedAt, minDate)] : [];

	const matrixCounts = await db
		.select({
			attackerTeamId: elimsTeamAttacks.attackerTeamId,
			victimTeamId: elimsTeamAttacks.victimTeamId,
			attackCount: count(),
		})
		.from(elimsTeamAttacks)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.groupBy(elimsTeamAttacks.attackerTeamId, elimsTeamAttacks.victimTeamId);

	// Initialize 12x12 matrix
	const matrix: Record<number, Record<number, number>> = {};
	for (const t1 of teams) {
		const row: Record<number, number> = {};
		for (const t2 of teams) {
			row[t2.id] = 0;
		}
		matrix[t1.id] = row;
	}

	let totalRecordedAttacks = 0;
	for (const row of matrixCounts) {
		const teamRow = matrix[row.attackerTeamId];
		if (teamRow && row.victimTeamId in teamRow) {
			teamRow[row.victimTeamId] = row.attackCount;
		}
		totalRecordedAttacks += row.attackCount;
	}

	// Build per-team breakdown (incoming vs outgoing)
	const teamBreakdowns: Record<number, TeamAttackBreakdown> = {};

	for (const t of teams) {
		const teamId = t.id;
		const teamName = t.name;

		// Outgoing: attacks launched by teamId
		let totalOutgoing = 0;
		const outgoingList: Array<{
			teamId: number;
			teamName: string;
			count: number;
		}> = [];

		// Incoming: attacks received by teamId
		let totalIncoming = 0;
		const incomingList: Array<{
			teamId: number;
			teamName: string;
			count: number;
		}> = [];

		for (const other of teams) {
			if (other.id === teamId) continue;

			const outCount = matrix[teamId]?.[other.id] ?? 0;
			if (outCount > 0) {
				totalOutgoing += outCount;
				outgoingList.push({
					teamId: other.id,
					teamName: other.name,
					count: outCount,
				});
			}

			const inCount = matrix[other.id]?.[teamId] ?? 0;
			if (inCount > 0) {
				totalIncoming += inCount;
				incomingList.push({
					teamId: other.id,
					teamName: other.name,
					count: inCount,
				});
			}
		}

		outgoingList.sort((a, b) => b.count - a.count);
		incomingList.sort((a, b) => b.count - a.count);

		const outgoingByTeam = outgoingList.map((item) => ({
			...item,
			percentage:
				totalOutgoing > 0
					? Math.round((item.count / totalOutgoing) * 1000) / 10
					: 0,
		}));

		const incomingByTeam = incomingList.map((item) => ({
			...item,
			percentage:
				totalIncoming > 0
					? Math.round((item.count / totalIncoming) * 1000) / 10
					: 0,
		}));

		const topThreat = incomingByTeam[0] ?? null;
		const topTarget = outgoingByTeam[0] ?? null;

		teamBreakdowns[teamId] = {
			teamId,
			teamName,
			incoming: {
				total: totalIncoming,
				byTeam: incomingByTeam,
			},
			outgoing: {
				total: totalOutgoing,
				byTeam: outgoingByTeam,
			},
			topThreat,
			topTarget,
		};
	}

	// 3. Fetch up to 25 recent attacks for the live ticker
	const recentRaw = await db
		.select({
			id: elimsTeamAttacks.id,
			attackerId: elimsTeamAttacks.attackerId,
			attackerName: elimsTeamAttacks.attackerName,
			attackerTeamId: elimsTeamAttacks.attackerTeamId,
			victimId: elimsTeamAttacks.victimId,
			victimName: elimsTeamAttacks.victimName,
			victimTeamId: elimsTeamAttacks.victimTeamId,
			details: elimsTeamAttacks.details,
			detectedAt: elimsTeamAttacks.detectedAt,
		})
		.from(elimsTeamAttacks)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(elimsTeamAttacks.detectedAt))
		.limit(25);

	const recentAttacks = recentRaw.map((r) => ({
		id: r.id,
		attackerId: r.attackerId,
		attackerName: r.attackerName,
		attackerTeamId: r.attackerTeamId,
		attackerTeamName:
			teamNameMap.get(r.attackerTeamId) ?? `Team ${r.attackerTeamId}`,
		victimId: r.victimId,
		victimName: r.victimName,
		victimTeamId: r.victimTeamId,
		victimTeamName: teamNameMap.get(r.victimTeamId) ?? `Team ${r.victimTeamId}`,
		details: r.details,
		detectedAt: r.detectedAt.toISOString(),
	}));

	return {
		teams: teams.map((t) => ({
			id: t.id,
			name: t.name,
			lives: t.lives,
			score: t.score,
			position: t.position,
			eliminated: t.eliminated,
		})),
		matrix,
		teamBreakdowns,
		recentAttacks,
		totalRecordedAttacks,
		timeframe,
	};
}
