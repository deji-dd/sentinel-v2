import {
	and,
	db,
	desc,
	eq,
	gte,
	inArray,
	ledgerEvents,
	lte,
	personalLogs,
	sql,
	systemStates,
	wealthAccountSnapshots,
} from "@sentinel/database";
import type {
	WealthAnalyticsResponse,
	WealthBalances,
	WealthCategoryRow,
	WealthEventItem,
	WealthKPIs,
	WealthLedgerState,
	WealthStateResponse,
	WealthTimelinePoint,
	WealthTransaction,
	WealthTransactionsResponse,
} from "@sentinel/schemas";
import { extractItemMarketPrice, getWealthRule, Logger } from "@sentinel/utils";
import { Elysia, t } from "elysia";
import {
	notifySchedulerForceRun,
	requestWealthReinitialize,
} from "../../lib/scheduler-ipc";
import { authenticateCrimeLedgerRequest } from "./crime-ledger";

/**
 * The personal wealth ledger endpoint: where the money came from, where it went,
 * what items moved, and how much of it the ledger can actually account for.
 *
 * WHY THE API OWNS THE ARITHMETIC
 *
 * Everything needed lives server-side: the full event history in `ledger_events`,
 * the anchor and drift readings in `wealth_account_snapshots`, item prices in
 * `torn_items`. The userscript holds none of it and has no Torn API key of its
 * own, so it renders what this returns rather than re-deriving it — the same rule
 * the crime, battlestats, company and stock surfaces follow, so two clients can
 * never disagree about the same ledger.
 *
 * THE THREE THINGS THIS SURFACE IS FOR
 *
 * 1. CASH IS NOT PROFIT. `walletNet` is what moved through the pocket;
 *    `netWorthDelta` is what the account actually gained or lost. A vault deposit
 *    moves the first and not the second, and reporting only one of them is how a
 *    wealth panel ends up telling the reader they lost money by saving it.
 *
 * 2. AN UNPRICED EVENT IS NOT A ZERO. `coverage` carries the count and magnitude
 *    of everything the classifier could not put a trustworthy number on, so the
 *    reader sees the shape of what is missing.
 *
 * 3. DRIFT IS THE CHECK. Torn publishes its own `daily_networth`. The difference
 *    between it and `trackedNetWorth` is surfaced rather than hidden, because a
 *    drift that is not near zero means a rule is wrong — and that is the only
 *    mechanical way to find out.
 */

const logger = new Logger("API", "WealthLedger");

const STATE_ID = "personal:wealth";
/** The scheduler worker that owns the reconciler for this ledger. */
const WEALTH_WORKER_NAME = "personal:wealth";

type LedgerEventRow = typeof ledgerEvents.$inferSelect;

/** Timeframe parsing, matching the other personal ledger surfaces. */
function parseTimeframe(days: string | undefined): {
	days: string;
	from: Date | null;
} {
	if (!days || days === "all") return { days: "all", from: null };
	const parsed = Number.parseInt(days, 10);
	if (!Number.isFinite(parsed) || parsed <= 0)
		return { days: "30", from: null };
	const from = new Date(Date.now() - parsed * 86_400_000);
	return { days: String(parsed), from };
}

/**
 * Item prices, read once per request.
 *
 * `ledger_events` stores item ids rather than a copy of the price, so a stale
 * price cannot be baked into history: a valuation is always the current one.
 */
async function loadItemPriceMap(): Promise<Map<string, number>> {
	const rows = await db.query.tornItems.findMany({
		columns: { id: true, data: true },
	});
	const prices = new Map<string, number>();
	for (const row of rows) {
		const price = extractItemMarketPrice(row.data);
		if (price > 0) prices.set(row.id, price);
	}
	return prices;
}

type AssetEffect = { assetId?: string; quantityChange?: number; uid?: number };

