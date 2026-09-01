import {
	and,
	asc,
	battlestatsLedgers,
	count,
	db,
	desc,
	eq,
	gte,
	inArray,
	like,
	lte,
	or,
	personalLogs,
	type SQL,
	sql,
	systemStates,
	tornGyms,
} from "@sentinel/database";
import { STAT_GAIN_LOG_IDS } from "@sentinel/utils";
import { Elysia, t } from "elysia";

import { requestBattlestatsLedgerReinitialize } from "../../lib/scheduler-ipc";

export async function getBattlestatsLedgerStateObject() {
	const [record] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, "personal:battlestats_ledger"));

	const [totals] = await db
		.select({
			totalInDb: count(battlestatsLedgers.id),
			totalStatGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
			totalTrains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
			totalEnergyUsed: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
			minTimestamp: sql<number | null>`min(${battlestatsLedgers.timestamp})`,
			maxTimestamp: sql<number | null>`max(${battlestatsLedgers.timestamp})`,
		})
		.from(battlestatsLedgers);

	const [personalLogsCount] = await db
		.select({ count: count(personalLogs.id) })
		.from(personalLogs)
		.where(inArray(personalLogs.log, STAT_GAIN_LOG_IDS));

	const statTypeRows = await db
		.select({
			statType: battlestatsLedgers.statType,
			count: count(battlestatsLedgers.id),
			gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
			trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
			energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
		})
		.from(battlestatsLedgers)
		.groupBy(battlestatsLedgers.statType);

	const sourceRows = await db
		.select({
			source: battlestatsLedgers.source,
			count: count(battlestatsLedgers.id),
			gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
			trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
			energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
		})
		.from(battlestatsLedgers)
		.groupBy(battlestatsLedgers.source);

	const rawData = (record?.data as Record<string, unknown> | undefined) ?? {};
	const allTimeTotalGained = Number(totals?.totalStatGained ?? 0);

	const allTimeStats = statTypeRows.map((st) => {
		const stCount = Number(st.count);
		const stGained = Number(st.gained);
		const stEnergy = Number(st.energy);
		const stTrains = Number(st.trains);
		const efficiency =
			stEnergy > 0 ? Number((stGained / stEnergy).toFixed(2)) : 0;
		const percentage =
			allTimeTotalGained > 0
				? Number(((stGained / allTimeTotalGained) * 100).toFixed(1))
				: 0;

		return {
			statType: st.statType,
			count: stCount,
			gained: stGained,
			trains: stTrains,
			energy: stEnergy,
			efficiency,
			percentage,
		};
	});

	const allTimeSources = sourceRows.map((src) => {
		const srcCount = Number(src.count);
		const srcGained = Number(src.gained);
		const srcEnergy = Number(src.energy);
		const srcTrains = Number(src.trains);
		const percentage =
			allTimeTotalGained > 0
				? Number(((srcGained / allTimeTotalGained) * 100).toFixed(1))
				: 0;

		return {
			source: src.source,
			count: srcCount,
			gained: srcGained,
			trains: srcTrains,
			energy: srcEnergy,
			percentage,
		};
	});

	return {
		status: (rawData.status as string) ?? "idle",
		totalIndexedLogs: Number(
			rawData.totalIndexedLogs ?? totals?.totalInDb ?? 0,
		),
		lastProcessedTimestamp:
			(rawData.lastProcessedTimestamp as number | null) ?? null,
		lastError: (rawData.lastError as string | null) ?? null,
		updatedAt:
			(rawData.updatedAt as string) ??
			(record?.updatedAt
				? new Date(record.updatedAt).toISOString()
				: new Date().toISOString()),
		totalInDb: totals?.totalInDb ?? 0,
		totalStatGained: allTimeTotalGained,
		totalTrains: Number(totals?.totalTrains ?? 0),
		totalEnergyUsed: Number(totals?.totalEnergyUsed ?? 0),
		overallEfficiency:
			Number(totals?.totalEnergyUsed ?? 0) > 0
				? Number(
						(allTimeTotalGained / Number(totals?.totalEnergyUsed ?? 1)).toFixed(
							2,
						),
					)
				: 0,
		totalPersonalLogsCount: personalLogsCount?.count ?? 0,
		dbOldestDate: totals?.minTimestamp
			? new Date(
					typeof totals.minTimestamp === "number" && totals.minTimestamp < 1e11
						? totals.minTimestamp * 1000
						: totals.minTimestamp,
				).toISOString()
			: null,
		dbNewestDate: totals?.maxTimestamp
			? new Date(
					typeof totals.maxTimestamp === "number" && totals.maxTimestamp < 1e11
						? totals.maxTimestamp * 1000
						: totals.maxTimestamp,
				).toISOString()
			: null,
		allTimeStats,
		allTimeSources,
	};
}

