import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	doublePrecision,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Sentinel Capital persistence.
 *
 * Every transactional row is scoped by `book` (`live` | `paper`) with no
 * default, so a query that forgets the scope fails to insert rather than
 * silently writing into the wrong book. Market data is global: both books value
 * the same Torn prices, and only one poller is needed.
 *
 * Money and unit columns are `numeric` and therefore arrive in TypeScript as
 * decimal strings. That is deliberate: a fund's AUM can exceed the exact
 * integer range of a JS number, and every arithmetic path goes through the pure
 * helpers in `@sentinel/utils` before a value is persisted.
 */

const money = (name: string) => numeric(name, { precision: 38, scale: 6 });
const unit = (name: string) => numeric(name, { precision: 30, scale: 10 });
const price = (name: string) => numeric(name, { precision: 24, scale: 6 });

const createdAt = timestamp("created_at", {
	withTimezone: true,
	mode: "date",
})
	.defaultNow()
	.notNull();

const updatedAt = timestamp("updated_at", {
	withTimezone: true,
	mode: "date",
})
	.defaultNow()
	.notNull();

export const capitalBooks = pgTable("capital_books", {
	/** `live` or `paper`. */
	book: text("book").primaryKey(),
	displayName: text("display_name").notNull(),
	status: text("status").default("active").notNull(),
	/** Epoch seconds the book started accepting rows, for log-relevance checks. */
	startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	createdBy: text("created_by"),
	createdAt,
	updatedAt,
});

export type CapitalBookRow = typeof capitalBooks.$inferSelect;
export type NewCapitalBookRow = typeof capitalBooks.$inferInsert;

export const capitalBookConfigs = pgTable("capital_book_configs", {
	book: text("book")
		.primaryKey()
		.references(() => capitalBooks.book, { onDelete: "cascade" }),
	publicShowAum: boolean("public_show_aum").default(true).notNull(),
	publicShowTrades: boolean("public_show_trades").default(true).notNull(),
	publicShowHoldings: boolean("public_show_holdings").default(true).notNull(),
	publicShowFees: boolean("public_show_fees").default(true).notNull(),

	feeRateDailyBps: integer("fee_rate_daily_bps").default(2500).notNull(),
	feeRateWeeklyBps: integer("fee_rate_weekly_bps").default(1500).notNull(),
	feeRateMonthlyBps: integer("fee_rate_monthly_bps").default(500).notNull(),

	minCashReservePct: doublePrecision("min_cash_reserve_pct")
		.default(15)
		.notNull(),
	maxEquityPct: doublePrecision("max_equity_pct").default(85).notNull(),
	maxStockWeightPct: doublePrecision("max_stock_weight_pct")
		.default(12)
		.notNull(),
	maxPositions: integer("max_positions").default(7).notNull(),

	riskPerTradePct: doublePrecision("risk_per_trade_pct").default(0.5).notNull(),
	stopAtrMultiplier: doublePrecision("stop_atr_multiplier")
		.default(2.5)
		.notNull(),
	stopMinPct: doublePrecision("stop_min_pct").default(2).notNull(),
	trailingTriggerR: doublePrecision("trailing_trigger_r").default(1).notNull(),
	trailingAtrMultiplier: doublePrecision("trailing_atr_multiplier")
		.default(2)
		.notNull(),
	trailingPct: doublePrecision("trailing_pct").default(2).notNull(),
	tightenTrailPct: doublePrecision("tighten_trail_pct").default(1.5).notNull(),
	scaleOutR: doublePrecision("scale_out_r").default(1).notNull(),
	scaleOutFraction: doublePrecision("scale_out_fraction")
		.default(0.3333)
		.notNull(),
	timeStopDays: integer("time_stop_days").default(20).notNull(),

	minEntryScore: doublePrecision("min_entry_score").default(65).notNull(),
	maxRsi: doublePrecision("max_rsi").default(75).notNull(),
	overboughtSigma: doublePrecision("overbought_sigma").default(2).notNull(),
	/**
	 * Which alpha the desk trades. `reversal` buys oversold names and sells the
	 * reversion; `momentum` is the original trend-following score. Kept as a
	 * setting so the two can be compared on the paper book without a deploy.
	 */
	signalMode: text("signal_mode").default("reversal").notNull(),
	/** Enter when the 20-period z-score is at or below -entrySigma. */
	reversalEntrySigma: doublePrecision("reversal_entry_sigma")
		.default(1)
		.notNull(),
	/** Exit once the 20-period z-score is at or above this level. */
	reversalExitSigma: doublePrecision("reversal_exit_sigma")
		.default(1)
		.notNull(),
	/** Reject a reversal candidate whose annualised volatility exceeds this. */
	maxVolatilityPct: doublePrecision("max_volatility_pct").default(40).notNull(),

	/** ML meta-label overlay. Shadow logs predictions; enabled changes ranking. */
	mlEnabled: boolean("ml_enabled").default(false).notNull(),
	mlWeight: doublePrecision("ml_weight").default(0.25).notNull(),
	mlMinConfidence: doublePrecision("ml_min_confidence").default(0.5).notNull(),
	mlMaxModelAgeDays: integer("ml_max_model_age_days").default(120).notNull(),

	regimeSmaDays: integer("regime_sma_days").default(50).notNull(),

	drawdownHaltPct: doublePrecision("drawdown_halt_pct").default(20).notNull(),
	drawdownDeriskPct: doublePrecision("drawdown_derisk_pct")
		.default(10)
		.notNull(),
	dailyLossHaltPct: doublePrecision("daily_loss_halt_pct").default(5).notNull(),
	stopCooldownDays: integer("stop_cooldown_days").default(3).notNull(),

	orderValidityMinutes: integer("order_validity_minutes").default(60).notNull(),
	staleDataSeconds: integer("stale_data_seconds").default(180).notNull(),
	saleFeeBps: integer("sale_fee_bps").default(10).notNull(),

	withdrawalPerformanceFeeEnabled: boolean("withdrawal_performance_fee_enabled")
		.default(true)
		.notNull(),
	withdrawalExitFeeBps: integer("withdrawal_exit_fee_bps").default(0).notNull(),
	withdrawalMinAmount: money("withdrawal_min_amount")
		.default("1000000")
		.notNull(),
	withdrawalNoticeDays: integer("withdrawal_notice_days").default(0).notNull(),

	paymentMatchTolerancePct: doublePrecision("payment_match_tolerance_pct")
		.default(1)
		.notNull(),
	notifyUnmatchedBuys: boolean("notify_unmatched_buys").default(true).notNull(),

	paperStartingCash: money("paper_starting_cash")
		.default("150000000000")
		.notNull(),
	paperSlippageBps: integer("paper_slippage_bps").default(5).notNull(),
	paperAutoFill: boolean("paper_auto_fill").default(true).notNull(),

	engineEnabled: boolean("engine_enabled").default(true).notNull(),
	liveEnabled: boolean("live_enabled").default(false).notNull(),

	updatedBy: text("updated_by"),
	createdAt,
	updatedAt,
});

