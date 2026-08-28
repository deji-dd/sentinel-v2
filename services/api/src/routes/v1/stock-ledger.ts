import {
	and,
	asc,
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
	stockLedgers,
	systemStates,
	tornItems,
	tornProperties,
	tornStocks,
	userStocks,
} from "@sentinel/database";
import { extractItemMarketPrice } from "@sentinel/utils";
import { Elysia, t } from "elysia";
import { requestStocksLedgerReinitialize } from "../../lib/scheduler-ipc";

export const STOCK_GAIN_LOG_IDS = [
	5530, 5531, 5532, 5533, 5534, 5535, 5536, 5537,
];

/**
 * Computes active holding floor buy dates (`min(transaction.timestamp)`) for all currently owned stocks in `user_stocks`.
 */
export async function getActiveStockHoldingFloors(): Promise<
	Map<number, number>
> {
	const rows = db.select().from(userStocks).all();
	const floors = new Map<number, number>();
	for (const s of rows) {
		const stockId = Number(s.id);
		if (Number.isNaN(stockId) || (s.shares ?? 0) <= 0) continue;

		const rawTxs =
			typeof s.transactions === "string"
				? (JSON.parse(s.transactions) as unknown)
				: s.transactions;
		const txs: Array<{ timestamp?: number; bought?: number }> = Array.isArray(
			rawTxs,
		)
			? (rawTxs as Array<{ timestamp?: number; bought?: number }>)
			: [];

		let minTs = Number.MAX_SAFE_INTEGER;
		for (const tx of txs) {
			const ts = tx.timestamp ?? tx.bought;
			if (typeof ts === "number" && ts > 0 && ts < minTs) {
				minTs = ts;
			}
		}

		if (minTs !== Number.MAX_SAFE_INTEGER) {
			floors.set(stockId, minTs);
		}
	}
	return floors;
}

/**
 * Builds SQL filter condition enforcing buy date holding floors for active scope.
 */
export function buildScopeCondition(
	scope: string | undefined,
	floors: Map<number, number>,
): SQL | undefined {
	if (scope === "all_time") return undefined;

	// Default scope is "active"
	if (floors.size === 0) {
		return sql`1 = 0`; // No active holdings
	}

	const stockConditions: SQL[] = [];
	for (const [stockId, minTs] of floors.entries()) {
		const floorDate = new Date(minTs * 1000);
		stockConditions.push(
			and(
				eq(stockLedgers.stockId, stockId),
				gte(stockLedgers.timestamp, floorDate),
			) as SQL,
		);
	}

	return or(...stockConditions);
}