function readAssetsAffected(raw: unknown): AssetEffect[] {
	if (!Array.isArray(raw)) return [];
	const out: AssetEffect[] = [];
	for (const entry of raw) {
		if (entry && typeof entry === "object") out.push(entry as AssetEffect);
	}
	return out;
}

/**
 * Why this event has no trustworthy figure.
 *
 * "Unpriced" alone tells a reader nothing they can act on, so this names the
 * specific cause. The three are genuinely different problems: a log type with no
 * pricing rule needs a rule, an item with no market price needs a price, and a
 * payload missing the field its rule names means the rule is wrong.
 */
function explainPricing(
	row: LedgerEventRow,
	items: readonly WealthEventItem[],
): string {
	const rule = getWealthRule(row.logType ?? 0);
	if (rule && rule.priced === false) {
		return rule.evidence
			? `Recorded but deliberately not valued — ${rule.evidence}`
			: `Log type ${row.logType} is recorded but has no pricing rule.`;
	}
	if (!rule) {
		return `Log type ${row.logType} has no rule and no band, so its movements are counted but never valued.`;
	}

	const unpriced = items.filter((item) => item.marketPrice <= 0);
	if (unpriced.length > 0) {
		return `No market price for item ${[
			...new Set(unpriced.map((item) => item.itemId)),
		].join(", ")}, so this movement is a floor rather than a total.`;
	}

	const fields = rule.wallet?.[0]?.fields.join(" or ");
	return fields
		? `The payload carried no \`${fields}\`, so no amount could be read.`
		: "The payload carried nothing this log type is known to value.";
}

function toTransactions(
	rows: LedgerEventRow[],
	prices: ReadonlyMap<string, number>,
	names: ReadonlyMap<string, string>,
	payloads?: ReadonlyMap<string, unknown>,
): WealthTransaction[] {
	return rows.map((row) => {
		const effects = readAssetsAffected(row.assetsAffected);
		const build = (sign: 1 | -1): WealthEventItem[] =>
			effects
				.filter((effect) =>
					sign > 0
						? (effect.quantityChange ?? 0) > 0
						: (effect.quantityChange ?? 0) < 0,
				)
				.map((effect) => {
					const itemId = String(effect.assetId ?? "");
					const quantity = Math.abs(effect.quantityChange ?? 0);
					return {
						itemId,
						itemName: names.get(itemId) ?? null,
						quantity,
						uid: effect.uid ?? null,
						marketPrice: prices.get(itemId) ?? 0,
					};
				});

		const itemsIn = build(1);
		const itemsOut = build(-1);

		const transaction: WealthTransaction = {
			id: row.id,
			logId: row.logId ?? "",
			logType: row.logType ?? 0,
			timestamp: row.timestamp.toISOString(),
			category: (row.wealthCategory ??
				"other") as WealthTransaction["category"],
			label: row.transactionName,
			title: null,
			tornCategory: null,
			walletDelta: row.walletDelta,
			account: (row.account ?? null) as WealthTransaction["account"],
			accountDelta: row.accountDelta,
			itemsIn,
			itemsOut,
			netWorthDelta: row.assetDelta,
			priced: row.priced,
		};

		if (!row.priced) {
			transaction.pricingNote = explainPricing(row, [...itemsIn, ...itemsOut]);
			const payload = payloads?.get(row.logId ?? "");
			if (payload !== undefined) transaction.rawPayload = payload;
		}

		return transaction;
	});
}

async function loadItemNames(): Promise<Map<string, string>> {
	const rows = await db.query.tornItems.findMany({
		columns: { id: true, name: true },
	});
	const names = new Map<string, string>();
	for (const row of rows) {
		if (row.name) names.set(row.id, row.name);
	}
	return names;
}