export type CapitalBookConfigRow = typeof capitalBookConfigs.$inferSelect;
export type NewCapitalBookConfigRow = typeof capitalBookConfigs.$inferInsert;

export const capitalInvestors = pgTable(
	"capital_investors",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		/** `user`, `faction`, `operator`, or `test`. */
		kind: text("kind").notNull(),
		/** Default cadence for this investor's deposits and payouts. */
		frequency: text("frequency").default("weekly").notNull(),
		/** Default profit handling: `cash` pays out, `reinvest` compounds. */
		payoutMode: text("payout_mode").default("cash").notNull(),
		tornId: integer("torn_id"),
		factionId: integer("faction_id"),
		displayName: text("display_name").notNull(),
		status: text("status").default("active").notNull(),
		createdBy: text("created_by"),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("capital_investors_book_torn_idx")
			.on(table.book, table.tornId)
			.where(sql`${table.tornId} IS NOT NULL`),
		uniqueIndex("capital_investors_book_faction_idx")
			.on(table.book, table.factionId)
			.where(sql`${table.factionId} IS NOT NULL`),
		index("capital_investors_book_status_idx").on(table.book, table.status),
		check(
			"capital_investors_frequency_check",
			sql`${table.frequency} IN ('daily', 'weekly', 'monthly')`,
		),
		check(
			"capital_investors_payout_mode_check",
			sql`${table.payoutMode} IN ('cash', 'reinvest')`,
		),
	],
);

export type CapitalInvestorRow = typeof capitalInvestors.$inferSelect;
export type NewCapitalInvestorRow = typeof capitalInvestors.$inferInsert;

