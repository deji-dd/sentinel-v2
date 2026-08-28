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
	const record = db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, "personal:battlestats_ledger"))
		.get();

	const totals = db
		.select({
			totalInDb: count(battlestatsLedgers.id),
			totalStatGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
			totalTrains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
			totalEnergyUsed: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
			minTimestamp: sql<number | null>`min(${battlestatsLedgers.timestamp})`,
			maxTimestamp: sql<number | null>`max(${battlestatsLedgers.timestamp})`,
		})
		.from(battlestatsLedgers)
		.get();

	const personalLogsCount = db
		.select({ count: count(personalLogs.id) })
		.from(personalLogs)
		.where(inArray(personalLogs.log, STAT_GAIN_LOG_IDS))
		.get();

	const statTypeRows = db
		.select({
			statType: battlestatsLedgers.statType,
			count: count(battlestatsLedgers.id),
			gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
			trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
			energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
		})
		.from(battlestatsLedgers)
		.groupBy(battlestatsLedgers.statType)
		.all();

	const sourceRows = db
		.select({
			source: battlestatsLedgers.source,
			count: count(battlestatsLedgers.id),
			gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
			trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
			energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
		})
		.from(battlestatsLedgers)
		.groupBy(battlestatsLedgers.source)
		.all();

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

	const allTimeSources = sourceRows.map((sr) => {
		const srCount = Number(sr.count);
		const srGained = Number(sr.gained);
		const percentage =
			allTimeTotalGained > 0
				? Number(((srGained / allTimeTotalGained) * 100).toFixed(1))
				: 0;

		return {
			source: sr.source,
			count: srCount,
			gained: srGained,
			trains: Number(sr.trains),
			energy: Number(sr.energy),
			percentage,
		};
	});

	const topStatCategory =
		[...allTimeStats].sort((a, b) => b.gained - a.gained)[0] ?? null;

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
		isInitialized: record?.init ?? false,
		totals: {
			totalInDb: totals?.totalInDb ?? 0,
			totalStatGained: allTimeTotalGained,
			totalTrains: Number(totals?.totalTrains ?? 0),
			totalEnergyUsed: Number(totals?.totalEnergyUsed ?? 0),
			avgGainPerTrain:
				Number(totals?.totalTrains ?? 0) > 0
					? Number(
							(allTimeTotalGained / Number(totals?.totalTrains ?? 1)).toFixed(
								2,
							),
						)
					: 0,
			avgGainPerEnergy:
				Number(totals?.totalEnergyUsed ?? 0) > 0
					? Number(
							(
								allTimeTotalGained / Number(totals?.totalEnergyUsed ?? 1)
							).toFixed(2),
						)
					: 0,
			minTimestamp: totals?.minTimestamp ?? null,
			maxTimestamp: totals?.maxTimestamp ?? null,
			matchingPersonalLogs: personalLogsCount?.count ?? 0,
		},
		allTimeStats,
		allTimeSources,
		topStatCategory,
	};
}

export const getGymLedgerStateObject = getBattlestatsLedgerStateObject;

