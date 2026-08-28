import {
	and,
	asc,
	count,
	crimeActionMappings,
	crimeLogs,
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
	tornCrimes,
} from "@sentinel/database";
import { Elysia, t } from "elysia";
import { requestCrimeLedgerReinitialize } from "../../lib/scheduler-ipc";

export const CRIME_LOG_IDS = [
	9010, 9015, 9020, 9025, 9027, 9030, 9050, 9051, 9052, 9053, 9055, 9056, 9060,
	9065, 9070, 9071, 9072, 9073, 9150, 9154, 9155, 9158, 9160, 9163, 9165, 9190,
	9191,
];

export const DEFAULT_CRIME_NAMES: Record<number, string> = {
	1: "Search For Cash",
	2: "Bootlegging",
	3: "Graffiti",
	4: "Shoplifting",
	5: "Pickpocketing",
	6: "Card Skimming",
	7: "Burglary",
	8: "Street Hustling",
	9: "Disposal",
	10: "Cracking",
	11: "Forgery",
	12: "Scamming",
	13: "Arson & Robbery",
};

export async function getCrimeLedgerStateObject() {
	const record = db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, "personal:crimes_ledger"))
		.get();

	const totals = db
		.select({
			totalInDb: count(crimeLogs.id),
			totalNerveSpent: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
			totalLootValue: sql<number>`COALESCE(sum(${crimeLogs.value}), 0)`,
			minTimestamp: sql<number | null>`min(${crimeLogs.timestamp})`,
			maxTimestamp: sql<number | null>`max(${crimeLogs.timestamp})`,
		})
		.from(crimeLogs)
		.get();

	const personalLogsCount = db
		.select({ count: count(personalLogs.id) })
		.from(personalLogs)
		.where(inArray(personalLogs.log, CRIME_LOG_IDS))
		.get();

	const distinctCrimes = db
		.select({ count: sql<number>`count(distinct ${crimeLogs.crimeId})` })
		.from(crimeLogs)
		.get();

	const rawData = (record?.data as Record<string, unknown> | undefined) ?? {};

	const tornCrimesList = db
		.select({
			id: tornCrimes.id,
			name: tornCrimes.name,
		})
		.from(tornCrimes)
		.all();

	const crimeNamesMap = new Map<number, string>();
	for (const tc of tornCrimesList) {
		const numId = Number(tc.id);
		if (!Number.isNaN(numId) && tc.name) {
			crimeNamesMap.set(numId, tc.name);
		}
	}

	const categoryRows = db
		.select({
			crimeId: crimeLogs.crimeId,
			count: count(crimeLogs.id),
			nerve: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
			value: sql<number>`COALESCE(sum(${crimeLogs.value}), 0)`,
		})
		.from(crimeLogs)
		.groupBy(crimeLogs.crimeId)
		.all();

	const allTimeTotalCrimes = totals?.totalInDb ?? 0;
	const allTimeCategories = categoryRows.map((cat) => {
		const catCount = Number(cat.count);
		const catNerve = Number(cat.nerve);
		const catValue = Number(cat.value);
		const efficiency =
			catNerve > 0 ? Number((catValue / catNerve).toFixed(2)) : 0;
		const percentage =
			allTimeTotalCrimes > 0
				? Number(((catCount / allTimeTotalCrimes) * 100).toFixed(1))
				: 0;

		const crimeName =
			crimeNamesMap.get(cat.crimeId) ??
			DEFAULT_CRIME_NAMES[cat.crimeId] ??
			(cat.crimeId > 0 ? `Crime #${cat.crimeId}` : "Unclassified");

		return {
			crimeId: cat.crimeId,
			crimeName,
			count: catCount,
			nerve: catNerve,
			value: catValue,
			efficiency,
			percentage,
		};
	});

	const topProfitCategory =
		[...allTimeCategories].sort((a, b) => b.value - a.value)[0] ?? null;
	const topEfficientCategory =
		[...allTimeCategories]
			.filter((c) => c.nerve > 0)
			.sort((a, b) => b.efficiency - a.efficiency)[0] ?? null;

	return {
		status: (rawData.status as string) ?? "idle",
		totalIndexedCrimes: Number(
			rawData.totalIndexedCrimes ?? totals?.totalInDb ?? 0,
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
		totalNerveSpent: Number(totals?.totalNerveSpent ?? 0),
		totalLootValue: Number(totals?.totalLootValue ?? 0),
		distinctCrimesCount: Number(distinctCrimes?.count ?? 0),
		totalPersonalLogsCrimes: personalLogsCount?.count ?? 0,
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
		topProfitCategory,
		topEfficientCategory,
		allTimeCategories,
	};
}

