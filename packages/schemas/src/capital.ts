/**
 * Shared contract for Sentinel Capital — the managed Torn stock trading fund.
 *
 * Money and unit balances cross the wire as decimal strings, not numbers:
 * PostgreSQL stores them as `numeric`, and a fund's AUM can exceed the exact
 * integer range a JS number represents. The web client formats them for display
 * and uses numbers only for chart geometry, where a fractional-dollar rounding
 * error is irrelevant.
 *
 * This module is intentionally dependency-free so both the API and the browser
 * can import it. Any new figure the dashboard renders belongs here first.
 */

/** The two books every capital row is scoped to. */
export const CAPITAL_BOOKS = ["live", "paper"] as const;
export type CapitalBook = (typeof CAPITAL_BOOKS)[number];

export function isCapitalBook(value: unknown): value is CapitalBook {
	return value === "live" || value === "paper";
}

/** How often an investor lot receives a profit distribution. */
export const CAPITAL_PAYOUT_FREQUENCIES = [
	"daily",
	"weekly",
	"monthly",
] as const;
export type CapitalPayoutFrequency =
	(typeof CAPITAL_PAYOUT_FREQUENCIES)[number];

export function isCapitalPayoutFrequency(
	value: unknown,
): value is CapitalPayoutFrequency {
	return value === "daily" || value === "weekly" || value === "monthly";
}

/** Default performance-fee rates, in basis points of distributed profit. */
export const CAPITAL_DEFAULT_FEE_BPS: Record<CapitalPayoutFrequency, number> = {
	daily: 2500,
	weekly: 1500,
	monthly: 500,
};

/** Frequency labels used in both the dashboard and Discord embeds. */
export const CAPITAL_FREQUENCY_LABELS: Record<CapitalPayoutFrequency, string> =
	{
		daily: "Daily",
		weekly: "Weekly",
		monthly: "Monthly",
	};

export const CAPITAL_INVESTOR_KINDS = [
	"user",
	"faction",
	"operator",
	"test",
] as const;
export type CapitalInvestorKind = (typeof CAPITAL_INVESTOR_KINDS)[number];

export const CAPITAL_ACCESS_ROLES = ["admin", "investor", "viewer"] as const;
export type CapitalAccessRole = (typeof CAPITAL_ACCESS_ROLES)[number];

export const CAPITAL_ORDER_SIDES = ["buy", "sell"] as const;
export type CapitalOrderSide = (typeof CAPITAL_ORDER_SIDES)[number];

export const CAPITAL_ORDER_STATUSES = [
	"recommended",
	"accepted",
	"partially_filled",
	"filled",
	"expired",
	"cancelled",
] as const;
export type CapitalOrderStatus = (typeof CAPITAL_ORDER_STATUSES)[number];

export const CAPITAL_PAYOUT_STATUSES = [
	"scheduled",
	"due",
	"unfunded",
	"partially_paid",
	"paid",
	"skipped_no_profit",
	"cancelled",
] as const;
export type CapitalPayoutStatus = (typeof CAPITAL_PAYOUT_STATUSES)[number];

export const CAPITAL_WITHDRAWAL_STATUSES = [
	"requested",
	"quoted",
	"approved",
	"queued_liquidity",
	"paid",
	"rejected",
	"cancelled",
] as const;
export type CapitalWithdrawalStatus =
	(typeof CAPITAL_WITHDRAWAL_STATUSES)[number];

export const CAPITAL_PAYMENT_KINDS = [
	"deposit",
	"payout",
	"withdrawal",
] as const;
export type CapitalPaymentKind = (typeof CAPITAL_PAYMENT_KINDS)[number];

export const CAPITAL_PAYMENT_INTENT_STATUSES = [
	"pending",
	"matched",
	"paid",
	"ignored",
	"expired",
	"variance",
] as const;
export type CapitalPaymentIntentStatus =
	(typeof CAPITAL_PAYMENT_INTENT_STATUSES)[number];