async function loadState(): Promise<{
	state: WealthLedgerState;
	anchorTimestamp: Date | null;
}> {
	const record = await db.query.systemStates.findFirst({
		where: eq(systemStates.id, STATE_ID),
	});

	const stored = (record?.data ?? {}) as Partial<{
		status: WealthLedgerState["status"];
		initialised: boolean;
		anchorTimestamp: number | null;
		anchorDate: string | null;
		totalIndexedEvents: number;
		lastReconciledAt: string | null;
		lastError: string | null;
		updatedAt: string;
	}>;

	const [counts] = await db
		.select({
			priced: sql<number>`count(*) filter (where ${ledgerEvents.priced})`,
			unpriced: sql<number>`count(*) filter (where not ${ledgerEvents.priced})`,
			unpricedAmount: sql<number>`COALESCE(sum(abs(${ledgerEvents.assetDelta})) filter (where not ${ledgerEvents.priced}), 0)`,
			types: sql<number>`count(distinct ${ledgerEvents.logType})`,
		})
		.from(ledgerEvents);

	// Anything the engine could not file is surfaced by name, not counted away.
	const unclassifiedRows = await db
		.select({
			logType: ledgerEvents.logType,
			events: sql<number>`count(*)`,
			sample: sql<string>`max(${ledgerEvents.transactionName})`,
		})
		.from(ledgerEvents)
		.where(eq(ledgerEvents.wealthCategory, "other"))
		.groupBy(ledgerEvents.logType)
		.orderBy(desc(sql`count(*)`))
		.limit(50);

	// The anchor row is the authority on whether the ledger is usable, not the
	// saved flag: init writes that flag before doing its work, so a run that
	// failed half way leaves a state claiming to be anchored with nothing behind
	// it. Reporting from the flag is what showed "anchored" over zero balances.
	const [anchorRow] = await db
		.select({ id: wealthAccountSnapshots.id })
		.from(wealthAccountSnapshots)
		.where(eq(wealthAccountSnapshots.source, "anchor"))
		.limit(1);

	const state: WealthLedgerState = {
		status: stored.status ?? "idle",
		initialised: anchorRow !== undefined,
		anchorTimestamp: stored.anchorTimestamp ?? null,
		anchorDate: stored.anchorDate ?? null,
		totalIndexedEvents: stored.totalIndexedEvents ?? 0,
		lastReconciledAt: stored.lastReconciledAt ?? null,
		lastError: stored.lastError ?? null,
		updatedAt: stored.updatedAt ?? new Date().toISOString(),
		coverage: {
			pricedEvents: Number(counts?.priced ?? 0),
			unpricedEvents: Number(counts?.unpriced ?? 0),
			unpricedAmount: Number(counts?.unpricedAmount ?? 0),
			unclassified: unclassifiedRows.map((row) => ({
				logType: Number(row.logType ?? 0),
				title: row.sample,
				events: Number(row.events),
				sample: row.sample,
			})),
			classifiedLogTypes: Number(counts?.types ?? 0),
			totalLogTypes: null,
		},
	};

	return {
		state,
		anchorTimestamp: state.anchorTimestamp
			? new Date(state.anchorTimestamp * 1000)
			: null,
	};
}

/**
 * Current balances, from the anchor plus every event since.
 *
 * The item leg is recovered rather than stored twice: `assetDelta` is by
 * construction `wallet + account + items`, so items are whatever is left once
 * the two cash legs are taken out.
 */
