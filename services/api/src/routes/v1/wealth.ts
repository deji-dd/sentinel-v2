import {
	and,
	asc,
	companyDailyProfits,
	count,
	db,
	desc,
	eq,
	gte,
	ledgerEvents,
	like,
	or,
	type SQL,
	sql,
	systemStates,
} from "@sentinel/database";
import { Elysia, t } from "elysia";
import { requestWealthInit } from "../../lib/scheduler-ipc";

export const WEALTH_STATE_ID = "personal:wealth";

export type WealthStateData = {
	init: boolean;
	initTimestamp: number | null;
	status: string;
	lastSyncTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totals: {
		totalInflow: number;
		totalOutflow: number;
		netProfit: number;
		crimesInflow: number;
		stocksInflow: number;
		companyInflow: number;
		companyOutflow: number;
		otherInflow: number;
	};
	totalEventsIndexed: number;
};

export async function getWealthStateObject(): Promise<WealthStateData> {
	const record = db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, WEALTH_STATE_ID))
		.get();

	const rawData = (record?.data as Record<string, unknown> | undefined) ?? {};
	const init = Boolean(record?.init ?? rawData.init ?? false);
	const initTimestamp = (rawData.initTimestamp as number | null) ?? null;

	let totalInflow = 0;
	let totalOutflow = 0;
	let crimesInflow = 0;
	let stocksInflow = 0;
	let companyInflow = 0;
	let companyOutflow = 0;
	let otherInflow = 0;
	let totalEventsIndexed = 0;

	if (init && initTimestamp !== null) {
		const initDate = new Date(initTimestamp * 1000);

		// Aggregate ledger_events since init
		const eventRows = db
			.select({
				type: ledgerEvents.type,
				totalPnl: sql<number>`COALESCE(sum(${ledgerEvents.realizedPnl}), 0)`,
				count: count(ledgerEvents.id),
			})
			.from(ledgerEvents)
			.where(gte(ledgerEvents.timestamp, initDate))
			.groupBy(ledgerEvents.type)
			.all();

		for (const row of eventRows) {
			const pnl = Number(row.totalPnl);
			totalEventsIndexed += Number(row.count);

			if (row.type === "crime_reward") {
				crimesInflow += pnl;
			} else if (row.type === "stock_dividend") {
				stocksInflow += pnl;
			} else if (pnl > 0) {
				otherInflow += pnl;
			} else if (pnl < 0) {
				totalOutflow += Math.abs(pnl);
			}
		}

		// Company profit since init
		const companyRows = db
			.select({
				inflow: sql<number>`COALESCE(sum(${companyDailyProfits.inflow}), 0)`,
				outflow: sql<number>`COALESCE(sum(${companyDailyProfits.outflow}), 0)`,
			})
			.from(companyDailyProfits)
			.where(gte(companyDailyProfits.timestamp, initDate))
			.get();

		companyInflow = Number(companyRows?.inflow ?? 0);
		companyOutflow = Number(companyRows?.outflow ?? 0);

		totalInflow = crimesInflow + stocksInflow + otherInflow + companyInflow;
		totalOutflow += companyOutflow;
	}

	const netProfit = totalInflow - totalOutflow;

	return {
		init,
		initTimestamp,
		status: (rawData.status as string) ?? "idle",
		lastSyncTimestamp: (rawData.lastSyncTimestamp as number | null) ?? null,
		lastError: (rawData.lastError as string | null) ?? null,
		updatedAt:
			(rawData.updatedAt as string) ??
			(record?.updatedAt
				? new Date(record.updatedAt).toISOString()
				: new Date().toISOString()),
		totals: {
			totalInflow,
			totalOutflow,
			netProfit,
			crimesInflow,
			stocksInflow,
			companyInflow,
			companyOutflow,
			otherInflow,
		},
		totalEventsIndexed,
	};
}