export const capitalInvestorContacts = pgTable(
	"capital_investor_contacts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		investorId: text("investor_id")
			.references(() => capitalInvestors.id, { onDelete: "cascade" })
			.notNull(),
		tornId: integer("torn_id"),
		discordId: text("discord_id"),
		name: text("name"),
		/** `primary` receives notifications; `viewer` gets read access only. */
		role: text("role").default("viewer").notNull(),
		createdAt,
	},
	(table) => [
		index("capital_contacts_investor_idx").on(table.investorId),
		index("capital_contacts_discord_idx").on(table.discordId),
	],
);

export type CapitalInvestorContactRow =
	typeof capitalInvestorContacts.$inferSelect;
export type NewCapitalInvestorContactRow =
	typeof capitalInvestorContacts.$inferInsert;

export const capitalInvestments = pgTable(
	"capital_investments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		investorId: text("investor_id")
			.references(() => capitalInvestors.id, { onDelete: "cascade" })
			.notNull(),
		/** One lot per deposit; a lot never receives a second deposit. */
		status: text("status").default("active").notNull(),
		frequency: text("frequency").notNull(),
		/** `cash` or `reinvest`: reinvest compounds the net payout into the lot. */
		payoutMode: text("payout_mode").default("cash").notNull(),
		/** Net cash deposited into this lot (principal is not reduced by payouts). */
		principal: money("principal").notNull(),
		/** Units issued at `nav_at_deposit`. */
		units: unit("units").notNull(),
		navAtDeposit: money("nav_at_deposit").notNull(),
		/** NAV per unit at the last fully settled payout. */
		highWaterNav: money("high_water_nav").notNull(),
		cumulativePayouts: money("cumulative_payouts").default("0").notNull(),
		cumulativeFees: money("cumulative_fees").default("0").notNull(),
		openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		lastPayoutAt: timestamp("last_payout_at", {
			withTimezone: true,
			mode: "date",
		}),
		nextPayoutAt: timestamp("next_payout_at", {
			withTimezone: true,
			mode: "date",
		}),
		closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
		note: text("note"),
		createdBy: text("created_by"),
		createdAt,
		updatedAt,
	},
	(table) => [
		index("capital_investments_book_investor_idx").on(
			table.book,
			table.investorId,
		),
		index("capital_investments_book_status_idx").on(table.book, table.status),
		index("capital_investments_next_payout_idx").on(
			table.book,
			table.nextPayoutAt,
		),
	],
);

export type CapitalInvestmentRow = typeof capitalInvestments.$inferSelect;
export type NewCapitalInvestmentRow = typeof capitalInvestments.$inferInsert;