async function loadBalances(
	anchorTimestamp: Date | null,
): Promise<WealthBalances> {
	const [anchor] = anchorTimestamp
		? await db
				.select()
				.from(wealthAccountSnapshots)
				.where(eq(wealthAccountSnapshots.source, "anchor"))
				.orderBy(desc(wealthAccountSnapshots.timestamp))
				.limit(1)
		: [];

	if (!anchor) {
		return {
			wallet: 0,
			accounts: {},
			itemsValue: 0,
			trackedNetWorth: 0,
			tornNetWorth: null,
			netWorthDrift: null,
			observedAt: new Date().toISOString(),
		};
	}

	const [totals] = await db
		.select({
			wallet: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}), 0)`,
			account: sql<number>`COALESCE(sum(${ledgerEvents.accountDelta}), 0)`,
			asset: sql<number>`COALESCE(sum(${ledgerEvents.assetDelta}), 0)`,
		})
		.from(ledgerEvents)
		.where(gte(ledgerEvents.timestamp, anchor.timestamp));

	const perAccount = await db
		.select({
			account: ledgerEvents.account,
			total: sql<number>`COALESCE(sum(${ledgerEvents.accountDelta}), 0)`,
		})
		.from(ledgerEvents)
		.where(gte(ledgerEvents.timestamp, anchor.timestamp))
		.groupBy(ledgerEvents.account);

	const walletNet = Number(totals?.wallet ?? 0);
	const accountNet = Number(totals?.account ?? 0);
	const assetNet = Number(totals?.asset ?? 0);

	const accounts: WealthBalances["accounts"] = {
		vault: anchor.vault,
		company: anchor.company,
		bank: anchor.cityBank,
		cayman: anchor.caymanBank,
		piggy: anchor.piggyBank,
		bookie: anchor.bookie,
	};
	for (const row of perAccount) {
		if (!row.account) continue;
		const key = row.account as keyof WealthBalances["accounts"];
		accounts[key] = (accounts[key] ?? 0) + Number(row.total);
	}

	const itemsValue = anchor.itemsValue + (assetNet - walletNet - accountNet);
	const wallet = anchor.wallet + walletNet;
	let trackedNetWorth = wallet + itemsValue;
	for (const value of Object.values(accounts)) {
		if (typeof value === "number") trackedNetWorth += value;
	}

	const [latest] = await db
		.select()
		.from(wealthAccountSnapshots)
		.where(eq(wealthAccountSnapshots.source, "api"))
		.orderBy(desc(wealthAccountSnapshots.timestamp))
		.limit(1);

	const tornNetWorth = latest?.tornNetWorth ?? anchor.tornNetWorth ?? null;

	return {
		wallet,
		accounts,
		itemsValue,
		trackedNetWorth,
		tornNetWorth,
		netWorthDrift:
			tornNetWorth === null ? null : trackedNetWorth - tornNetWorth,
		observedAt: (latest?.timestamp ?? anchor.timestamp).toISOString(),
	};
}

export const wealthLedgerRoutes = new Elysia({ prefix: "/wealth-ledger" })
	.derive(async ({ headers, set }) => {
		const isAuthed = await authenticateCrimeLedgerRequest(headers);
		if (!isAuthed) {
			set.status = 401;
			throw new Error("Unauthorized: Invalid API key.");
		}
		return {};
	})
	// GET /v2/system/wealth-ledger/state — ledger telemetry, anchor and coverage
	.get(
		"/state",
		async (): Promise<WealthStateResponse> => {
			const { state, anchorTimestamp } = await loadState();
			return {
				success: true,
				state,
				balances: await loadBalances(anchorTimestamp),
			};
		},
		{
			detail: {
				summary: "Wealth ledger state",
				description:
					"Reports the ledger's anchor, how many events it has indexed, and exactly how much of the account's activity it could put a trustworthy number on.",
			},
		},
	)
	// GET /v2/system/wealth-ledger/accounts — balances and net-worth drift
	.get(
		"/accounts",
		async () => {
			const { anchorTimestamp } = await loadState();
			const balances = await loadBalances(anchorTimestamp);
			return { success: true, balances };
		},
		{
			detail: {
				summary: "Wealth account balances",
				description:
					"Current wallet, every non-wallet balance the player owns, item value, and the difference between the tracked net worth and Torn's own figure.",
			},
		},
	)
	// GET /v2/system/wealth-ledger/analytics — the Wealth tab's whole payload
	.get(
		"/analytics",
		async ({ query }): Promise<WealthAnalyticsResponse> => {
			const timeframe = parseTimeframe(query.days);
			const { state, anchorTimestamp } = await loadState();

			const where =
				timeframe.from === null
					? undefined
					: and(gte(ledgerEvents.timestamp, timeframe.from));

			const [totals] = await db
				.select({
					walletIn: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}) filter (where ${ledgerEvents.walletDelta} > 0), 0)`,
					walletOut: sql<number>`COALESCE(sum(-${ledgerEvents.walletDelta}) filter (where ${ledgerEvents.walletDelta} < 0), 0)`,
					walletNet: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}), 0)`,
					accountNet: sql<number>`COALESCE(sum(${ledgerEvents.accountDelta}), 0)`,
					netWorthDelta: sql<number>`COALESCE(sum(${ledgerEvents.assetDelta}), 0)`,
					events: sql<number>`count(*)`,
				})
				.from(ledgerEvents)
				.where(where);

			// Item legs are recovered from assetDelta, which is by construction
			// wallet + account + items.
			const itemsInValue =
				Number(totals?.netWorthDelta ?? 0) -
				Number(totals?.walletNet ?? 0) -
				Number(totals?.accountNet ?? 0);

			const kpis: WealthKPIs = {
				walletIn: Number(totals?.walletIn ?? 0),
				walletOut: Number(totals?.walletOut ?? 0),
				walletNet: Number(totals?.walletNet ?? 0),
				accountNet: Number(totals?.accountNet ?? 0),
				itemsInValue,
				itemsOutValue: 0,
				netWorthDelta: Number(totals?.netWorthDelta ?? 0),
				events: Number(totals?.events ?? 0),
			};

			const dailyRows = await db
				.select({
					date: sql<string>`to_char(date_trunc('day', ${ledgerEvents.timestamp} at time zone 'UTC'), 'YYYY-MM-DD')`,
					walletIn: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}) filter (where ${ledgerEvents.walletDelta} > 0), 0)`,
					walletOut: sql<number>`COALESCE(sum(-${ledgerEvents.walletDelta}) filter (where ${ledgerEvents.walletDelta} < 0), 0)`,
					walletNet: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}), 0)`,
					netWorthDelta: sql<number>`COALESCE(sum(${ledgerEvents.assetDelta}), 0)`,
					events: sql<number>`count(*)`,
				})
				.from(ledgerEvents)
				.where(where)
				.groupBy(
					sql`date_trunc('day', ${ledgerEvents.timestamp} at time zone 'UTC')`,
				)
				.orderBy(
					sql`date_trunc('day', ${ledgerEvents.timestamp} at time zone 'UTC')`,
				);

			const timeline: WealthTimelinePoint[] = dailyRows.map((row) => ({
				date: row.date,
				walletIn: Number(row.walletIn),
				walletOut: Number(row.walletOut),
				walletNet: Number(row.walletNet),
				netWorthDelta: Number(row.netWorthDelta),
				events: Number(row.events),
			}));

			const categoryRows = await db
				.select({
					category: ledgerEvents.wealthCategory,
					walletIn: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}) filter (where ${ledgerEvents.walletDelta} > 0), 0)`,
					walletOut: sql<number>`COALESCE(sum(-${ledgerEvents.walletDelta}) filter (where ${ledgerEvents.walletDelta} < 0), 0)`,
					walletNet: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}), 0)`,
					netWorthDelta: sql<number>`COALESCE(sum(${ledgerEvents.assetDelta}), 0)`,
					events: sql<number>`count(*)`,
					unpricedEvents: sql<number>`count(*) filter (where not ${ledgerEvents.priced})`,
				})
				.from(ledgerEvents)
				.where(where)
				.groupBy(ledgerEvents.wealthCategory);

			const categories: WealthCategoryRow[] = categoryRows
				.map((row) => ({
					category: (row.category ?? "other") as WealthCategoryRow["category"],
					walletIn: Number(row.walletIn),
					walletOut: Number(row.walletOut),
					walletNet: Number(row.walletNet),
					netWorthDelta: Number(row.netWorthDelta),
					events: Number(row.events),
					unpricedEvents: Number(row.unpricedEvents),
				}))
				.sort(
					(a, b) =>
						Math.abs(b.walletNet) +
						Math.abs(b.netWorthDelta) -
						(Math.abs(a.walletNet) + Math.abs(a.netWorthDelta)),
				);

			const eventRows = await db
				.select()
				.from(ledgerEvents)
				.where(where)
				.orderBy(
					desc(sql`abs(${ledgerEvents.assetDelta})`),
					desc(ledgerEvents.timestamp),
				)
				.limit(25);

			const [prices, names] = await Promise.all([
				loadItemPriceMap(),
				loadItemNames(),
			]);

			return {
				success: true,
				timeframe: {
					days: timeframe.days,
					from: timeframe.from?.toISOString() ?? null,
					to: new Date().toISOString(),
				},
				state,
				balances: await loadBalances(anchorTimestamp),
				kpis,
				timeline,
				categories,
				topEvents: toTransactions(eventRows, prices, names),
			};
		},
		{
			query: t.Object({ days: t.Optional(t.String()) }),
			detail: {
				summary: "Wealth analytics",
				description:
					"KPIs, the daily cash-flow and net-worth timeline, the category breakdown and the largest single movements over the requested window.",
			},
		},
	)
	// GET /v2/system/wealth-ledger/transactions — the ledger, paged and filtered
	.get(
		"/transactions",
		async ({ query }): Promise<WealthTransactionsResponse> => {
			const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
			const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

			// `priced` selects between the whole ledger, only what can be trusted,
			// and only what cannot — which is the debugging view.
			const pricedFilter = query.priced;
			// A "movement" is an event that changed something. This is ON by
			// default: a forum post is real history but it is not a transaction, and
			// a list full of them buries the rows the reader came for. `movements=0`
			// asks for the whole ledger, which is what the audit wants.
			const movementsOnly = query.movements !== "0";

			const filters = [];
			if (pricedFilter === "1") filters.push(eq(ledgerEvents.priced, true));
			if (pricedFilter === "0") filters.push(eq(ledgerEvents.priced, false));
			if (query.category) {
				filters.push(eq(ledgerEvents.wealthCategory, query.category));
			}
			if (query.logType) {
				const logType = Number(query.logType);
				if (Number.isInteger(logType)) {
					filters.push(eq(ledgerEvents.logType, logType));
				}
			}
			if (query.from) {
				const from = new Date(query.from);
				if (!Number.isNaN(from.getTime())) {
					filters.push(gte(ledgerEvents.timestamp, from));
				}
			}
			if (query.to) {
				const to = new Date(query.to);
				if (!Number.isNaN(to.getTime())) {
					filters.push(lte(ledgerEvents.timestamp, to));
				}
			}
			if (query.minAmount) {
				const amount = Number(query.minAmount);
				if (Number.isFinite(amount)) {
					filters.push(gte(sql`abs(${ledgerEvents.assetDelta})`, amount));
				}
			}
			if (movementsOnly) {
				filters.push(
					sql`(${ledgerEvents.walletDelta} <> 0 or ${ledgerEvents.accountDelta} <> 0 or ${ledgerEvents.assetDelta} <> 0 or ${ledgerEvents.assetsAffected} <> '[]'::jsonb)`,
				);
			}
			const where = filters.length > 0 ? and(...filters) : undefined;

			const [countRow] = await db
				.select({ total: sql<number>`count(*)` })
				.from(ledgerEvents)
				.where(where);

			const rows = await db
				.select()
				.from(ledgerEvents)
				.where(where)
				.orderBy(desc(ledgerEvents.timestamp), desc(ledgerEvents.id))
				.limit(limit)
				.offset(offset);

			const [prices, names] = await Promise.all([
				loadItemPriceMap(),
				loadItemNames(),
			]);

			// The raw payload is fetched only when it is going to be shown. It is
			// what makes an unpriced row fixable without opening the database.
			let payloads: Map<string, unknown> | undefined;
			if (query.payloads === "1" && rows.length > 0) {
				const logIds = rows
					.map((row) => row.logId)
					.filter(
						(id): id is string => typeof id === "string" && id.length > 0,
					);
				if (logIds.length > 0) {
					const logRows = await db
						.select({ id: personalLogs.id, data: personalLogs.data })
						.from(personalLogs)
						.where(inArray(personalLogs.id, logIds));
					payloads = new Map(
						logRows.map((row) => [
							row.id,
							(row.data as Record<string, unknown> | null)?.data ?? row.data,
						]),
					);
				}
			}

			return {
				success: true,
				total: Number(countRow?.total ?? 0),
				offset,
				limit,
				transactions: toTransactions(rows, prices, names, payloads),
			};
		},
		{
			query: t.Object({
				limit: t.Optional(t.String()),
				offset: t.Optional(t.String()),
				category: t.Optional(t.String()),
				logType: t.Optional(t.String()),
				minAmount: t.Optional(t.String()),
				/** `1` priced only, `0` unpriced only, omitted for everything. */
				priced: t.Optional(t.String()),
				/** `0` to include events that changed nothing. On by default. */
				movements: t.Optional(t.String()),
				/** `1` to include the raw Torn payload on unpriced rows. */
				payloads: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
			}),
			detail: {
				summary: "Wealth transactions",
				description:
					"The ledger itself, newest first. Filter by category, log type, date range, minimum magnitude, and by whether the amount could be trusted. Rows that are not fully priced come back with a plain-language reason and, on request, the raw payload they were built from. Note that the movement filter is ON by default and `priced=0` does not turn it off: an unpriced event usually has a zero movement, so a caller asking for unpriced rows almost always wants `movements=0` too.",
			},
		},
	)

	// POST /v2/system/wealth-ledger/reinitialize — re-anchor from scratch
	.post(
		"/reinitialize",
		async () => {
			const schedulerNotified = await requestWealthReinitialize();
			return {
				success: true,
				message: schedulerNotified
					? "Wealth ledger re-anchoring dispatched to the scheduler. Balances are measured as of 00:00 UTC today, and today's events are replayed against them."
					: "The scheduler is unreachable; the ledger will re-anchor on its next cycle.",
				schedulerNotified,
			};
		},
		{
			detail: {
				summary: "Re-anchor the wealth ledger",
				description:
					"Wipes ledger_events and rebuilds them from the personal log, measuring day-zero balances as of 00:00 UTC today. Destructive by design: anchoring is what makes the ledger correct, so this is the escape hatch for a ledger in a state worth discarding.",
			},
		},
	)

	// POST /v2/system/wealth-ledger/refresh — reconcile now, then report
	.post(
		"/refresh",
		async () => {
			// The scheduler owns the reconciler, so the API asks it to run rather
			// than reaching into another service's worker. A scheduler that is
			// unreachable is reported and does not stop the ledger being read.
			const delivered = await notifySchedulerForceRun(WEALTH_WORKER_NAME);
			if (!delivered) {
				logger.warn(
					"Could not reach the scheduler to reconcile the wealth ledger; returning the current state.",
				);
			}
			const { state, anchorTimestamp } = await loadState();
			return {
				success: true,
				state,
				balances: await loadBalances(anchorTimestamp),
			} satisfies WealthStateResponse;
		},
		{
			detail: {
				summary: "Reconcile the wealth ledger",
				description:
					"Asks the scheduler to fill in any log the live ingest path missed, then returns the refreshed state and balances.",
			},
		},
	);