export const crimeLedgerRoutes = new Elysia({ prefix: "/crime-ledger" })
	// GET /api/v1/system/crime-ledger/state — overall ledger synchronization and summary telemetry
	.get(
		"/state",
		async () => {
			return getCrimeLedgerStateObject();
		},
		{
			detail: {
				summary: "Get Crimes Ledger State",
				description:
					"Returns the synchronization status, overall totals, nerve expenditure, and database records count for Crime Ledger.",
			},
		},
	)
	// GET /api/v1/system/crime-ledger/logs — paginated crime ledger records with rich filtering
	.get(
		"/logs",
		async ({ query }) => {
			const page = Math.max(1, Number(query.page ?? 1) || 1);
			const limit = Math.min(Math.max(1, Number(query.limit ?? 50) || 50), 100);
			const offset = (page - 1) * limit;

			const conditions: SQL[] = [];

			if (query.date) {
				const dayStart = new Date(`${query.date}T00:00:00Z`);
				const dayEnd = new Date(`${query.date}T23:59:59Z`);
				if (
					!Number.isNaN(dayStart.getTime()) &&
					!Number.isNaN(dayEnd.getTime())
				) {
					conditions.push(
						and(
							gte(crimeLogs.timestamp, dayStart),
							lte(crimeLogs.timestamp, dayEnd),
						) as SQL,
					);
				}
			} else if (query.from || query.to) {
				if (query.from) {
					const fromDate = new Date(
						query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
					);
					if (!Number.isNaN(fromDate.getTime())) {
						conditions.push(gte(crimeLogs.timestamp, fromDate) as SQL);
					}
				}
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						conditions.push(lte(crimeLogs.timestamp, toDate) as SQL);
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
				conditions.push(gte(crimeLogs.timestamp, cutoff) as SQL);
			}

			if (query.crimeId && query.crimeId !== "ALL") {
				const cId = Number(query.crimeId);
				if (!Number.isNaN(cId)) {
					conditions.push(eq(crimeLogs.crimeId, cId));
				}
			}

			if (query.search) {
				const pattern = `%${query.search.trim()}%`;
				conditions.push(
					or(
						like(crimeLogs.action, pattern),
						like(crimeLogs.id, pattern),
					) as SQL,
				);
			}

			if (query.minNerve) {
				const minN = Number(query.minNerve);
				if (!Number.isNaN(minN)) {
					conditions.push(gte(crimeLogs.nerve, minN));
				}
			}

			if (query.minVal) {
				const minV = Number(query.minVal);
				if (!Number.isNaN(minV)) {
					conditions.push(gte(crimeLogs.value, minV));
				}
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			const totalResult = db
				.select({ count: count(crimeLogs.id) })
				.from(crimeLogs)
				.where(whereClause)
				.get();

			const total = totalResult?.count ?? 0;

			// Determine sorting
			let orderColumn: SQL = desc(crimeLogs.timestamp);
			const isAsc = query.sortOrder === "asc";

			if (query.sortBy === "nerve") {
				orderColumn = isAsc ? asc(crimeLogs.nerve) : desc(crimeLogs.nerve);
			} else if (query.sortBy === "value") {
				orderColumn = isAsc ? asc(crimeLogs.value) : desc(crimeLogs.value);
			} else if (query.sortBy === "crimeId" || query.sortBy === "category") {
				orderColumn = isAsc ? asc(crimeLogs.crimeId) : desc(crimeLogs.crimeId);
			} else if (query.sortBy === "action") {
				orderColumn = isAsc ? asc(crimeLogs.action) : desc(crimeLogs.action);
			} else {
				orderColumn = isAsc
					? asc(crimeLogs.timestamp)
					: desc(crimeLogs.timestamp);
			}

			const rawLogs = db
				.select({
					id: crimeLogs.id,
					crimeId: crimeLogs.crimeId,
					action: crimeLogs.action,
					nerve: crimeLogs.nerve,
					value: crimeLogs.value,
					timestamp: crimeLogs.timestamp,
					createdAt: crimeLogs.createdAt,
				})
				.from(crimeLogs)
				.where(whereClause)
				.orderBy(orderColumn)
				.limit(limit)
				.offset(offset)
				.all();

			// Fetch Torn crime names map
			const tornCrimesList = db
				.select({
					id: tornCrimes.id,
					name: tornCrimes.name,
				})
				.from(tornCrimes)
				.all();

			const crimeNamesMap = new Map<number, string>();
			for (const tc of tornCrimesList) {
				const numId = Number(tc.id);
				if (!Number.isNaN(numId) && tc.name) {
					crimeNamesMap.set(numId, tc.name);
				}
			}

			const logs = rawLogs.map((log) => {
				const crimeName =
					crimeNamesMap.get(log.crimeId) ??
					DEFAULT_CRIME_NAMES[log.crimeId] ??
					(log.crimeId > 0 ? `Crime #${log.crimeId}` : "Unclassified");

				return {
					...log,
					crimeName,
				};
			});

			return {
				logs,
				total,
				page,
				limit,
				totalPages: Math.ceil(total / limit),
			};
		},
		{
			query: t.Object({
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
				date: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				days: t.Optional(t.String()),
				crimeId: t.Optional(t.String()),
				search: t.Optional(t.String()),
				minNerve: t.Optional(t.String()),
				minVal: t.Optional(t.String()),
				sortBy: t.Optional(t.String()),
				sortOrder: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Crime Logs",
				description:
					"Returns paginated crime ledger records with filtering and sorting.",
			},
		},
	)
	// GET /api/v1/system/crime-ledger/analytics — comprehensive data analysis & telemetry aggregations
	.get(
		"/analytics",
		async ({ query }) => {
			const conditions: SQL[] = [];

			if (query.date) {
				const dayStart = new Date(`${query.date}T00:00:00Z`);
				const dayEnd = new Date(`${query.date}T23:59:59Z`);
				if (
					!Number.isNaN(dayStart.getTime()) &&
					!Number.isNaN(dayEnd.getTime())
				) {
					conditions.push(
						and(
							gte(crimeLogs.timestamp, dayStart),
							lte(crimeLogs.timestamp, dayEnd),
						) as SQL,
					);
				}
			} else if (query.from || query.to) {
				if (query.from) {
					const fromDate = new Date(
						query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
					);
					if (!Number.isNaN(fromDate.getTime())) {
						conditions.push(gte(crimeLogs.timestamp, fromDate) as SQL);
					}
				}
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						conditions.push(lte(crimeLogs.timestamp, toDate) as SQL);
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
				conditions.push(gte(crimeLogs.timestamp, cutoff) as SQL);
			}

			if (query.crimeId && query.crimeId !== "ALL") {
				const cId = Number(query.crimeId);
				if (!Number.isNaN(cId)) {
					conditions.push(eq(crimeLogs.crimeId, cId));
				}
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			// 1. Overall KPIs
			const kpiResult = db
				.select({
					totalCrimes: count(crimeLogs.id),
					totalNerve: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
					totalValue: sql<number>`COALESCE(sum(${crimeLogs.value}), 0)`,
					distinctCrimes: sql<number>`count(distinct ${crimeLogs.crimeId})`,
				})
				.from(crimeLogs)
				.where(whereClause)
				.get();

			const totalCrimes = kpiResult?.totalCrimes ?? 0;
			const totalNerve = Number(kpiResult?.totalNerve ?? 0);
			const totalValue = Number(kpiResult?.totalValue ?? 0);
			const distinctCrimes = Number(kpiResult?.distinctCrimes ?? 0);

			const avgValuePerCrime =
				totalCrimes > 0 ? Number((totalValue / totalCrimes).toFixed(2)) : 0;
			const avgNervePerCrime =
				totalCrimes > 0 ? Number((totalNerve / totalCrimes).toFixed(2)) : 0;
			const avgValuePerNerve =
				totalNerve > 0 ? Number((totalValue / totalNerve).toFixed(2)) : 0;

			// 2. Daily Timeline Activity
			const dailyActivity = db
				.select({
					date: sql<string>`strftime('%Y-%m-%d', datetime(${crimeLogs.timestamp}, 'unixepoch'))`,
					count: count(crimeLogs.id),
					nerve: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
					value: sql<number>`COALESCE(sum(${crimeLogs.value}), 0)`,
				})
				.from(crimeLogs)
				.where(whereClause)
				.groupBy(
					sql`strftime('%Y-%m-%d', datetime(${crimeLogs.timestamp}, 'unixepoch'))`,
				)
				.orderBy(
					asc(
						sql`strftime('%Y-%m-%d', datetime(${crimeLogs.timestamp}, 'unixepoch'))`,
					),
				)
				.all();

			const timeline = dailyActivity.map((d) => {
				const dayCount = Number(d.count);
				const dayNerve = Number(d.nerve);
				const dayValue = Number(d.value);
				const efficiency =
					dayNerve > 0 ? Number((dayValue / dayNerve).toFixed(2)) : 0;

				return {
					date: d.date,
					count: dayCount,
					nerve: dayNerve,
					value: dayValue,
					efficiency,
				};
			});

			// 3. Category Breakdown
			const tornCrimesList = db
				.select({
					id: tornCrimes.id,
					name: tornCrimes.name,
				})
				.from(tornCrimes)
				.all();

			const crimeNamesMap = new Map<number, string>();
			for (const tc of tornCrimesList) {
				const numId = Number(tc.id);
				if (!Number.isNaN(numId) && tc.name) {
					crimeNamesMap.set(numId, tc.name);
				}
			}

			const categoryRows = db
				.select({
					crimeId: crimeLogs.crimeId,
					count: count(crimeLogs.id),
					nerve: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
					value: sql<number>`COALESCE(sum(${crimeLogs.value}), 0)`,
				})
				.from(crimeLogs)
				.where(whereClause)
				.groupBy(crimeLogs.crimeId)
				.orderBy(desc(count(crimeLogs.id)))
				.all();

			const categories = categoryRows.map((cat) => {
				const catCount = Number(cat.count);
				const catNerve = Number(cat.nerve);
				const catValue = Number(cat.value);
				const efficiency =
					catNerve > 0 ? Number((catValue / catNerve).toFixed(2)) : 0;
				const percentage =
					totalCrimes > 0
						? Number(((catCount / totalCrimes) * 100).toFixed(1))
						: 0;

				const crimeName =
					crimeNamesMap.get(cat.crimeId) ??
					DEFAULT_CRIME_NAMES[cat.crimeId] ??
					(cat.crimeId > 0 ? `Crime #${cat.crimeId}` : "Unclassified");

				return {
					crimeId: cat.crimeId,
					crimeName,
					count: catCount,
					nerve: catNerve,
					value: catValue,
					efficiency,
					percentage,
				};
			});

			// 4. Hourly Distribution (0-23 hours UTC)
			const hourlyRows = db
				.select({
					hour: sql<string>`strftime('%H', datetime(${crimeLogs.timestamp}, 'unixepoch'))`,
					count: count(crimeLogs.id),
					nerve: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
				})
				.from(crimeLogs)
				.where(whereClause)
				.groupBy(
					sql`strftime('%H', datetime(${crimeLogs.timestamp}, 'unixepoch'))`,
				)
				.orderBy(
					asc(
						sql`strftime('%H', datetime(${crimeLogs.timestamp}, 'unixepoch'))`,
					),
				)
				.all();

			const hourlyMap = new Map<number, { count: number; nerve: number }>();
			for (const h of hourlyRows) {
				const hourNum = Number(h.hour);
				if (!Number.isNaN(hourNum)) {
					hourlyMap.set(hourNum, {
						count: Number(h.count),
						nerve: Number(h.nerve),
					});
				}
			}

			const hourly = Array.from({ length: 24 }, (_, i) => ({
				hour: i,
				count: hourlyMap.get(i)?.count ?? 0,
				nerve: hourlyMap.get(i)?.nerve ?? 0,
			}));

			// 5. Top 10 High-Yield Single Loot Events
			const topLootRows = db
				.select({
					id: crimeLogs.id,
					crimeId: crimeLogs.crimeId,
					action: crimeLogs.action,
					nerve: crimeLogs.nerve,
					value: crimeLogs.value,
					timestamp: crimeLogs.timestamp,
				})
				.from(crimeLogs)
				.where(whereClause)
				.orderBy(desc(crimeLogs.value))
				.limit(10)
				.all();

			const topLootEvents = topLootRows.map((row) => ({
				...row,
				crimeName:
					crimeNamesMap.get(row.crimeId) ??
					DEFAULT_CRIME_NAMES[row.crimeId] ??
					(row.crimeId > 0 ? `Crime #${row.crimeId}` : "Unclassified"),
			}));

			return {
				kpis: {
					totalCrimes,
					totalNerve,
					totalValue,
					distinctCrimes,
					avgValuePerCrime,
					avgNervePerCrime,
					avgValuePerNerve,
				},
				timeline,
				categories,
				hourly,
				topLootEvents,
			};
		},
		{
			query: t.Object({
				days: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				date: t.Optional(t.String()),
				crimeId: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Crimes Analytics",
				description:
					"Computes aggregated analytics, timeline metrics, ROI efficiency, hourly heatmap, and top yields.",
			},
		},
	)
	// GET /api/v1/system/crime-ledger/categories/:crimeId/actions — list all distinct classified actions under a crime category
	.get(
		"/categories/:crimeId/actions",
		async ({ params }) => {
			const crimeId = Number(params.crimeId);
			if (Number.isNaN(crimeId)) {
				return {
					crimeId: 0,
					totalCount: 0,
					totalNerve: 0,
					totalValue: 0,
					actions: [],
				};
			}

			const actionRows = db
				.select({
					action: crimeLogs.action,
					count: count(crimeLogs.id),
					nerve: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
					value: sql<number>`COALESCE(sum(${crimeLogs.value}), 0)`,
					lastTimestamp: sql<number | null>`max(${crimeLogs.timestamp})`,
				})
				.from(crimeLogs)
				.where(eq(crimeLogs.crimeId, crimeId))
				.groupBy(crimeLogs.action)
				.orderBy(desc(count(crimeLogs.id)))
				.all();

			const totalCategoryCount = actionRows.reduce(
				(sum, r) => sum + Number(r.count),
				0,
			);
			const totalCategoryNerve = actionRows.reduce(
				(sum, r) => sum + Number(r.nerve),
				0,
			);
			const totalCategoryValue = actionRows.reduce(
				(sum, r) => sum + Number(r.value),
				0,
			);

			const actions = actionRows.map((r) => {
				const c = Number(r.count);
				const n = Number(r.nerve);
				const v = Number(r.value);
				const efficiency = n > 0 ? Number((v / n).toFixed(2)) : 0;
				const percentage =
					totalCategoryCount > 0
						? Number(((c / totalCategoryCount) * 100).toFixed(1))
						: 0;

				return {
					action: r.action || "Unknown Action",
					count: c,
					nerve: n,
					value: v,
					efficiency,
					percentage,
					lastTimestamp: r.lastTimestamp,
				};
			});

			return {
				crimeId,
				totalCount: totalCategoryCount,
				totalNerve: totalCategoryNerve,
				totalValue: totalCategoryValue,
				actions,
			};
		},
		{
			params: t.Object({
				crimeId: t.String(),
			}),
			detail: {
				summary: "List Actions for Category",
				description:
					"Returns distinct classified log action strings, execution counts, and financial yields for a specific crime category.",
			},
		},
	)
	// GET /api/v1/system/crime-ledger/definitions — list known Torn crime categories & reference data
	.get(
		"/definitions",
		async () => {
			const tornList = db
				.select({
					id: tornCrimes.id,
					name: tornCrimes.name,
					data: tornCrimes.data,
				})
				.from(tornCrimes)
				.all();

			const definitions = tornList.map((c) => ({
				id: Number(c.id),
				name: c.name ?? `Crime #${c.id}`,
				data: c.data,
			}));

			// Augment with default crime names if missing in DB
			for (const [idStr, name] of Object.entries(DEFAULT_CRIME_NAMES)) {
				const idNum = Number(idStr);
				if (!definitions.some((d) => d.id === idNum)) {
					definitions.push({
						id: idNum,
						name,
						data: { id: idNum, name },
					});
				}
			}

			definitions.sort((a, b) => a.id - b.id);

			return { definitions };
		},
		{
			detail: {
				summary: "List Crime Definitions",
				description:
					"Returns all recognized crime definitions from Torn reference data.",
			},
		},
	)
	// GET /api/v1/system/crime-ledger/mappings — list custom action mappings
	.get(
		"/mappings",
		async () => {
			const mappings = db.select().from(crimeActionMappings).all();
			return { mappings };
		},
		{
			detail: {
				summary: "List Custom Crime Action Mappings",
				description: "Returns all custom action string to Crime ID overrides.",
			},
		},
	)
	// POST /api/v1/system/crime-ledger/mappings — create or update action mapping
	.post(
		"/mappings",
		async ({ body }) => {
			const actionId = body.action.trim().toLowerCase();
			const crimeId = Number(body.crimeId);

			const now = new Date();
			db.insert(crimeActionMappings)
				.values({
					id: actionId,
					crimeId,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: crimeActionMappings.id,
					set: {
						crimeId,
						updatedAt: now,
					},
				})
				.run();

			return {
				success: true,
				mapping: {
					id: actionId,
					crimeId,
					updatedAt: now.toISOString(),
				},
			};
		},
		{
			body: t.Object({
				action: t.String(),
				crimeId: t.Number(),
			}),
			detail: {
				summary: "Save Custom Crime Action Mapping",
				description:
					"Registers or updates a mapping between an action text string and a Torn crime ID.",
			},
		},
	)
	// POST /api/v1/system/crime-ledger/reconcile — dispatches re-initialization to scheduler via IPC
	.post(
		"/reconcile",
		async () => {
			const schedulerNotified = await requestCrimeLedgerReinitialize();

			return {
				success: true,
				message: schedulerNotified
					? "Crime ledger re-initialization dispatched to scheduler worker."
					: "Scheduler offline; crime ledger re-initialization queued for next boot.",
				schedulerNotified,
			};
		},
		{
			detail: {
				summary: "Trigger Crime Ledger Re-initialization",
				description:
					"Dispatches an IPC command to the scheduler to wipe crime_logs and regenerate them from personal_logs.",
			},
		},
	);