export const capitalTransactions = pgTable(
	"capital_transactions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		type: text("type").notNull(),
		investorId: text("investor_id"),
		investmentId: text("investment_id"),
		stockId: integer("stock_id"),
		/** Signed cash impact: positive into the fund, negative out of it. */
		amount: money("amount").default("0").notNull(),
		shares: bigint("shares", { mode: "number" }),
		price: price("price"),
		fees: money("fees").default("0").notNull(),
		units: unit("units"),
		navPerUnit: money("nav_per_unit"),
		source: text("source").notNull(),
		/** Torn log id for idempotent log-driven bookings. */
		sourceLogId: text("source_log_id"),
		orderId: text("order_id"),
		fillId: text("fill_id"),
		payoutId: text("payout_id"),
		withdrawalId: text("withdrawal_id"),
		status: text("status").default("confirmed").notNull(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		recordedAt: timestamp("recorded_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		recordedBy: text("recorded_by"),
		note: text("note"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("capital_transactions_source_log_idx")
			.on(table.sourceLogId)
			.where(sql`${table.sourceLogId} IS NOT NULL`),
		index("capital_transactions_book_time_idx").on(
			table.book,
			table.occurredAt,
		),
		index("capital_transactions_book_type_idx").on(table.book, table.type),
		index("capital_transactions_investment_idx").on(table.investmentId),
		check(
			"capital_transactions_metadata_is_object",
			sql`jsonb_typeof(${table.metadata}) = 'object'`,
		),
	],
);

export type CapitalTransactionRow = typeof capitalTransactions.$inferSelect;
export type NewCapitalTransactionRow = typeof capitalTransactions.$inferInsert;

export const capitalPositions = pgTable(
	"capital_positions",
	{
		book: text("book").notNull(),
		stockId: integer("stock_id").notNull(),
		shares: bigint("shares", { mode: "number" }).default(0).notNull(),
		costBasis: money("cost_basis").default("0").notNull(),
		realized: money("realized").default("0").notNull(),
		/** True when the owner recorded an off-recommendation trade as a fund error. */
		isUnplanned: boolean("is_unplanned").default(false).notNull(),
		/**
		 * Execution price of the opening fill, excluding fees. `costBasis /
		 * shares` includes fees and drifts after a partial sell; the entry price
		 * must stay put.
		 */
		entryPrice: price("entry_price"),
		/**
		 * Frozen hard stop from the entry order. The engine never recomputes it
		 * from the current ATR: widening it would exceed the risk budget, and
		 * tightening it would make R jump and fire the +1R/+2R exits early.
		 */
		stopPrice: price("stop_price"),
		/** Frozen +2R take-profit from the entry order. */
		targetPrice: price("target_price"),
		/** High-water mark since entry, for the trailing stop only. */
		peakPrice: price("peak_price"),
		/** Set when the +1R partial trim has executed. */
		scaledOutAt: timestamp("scaled_out_at", {
			withTimezone: true,
			mode: "date",
		}),
		openedAt: timestamp("opened_at", { withTimezone: true, mode: "date" }),
		lastTradeAt: timestamp("last_trade_at", {
			withTimezone: true,
			mode: "date",
		}),
		updatedAt,
	},
	(table) => [
		uniqueIndex("capital_positions_book_stock_idx").on(
			table.book,
			table.stockId,
		),
	],
);

export type CapitalPositionRow = typeof capitalPositions.$inferSelect;
export type NewCapitalPositionRow = typeof capitalPositions.$inferInsert;

export const capitalOrders = pgTable(
	"capital_orders",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		stockId: integer("stock_id").notNull(),
		side: text("side").notNull(),
		status: text("status").default("recommended").notNull(),
		recommendedShares: bigint("recommended_shares", { mode: "number" })
			.default(0)
			.notNull(),
		filledShares: bigint("filled_shares", { mode: "number" })
			.default(0)
			.notNull(),
		/** Price at recommendation time. */
		priceGuide: price("price_guide").notNull(),
		recommendedPrice: price("recommended_price"),
		minPrice: price("min_price"),
		maxPrice: price("max_price"),
		averageFillPrice: price("average_fill_price"),
		score: doublePrecision("score").default(0).notNull(),
		rationale: text("rationale").default("").notNull(),
		factorSnapshot: jsonb("factor_snapshot")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		riskFlags: jsonb("risk_flags").$type<string[]>().default([]).notNull(),
		stopPrice: price("stop_price"),
		targetPrice: price("target_price"),
		/** Machine-readable exit reason for a sell order (`stop`, `target`, ...). */
		exitReason: text("exit_reason"),
		expectedAnnualIncome: money("expected_annual_income"),
		runId: text("run_id"),
		generatedAt: timestamp("generated_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		acceptedAt: timestamp("accepted_at", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt,
		updatedAt,
	},
	(table) => [
		index("capital_orders_book_status_idx").on(table.book, table.status),
		index("capital_orders_book_stock_time_idx").on(
			table.book,
			table.stockId,
			table.generatedAt,
		),
		check(
			"capital_orders_factors_is_object",
			sql`jsonb_typeof(${table.factorSnapshot}) = 'object'`,
		),
	],
);

export type CapitalOrderRow = typeof capitalOrders.$inferSelect;
export type NewCapitalOrderRow = typeof capitalOrders.$inferInsert;

export const capitalFills = pgTable(
	"capital_fills",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		orderId: text("order_id"),
		stockId: integer("stock_id").notNull(),
		side: text("side").notNull(),
		shares: bigint("shares", { mode: "number" }).notNull(),
		price: price("price").notNull(),
		notional: money("notional").notNull(),
		fees: money("fees").default("0").notNull(),
		source: text("source").notNull(),
		sourceLogId: text("source_log_id"),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		recordedAt: timestamp("recorded_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		varianceShares: bigint("variance_shares", { mode: "number" }),
		variancePrice: price("variance_price"),
		slippageBps: doublePrecision("slippage_bps"),
		delaySeconds: integer("delay_seconds"),
		notionalDelta: money("notional_delta"),
		decisionIssueId: text("decision_issue_id"),
		/** Why the sell happened (`stop`, `target`, `reversal`, ...). */
		exitReason: text("exit_reason"),
		note: text("note"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		createdAt,
	},
	(table) => [
		uniqueIndex("capital_fills_source_log_idx")
			.on(table.sourceLogId)
			.where(sql`${table.sourceLogId} IS NOT NULL`),
		index("capital_fills_book_time_idx").on(table.book, table.occurredAt),
		index("capital_fills_order_idx").on(table.orderId),
		check(
			"capital_fills_metadata_is_object",
			sql`jsonb_typeof(${table.metadata}) = 'object'`,
		),
	],
);

export type CapitalFillRow = typeof capitalFills.$inferSelect;
export type NewCapitalFillRow = typeof capitalFills.$inferInsert;

export const capitalOrderOutcomes = pgTable(
	"capital_order_outcomes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		orderId: text("order_id")
			.references(() => capitalOrders.id, { onDelete: "cascade" })
			.notNull(),
		book: text("book").notNull(),
		horizon: text("horizon").notNull(),
		price: price("price"),
		returnPct: doublePrecision("return_pct"),
		maxAdversePct: doublePrecision("max_adverse_pct"),
		maxFavorablePct: doublePrecision("max_favorable_pct"),
		evaluatedAt: timestamp("evaluated_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		createdAt,
	},
	(table) => [
		uniqueIndex("capital_order_outcomes_order_horizon_idx").on(
			table.orderId,
			table.horizon,
		),
	],
);

export type CapitalOrderOutcomeRow = typeof capitalOrderOutcomes.$inferSelect;
export type NewCapitalOrderOutcomeRow =
	typeof capitalOrderOutcomes.$inferInsert;

export const capitalPayoutObligations = pgTable(
	"capital_payout_obligations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		investmentId: text("investment_id")
			.references(() => capitalInvestments.id, { onDelete: "cascade" })
			.notNull(),
		investorId: text("investor_id")
			.references(() => capitalInvestors.id, { onDelete: "cascade" })
			.notNull(),
		frequency: text("frequency").notNull(),
		periodStart: timestamp("period_start", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		periodEnd: timestamp("period_end", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }).notNull(),
		grossAmount: money("gross_amount").notNull(),
		feeAmount: money("fee_amount").default("0").notNull(),
		netAmount: money("net_amount").notNull(),
		paidAmount: money("paid_amount").default("0").notNull(),
		remainingAmount: money("remaining_amount").notNull(),
		status: text("status").default("due").notNull(),
		highWaterNav: money("high_water_nav").notNull(),
		navAtCreation: money("nav_at_creation").notNull(),
		paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
		paidBy: text("paid_by"),
		paymentReference: text("payment_reference"),
		sourceLogId: text("source_log_id"),
		idempotencyKey: text("idempotency_key"),
		note: text("note"),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("capital_payouts_source_log_idx")
			.on(table.sourceLogId)
			.where(sql`${table.sourceLogId} IS NOT NULL`),
		uniqueIndex("capital_payouts_idempotency_idx")
			.on(table.idempotencyKey)
			.where(sql`${table.idempotencyKey} IS NOT NULL`),
		index("capital_payouts_book_status_due_idx").on(
			table.book,
			table.status,
			table.dueAt,
		),
		index("capital_payouts_investment_idx").on(table.investmentId),
	],
);

export type CapitalPayoutObligationRow =
	typeof capitalPayoutObligations.$inferSelect;
export type NewCapitalPayoutObligationRow =
	typeof capitalPayoutObligations.$inferInsert;

export const capitalWithdrawalRequests = pgTable(
	"capital_withdrawal_requests",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		investmentId: text("investment_id")
			.references(() => capitalInvestments.id, { onDelete: "cascade" })
			.notNull(),
		investorId: text("investor_id")
			.references(() => capitalInvestors.id, { onDelete: "cascade" })
			.notNull(),
		requestedAmount: money("requested_amount").notNull(),
		requestedUnits: unit("requested_units"),
		unitsToRedeem: unit("units_to_redeem").notNull(),
		grossValue: money("gross_value").notNull(),
		principalBasis: money("principal_basis").notNull(),
		profitAmount: money("profit_amount").default("0").notNull(),
		lossAmount: money("loss_amount").default("0").notNull(),
		performanceFee: money("performance_fee").default("0").notNull(),
		exitFee: money("exit_fee").default("0").notNull(),
		netAmount: money("net_amount").notNull(),
		liquidityWarning: text("liquidity_warning"),
		status: text("status").default("requested").notNull(),
		referenceCode: text("reference_code"),
		sourceLogId: text("source_log_id"),
		requestedAt: timestamp("requested_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		quotedAt: timestamp("quoted_at", {
			withTimezone: true,
			mode: "date",
		}),
		approvedAt: timestamp("approved_at", {
			withTimezone: true,
			mode: "date",
		}),
		paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
		rejectedAt: timestamp("rejected_at", {
			withTimezone: true,
			mode: "date",
		}),
		note: text("note"),
		requestedBy: text("requested_by"),
		approvedBy: text("approved_by"),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("capital_withdrawals_source_log_idx")
			.on(table.sourceLogId)
			.where(sql`${table.sourceLogId} IS NOT NULL`),
		uniqueIndex("capital_withdrawals_reference_idx")
			.on(table.referenceCode)
			.where(sql`${table.referenceCode} IS NOT NULL`),
		index("capital_withdrawals_book_status_idx").on(table.book, table.status),
		index("capital_withdrawals_investment_idx").on(table.investmentId),
	],
);