export async function getStockLedgerStateObject(scope: string = "active") {
	const record = db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, "personal:stocks_ledger"))
		.get();

	const activeFloors = await getActiveStockHoldingFloors();
	const scopeCondition = buildScopeCondition(scope, activeFloors);

	const totals = db
		.select({
			totalInDb: count(stockLedgers.id),
			totalValue: sql<number>`COALESCE(sum(${stockLedgers.value}), 0)`,
			minTimestamp: sql<number | null>`min(${stockLedgers.timestamp})`,
			maxTimestamp: sql<number | null>`max(${stockLedgers.timestamp})`,
		})
		.from(stockLedgers)
		.where(scopeCondition)
		.get();

	const personalLogsCount = db
		.select({ count: count(personalLogs.id) })
		.from(personalLogs)
		.where(inArray(personalLogs.log, STOCK_GAIN_LOG_IDS))
		.get();

	const distinctStocks = db
		.select({ count: sql<number>`count(distinct ${stockLedgers.stockId})` })
		.from(stockLedgers)
		.where(scopeCondition)
		.get();

	const rawData = (record?.data as Record<string, unknown> | undefined) ?? {};

	const tornStocksList = db
		.select({
			id: tornStocks.id,
			name: tornStocks.name,
			acronym: tornStocks.acronym,
		})
		.from(tornStocks)
		.all();

	const stockNamesMap = new Map<number, { name: string; acronym: string }>();
	for (const ts of tornStocksList) {
		const numId = Number(ts.id);
		if (!Number.isNaN(numId) && ts.name) {
			stockNamesMap.set(numId, { name: ts.name, acronym: ts.acronym });
		}
	}

	const stockRows = db
		.select({
			stockId: stockLedgers.stockId,
			count: count(stockLedgers.id),
			value: sql<number>`COALESCE(sum(${stockLedgers.value}), 0)`,
		})
		.from(stockLedgers)
		.where(scopeCondition)
		.groupBy(stockLedgers.stockId)
		.all();

	const allTimeTotalValue = Number(totals?.totalValue ?? 0);
	const allTimeTotalCount = Number(totals?.totalInDb ?? 0);

	const allTimeStocks = stockRows.map((st) => {
		const stCount = Number(st.count);
		const stValue = Number(st.value);
		const percentage =
			allTimeTotalValue > 0
				? Number(((stValue / allTimeTotalValue) * 100).toFixed(1))
				: 0;

		const stockMeta = stockNamesMap.get(st.stockId);
		const stockName = stockMeta?.name ?? `Stock #${st.stockId}`;
		const acronym = stockMeta?.acronym ?? `ST${st.stockId}`;

		return {
			stockId: st.stockId,
			stockName,
			acronym,
			count: stCount,
			value: stValue,
			percentage,
		};
	});

	const topProfitStock =
		[...allTimeStocks].sort((a, b) => b.value - a.value)[0] ?? null;

	const activeUserStocksCount = db
		.select({ count: count(userStocks.id) })
		.from(userStocks)
		.get();

	return {
		scope,
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
		totalInDb: allTimeTotalCount,
		totalDividendValue: allTimeTotalValue,
		distinctStocksCount: Number(distinctStocks?.count ?? 0),
		activeUserStocksCount: Number(activeUserStocksCount?.count ?? 0),
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
		topProfitStock,
		allTimeStocks,
	};
}