export const wealthRoutes = new Elysia({ prefix: "/wealth" })
	// GET /api/v1/system/wealth/state — returns current wealth tracking state & aggregated financial totals
	.get(
		"/state",
		async () => {
			return getWealthStateObject();
		},
		{
			detail: {
				summary: "Get Wealth Tracking State",
				description:
					"Returns whether wealth tracking is active, its initTimestamp, and net inflow/outflow totals.",
			},
		},
	)
	// POST /api/v1/system/wealth/init — initializes or resets wealth tracking from a given timestamp
	.post(
		"/init",
		async ({ body }) => {
			const currentSec = Math.floor(Date.now() / 1000);
			const initTimestamp = body?.timestamp
				? Number(body.timestamp)
				: currentSec;
			const now = new Date();

			const stateData: WealthStateData = {
				init: true,
				initTimestamp,
				status: "idle",
				lastSyncTimestamp: currentSec,
				lastError: null,
				updatedAt: now.toISOString(),
				totals: {
					totalInflow: 0,
					totalOutflow: 0,
					netProfit: 0,
					crimesInflow: 0,
					stocksInflow: 0,
					companyInflow: 0,
					companyOutflow: 0,
					otherInflow: 0,
				},
				totalEventsIndexed: 0,
			};

			db.insert(systemStates)
				.values({
					id: WEALTH_STATE_ID,
					init: true,
					data: stateData,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: true,
						data: stateData,
						updatedAt: now,
					},
				})
				.run();

			await requestWealthInit(initTimestamp);

			return {
				success: true,
				message: `Wealth tracking initialized from ${new Date(initTimestamp * 1000).toISOString()}`,
				state: stateData,
			};
		},
		{
			body: t.Optional(
				t.Object({
					timestamp: t.Optional(t.Number()),
				}),
			),
			detail: {
				summary: "Initialize Wealth Tracking",
				description:
					"Marks wealth tracking as initialized and sets the starting timestamp cut-off.",
			},
		},
	)
	// GET /api/v1/system/wealth/timeline — returns daily financial timeline of inflows/outflows since init
	.get(
		"/timeline",
		async () => {
			const state = await getWealthStateObject();
			if (!state.init || state.initTimestamp === null) {
				return { timeline: [], initTimestamp: null };
			}

			const initDate = new Date(state.initTimestamp * 1000);

			// Aggregate daily events from ledgerEvents
			const dailyEvents = db
				.select({
					date: sql<string>`strftime('%Y-%m-%d', datetime(${ledgerEvents.timestamp}, 'unixepoch'))`,
					cashFlow: sql<number>`COALESCE(sum(${ledgerEvents.cashFlow}), 0)`,
					realizedPnl: sql<number>`COALESCE(sum(${ledgerEvents.realizedPnl}), 0)`,
					count: count(ledgerEvents.id),
				})
				.from(ledgerEvents)
				.where(gte(ledgerEvents.timestamp, initDate))
				.groupBy(
					sql`strftime('%Y-%m-%d', datetime(${ledgerEvents.timestamp}, 'unixepoch'))`,
				)
				.orderBy(
					asc(
						sql`strftime('%Y-%m-%d', datetime(${ledgerEvents.timestamp}, 'unixepoch'))`,
					),
				)
				.all();

			let runningCumulative = 0;
			const timeline = dailyEvents.map((d) => {
				const dayInflow = Math.max(0, Number(d.realizedPnl));
				const dayOutflow =
					Number(d.realizedPnl) < 0 ? Math.abs(Number(d.realizedPnl)) : 0;
				runningCumulative += dayInflow - dayOutflow;

				return {
					date: d.date,
					inflow: dayInflow,
					outflow: dayOutflow,
					netProfit: dayInflow - dayOutflow,
					cumulative: runningCumulative,
					count: Number(d.count),
				};
			});

			return {
				timeline,
				initTimestamp: state.initTimestamp,
			};
		},
		{
			detail: {
				summary: "Get Wealth Timeline",
				description:
					"Returns daily inflow, outflow, and cumulative wealth accumulation since init.",
			},
		},
	)
	// GET /api/v1/system/wealth/ledger — returns paginated ledger events since init
	.get(
		"/ledger",
		async ({ query }) => {
			const state = await getWealthStateObject();
			if (!state.init || state.initTimestamp === null) {
				return { events: [], total: 0, page: 1, limit: 50, totalPages: 0 };
			}

			const initDate = new Date(state.initTimestamp * 1000);
			const page = Math.max(1, Number(query.page ?? 1) || 1);
			const limit = Math.min(Math.max(1, Number(query.limit ?? 50) || 50), 100);
			const offset = (page - 1) * limit;

			const conditions: SQL[] = [gte(ledgerEvents.timestamp, initDate)];

			if (query.type) {
				conditions.push(eq(ledgerEvents.type, query.type));
			}

			if (query.search) {
				const pattern = `%${query.search.trim()}%`;
				conditions.push(
					or(
						like(ledgerEvents.transactionName, pattern),
						like(ledgerEvents.id, pattern),
					) as SQL,
				);
			}

			const whereClause = and(...conditions);

			const totalResult = db
				.select({ count: count(ledgerEvents.id) })
				.from(ledgerEvents)
				.where(whereClause)
				.get();

			const total = totalResult?.count ?? 0;

			const events = db
				.select()
				.from(ledgerEvents)
				.where(whereClause)
				.orderBy(desc(ledgerEvents.timestamp))
				.limit(limit)
				.offset(offset)
				.all();

			return {
				events,
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
				type: t.Optional(t.String()),
				search: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Wealth Ledger Events",
				description:
					"Returns paginated financial transactions occurring from initTimestamp onwards.",
			},
		},
	);