export const battlestatsLedgerRoutes = new Elysia({
	prefix: "/battlestats-ledger",
})
	// GET /api/v1/system/battlestats-ledger/state
	.get(
		"/state",
		async () => {
			return await getBattlestatsLedgerStateObject();
		},
		{
			detail: {
				summary: "Get Battlestats Ledger State",
				description:
					"Returns the current operational state, total indexed records, all-time stat/source aggregates, and data bounds.",
			},
		},
	)
	// GET /api/v1/system/battlestats-ledger/logs — paginated logs with filtering & search
	.get(
		"/logs",
		async ({ query }) => {
			const page = Number(query.page ?? 1);
			const pageSize = Math.min(Number(query.pageSize ?? 50), 200);
			const offset = (page - 1) * pageSize;

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

			if (query.search?.trim()) {
				const searchVal = query.search.trim();
				conditions.push(
					or(
						eq(battlestatsLedgers.id, searchVal),
						like(battlestatsLedgers.statType, `%${searchVal}%`),
						like(battlestatsLedgers.source, `%${searchVal}%`),
					) as SQL,
				);
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			let orderByClause = desc(battlestatsLedgers.timestamp);
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
			} else if (query.sortBy === "energyUsed") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.energyUsed)
						: desc(battlestatsLedgers.energyUsed);
			} else if (query.sortBy === "statType") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.statType)
						: desc(battlestatsLedgers.statType);
			} else if (query.sortBy === "source") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.source)
						: desc(battlestatsLedgers.source);
			} else if (query.sortBy === "trains") {
				orderByClause =
					query.sortOrder === "asc"
						? asc(battlestatsLedgers.trains)
						: desc(battlestatsLedgers.trains);
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

			const [totalCountResult, rows] = await Promise.all([
				db
					.select({ count: count(battlestatsLedgers.id) })
					.from(battlestatsLedgers)
					.where(whereClause)
					.get(),
				db
					.select()
					.from(battlestatsLedgers)
					.where(whereClause)
					.orderBy(orderByClause)
					.limit(pageSize)
					.offset(offset)
					.all(),
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
				days: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				statType: t.Optional(t.String()),
				source: t.Optional(t.String()),
				search: t.Optional(t.String()),
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
			const summaryResult = db
				.select({
					totalLogs: count(battlestatsLedgers.id),
					totalGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					totalTrains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					totalEnergyUsed: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.get();

			const totalGained = Number(summaryResult?.totalGained ?? 0);
			const totalLogs = summaryResult?.totalLogs ?? 0;
			const totalTrains = Number(summaryResult?.totalTrains ?? 0);
			const totalEnergyUsed = Number(summaryResult?.totalEnergyUsed ?? 0);

			// Stat breakdown (Strength, Defense, Speed, Dexterity)
			const statRows = db
				.select({
					statType: battlestatsLedgers.statType,
					count: count(battlestatsLedgers.id),
					gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(battlestatsLedgers.statType)
				.all();

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
			const sourceRows = db
				.select({
					source: battlestatsLedgers.source,
					count: count(battlestatsLedgers.id),
					gained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					energy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(battlestatsLedgers.source)
				.all();

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
			const timelineRows = db
				.select({
					date: sql<string>`strftime('%Y-%m-%d', datetime(${battlestatsLedgers.timestamp}, 'unixepoch'))`,
					statType: battlestatsLedgers.statType,
					dailyGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					dailyEnergy: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
					dailyTrains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
					count: count(battlestatsLedgers.id),
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(
					sql`strftime('%Y-%m-%d', datetime(${battlestatsLedgers.timestamp}, 'unixepoch'))`,
					battlestatsLedgers.statType,
				)
				.orderBy(
					sql`strftime('%Y-%m-%d', datetime(${battlestatsLedgers.timestamp}, 'unixepoch')) ASC`,
				)
				.all();

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
			const hourlyRows = db
				.select({
					hour: sql<number>`cast(strftime('%H', datetime(${battlestatsLedgers.timestamp}, 'unixepoch')) as integer)`,
					totalGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
					count: count(battlestatsLedgers.id),
				})
				.from(battlestatsLedgers)
				.where(whereClause)
				.groupBy(
					sql`cast(strftime('%H', datetime(${battlestatsLedgers.timestamp}, 'unixepoch')) as integer)`,
				)
				.all();

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
			const topEvents = db
				.select()
				.from(battlestatsLedgers)
				.where(whereClause)
				.orderBy(desc(battlestatsLedgers.statGained))
				.limit(10)
				.all()
				.map((r) => ({
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
			const userStateRecord = db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:live_state"))
				.get();

			const perksRecord = db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:user_perks"))
				.get();

			const gymUnlocksRecord = db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:gym_unlocks"))
				.get();

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
				activeGyms = db
					.select()
					.from(tornGyms)
					.where(inArray(tornGyms.id, activeGymIds.map(String)))
					.all();
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