export type CapitalWithdrawalRequestRow =
	typeof capitalWithdrawalRequests.$inferSelect;
export type NewCapitalWithdrawalRequestRow =
	typeof capitalWithdrawalRequests.$inferInsert;

export const capitalPaymentIntents = pgTable(
	"capital_payment_intents",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		/** `deposit`, `payout`, or `withdrawal`. */
		kind: text("kind").notNull(),
		status: text("status").default("pending").notNull(),
		investorId: text("investor_id"),
		investmentId: text("investment_id"),
		/** Cadence to use when a matched deposit creates a lot. */
		frequency: text("frequency"),
		/** Payout mode for a matched deposit lot. */
		payoutMode: text("payout_mode").default("cash").notNull(),
		/** Payout obligation ids this intent settles, when kind = payout. */
		payoutIds: jsonb("payout_ids").$type<string[]>().default([]).notNull(),
		counterpartyTornId: integer("counterparty_torn_id"),
		expectedAmount: money("expected_amount").notNull(),
		matchedAmount: money("matched_amount"),
		tolerancePct: doublePrecision("tolerance_pct").default(1).notNull(),
		referenceCode: text("reference_code").notNull(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		matchedLogId: text("matched_log_id"),
		discordChannelId: text("discord_channel_id"),
		discordMessageId: text("discord_message_id"),
		note: text("note"),
		createdBy: text("created_by"),
		createdAt,
		updatedAt,
	},
	(table) => [
		uniqueIndex("capital_payment_intents_book_reference_idx").on(
			table.book,
			table.referenceCode,
		),
		uniqueIndex("capital_payment_intents_matched_log_idx")
			.on(table.matchedLogId)
			.where(sql`${table.matchedLogId} IS NOT NULL`),
		index("capital_payment_intents_book_status_idx").on(
			table.book,
			table.status,
		),
		index("capital_payment_intents_counterparty_idx").on(
			table.counterpartyTornId,
		),
	],
);