export const CAPITAL_ISSUE_KINDS = [
	"unmatched_buy",
	"unmatched_sell",
	"share_shortfall",
	"cash_overdraft",
	"unmatched_deposit",
	"unmatched_payout",
	"payment_variance",
	"withdrawal_liquidity",
	"unfunded_payout",
] as const;
export type CapitalIssueKind = (typeof CAPITAL_ISSUE_KINDS)[number];

export const CAPITAL_ISSUE_STATUSES = ["open", "resolved", "ignored"] as const;
export type CapitalIssueStatus = (typeof CAPITAL_ISSUE_STATUSES)[number];

export const CAPITAL_TRANSACTION_TYPES = [
	"deposit",
	"withdrawal",
	"buy",
	"sell",
	"dividend",
	"fee",
	"payout",
	"exit_fee",
	"reinvest",
	"adjustment",
	"seed",
] as const;
export type CapitalTransactionType = (typeof CAPITAL_TRANSACTION_TYPES)[number];

export const CAPITAL_ENGINE_RUN_STATUSES = [
	"running",
	"completed",
	"error",
] as const;
export type CapitalEngineRunStatus =
	(typeof CAPITAL_ENGINE_RUN_STATUSES)[number];

export const CAPITAL_SMOKE_STEP_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"skipped",
] as const;
export type CapitalSmokeStepStatus =
	(typeof CAPITAL_SMOKE_STEP_STATUSES)[number];

/** Where a fill came from. `decision` is an owner-confirmed unmatched trade. */
export const CAPITAL_FILL_SOURCES = [
	"torn_log",
	"manual",
	"paper",
	"decision",
] as const;
export type CapitalFillSource = (typeof CAPITAL_FILL_SOURCES)[number];

/** A decimal money or unit string, exactly as stored by PostgreSQL. */
export type CapitalDecimal = string;

/** Directions a Torn money log can take. */
export const CAPITAL_MONEY_LOG_IDS = {
	/** Money send — owner paid someone. */
	send: 4800,
	/** Money receive — someone paid the owner. */
	receive: 4810,
} as const;

// ─── Shared primitives ───────────────────────────────────────────────────────

export interface CapitalPublicFlags {
	showAum: boolean;
	showTrades: boolean;
	showHoldings: boolean;
	showFees: boolean;
}

export interface CapitalSummary {
	book: CapitalBook;
	displayName: string;
	asOfIso: string;
	inceptionIso: string | null;
	daysRunning: number | null;
	aum: CapitalDecimal;
	/** Market value of open positions (AUM minus cash). */
	positionsValue: CapitalDecimal;
	navPerUnit: CapitalDecimal;
	unitsOutstanding: CapitalDecimal;
	investedCapital: CapitalDecimal;
	cash: CapitalDecimal;
	totalReturnPct: number | null;
	sinceInceptionReturnPct: number | null;
	cumulativePayouts: CapitalDecimal;
	cumulativeFees: CapitalDecimal;
	investorCount: number;
	openIssueCount: number;
}

export interface CapitalPerformancePoint {
	capturedAtIso: string;
	navPerUnit: CapitalDecimal;
	returnPct: number;
	aum: CapitalDecimal | null;
	investorCount: number | null;
}

export interface CapitalPublicHolding {
	stockId: number;
	name: string;
	acronym: string;
	shares: number;
	price: CapitalDecimal;
	value: CapitalDecimal;
	weightPct: number;
}

export interface CapitalPublicTrade {
	id: string;
	stockId: number;
	name: string;
	acronym: string;
	side: CapitalOrderSide;
	shares: number;
	price: CapitalDecimal;
	notional: CapitalDecimal;
	/** Why this sell happened; null for buys and legacy fills. */
	exitReason: string | null;
	fees: CapitalDecimal;
	occurredAtIso: string;
}