export const battlestatsLedgerRoutes = new Elysia({
	prefix: "/battlestats-ledger",
})
	// GET /api/v1/system/battlestats-ledger/state
	.get(
		"/state",
		async () => {
			return getBattlestatsLedgerStateObject();
		},
		{
			detail: {
				summary: "Get Battlestats Ledger State",
				description:
					"Returns the synchronization status, overall stat gains, efficiency, and database bounds.",
			},
		},
	)
	// GET /api/v1/system/battlestats-ledger/logs — paginated logs
	.get(
		"/logs",
		async ({ query }) => {
			const page = Math.max(1, Number(query.page ?? 1) || 1);
			const pageSize = Math.min(
				Math.max(1, Number(query.pageSize ?? 50) || 50),
				100,
			);
			const offset = (page - 1) * pageSize;

			const conditions: SQL[] = [];

			if (query.statType && query.statType !== "all") {
				conditions.push(eq(battlestatsLedgers.statType, query.statType));
			}

			if (query.source && query.source !== "all") {
				conditions.push(eq(battlestatsLedgers.source, query.source));
			}

			if (query.date) {
				const dayStart = new Date(`${query.date}T00:00:00Z`);
				const dayEnd = new Date(`${query.date}T23:59:59Z`);
				if (
					!Number.isNaN(dayStart.getTime()) &&
					!Number.isNaN(dayEnd.getTime())
				) {
					conditions.push(
						and(
							gte(battlestatsLedgers.timestamp, dayStart),
							lte(battlestatsLedgers.timestamp, dayEnd),
						) as SQL,
					);
				}
			} else if (query.from || query.to) {
				if (query.from) {
					const fromDate = new Date(
						query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
					);
					if (!Number.isNaN(fromDate.getTime())) {
						conditions.push(gte(battlestatsLedgers.timestamp, fromDate) as SQL);
					}
				}
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						conditions.push(lte(battlestatsLedgers.timestamp, toDate) as SQL);
					}
				}
			} else if (query.days && query.days !== "all") {
				const numDays = Math.max(1, Number(query.days) || 30);
				const now = new Date();
				const todayUtcStart = new Date(
					Date.UTC(
						now.getUTCFullYear(),
						now.getUTCMonth(),
						now.getUTCDate(),
						0,
						0,
						0,
					),
				);
				const cutoff = new Date(
					todayUtcStart.getTime() - (numDays - 1) * 86400 * 1000,
				);
				conditions.push(gte(battlestatsLedgers.timestamp, cutoff) as SQL);
			}

			if (query.search) {
				const pattern = `%${query.search.trim()}%`;
				conditions.push(
					or(
						like(battlestatsLedgers.id, pattern),
						like(battlestatsLedgers.statType, pattern),
						like(battlestatsLedgers.source, pattern),
					) as SQL,
				);
			}

			if (query.minGain) {
				const minG = Number(query.minGain);
				if (!Number.isNaN(minG)) {
					conditions.push(gte(battlestatsLedgers.statGained, minG));
				}
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			let orderByClause: SQL = desc(battlestatsLedgers.timestamp);

			if (query.sortBy === "timestamp") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.timestamp)
						: desc(battlestatsLedgers.timestamp);
			} else if (query.sortBy === "statGained") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.statGained)
						: desc(battlestatsLedgers.statGained);
			} else if (query.sortBy === "statType") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.statType)
						: desc(battlestatsLedgers.statType);
			} else if (query.sortBy === "energyUsed") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.energyUsed)
						: desc(battlestatsLedgers.energyUsed);
			} else if (query.sortBy === "statBefore") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.statBefore)
						: desc(battlestatsLedgers.statBefore);
			} else if (query.sortBy === "statAfter") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.statAfter)
						: desc(battlestatsLedgers.statAfter);
			}

			const [[totalCountResult], rows] = await Promise.all([
				db
					.select({ count: count(battlestatsLedgers.id) })
					.from(battlestatsLedgers)
					.where(whereClause),
				db
					.select()
					.from(battlestatsLedgers)
					.where(whereClause)
					.orderBy(orderByClause)
					.limit(pageSize)
					.offset(offset),
			]);

			const total = totalCountResult?.count ?? 0;
			const totalPages = Math.ceil(total / pageSize);

			return {
				items: rows.map((r) => ({
					id: r.id,
					timestamp:
						r.timestamp instanceof Date
							? r.timestamp.toISOString()
							: new Date(r.timestamp).toISOString(),
					statType: r.statType,
					source: r.source,
					trains: r.trains,
					energyUsed: r.energyUsed,
					statGained: r.statGained,
					statBefore: r.statBefore,
					statAfter: r.statAfter,
					gainPerEnergy:
						(r.energyUsed ?? 0) > 0
							? Number((r.statGained / (r.energyUsed ?? 1)).toFixed(2))
							: null,
				})),
				pagination: {
					page,
					pageSize,
					total,
					totalPages,
					hasNextPage: page < totalPages,
					hasPrevPage: page > 1,
				},
			};
		},
		{
			query: t.Object({
				page: t.Optional(t.String()),
				pageSize: t.Optional(t.String()),
				date: t.Optional(t.String()),
				days: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				statType: t.Optional(t.String()),
				source: t.Optional(t.String()),
				search: t.Optional(t.String()),
				minGain: t.Optional(t.String()),
				sortBy: t.Optional(t.String()),
				sortOrder: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Paginated Battlestats Logs",
				description:
					"Returns paginated and filtered stat training logs with before/after comparisons and efficiency metrics.",
			},
		},
	)
	// GET /api/v1/system/battlestats-ledger/analytics
	.get(
		"/analytics",
		async ({ query }) => {
			const conditions: SQL[] = [];

			if (query.from) {
				const fromDate = new Date(query.from);
				if (!Number.isNaN(fromDate.getTime())) {
					conditions.push(gte(battlestatsLedgers.timestamp, fromDate));
				}
			}

			if (query.to) {
				const toDate = new Date(query.to);
				if (!Number.isNaN(toDate.getTime())) {
					conditions.push(lte(battlestatsLedgers.timestamp, toDate));
				}
			}

			if (!query.from && !query.to && query.days && query.days !== "all") {
				const days = Number(query.days);
				if (!Number.isNaN(days) && days > 0) {
					const cutoff = new Date(Date.now() - days * 86400 * 1000);
					conditions.push(gte(battlestatsLedgers.timestamp, cutoff));
				}
			}

			if (query.statType && query.statType !== "all") {
				conditions.push(eq(battlestatsLedgers.statType, query.statType));
			}

			if (query.source && query.source !== "all") {
				conditions.push(eq(battlestatsLedgers.source, query.source));
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			// Aggregate overall metrics for selected filter range
			const [summaryResult] = await db
				.select({
					totalLogs: count(battlestatsLedgers.id),
					totalGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					totalTrains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					totalEnergyUsed: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
				})
				.from(battlestatsLedgers)
				.where(whereClause);

			const totalGained = Number(summaryResult?.totalGained ?? 0);
			const totalLogs = summaryResult?.totalLogs ?? 0;
			const totalTrains = Number(summaryResult?.totalTrains ?? 0);
			const totalEnergyUsed = Number(summaryResult?.totalEnergyUsed ?? 0);

			// Stat breakdown (Strength, Defense, Speed, Dexterity)
			const statRows = await db
				.select({
					statType: battlestatsLedgers.statType,
					count: count(battlestatsLedgers.id),
					gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(battlestatsLedgers.statType);

			const statBreakdown = statRows.map((sr) => {
				const srGained = Number(sr.gained);
				const srEnergy = Number(sr.energy);
				const srTrains = Number(sr.trains);
				const efficiency =
					srEnergy > 0 ? Number((srGained / srEnergy).toFixed(2)) : 0;
				const percentage =
					totalGained > 0
						? Number(((srGained / totalGained) * 100).toFixed(1))
						: 0;

				return {
					statType: sr.statType,
					count: Number(sr.count),
					gained: srGained,
					trains: srTrains,
					energy: srEnergy,
					efficiency,
					percentage,
				};
			});

			// Source breakdown (gym vs item vs book vs company)
			const sourceRows = await db
				.select({
					source: battlestatsLedgers.source,
					count: count(battlestatsLedgers.id),
					gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(battlestatsLedgers.source);

			const sourceBreakdown = sourceRows.map((src) => {
				const srcGained = Number(src.gained);
				const percentage =
					totalGained > 0
						? Number(((srcGained / totalGained) * 100).toFixed(1))
						: 0;

				return {
					source: src.source,
					count: Number(src.count),
					gained: srcGained,
					trains: Number(src.trains),
					energy: Number(src.energy),
					percentage,
				};
			});

			// Daily timeline aggregation (strength, defense, speed, dexterity, totalGained, energyUsed)
			const timelineRows = await db
				.select({
					date: sql<string>`to_char(${battlestatsLedgers.timestamp}, 'YYYY-MM-DD')`,
					statType: battlestatsLedgers.statType,
					dailyGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					dailyEnergy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
					dailyTrains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					count: count(battlestatsLedgers.id),
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(
					sql`to_char(${battlestatsLedgers.timestamp}, 'YYYY-MM-DD')`,
					battlestatsLedgers.statType,
				)
				.orderBy(
					sql`to_char(${battlestatsLedgers.timestamp}, 'YYYY-MM-DD') ASC`,
				);

			const timelineMap = new Map<
				string,
				{
					date: string;
					strength: number;
					defense: number;
					speed: number;
					dexterity: number;
					totalGained: number;
					energyUsed: number;
					trains: number;
					count: number;
				}
			>();

			for (const r of timelineRows) {
				const d = r.date;
				if (!d) continue;

				let entry = timelineMap.get(d);
				if (!entry) {
					entry = {
						date: d,
						strength: 0,
						defense: 0,
						speed: 0,
						dexterity: 0,
						totalGained: 0,
						energyUsed: 0,
						trains: 0,
						count: 0,
					};
					timelineMap.set(d, entry);
				}

				const gained = Number(r.dailyGained);
				const energy = Number(r.dailyEnergy);
				const trains = Number(r.dailyTrains);
				const logCount = Number(r.count);

				if (r.statType === "strength") entry.strength += gained;
				else if (r.statType === "defense") entry.defense += gained;
				else if (r.statType === "speed") entry.speed += gained;
				else if (r.statType === "dexterity") entry.dexterity += gained;

				entry.totalGained += gained;
				entry.energyUsed += energy;
				entry.trains += trains;
				entry.count += logCount;
			}

			const timeline = Array.from(timelineMap.values());

			// Hourly distribution (0-23 UTC)
			const hourlyRows = await db
				.select({
					hour: sql<number>`cast(to_char(${battlestatsLedgers.timestamp}, 'HH24') as integer)`,
					totalGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					count: count(battlestatsLedgers.id),
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(
					sql`cast(to_char(${battlestatsLedgers.timestamp}, 'HH24') as integer)`,
				);

			const hourlyMap = new Map<
				number,
				{ hour: number; totalGained: number; count: number }
			>();
			for (let h = 0; h < 24; h++) {
				hourlyMap.set(h, { hour: h, totalGained: 0, count: 0 });
			}

			for (const hr of hourlyRows) {
				const h = Number(hr.hour);
				if (h >= 0 && h < 24) {
					hourlyMap.set(h, {
						hour: h,
						totalGained: Number(hr.totalGained),
						count: Number(hr.count),
					});
				}
			}

			const hourly = Array.from(hourlyMap.values()).sort(
				(a, b) => a.hour - b.hour,
			);

			// Top single stat gain events
			const topEventRows = await db
				.select()
				.from(battlestatsLedgers)
				.where(whereClause)
				.orderBy(desc(battlestatsLedgers.statGained))
				.limit(10);

			const topEvents = topEventRows.map((r) => ({
				id: r.id,
				timestamp:
					r.timestamp instanceof Date
						? r.timestamp.toISOString()
						: new Date(r.timestamp).toISOString(),
				statType: r.statType,
				source: r.source,
				trains: r.trains,
				energyUsed: r.energyUsed,
				statGained: r.statGained,
				statBefore: r.statBefore,
				statAfter: r.statAfter,
			}));

			return {
				summary: {
					totalLogs,
					totalGained,
					totalTrains,
					totalEnergyUsed,
					avgGainPerTrain:
						totalTrains > 0
							? Number((totalGained / totalTrains).toFixed(2))
							: 0,
					avgGainPerEnergy:
						totalEnergyUsed > 0
							? Number((totalGained / totalEnergyUsed).toFixed(2))
							: 0,
				},
				statBreakdown,
				sourceBreakdown,
				timeline,
				hourly,
				topEvents,
			};
		},
		{
			query: t.Object({
				days: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				statType: t.Optional(t.String()),
				source: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Battlestats Ledger Analytics",
				description:
					"Returns KPI summaries, timeline series, stat breakdowns, source splits, and hourly distributions for Battlestats Ledger.",
			},
		},
	)
	// POST /api/v1/system/battlestats-ledger/reconcile — triggers full replay/rebuild from personal logs
	.post(
		"/reconcile",
		async () => {
			const success = await requestBattlestatsLedgerReinitialize();
			return {
				success,
				message: success
					? "Battlestats ledger reinitialization dispatched to scheduler."
					: "Could not dispatch to scheduler via IPC; command will apply on startup.",
			};
		},
		{
			detail: {
				summary: "Reinitialize Battlestats Ledger",
				description:
					"Dispatches a command to the background scheduler to wipe and re-index battlestats records from historical personal logs.",
			},
		},
	)
	// GET /api/v1/system/battlestats-ledger/efficiency-data — returns data for the calculator
	.get(
		"/efficiency-data",
		async () => {
			const [userStateRecord] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:live_state"));

			const [perksRecord] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:user_perks"));

			const [gymUnlocksRecord] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:gym_unlocks"));

			const userState =
				(userStateRecord?.data as Record<string, unknown>) ?? {};
			const perksData = (perksRecord?.data as Record<string, unknown>) ?? {};
			const gymUnlocks =
				(gymUnlocksRecord?.data as Record<string, unknown>) ?? {};

			const activeGymIds = [
				gymUnlocks.strengthGym,
				gymUnlocks.defenseGym,
				gymUnlocks.speedGym,
				gymUnlocks.dexterityGym,
			].filter(Boolean) as number[];

			let activeGyms: (typeof tornGyms.$inferSelect)[] = [];
			if (activeGymIds.length > 0) {
				activeGyms = await db
					.select()
					.from(tornGyms)
					.where(inArray(tornGyms.id, activeGymIds.map(String)));
			}

			let strengthPerk = 1;
			let speedPerk = 1;
			let defensePerk = 1;
			let dexterityPerk = 1;

			let strengthBonus = 0;
			let speedBonus = 0;
			let defenseBonus = 0;
			let dexterityBonus = 0;
			let generalBonus = 0;

			const categorizedPerks = perksData.categorizedPerks as
				| Record<string, string[]>
				| undefined;
			if (categorizedPerks) {
				const allPerks = Object.values(categorizedPerks).flat();
				for (const perkStr of allPerks) {
					const match =
						typeof perkStr === "string"
							? perkStr.match(
									/\+\s*(\d+(?:\.\d+)?)%\s*(?:([a-zA-Z]+)\s+)?gym gains/i,
								)
							: null;
					if (match) {
						const val = Number(match[1]);
						const stat = match[2]?.toLowerCase();

						if (stat === "strength") {
							strengthBonus += val;
						} else if (stat === "speed") {
							speedBonus += val;
						} else if (stat === "defense") {
							defenseBonus += val;
						} else if (stat === "dexterity") {
							dexterityBonus += val;
						} else {
							generalBonus += val;
						}
					}
				}
			}

			strengthPerk = 1 + (strengthBonus + generalBonus) / 100;
			speedPerk = 1 + (speedBonus + generalBonus) / 100;
			defensePerk = 1 + (defenseBonus + generalBonus) / 100;
			dexterityPerk = 1 + (dexterityBonus + generalBonus) / 100;

			const battlestats =
				(userState.battlestats as Record<string, unknown>) ?? {};
			const bars = (userState.bars as Record<string, unknown>) ?? {};
			const happy = (bars.happy as Record<string, unknown>) ?? {};

			return {
				stats: {
					strength: (battlestats.strength as number) ?? 0,
					defense: (battlestats.defense as number) ?? 0,
					speed: (battlestats.speed as number) ?? 0,
					dexterity: (battlestats.dexterity as number) ?? 0,
				},
				maxHappy: (happy.maximum as number) ?? 0,
				perks: {
					strength: strengthPerk,
					speed: speedPerk,
					defense: defensePerk,
					dexterity: dexterityPerk,
				},
				activeGyms: activeGyms.reduce(
					(acc, gym) => {
						if (gym.id === String(gymUnlocks.strengthGym)) acc.strength = gym;
						if (gym.id === String(gymUnlocks.defenseGym)) acc.defense = gym;
						if (gym.id === String(gymUnlocks.speedGym)) acc.speed = gym;
						if (gym.id === String(gymUnlocks.dexterityGym)) acc.dexterity = gym;
						return acc;
					},
					{} as Record<string, unknown>,
				),
			};
		},
		{
			detail: {
				summary: "Get Training Efficiency Data",
				description:
					"Returns data required to calculate the optimal gym training efficiency.",
			},
		},
	);

export const gymLedgerRoutes = new Elysia({ prefix: "/gym-ledger" }).use(
	battlestatsLedgerRoutes,
);