export type CapitalPaymentIntentRow = typeof capitalPaymentIntents.$inferSelect;
export type NewCapitalPaymentIntentRow =
	typeof capitalPaymentIntents.$inferInsert;

export const capitalNavSnapshots = pgTable(
	"capital_nav_snapshots",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		capturedAt: timestamp("captured_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		granularity: text("granularity").notNull(),
		cash: money("cash").notNull(),
		positionsValue: money("positions_value").notNull(),
		totalValue: money("total_value").notNull(),
		unitsOutstanding: unit("units_outstanding").notNull(),
		navPerUnit: money("nav_per_unit").notNull(),
		investedCapital: money("invested_capital").notNull(),
		cumulativePayouts: money("cumulative_payouts").notNull(),
		cumulativeFees: money("cumulative_fees").notNull(),
		investorCount: integer("investor_count").default(0).notNull(),
		returnPct: doublePrecision("return_pct"),
		createdAt,
	},
	(table) => [
		uniqueIndex("capital_nav_snapshots_book_granularity_time_idx").on(
			table.book,
			table.granularity,
			table.capturedAt,
		),
		index("capital_nav_snapshots_book_time_idx").on(
			table.book,
			table.capturedAt,
		),
	],
);

export type CapitalNavSnapshotRow = typeof capitalNavSnapshots.$inferSelect;
export type NewCapitalNavSnapshotRow = typeof capitalNavSnapshots.$inferInsert;