/** Investor-level result shown on a public book page. No contacts or IDs. */
export interface CapitalPublicInvestor {
	principal: CapitalDecimal;
	currentValue: CapitalDecimal;
	totalProfit: CapitalDecimal;
	totalReturnPct: number | null;
	aprPct: number | null;
}

export interface CapitalPublicOverview {
	success: boolean;
	summary: CapitalSummary;
	flags: CapitalPublicFlags;
	performance: CapitalPerformancePoint[];
	holdings: CapitalPublicHolding[];
	positions: CapitalPositionView[];
	investors: CapitalPublicInvestor[];
	trades: CapitalPublicTrade[];
	feeSchedule: Array<{
		frequency: CapitalPayoutFrequency;
		label: string;
		feeBps: number;
	}>;
	warnings: string[];
}

// ─── Investor-facing ────────────────────────────────────────────────────────

export interface CapitalContactView {
	id: string;
	tornId: number | null;
	discordId: string | null;
	name: string | null;
	role: "primary" | "viewer";
}

export interface CapitalInvestorView {
	id: string;
	book: CapitalBook;
	kind: CapitalInvestorKind;
	displayName: string;
	/** Default cadence inherited by every new deposit. */
	frequency: CapitalPayoutFrequency;
	/** Default profit handling inherited by every new deposit. */
	payoutMode: "cash" | "reinvest";
	tornId: number | null;
	factionId: number | null;
	status: string;
	contacts: CapitalContactView[];
}

export interface CapitalLotView {
	id: string;
	book: CapitalBook;
	status: "active" | "closed";
	frequency: CapitalPayoutFrequency;
	payoutMode: "cash" | "reinvest";
	principal: CapitalDecimal;
	units: CapitalDecimal;
	navAtDeposit: CapitalDecimal;
	highWaterNav: CapitalDecimal;
	currentValue: CapitalDecimal;
	profit: CapitalDecimal;
	totalProfit: CapitalDecimal;
	returnPct: number | null;
	aprPct: number | null;
	xirrPct: number | null;
	daysInvested: number | null;
	cumulativePayouts: CapitalDecimal;
	cumulativeFees: CapitalDecimal;
	openedAtIso: string;
	lastPayoutAtIso: string | null;
	nextPayoutAtIso: string | null;
}

export interface CapitalPayoutView {
	id: string;
	book: CapitalBook;
	investmentId: string;
	investorId: string;
	investorName: string;
	frequency: CapitalPayoutFrequency;
	periodStartIso: string;
	periodEndIso: string;
	dueAtIso: string;
	grossAmount: CapitalDecimal;
	feeAmount: CapitalDecimal;
	netAmount: CapitalDecimal;
	paidAmount: CapitalDecimal;
	remainingAmount: CapitalDecimal;
	status: CapitalPayoutStatus;
	paidAtIso: string | null;
	paymentReference: string | null;
}

export interface CapitalWithdrawalView {
	id: string;
	book: CapitalBook;
	investmentId: string;
	investorId: string;
	investorName: string;
	requestedAmount: CapitalDecimal;
	unitsToRedeem: CapitalDecimal;
	grossValue: CapitalDecimal;
	principalBasis: CapitalDecimal;
	profitAmount: CapitalDecimal;
	lossAmount: CapitalDecimal;
	performanceFee: CapitalDecimal;
	exitFee: CapitalDecimal;
	netAmount: CapitalDecimal;
	liquidityWarning: string | null;
	status: CapitalWithdrawalStatus;
	requestedAtIso: string;
	quotedAtIso: string | null;
	approvedAtIso: string | null;
	paidAtIso: string | null;
	referenceCode: string | null;
	note: string | null;
}