export const stockLedgerRoutes = new Elysia({ prefix: "/stock-ledger" })
	// GET /api/v1/system/stock-ledger/state
	.get(
		"/state",
		async ({ query }) => {
			return getStockLedgerStateObject(query.scope ?? "active");
		},
		{
			query: t.Object({
				scope: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Stocks Ledger State",
				description:
					"Returns the synchronization status, scope-filtered dividend totals, active stock holdings count, and database bounds.",
			},
		},
	)
	// GET /api/v1/system/stock-ledger/logs — paginated stock dividend records
	.get(
		"/logs",
		async ({ query }) => {
			const page = Math.max(1, Number(query.page ?? 1) || 1);
			const limit = Math.min(Math.max(1, Number(query.limit ?? 50) || 50), 100);
			const offset = (page - 1) * limit;

			const scope = query.scope ?? "active";
			const activeFloors = await getActiveStockHoldingFloors();
			const scopeCondition = buildScopeCondition(scope, activeFloors);

			const conditions: SQL[] = [];
			if (scopeCondition) {
				conditions.push(scopeCondition);
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
							gte(stockLedgers.timestamp, dayStart),
							lte(stockLedgers.timestamp, dayEnd),
						) as SQL,
					);
				}
			} else if (query.from || query.to) {
				if (query.from) {
					const fromDate = new Date(
						query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
					);
					if (!Number.isNaN(fromDate.getTime())) {
						conditions.push(gte(stockLedgers.timestamp, fromDate) as SQL);
					}
				}
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						conditions.push(lte(stockLedgers.timestamp, toDate) as SQL);
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
				conditions.push(gte(stockLedgers.timestamp, cutoff) as SQL);
			}

			if (query.stockId && query.stockId !== "ALL") {
				const sId = Number(query.stockId);
				if (!Number.isNaN(sId)) {
					conditions.push(eq(stockLedgers.stockId, sId));
				}
			}

			if (query.search) {
				const pattern = `%${query.search.trim()}%`;
				conditions.push(
					or(
						like(stockLedgers.id, pattern),
						like(sql`cast(${stockLedgers.stockId} as text)`, pattern),
					) as SQL,
				);
			}

			if (query.minVal) {
				const minV = Number(query.minVal);
				if (!Number.isNaN(minV)) {
					conditions.push(gte(stockLedgers.value, minV));
				}
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			const totalResult = db
				.select({ count: count(stockLedgers.id) })
				.from(stockLedgers)
				.where(whereClause)
				.get();

			const total = totalResult?.count ?? 0;

			let orderColumn: SQL = desc(stockLedgers.timestamp);
			const isAsc = query.sortOrder === "asc";

			if (query.sortBy === "value") {
				orderColumn = isAsc
					? asc(stockLedgers.value)
					: desc(stockLedgers.value);
			} else if (query.sortBy === "stockId") {
				orderColumn = isAsc
					? asc(stockLedgers.stockId)
					: desc(stockLedgers.stockId);
			} else {
				orderColumn = isAsc
					? asc(stockLedgers.timestamp)
					: desc(stockLedgers.timestamp);
			}

			const rawLogs = db
				.select({
					id: stockLedgers.id,
					timestamp: stockLedgers.timestamp,
					stockId: stockLedgers.stockId,
					logType: stockLedgers.logType,
					value: stockLedgers.value,
					itemId: stockLedgers.itemId,
					createdAt: stockLedgers.createdAt,
				})
				.from(stockLedgers)
				.where(whereClause)
				.orderBy(orderColumn)
				.limit(limit)
				.offset(offset)
				.all();

			const tornStocksList = db
				.select({
					id: tornStocks.id,
					name: tornStocks.name,
					acronym: tornStocks.acronym,
				})
				.from(tornStocks)
				.all();

			const stockMetaMap = new Map<number, { name: string; acronym: string }>();
			for (const ts of tornStocksList) {
				const numId = Number(ts.id);
				if (!Number.isNaN(numId) && ts.name) {
					stockMetaMap.set(numId, { name: ts.name, acronym: ts.acronym });
				}
			}

			const itemIds = rawLogs
				.map((l) => l.itemId)
				.filter((id): id is number => id !== null && id !== undefined);

			const itemMap = new Map<number, { name: string; value: number }>();
			if (itemIds.length > 0) {
				const itemsList = db
					.select({
						id: tornItems.id,
						name: tornItems.name,
						data: tornItems.data,
					})
					.from(tornItems)
					.where(inArray(tornItems.id, itemIds.map(String)))
					.all();

				for (const item of itemsList) {
					const numId = Number(item.id);
					const itemData = (item.data as Record<string, unknown>) ?? {};
					const mktPrice = Number(
						(itemData.value as Record<string, unknown>)?.market_price ?? 0,
					);
					if (!Number.isNaN(numId)) {
						itemMap.set(numId, {
							name: item.name ?? `Item #${numId}`,
							value: mktPrice,
						});
					}
				}
			}

			const logs = rawLogs.map((log) => {
				const meta = stockMetaMap.get(log.stockId);
				const stockName = meta?.name ?? `Stock #${log.stockId}`;
				const acronym = meta?.acronym ?? `ST${log.stockId}`;
				const itemMeta = log.itemId ? itemMap.get(log.itemId) : undefined;

				return {
					...log,
					stockName,
					acronym,
					itemName: itemMeta?.name ?? null,
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
				scope: t.Optional(t.String()),
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
				date: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				days: t.Optional(t.String()),
				stockId: t.Optional(t.String()),
				search: t.Optional(t.String()),
				minVal: t.Optional(t.String()),
				sortBy: t.Optional(t.String()),
				sortOrder: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Stock Dividend Logs",
				description:
					"Returns paginated stock ledger records with filtering and sorting.",
			},
		},
	)
	// GET /api/v1/system/stock-ledger/analytics
	.get(
		"/analytics",
		async ({ query }) => {
			const scope = query.scope ?? "active";
			const activeFloors = await getActiveStockHoldingFloors();
			const scopeCondition = buildScopeCondition(scope, activeFloors);

			const conditions: SQL[] = [];
			if (scopeCondition) {
				conditions.push(scopeCondition);
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
							gte(stockLedgers.timestamp, dayStart),
							lte(stockLedgers.timestamp, dayEnd),
						) as SQL,
					);
				}
			} else if (query.from || query.to) {
				if (query.from) {
					const fromDate = new Date(
						query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
					);
					if (!Number.isNaN(fromDate.getTime())) {
						conditions.push(gte(stockLedgers.timestamp, fromDate) as SQL);
					}
				}
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						conditions.push(lte(stockLedgers.timestamp, toDate) as SQL);
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
				conditions.push(gte(stockLedgers.timestamp, cutoff) as SQL);
			}

			if (query.stockId && query.stockId !== "ALL") {
				const sId = Number(query.stockId);
				if (!Number.isNaN(sId)) {
					conditions.push(eq(stockLedgers.stockId, sId));
				}
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			// 1. Overall KPIs
			const kpiResult = db
				.select({
					totalDividends: count(stockLedgers.id),
					totalValue: sql<number>`COALESCE(sum(${stockLedgers.value}), 0)`,
					distinctStocks: sql<number>`count(distinct ${stockLedgers.stockId})`,
				})
				.from(stockLedgers)
				.where(whereClause)
				.get();

			const totalDividends = kpiResult?.totalDividends ?? 0;
			const totalValue = Number(kpiResult?.totalValue ?? 0);
			const distinctStocks = Number(kpiResult?.distinctStocks ?? 0);
			const avgValuePerDividend =
				totalDividends > 0
					? Number((totalValue / totalDividends).toFixed(2))
					: 0;

			// 2. Daily Timeline
			const dailyActivity = db
				.select({
					date: sql<string>`strftime('%Y-%m-%d', datetime(${stockLedgers.timestamp}, 'unixepoch'))`,
					count: count(stockLedgers.id),
					value: sql<number>`COALESCE(sum(${stockLedgers.value}), 0)`,
				})
				.from(stockLedgers)
				.where(whereClause)
				.groupBy(
					sql`strftime('%Y-%m-%d', datetime(${stockLedgers.timestamp}, 'unixepoch'))`,
				)
				.orderBy(
					asc(
						sql`strftime('%Y-%m-%d', datetime(${stockLedgers.timestamp}, 'unixepoch'))`,
					),
				)
				.all();

			const timeline = dailyActivity.map((d) => ({
				date: d.date,
				count: Number(d.count),
				value: Number(d.value),
			}));

			// 3. Stock Breakdown
			const tornStocksList = db
				.select({
					id: tornStocks.id,
					name: tornStocks.name,
					acronym: tornStocks.acronym,
				})
				.from(tornStocks)
				.all();

			const stockMetaMap = new Map<number, { name: string; acronym: string }>();
			for (const ts of tornStocksList) {
				const numId = Number(ts.id);
				if (!Number.isNaN(numId) && ts.name) {
					stockMetaMap.set(numId, { name: ts.name, acronym: ts.acronym });
				}
			}

			const stockRows = db
				.select({
					stockId: stockLedgers.stockId,
					count: count(stockLedgers.id),
					value: sql<number>`COALESCE(sum(${stockLedgers.value}), 0)`,
				})
				.from(stockLedgers)
				.where(whereClause)
				.groupBy(stockLedgers.stockId)
				.orderBy(desc(sql`COALESCE(sum(${stockLedgers.value}), 0)`))
				.all();

			const stocks = stockRows.map((st) => {
				const stCount = Number(st.count);
				const stValue = Number(st.value);
				const percentage =
					totalValue > 0
						? Number(((stValue / totalValue) * 100).toFixed(1))
						: 0;

				const meta = stockMetaMap.get(st.stockId);
				const stockName = meta?.name ?? `Stock #${st.stockId}`;
				const acronym = meta?.acronym ?? `ST${st.stockId}`;

				return {
					stockId: st.stockId,
					stockName,
					acronym,
					count: stCount,
					value: stValue,
					percentage,
				};
			});

			// 4. Top Yield Single Events
			const topYieldRows = db
				.select({
					id: stockLedgers.id,
					stockId: stockLedgers.stockId,
					logType: stockLedgers.logType,
					value: stockLedgers.value,
					itemId: stockLedgers.itemId,
					timestamp: stockLedgers.timestamp,
				})
				.from(stockLedgers)
				.where(whereClause)
				.orderBy(desc(stockLedgers.value))
				.limit(10)
				.all();

			const topYieldEvents = topYieldRows.map((row) => {
				const meta = stockMetaMap.get(row.stockId);
				return {
					...row,
					stockName: meta?.name ?? `Stock #${row.stockId}`,
					acronym: meta?.acronym ?? `ST${row.stockId}`,
				};
			});

			return {
				scope,
				kpis: {
					totalDividends,
					totalValue,
					distinctStocks,
					avgValuePerDividend,
				},
				timeline,
				stocks,
				topYieldEvents,
			};
		},
		{
			query: t.Object({
				scope: t.Optional(t.String()),
				days: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				date: t.Optional(t.String()),
				stockId: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Stocks Analytics",
				description:
					"Returns KPI summaries, dividend timelines, stock yield breakdowns, and top yields.",
			},
		},
	)
	// GET /api/v1/system/stock-ledger/roi-table
	.get(
		"/roi-table",
		async ({ query }) => {
			const targetScope = query?.scope === "all_time" ? "all_time" : "active";

			const stocks = db.select().from(tornStocks).all();
			const items = db.select().from(tornItems).all();
			const uStocks = db.select().from(userStocks).all();

			const userSharesMap = new Map(
				uStocks.map((u) => [Number(u.id), u.shares ?? 0]),
			);
			const pointsRow = db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "points_market_price"))
				.get();
			const pointPrice =
				typeof pointsRow?.data === "object" &&
				pointsRow?.data !== null &&
				"price" in pointsRow.data
					? Number((pointsRow.data as Record<string, unknown>).price)
					: 31330;

			// Scope-filtered ledgers query
			const activeFloors = await getActiveStockHoldingFloors();
			const scopeCondition = buildScopeCondition(targetScope, activeFloors);

			const ledgers = db
				.select()
				.from(stockLedgers)
				.where(scopeCondition)
				.all();

			const divEarningsMap = new Map<number, number>();
			for (const l of ledgers) {
				divEarningsMap.set(
					l.stockId,
					(divEarningsMap.get(l.stockId) ?? 0) + l.value,
				);
			}

			// Build dynamic item price map from torn_items database
			const itemNameMap = new Map<string, number>();
			for (const it of items) {
				const price = extractItemMarketPrice(it.data);
				if (it.name && price > 0) {
					itemNameMap.set(it.name.toLowerCase().trim(), price);
				}
			}

			// Build dynamic property average value from tornProperties database table
			const props = db.select().from(tornProperties).all();
			const standardProps = props.filter(
				(p) => Number(p.id) >= 1 && Number(p.id) <= 13,
			);
			const propCosts = standardProps.map((p) => {
				const dataObj =
					typeof p.data === "string" ? JSON.parse(p.data) : p.data;
				return Number((dataObj as Record<string, unknown> | null)?.cost ?? 0);
			});
			const dynamicAvgPropertyVal =
				propCosts.length > 0
					? Math.round(propCosts.reduce((a, b) => a + b, 0) / propCosts.length)
					: 0;

			const resolveDynamicItemPrice = (description: string): number => {
				const descLower = description.toLowerCase().trim();

				// Keyword overrides matching exact stock benefit payouts
				if (descLower.includes("property")) {
					return dynamicAvgPropertyVal;
				}
				if (descLower.includes("feathery") || descLower.includes("fhc"))
					return itemNameMap.get("feathery hotel coupon") ?? 0;
				if (descLower.includes("grenade"))
					return itemNameMap.get("box of grenades") ?? 0;
				if (descLower.includes("medical"))
					return itemNameMap.get("box of medical supplies") ?? 0;
				if (descLower.includes("lawyer"))
					return itemNameMap.get("lawyer's business card") ?? 0;
				if (descLower.includes("drug"))
					return itemNameMap.get("drug pack") ?? 0;
				if (
					descLower.includes("energy drink") ||
					descLower.includes("six-pack of energy")
				)
					return itemNameMap.get("six-pack of energy drink") ?? 0;
				if (
					descLower.includes("alcohol") ||
					descLower.includes("six-pack of alcohol")
				)
					return itemNameMap.get("six-pack of alcohol") ?? 0;
				if (descLower.includes("lottery") || descLower.includes("voucher"))
					return itemNameMap.get("lottery voucher") ?? 0;

				// Match by exact/partial name in torn_items
				for (const [name, price] of itemNameMap.entries()) {
					if (
						descLower.includes(name) ||
						name.includes(descLower.replace(/^1x\s+/, ""))
					) {
						return price;
					}
				}

				return 0;
			};

			const results = [];

			for (const s of stocks) {
				const stockId = Number(s.id);
				const market = (
					typeof s.market === "string" ? JSON.parse(s.market) : s.market
				) as Record<string, unknown> | undefined;
				const bonus = (
					typeof s.bonus === "string" ? JSON.parse(s.bonus) : s.bonus
				) as Record<string, unknown> | undefined;
				const images = (
					typeof s.images === "string" ? JSON.parse(s.images) : s.images
				) as Record<string, unknown> | undefined;

				const price = Number(market?.price ?? 0);
				const isPassive = Boolean(bonus?.passive);
				const frequency = isPassive ? 0 : Number(bonus?.frequency ?? 7);
				const requirement = Number(bonus?.requirement ?? 0);
				const description = String(bonus?.description ?? "");

				const userShares = userSharesMap.get(stockId) ?? 0;
				const realDividendsGotten = divEarningsMap.get(stockId) ?? 0;

				let userBlocks = 0;
				if (userShares >= requirement && requirement > 0) {
					let currentMultiplier = 1;
					let accumShares = 0;
					while (accumShares + currentMultiplier * requirement <= userShares) {
						accumShares += currentMultiplier * requirement;
						userBlocks++;
						currentMultiplier *= 2;
					}
				}

				let rewardValuePerCycle = 0;
				let rewardCategory:
					| "cash"
					| "item"
					| "points"
					| "resource"
					| "passive" = "passive";

				if (!isPassive && description) {
					const descLower = description.toLowerCase().trim();
					const moneyMatch = description.match(/\$([\d,]+)/);
					const pointsMatch = description.match(/(\d+)\s+points/i);

					const isNonTradeableResource =
						(descLower.includes("happiness") && !descLower.includes("pack")) ||
						(descLower.includes("nerve") && !descLower.includes("pack")) ||
						(descLower.includes("energy") && !descLower.includes("drink"));

					if (moneyMatch?.[1]) {
						rewardValuePerCycle = Number(moneyMatch[1].replace(/,/g, ""));
						rewardCategory = "cash";
					} else if (pointsMatch?.[1]) {
						const pointCount = Number(pointsMatch[1]);
						rewardValuePerCycle = pointCount * pointPrice;
						rewardCategory = "points";
					} else if (isNonTradeableResource) {
						rewardCategory = "resource";
						rewardValuePerCycle = 0;
					} else {
						rewardCategory = "item";
						rewardValuePerCycle = resolveDynamicItemPrice(description);
					}
				} else {
					rewardCategory = isPassive ? "passive" : "resource";
				}

				// 1. Current Realized APR (Real Dividend Data / Investment Value)
				const currentInvestmentVal =
					userShares > 0 ? userShares * price : requirement * price;
				const currentRealizedApr =
					currentInvestmentVal > 0
						? Number(
								((realDividendsGotten / currentInvestmentVal) * 100).toFixed(2),
							)
						: 0;

				// 2. Next Block Metrics (Calculated for Block userBlocks + 1)
				const targetBlockLevel = userBlocks + 1;
				const cumSharesForCurrentBlocks =
					userBlocks > 0 ? (2 ** userBlocks - 1) * requirement : 0;
				const partialShares = Math.max(
					0,
					userShares - cumSharesForCurrentBlocks,
				);
				const nextBlockSharesRequired = 2 ** userBlocks * requirement;
				const sharesRemainingForNextBlock = Math.max(
					0,
					nextBlockSharesRequired - partialShares,
				);
				const progressPercent =
					nextBlockSharesRequired > 0
						? Number(
								((partialShares / nextBlockSharesRequired) * 100).toFixed(1),
							)
						: 0;

				const nextBlockCost = Math.round(nextBlockSharesRequired * price);

				const payoutsPerYear = frequency > 0 ? 365.25 / frequency : 0;
				const annualRewardValue = Math.round(
					rewardValuePerCycle * payoutsPerYear,
				);

				const nextBlockApr =
					nextBlockCost > 0
						? Number(((annualRewardValue / nextBlockCost) * 100).toFixed(2))
						: 0;
				const nextPaybackYears =
					nextBlockApr > 0 ? Number((100 / nextBlockApr).toFixed(2)) : null;

				const logo = (images?.logo as string) ?? null;

				results.push({
					stockId,
					name: s.name,
					acronym: s.acronym,
					logo,
					price,
					requirement,
					frequency,
					isPassive,
					rewardCategory,
					description,
					rewardValuePerCycle,
					annualRewardValue,
					firstBlockCost: Math.round(requirement * price),
					realDividendsGotten: Math.round(realDividendsGotten),
					currentRealizedApr,
					userShares,
					userBlocks,
					targetBlockLevel,
					partialShares,
					nextBlockSharesRequired,
					sharesRemainingForNextBlock,
					progressPercent,
					nextBlockCost,
					nextBlockApr,
					nextPaybackYears,
					apr: nextBlockApr,
					paybackYears: nextPaybackYears,
				});
			}

			const activeStocks = results
				.filter(
					(r) =>
						!r.isPassive &&
						r.rewardCategory !== "resource" &&
						r.rewardValuePerCycle > 0,
				)
				.sort((a, b) => b.nextBlockApr - a.nextBlockApr);

			const passiveStocks = results
				.filter(
					(r) =>
						r.isPassive ||
						r.rewardCategory === "resource" ||
						r.rewardValuePerCycle === 0,
				)
				.sort((a, b) => a.acronym.localeCompare(b.acronym));

			return {
				activeStocks,
				passiveStocks,
			};
		},
		{
			query: t.Object({
				scope: t.Optional(
					t.Union([t.Literal("active"), t.Literal("all_time")]),
				),
			}),
			detail: {
				summary: "Get Stock Benefit ROI & APR Table",
				description:
					"Returns stock benefit calculations, annual returns (APR %), payback periods, and block increment costs.",
			},
		},
	)
	// POST /api/v1/system/stock-ledger/reconcile — triggers rebuild from personal logs
	.post(
		"/reconcile",
		async () => {
			const success = await requestStocksLedgerReinitialize();
			return {
				success,
				message: success
					? "Stocks ledger reinitialization dispatched to scheduler."
					: "Could not dispatch to scheduler via IPC; command will apply on startup.",
			};
		},
		{
			detail: {
				summary: "Reinitialize Stocks Ledger",
				description:
					"Dispatches a command to the background scheduler to wipe and re-index stock dividend records from historical personal logs.",
			},
		},
	);