export const capitalMarketLatest = pgTable("capital_market_latest", {
	stockId: integer("stock_id").primaryKey(),
	price: price("price").notNull(),
	cap: money("cap").default("0").notNull(),
	shares: bigint("shares", { mode: "number" }).default(0).notNull(),
	investors: integer("investors").default(0).notNull(),
	/** Torn's `chart.performance` object from the last detail fetch. */
	performance: jsonb("performance")
		.$type<Record<string, unknown>>()
		.default({})
		.notNull(),
	detailUpdatedAt: timestamp("detail_updated_at", {
		withTimezone: true,
		mode: "date",
	}),
	updatedAt,
});

export type CapitalMarketLatestRow = typeof capitalMarketLatest.$inferSelect;
export type NewCapitalMarketLatestRow = typeof capitalMarketLatest.$inferInsert;

export const capitalMlModels = pgTable(
	"capital_ml_models",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		version: text("version").notNull(),
		/** e.g. `meta_label_logistic`. */
		kind: text("kind").notNull(),
		featureSpec: jsonb("feature_spec").$type<string[]>().notNull(),
		/** Weights, standardisation and label definition. */
		artifact: jsonb("artifact").$type<Record<string, unknown>>().notNull(),
		metrics: jsonb("metrics")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		dataStart: timestamp("data_start", { withTimezone: true, mode: "date" }),
		dataEnd: timestamp("data_end", { withTimezone: true, mode: "date" }),
		trainedAt: timestamp("trained_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		active: boolean("active").default(false).notNull(),
		notes: text("notes"),
		createdAt,
		updatedAt,
	},
	(table) => [index("capital_ml_models_active_idx").on(table.active)],
);

export type CapitalMlModelRow = typeof capitalMlModels.$inferSelect;
export type NewCapitalMlModelRow = typeof capitalMlModels.$inferInsert;

export const capitalMlPredictions = pgTable(
	"capital_ml_predictions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		stockId: integer("stock_id").notNull(),
		modelId: text("model_id").references(() => capitalMlModels.id, {
			onDelete: "set null",
		}),
		horizonDays: integer("horizon_days").notNull(),
		/** Execution price at prediction time; the outcome is measured from it. */
		entryPrice: doublePrecision("entry_price"),
		probability: doublePrecision("probability").notNull(),
		ruleScore: doublePrecision("rule_score"),
		eligible: boolean("eligible").default(false).notNull(),
		/** The feature vector as named values, for post-hoc analysis. */
		features: jsonb("features").$type<Record<string, number>>(),
		createdAt,
		evaluatedAt: timestamp("evaluated_at", {
			withTimezone: true,
			mode: "date",
		}),
		realizedReturnPct: doublePrecision("realized_return_pct"),
		/** 1 target hit first, 0 stop/time, null pending. */
		barrierHit: integer("barrier_hit"),
	},
	(table) => [
		index("capital_ml_predictions_book_created_idx").on(
			table.book,
			table.createdAt,
		),
		index("capital_ml_predictions_pending_idx").on(table.evaluatedAt),
	],
);

export type CapitalMlPredictionRow = typeof capitalMlPredictions.$inferSelect;
export type NewCapitalMlPredictionRow =
	typeof capitalMlPredictions.$inferInsert;

export const capitalMarketCandles = pgTable(
	"capital_market_candles",
	{
		stockId: integer("stock_id").notNull(),
		intervalMinutes: integer("interval_minutes").notNull(),
		bucketStart: timestamp("bucket_start", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		open: price("open").notNull(),
		high: price("high").notNull(),
		low: price("low").notNull(),
		close: price("close").notNull(),
		shares: bigint("shares", { mode: "number" }),
		investors: integer("investors"),
		samples: integer("samples").default(1).notNull(),
		updatedAt,
	},
	(table) => [
		uniqueIndex("capital_candles_stock_interval_bucket_idx").on(
			table.stockId,
			table.intervalMinutes,
			table.bucketStart,
		),
		index("capital_candles_bucket_idx").on(table.bucketStart),
	],
);

export type CapitalMarketCandleRow = typeof capitalMarketCandles.$inferSelect;
export type NewCapitalMarketCandleRow =
	typeof capitalMarketCandles.$inferInsert;

export const capitalEngineRuns = pgTable(
	"capital_engine_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		trigger: text("trigger").notNull(),
		status: text("status").default("running").notNull(),
		startedAt: timestamp("started_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		finishedAt: timestamp("finished_at", {
			withTimezone: true,
			mode: "date",
		}),
		durationMs: integer("duration_ms"),
		dataAgeSeconds: integer("data_age_seconds"),
		stocksScored: integer("stocks_scored").default(0).notNull(),
		recommendations: integer("recommendations").default(0).notNull(),
		paperFills: integer("paper_fills").default(0).notNull(),
		errors: jsonb("errors").$type<string[]>().default([]).notNull(),
		details: jsonb("details")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		createdAt,
	},
	(table) => [
		index("capital_engine_runs_book_time_idx").on(table.book, table.startedAt),
		check(
			"capital_engine_runs_details_is_object",
			sql`jsonb_typeof(${table.details}) = 'object'`,
		),
	],
);