export interface CapitalInvestorTotals {
	principal: CapitalDecimal;
	currentValue: CapitalDecimal;
	totalProfit: CapitalDecimal;
	totalReturnPct: number | null;
	aprPct: number | null;
	xirrPct: number | null;
	daysInvested: number | null;
	cumulativePayouts: CapitalDecimal;
	cumulativeFees: CapitalDecimal;
	activeLots: number;
}

export interface CapitalInvestorPortfolio {
	success: boolean;
	investor: CapitalInvestorView | null;
	totals: CapitalInvestorTotals | null;
	lots: CapitalLotView[];
	payouts: CapitalPayoutView[];
	withdrawals: CapitalWithdrawalView[];
	performance: CapitalPerformancePoint[];
	warnings: string[];
}

export interface CapitalWithdrawalQuote {
	success: boolean;
	investmentId: string;
	requestedAmount: CapitalDecimal;
	unitsToRedeem: CapitalDecimal;
	grossValue: CapitalDecimal;
	principalBasis: CapitalDecimal;
	profitAmount: CapitalDecimal;
	lossAmount: CapitalDecimal;
	performanceFee: CapitalDecimal;
	exitFee: CapitalDecimal;
	netAmount: CapitalDecimal;
	liquidityWarning: string | null;
	validUntilIso: string;
}

// ─── Admin-facing ───────────────────────────────────────────────────────────

/** An open fund position, including cost basis and live P/L. */
export interface CapitalPositionView {
	book: CapitalBook;
	stockId: number;
	stockName: string;
	acronym: string;
	shares: number;
	averageCost: CapitalDecimal;
	price: CapitalDecimal;
	costBasis: CapitalDecimal;
	marketValue: CapitalDecimal;
	unrealizedPnl: CapitalDecimal;
	unrealizedPnlPct: number | null;
	realizedPnl: CapitalDecimal;
	weightPct: number;
	/** Frozen entry stop, frozen target and since-entry high water mark. */
	stopPrice: CapitalDecimal | null;
	targetPrice: CapitalDecimal | null;
	peakPrice: CapitalDecimal | null;
	openedAtIso: string | null;
}

export interface CapitalInvestorAdminRow {
	investor: CapitalInvestorView;
	principal: CapitalDecimal;
	currentValue: CapitalDecimal;
	totalProfit: CapitalDecimal;
	totalReturnPct: number | null;
	aprPct: number | null;
	daysInvested: number | null;
	cumulativePayouts: CapitalDecimal;
	cumulativeFees: CapitalDecimal;
	activeLots: number;
	nextPayoutAtIso: string | null;
}

export interface CapitalFillView {
	id: string;
	book: CapitalBook;
	orderId: string | null;
	stockId: number;
	stockName: string;
	side: CapitalOrderSide;
	shares: number;
	price: CapitalDecimal;
	notional: CapitalDecimal;
	/** Why this sell happened; null for buys and legacy fills. */
	exitReason: string | null;
	fees: CapitalDecimal;
	source: CapitalFillSource;
	occurredAtIso: string;
	variance: {
		sharesDelta: number;
		priceDelta: CapitalDecimal;
		slippageBps: number;
		delaySeconds: number;
		notionalDelta: CapitalDecimal;
	} | null;
	note: string | null;
}

export interface CapitalOrderView {
	id: string;
	book: CapitalBook;
	stockId: number;
	stockName: string;
	acronym: string;
	side: CapitalOrderSide;
	status: CapitalOrderStatus;
	recommendedShares: number;
	filledShares: number;
	averageFillPrice: CapitalDecimal | null;
	priceGuide: CapitalDecimal;
	minPrice: CapitalDecimal | null;
	maxPrice: CapitalDecimal | null;
	score: number;
	rationale: string;
	stopPrice: CapitalDecimal | null;
	targetPrice: CapitalDecimal | null;
	exitReason: string | null;
	expectedAnnualIncome: CapitalDecimal | null;
	riskFlags: string[];
	generatedAtIso: string;
	expiresAtIso: string;
	fill: CapitalFillView | null;
}

export interface CapitalReconciliationIssueView {
	id: string;
	book: CapitalBook;
	kind: CapitalIssueKind;
	status: CapitalIssueStatus;
	stockId: number | null;
	investorId: string | null;
	title: string;
	detail: string;
	amount: CapitalDecimal | null;
	details: Record<string, unknown>;
	discordMessageId: string | null;
	discordChannelId: string | null;
	detectedAtIso: string;
	resolvedAtIso: string | null;
	resolvedBy: string | null;
	resolutionNote: string | null;
}

export interface CapitalPaymentIntentView {
	id: string;
	book: CapitalBook;
	kind: CapitalPaymentKind;
	status: CapitalPaymentIntentStatus;
	investorId: string | null;
	investorName: string | null;
	investmentId: string | null;
	/** Cadence to use if a matched deposit creates a lot. */
	frequency: CapitalPayoutFrequency | null;
	payoutMode: "cash" | "reinvest";
	payoutIds: string[];
	counterpartyTornId: number | null;
	expectedAmount: CapitalDecimal;
	matchedAmount: CapitalDecimal | null;
	tolerancePct: number;
	referenceCode: string;
	expiresAtIso: string;
	matchedLogId: string | null;
	createdAtIso: string;
	note: string | null;
}

export interface CapitalEngineStatus {
	book: CapitalBook;
	enabled: boolean;
	liveEnabled: boolean;
	status: string | null;
	lastRunAtIso: string | null;
	lastSuccessAtIso: string | null;
	dataAgeSeconds: number | null;
	stocksScored: number;
	recommendations: number;
	paperFills: number;
	lastError: string | null;
	/** Live drawdown/daily-loss/cooldown state from the last cycle. */
	risk: {
		drawdownPct: number | null;
		dailyReturnPct: number | null;
		entriesPaused: boolean;
		sizeScale: number;
		cooldownStockCount: number;
		pauseReasons: string[];
	};
}

/** Which alpha the capital desk trades. */
export const CAPITAL_SIGNAL_MODES = ["reversal", "momentum"] as const;
export type CapitalSignalMode = (typeof CAPITAL_SIGNAL_MODES)[number];

export function isCapitalSignalMode(
	value: unknown,
): value is CapitalSignalMode {
	return value === "reversal" || value === "momentum";
}

export interface CapitalSettings {
	book: CapitalBook;
	publicShowAum: boolean;
	publicShowTrades: boolean;
	publicShowHoldings: boolean;
	publicShowFees: boolean;
	feeRateDailyBps: number;
	feeRateWeeklyBps: number;
	feeRateMonthlyBps: number;
	minCashReservePct: number;
	maxEquityPct: number;
	maxStockWeightPct: number;
	maxPositions: number;
	riskPerTradePct: number;
	stopAtrMultiplier: number;
	stopMinPct: number;
	trailingTriggerR: number;
	trailingAtrMultiplier: number;
	trailingPct: number;
	tightenTrailPct: number;
	scaleOutR: number;
	scaleOutFraction: number;
	timeStopDays: number;
	minEntryScore: number;
	maxRsi: number;
	overboughtSigma: number;
	signalMode: CapitalSignalMode;
	reversalEntrySigma: number;
	reversalExitSigma: number;
	maxVolatilityPct: number;
	mlEnabled: boolean;
	mlWeight: number;
	mlMinConfidence: number;
	mlMaxModelAgeDays: number;
	regimeSmaDays: number;
	drawdownHaltPct: number;
	drawdownDeriskPct: number;
	dailyLossHaltPct: number;
	stopCooldownDays: number;
	orderValidityMinutes: number;
	staleDataSeconds: number;
	saleFeeBps: number;
	withdrawalPerformanceFeeEnabled: boolean;
	withdrawalExitFeeBps: number;
	withdrawalMinAmount: CapitalDecimal;
	withdrawalNoticeDays: number;
	paymentMatchTolerancePct: number;
	notifyUnmatchedBuys: boolean;
	paperStartingCash: CapitalDecimal;
	paperSlippageBps: number;
	paperAutoFill: boolean;
	engineEnabled: boolean;
	liveEnabled: boolean;
	updatedAtIso: string;
	updatedBy: string | null;
}