export type CapitalEngineRunRow = typeof capitalEngineRuns.$inferSelect;
export type NewCapitalEngineRunRow = typeof capitalEngineRuns.$inferInsert;

export const capitalReconciliationIssues = pgTable(
	"capital_reconciliation_issues",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		kind: text("kind").notNull(),
		status: text("status").default("open").notNull(),
		stockId: integer("stock_id"),
		investorId: text("investor_id"),
		title: text("title").notNull(),
		detail: text("detail").default("").notNull(),
		amount: money("amount"),
		details: jsonb("details")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		discordChannelId: text("discord_channel_id"),
		discordMessageId: text("discord_message_id"),
		detectedAt: timestamp("detected_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		resolvedAt: timestamp("resolved_at", {
			withTimezone: true,
			mode: "date",
		}),
		resolvedBy: text("resolved_by"),
		resolutionNote: text("resolution_note"),
		createdAt,
		updatedAt,
	},
	(table) => [
		index("capital_issues_book_status_idx").on(table.book, table.status),
		index("capital_issues_book_kind_idx").on(table.book, table.kind),
		index("capital_issues_stock_idx").on(table.book, table.stockId),
		check(
			"capital_issues_details_is_object",
			sql`jsonb_typeof(${table.details}) = 'object'`,
		),
	],
);

export type CapitalReconciliationIssueRow =
	typeof capitalReconciliationIssues.$inferSelect;
export type NewCapitalReconciliationIssueRow =
	typeof capitalReconciliationIssues.$inferInsert;

export const capitalAccess = pgTable(
	"capital_access",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		tornId: integer("torn_id"),
		discordId: text("discord_id"),
		role: text("role").default("viewer").notNull(),
		investorId: text("investor_id"),
		note: text("note"),
		createdBy: text("created_by"),
		createdAt,
	},
	(table) => [
		uniqueIndex("capital_access_book_torn_idx")
			.on(table.book, table.tornId)
			.where(sql`${table.tornId} IS NOT NULL`),
		uniqueIndex("capital_access_book_discord_idx")
			.on(table.book, table.discordId)
			.where(sql`${table.discordId} IS NOT NULL`),
		index("capital_access_book_role_idx").on(table.book, table.role),
	],
);

export type CapitalAccessRow = typeof capitalAccess.$inferSelect;
export type NewCapitalAccessRow = typeof capitalAccess.$inferInsert;

export const capitalAuditLog = pgTable(
	"capital_audit_log",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").notNull(),
		actorDiscordId: text("actor_discord_id"),
		action: text("action").notNull(),
		entityType: text("entity_type").notNull(),
		entityId: text("entity_id").notNull(),
		before: jsonb("before").$type<Record<string, unknown> | null>(),
		after: jsonb("after").$type<Record<string, unknown> | null>(),
		note: text("note"),
		createdAt,
	},
	(table) => [
		index("capital_audit_book_time_idx").on(table.book, table.createdAt),
		index("capital_audit_entity_idx").on(table.entityType, table.entityId),
	],
);

export type CapitalAuditLogRow = typeof capitalAuditLog.$inferSelect;
export type NewCapitalAuditLogRow = typeof capitalAuditLog.$inferInsert;

export const capitalSmokeReports = pgTable(
	"capital_smoke_reports",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		book: text("book").default("paper").notNull(),
		startedAt: timestamp("started_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		finishedAt: timestamp("finished_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		status: text("status").notNull(),
		trigger: text("trigger").default("manual").notNull(),
		report: jsonb("report")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		createdAt,
	},
	(table) => [
		index("capital_smoke_reports_book_time_idx").on(
			table.book,
			table.startedAt,
		),
		check(
			"capital_smoke_reports_report_is_object",
			sql`jsonb_typeof(${table.report}) = 'object'`,
		),
	],
);

export type CapitalSmokeReportRow = typeof capitalSmokeReports.$inferSelect;
export type NewCapitalSmokeReportRow = typeof capitalSmokeReports.$inferInsert;