export interface CapitalAdminOverview {
	success: boolean;
	summary: CapitalSummary;
	settings: CapitalSettings;
	engine: CapitalEngineStatus;
	investors: CapitalInvestorAdminRow[];
	payoutsDue: CapitalPayoutView[];
	withdrawalsPending: CapitalWithdrawalView[];
	openIssues: CapitalReconciliationIssueView[];
	paymentIntentsPending: CapitalPaymentIntentView[];
	orders: CapitalOrderView[];
	recentFills: CapitalFillView[];
	performance: CapitalPerformancePoint[];
	holdings: CapitalPublicHolding[];
	positions: CapitalPositionView[];
	notifications: {
		unfundedPayouts: number;
		openIssues: number;
		pendingWithdrawals: number;
		pendingPayments: number;
	};
}

export interface CapitalApiCallReport {
	endpoint: string;
	keySuffix: string;
	keyOwner: number | null;
	status: number | null;
	latencyMs: number;
	errorCode: number | null;
	error: string | null;
}

export interface CapitalSmokeStep {
	id: string;
	label: string;
	status: CapitalSmokeStepStatus;
	durationMs: number;
	detail: string | null;
	error: string | null;
}

export interface CapitalSmokeReport {
	id: string;
	book: "paper";
	startedAtIso: string;
	finishedAtIso: string;
	status: "completed" | "failed";
	steps: CapitalSmokeStep[];
	apiCalls: CapitalApiCallReport[];
	dataAgeSeconds: number | null;
	stocksScored: number;
	recommendations: number;
	simulatedFills: number;
	navPerUnit: CapitalDecimal | null;
	cash: CapitalDecimal | null;
	errors: string[];
	warnings: string[];
	trigger: "manual" | "schedule";
}

export interface CapitalAccessRow {
	id: string;
	book: CapitalBook;
	tornId: number | null;
	discordId: string | null;
	role: CapitalAccessRole;
	investorId: string | null;
	note: string | null;
	createdAtIso: string;
	createdBy: string | null;
}

export interface CapitalAuditRow {
	id: string;
	book: CapitalBook;
	actorDiscordId: string | null;
	action: string;
	entityType: string;
	entityId: string;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	note: string | null;
	createdAtIso: string;
}

// ─── Discord alert payloads ─────────────────────────────────────────────────

export type CapitalAlertKind =
	| "recommendation"
	| "payout_due"
	| "withdrawal_request"
	| "risk"
	| "reconciliation"
	| "payment"
	| "key_failure";

export interface CapitalAlertField {
	name: string;
	value: string;
	inline?: boolean;
}

export interface CapitalAlertPayload {
	kind: CapitalAlertKind;
	book: CapitalBook;
	/** Torn stock id, when the alert is about a specific stock. */
	stockId?: number | null;
	title: string;
	body: string;
	fields?: CapitalAlertField[];
	/** Deep link into the dashboard, e.g. `/desk` or `/desk/paper`. */
	link?: string;
	/** Decision buttons the bot should render, if any. */
	decision?: {
		type: "unmatched_buy" | "payment";
		id: string;
		actions: string[];
	};
}

/** Deep link to a stock's owned-shares tab in Torn. */
export function tornStockUrl(stockId: number): string {
	return `https://www.torn.com/page.php?sid=stocks&stockID=${encodeURIComponent(String(stockId))}&tab=owned`;
}

export interface CapitalPaperAlertPayload {
	reportId: string;
	title: string;
	summary: string;
	success: boolean;
	link: string;
}
