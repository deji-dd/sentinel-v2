/**
 * Torn stock-market alerting.
 *
 * Two independent features share this vocabulary:
 *
 * - **Guild alerts** (`GuildStockAlertConfig`): one configuration per Discord
 *   guild, stored in `guild_stock_alert_configs`, posting notable moves and
 *   window highs/lows into a channel. Scoped per guild — not per Torn faction —
 *   because the channel, the sensitivity and the audience are all properties of
 *   the server, and both family factions live in it.
 * - **Personal alerts** (`UserStockAlertSubscription`): per-user subscriptions
 *   created from the `/stock-alerts` command, delivered by DM.
 *
 * Alerting is intentionally *not* a single static threshold: a move rule is a
 * `{ windowMinutes, thresholdPct }` pair, so a server can ask for both
 * "0.5% in 30 minutes" and "10% in a week" at the same time.
 */

/**
 * Ranges an alert can be scoped to.
 *
 * Every entry is one of the rolling windows Torn already publishes on
 * `/torn/{stockId}/stocks` (`chart.performance`), so no local price history is
 * required and an alert works from the first poll. Arbitrary lengths such as
 * "45 days" are deliberately absent: Torn does not publish them, and inventing
 * them would mean building and backfilling our own price series.
 */
export const STOCK_ALERT_RANGES = [
	"1h",
	"24h",
	"7d",
	"30d",
	"1y",
	"all_time",
] as const;

export type StockAlertRange = (typeof STOCK_ALERT_RANGES)[number];

/** Human-readable name of a range, e.g. `30d` -> "30 days". */
export const STOCK_ALERT_RANGE_LABELS: Record<StockAlertRange, string> = {
	"1h": "1 hour",
	"24h": "24 hours",
	"7d": "7 days",
	"30d": "30 days",
	"1y": "1 year",
	all_time: "all time",
};

/**
 * Length of each range in minutes, or null for `all_time`, which has no length.
 *
 * Used to turn a range into the change window a move rule is measured over, and
 * to keep the range and window vocabularies in step.
 */
export const STOCK_ALERT_RANGE_MINUTES: Record<StockAlertRange, number | null> =
	{
		"1h": 60,
		"24h": 1440,
		"7d": 10_080,
		"30d": 43_200,
		"1y": 525_600,
		all_time: null,
	};

export function formatStockAlertRange(range: StockAlertRange): string {
	return STOCK_ALERT_RANGE_LABELS[range];
}

/**
 * Torn's own `period` identifier for each range, used in a stock's deep link.
 *
 * Torn spells the all-time period without an underscore (`alltime`), so this
 * cannot simply be derived from the range key.
 */
export const STOCK_ALERT_RANGE_PERIODS: Record<StockAlertRange, string> = {
	"1h": "hour",
	"24h": "day",
	"7d": "week",
	"30d": "month",
	"1y": "year",
	all_time: "alltime",
};

/** Period an alert opens when it is not tied to one of the published ranges. */
export const DEFAULT_STOCK_ALERT_PERIOD = "day";

/** The chart period an alert should open, given the range it was raised for. */
export function stockAlertPeriod(range: StockAlertRange | undefined): string {
	return range ? STOCK_ALERT_RANGE_PERIODS[range] : DEFAULT_STOCK_ALERT_PERIOD;
}

/** Narrowing guard for values arriving from JSON columns or HTTP bodies. */
export function isStockAlertRange(value: unknown): value is StockAlertRange {
	return (
		typeof value === "string" &&
		(STOCK_ALERT_RANGES as readonly string[]).includes(value)
	);
}

/**
 * Move windows a rule may use, in minutes.
 *
 * Windows up to an hour are measured against the `chart.history` series
 * (1-minute resolution, last hour) returned by `/torn/{stockId}/stocks`. Longer
 * windows — one day and beyond — use that response's `chart.performance`
 * figures instead, which is why they are limited to lengths Torn actually
 * publishes.
 */
export const STOCK_ALERT_CHANGE_WINDOW_MINUTES = [
	5, 10, 15, 20, 30, 45, 60, 1440, 10_080, 43_200, 525_600,
] as const;

export type StockAlertChangeWindowMinutes =
	(typeof STOCK_ALERT_CHANGE_WINDOW_MINUTES)[number];

/**
 * The range that backs a long move window.
 *
 * Windows at or above one day are served by Torn's own rolling figures rather
 * than the hour-long history series, so each one has exactly one range behind
 * it.
 */
export const STOCK_ALERT_CHANGE_WINDOW_RANGES: Readonly<
	Partial<Record<number, StockAlertRange>>
> = {
	1440: "24h",
	10080: "7d",
	43200: "30d",
	525600: "1y",
};

/** One "notable move" rule: a percentage threshold over a minute window. */
export interface StockAlertChangeRule {
	/** Window length in minutes; must be one of `STOCK_ALERT_CHANGE_WINDOW_MINUTES`. */
	windowMinutes: number;
	/** Absolute percentage move that makes the window notable (e.g. 0.5 = 0.5%). */
	thresholdPct: number;
}

/** One Discord guild's stock-alert settings. */
export interface GuildStockAlertConfig {
	/** Master switch. Alerts also require a `channelId` to actually be posted. */
	enabled: boolean;
	/** Discord snowflake of the alert channel, or null when unrouted. */
	channelId: string | null;
	/**
	 * Notable-move rules. An empty list disables change alerts while leaving
	 * high/low alerting active.
	 */
	changeRules: StockAlertChangeRule[];
	/**
	 * Which ranges raise a high/low alert. Any combination of the six; an empty
	 * list leaves only move alerts.
	 */
	highLowRanges: StockAlertRange[];
	/**
	 * Minimum minutes between two alerts of the same kind for the same stock.
	 * Extremes are always recorded while suppressed, so the baseline never goes
	 * stale — only the message is dropped.
	 */
	cooldownMinutes: number;

	updatedAt?: string;
	updatedBy?: string;
}

export const MAX_STOCK_ALERT_CHANGE_RULES = 6;
export const MIN_STOCK_ALERT_THRESHOLD_PCT = 0.05;
/** A 500% window move is already extraordinary; anything beyond it is a data error. */
export const MAX_STOCK_ALERT_THRESHOLD_PCT = 500;
export const MAX_STOCK_ALERT_COOLDOWN_MINUTES = 1440;

/**
 * Factory defaults: disabled and unrouted, so deploying the feature never starts
 * posting until an admin opts in. The two rules cover the common cases — a quick
 * half-percent flick and a slower one-percent drift — and the two default ranges
 * are the ones the feature shipped with.
 */
export const DEFAULT_GUILD_STOCK_ALERT_CONFIG: GuildStockAlertConfig = {
	enabled: false,
	channelId: null,
	changeRules: [
		{ windowMinutes: 30, thresholdPct: 0.5 },
		{ windowMinutes: 60, thresholdPct: 1 },
	],
	highLowRanges: ["24h", "all_time"],
	cooldownMinutes: 30,
};

/**
 * Per-stock alerting memory, persisted so restarts neither re-announce an
 * extreme nor lose a cooldown.
 */
export interface StockAlertState {
	/**
	 * False until the first successful evaluation. The seeding evaluation only
	 * records baselines, so enabling the feature cannot produce an alert burst.
	 */
	seeded: boolean;
	/** Last observed price, used to skip redundant per-stock detail requests. */
	lastPrice: number | null;
	/** Highest/lowest price seen per range, seeded from Torn's own figures. */
	extremes: Partial<Record<StockAlertRange, { high: number; low: number }>>;
	/** Epoch-ms timestamp of the last emitted alert per alert key. */
	lastAlertAt: Record<string, number>;
}

/** One range's high/low context, attached to every alert for the embed body. */
export interface StockAlertRangeContext {
	range: StockAlertRange;
	/** Human-readable range, e.g. "30 days". */
	label: string;
	high: number;
	low: number;
}

/** Window high/low context attached to every alert for the embed body. */
export interface StockAlertMarketContext {
	/** One entry per range the guild tracks, in `STOCK_ALERT_RANGES` order. */
	ranges: StockAlertRangeContext[];
}

/** A single alertable event, shared by the worker, IPC transport and the bot. */
export interface StockAlertEvent {
	type: "change" | "high" | "low" | "flow";
	/** Stable identity for the alert kind, e.g. `change:30`, `high:7d`. */
	alertKey: string;
	stockId: number;
	name: string;
	acronym: string;
	/** Price observed when the alert was raised. */
	price: number;
	/** Human-readable window, e.g. "30 minutes", "7 days", "all time". */
	windowLabel: string;
	/**
	 * The rolling range this alert was raised for.
	 *
	 * Absent for intraday move alerts, which are measured from the minute history
	 * rather than from one of Torn's published ranges. Carried explicitly so an
	 * embed can open the stock at the matching chart period instead of trying to
	 * infer it back out of the human-readable label.
	 */
	range?: StockAlertRange;
	/** Change alerts: signed percentage move and the price it is measured from. */
	changePct?: number;
	referencePrice?: number;
	referenceAt?: number;
	thresholdPct?: number;
	/** High/low alerts: the new extreme and the one it replaced. */
	extreme?: number;
	previousExtreme?: number;
	/**
	 * Flow alerts: signed net shares issued (+) or retired (−) between sweeps.
	 *
	 * The scale is large by nature — the market's median hour moves a few million
	 * shares on the bigger companies — and the *percentage* below is what a reader
	 * can compare across stocks.
	 */
	flowShares?: number;
	/** Flow alerts: that flow as a signed percentage of the previous share count. */
	flowPct?: number;
	/** Flow alerts: the outstanding share count the flow was measured against. */
	outstandingShares?: number;
	/**
	 * Flow alerts: the threshold the subscription was set at, in the unit the
	 * subscription chose. Exactly one of these two is present on a flow alert, so
	 * a DM can state the rule it fired under without re-reading the subscription.
	 */
	flowThresholdPct?: number;
	flowThresholdShares?: number;
	/** Range high/low context for the embed body. */
	context: StockAlertMarketContext;
}

/** Payload of one batched alert delivery for a single Discord channel. */
export interface StockAlertBatchPayload {
	notificationChannelId: string;
	alerts: StockAlertEvent[];
}

// ─── Personal alerts ────────────────────────────────────────────────────────

/**
 * What a personal alert watches.
 *
 * The first four are **comparisons** and fire on the crossing, not while the
 * condition holds, so a price that parks above a threshold is reported once.
 * The next two are **extremes** and fire when Torn's own window high/low beats
 * the one recorded for that subscription.
 *
 * The last four are **flow** conditions and they read the market rather than the
 * price. Buying issues shares into a stock and selling retires them, so the
 * change in a stock's outstanding share count between two sweeps *is* the net
 * buy/sell pressure on it. That is the only bulk-trade signal the API can carry:
 * stocks trade instantly against the market itself, with no order book, no
 * volume figure and no player-to-player trade (`/torn/stocks` publishes a price,
 * a share count and an investor count, and nothing else). A flow alert is
 * therefore a **net** figure across every player, bounded by the alert worker's
 * sweep cadence, and blind to a buy and a sell of the same size in one window. A
 * stock split or merge also moves the share count without anybody trading.
 *
 * Each direction has two variants because the threshold has two natural units: a
 * percentage of the float, which is comparable across stocks, and an absolute
 * share count, which is what a reader watching one stock actually thinks in. The
 * unit lives in the condition rather than in a separate modal field because a
 * Discord modal is static — every field is always shown — so a "unit" select
 * would appear in front of the price alerts too and would have to be answered
 * for conditions it means nothing to.
 */
export const USER_STOCK_ALERT_CONDITIONS = [
	"price_above",
	"price_below",
	"change_up",
	"change_down",
	"new_high",
	"new_low",
	"bulk_buy",
	"bulk_buy_shares",
	"bulk_sell",
	"bulk_sell_shares",
] as const;

export type UserStockAlertCondition =
	(typeof USER_STOCK_ALERT_CONDITIONS)[number];

/**
 * Label used in the Discord select menu and the `/stock-alerts list` view.
 *
 * The four flow labels spell out their unit, because the trigger select is where
 * a reader decides what the Amount field will mean.
 */
export const USER_STOCK_ALERT_CONDITION_LABELS: Record<
	UserStockAlertCondition,
	string
> = {
	price_above: "Price rises above",
	price_below: "Price falls below",
	change_up: "Rises by %",
	change_down: "Falls by %",
	new_high: "New high",
	new_low: "New low",
	bulk_buy: "Bulk buying (% of shares)",
	bulk_buy_shares: "Bulk buying (share count)",
	bulk_sell: "Bulk selling (% of shares)",
	bulk_sell_shares: "Bulk selling (share count)",
};

/** Conditions whose threshold is a price in dollars rather than a percentage. */
export const USER_STOCK_ALERT_PRICE_CONDITIONS = [
	"price_above",
	"price_below",
] as const satisfies readonly UserStockAlertCondition[];

/** Conditions measured against one of Torn's rolling ranges. */
export const USER_STOCK_ALERT_RANGED_CONDITIONS = [
	"change_up",
	"change_down",
	"new_high",
	"new_low",
] as const satisfies readonly UserStockAlertCondition[];

/** Conditions whose threshold is a percentage move. */
export const USER_STOCK_ALERT_PERCENT_CONDITIONS = [
	"change_up",
	"change_down",
] as const satisfies readonly UserStockAlertCondition[];

/**
 * Conditions measured as net share flow against the stock's outstanding shares.
 *
 * These ignore the range select: their window is the gap between two market
 * sweeps (`USER_STOCK_ALERT_FLOW_WINDOW_MINUTES`), not one of Torn's rolling
 * ranges, so a subscription stores `rangeKey = null` exactly as the price
 * conditions do.
 */
export const USER_STOCK_ALERT_FLOW_CONDITIONS = [
	"bulk_buy",
	"bulk_buy_shares",
	"bulk_sell",
	"bulk_sell_shares",
] as const satisfies readonly UserStockAlertCondition[];

/** How one flow condition reads its threshold. */
export interface UserStockAlertFlowReading {
	/** Shares being issued into the stock, or retired out of it. */
	direction: "buy" | "sell";
	/** Whether the threshold is a share of the float or a count of shares. */
	unit: "pct" | "shares";
}

/**
 * Reads a flow condition's direction and threshold unit, or null when the
 * condition is not a flow one.
 *
 * Derived from the condition name rather than kept in a lookup table: the two
 * variants of a direction differ only by their `_shares` suffix, and a table that
 * can disagree with the vocabulary is a table that eventually will. The four
 * names are asserted against the reading in the tests.
 */
export function readUserStockAlertFlow(
	condition: UserStockAlertCondition,
): UserStockAlertFlowReading | null {
	if (
		!(USER_STOCK_ALERT_FLOW_CONDITIONS as readonly string[]).includes(condition)
	) {
		return null;
	}

	return {
		direction: condition.startsWith("bulk_buy") ? "buy" : "sell",
		unit: condition.endsWith("_shares") ? "shares" : "pct",
	};
}

export function isUserStockAlertFlowCondition(
	condition: UserStockAlertCondition,
): boolean {
	return readUserStockAlertFlow(condition) !== null;
}

export function isUserStockAlertCondition(
	value: unknown,
): value is UserStockAlertCondition {
	return (
		typeof value === "string" &&
		(USER_STOCK_ALERT_CONDITIONS as readonly string[]).includes(value)
	);
}

export function userStockAlertConditionNeedsRange(
	condition: UserStockAlertCondition,
): boolean {
	return (USER_STOCK_ALERT_RANGED_CONDITIONS as readonly string[]).includes(
		condition,
	);
}

export function userStockAlertConditionNeedsThreshold(
	condition: UserStockAlertCondition,
): boolean {
	return !(condition === "new_high" || condition === "new_low");
}

/**
 * Per-subscription memory.
 *
 * Persisted for the same reason the guild state is: a restart must not
 * re-announce a crossing the user has already been told about.
 */
export interface UserStockAlertState {
	/**
	 * False until the first successful evaluation, which only records the
	 * baseline. Without this, subscribing while a price already sits above the
	 * threshold would DM immediately.
	 */
	seeded: boolean;
	/** Edge memory for the comparison conditions: was the test true last cycle? */
	wasTrue: boolean | null;
	/** The extreme recorded for a `new_high` / `new_low` subscription. */
	lastExtreme: number | null;
	/**
	 * Flow memory: the stock's outstanding share count at the last sweep.
	 *
	 * Advanced on *every* sweep that reports a share count, not only on a
	 * delivery, so an alert describes one window's flow instead of re-reporting a
	 * dump the user has already been told about.
	 */
	lastShares: number | null;
	/** Epoch-ms of the sweep that recorded `lastShares`, for the window label. */
	lastSharesAt: number | null;
	/** Epoch-ms timestamp of the last delivery, used as a cooldown floor. */
	lastAlertAt: number | null;
}

export function createEmptyUserStockAlertState(): UserStockAlertState {
	return {
		seeded: false,
		wasTrue: null,
		lastExtreme: null,
		lastShares: null,
		lastSharesAt: null,
		lastAlertAt: null,
	};
}

/** A user's subscription to one condition on one stock, delivered by DM. */
export interface UserStockAlertSubscription {
	id: string;
	/** Discord guild the command was run in; subscriptions never cross servers. */
	guildId: string;
	discordUserId: string;
	stockId: number;
	condition: UserStockAlertCondition;
	/** Range the condition is measured over; null for the price conditions. */
	range: StockAlertRange | null;
	/** Price in dollars or percentage move, depending on the condition. */
	threshold: number | null;
	/**
	 * Canonical signature of `(stockId, condition, range, threshold)`.
	 *
	 * Duplicate subscriptions are prevented by a unique index on
	 * `(discordUserId, conditionKey)` rather than on the four columns, because
	 * Postgres treats NULLs as distinct in a unique index — which would silently
	 * allow the same `new_high` subscription twice.
	 */
	conditionKey: string;
	enabled: boolean;
	state: UserStockAlertState;
	createdAt?: string;
	updatedAt?: string;
}

/** One triggered subscription, carried over IPC to the bot for delivery. */
export interface UserStockAlertEvent {
	subscriptionId: string;
	/** Discord snowflake of the user to DM. */
	discordUserId: string;
	condition: UserStockAlertCondition;
	/** Human-readable trigger, e.g. "Price rose above $1,200.00". */
	description: string;
	/** The underlying market event, rendered by the shared embed builder. */
	event: StockAlertEvent;
}

/** Payload of one batch of personal alerts, one DM per user. */
export interface UserStockAlertBatchPayload {
	alerts: UserStockAlertEvent[];
}

/** Longest a single user may keep, so one member cannot flood the worker. */
export const MAX_USER_STOCK_ALERTS = 25;

export const MIN_USER_STOCK_ALERT_THRESHOLD_PCT = 0.5;
export const MAX_USER_STOCK_ALERT_THRESHOLD_PCT = 500;
export const MIN_USER_STOCK_ALERT_PRICE = 1;
export const MAX_USER_STOCK_ALERT_PRICE = 1_000_000_000;

/**
 * Bounds for a flow threshold, as a percentage of outstanding shares per sweep.
 *
 * Taken from the market's own behaviour rather than invented. Across ~41 days of
 * hourly candles the median hour moves about 0.01% of a large stock's shares,
 * while a whale-scale window lands at 1–2.5%. Counted over that same period, a
 * 0.25% threshold crossed 12–15 times on TSB and FHG and 23–69 times on the
 * busier stocks, and 1% only 1–12 times — so the floor sits above routine churn
 * and the ceiling well past anything the market has actually printed.
 */
export const MIN_USER_STOCK_ALERT_FLOW_PCT = 0.05;
export const MAX_USER_STOCK_ALERT_FLOW_PCT = 25;

/**
 * Bounds for a flow threshold expressed as an absolute share count.
 *
 * The floor is deliberately permissive — a hundred thousand shares is well under
 * the routine hourly churn of the big companies, so it is a choice a reader can
 * make rather than one this code makes for them — while the ceiling sits just
 * above the largest float Torn lists (~92B on HRG), because a threshold beyond
 * every float could only ever produce an alert that never fires. Counts are whole
 * numbers: a fraction of a share is not something Torn trades.
 */
export const MIN_USER_STOCK_ALERT_FLOW_SHARES = 100_000;
export const MAX_USER_STOCK_ALERT_FLOW_SHARES = 100_000_000_000;

/**
 * Sweep cadence the flow conditions measure across, in minutes.
 *
 * Mirrors the worker's five-minute cron pattern. It is the *nominal* window only
 * — a skipped cycle makes the real window longer, which is why a delivered alert
 * carries the window it actually measured.
 */
export const USER_STOCK_ALERT_FLOW_WINDOW_MINUTES = 5;

/**
 * Minimum gap between two deliveries of the same subscription.
 *
 * The comparison conditions already fire on the crossing, so this is a backstop
 * against a price oscillating around a threshold rather than the primary
 * throttle.
 */
export const USER_STOCK_ALERT_COOLDOWN_MINUTES = 60;

/** Formats a comparison threshold for humans, e.g. "$1,200.00" or "5%". */
/** Formats a threshold for humans: "$1,200.00", "5%", "0.25% of shares" or "250,000,000 shares". */
export function formatUserStockAlertThreshold(
	condition: UserStockAlertCondition,
	threshold: number,
): string {
	if (
		(USER_STOCK_ALERT_PRICE_CONDITIONS as readonly string[]).includes(condition)
	) {
		return `$${threshold.toLocaleString("en-US", {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`;
	}

	const flow = readUserStockAlertFlow(condition);
	if (flow) {
		return flow.unit === "shares"
			? `${Math.round(threshold).toLocaleString("en-US")} shares`
			: `${threshold}% of shares`;
	}

	return `${threshold}%`;
}

/**
 * Canonical signature of a subscription, used both as the uniqueness key and as
 * the modal's `custom_id` payload.
 *
 * Every part is present for every condition — an unused range becomes `-` — so
 * two subscriptions can never collide through a missing segment.
 */
export function buildUserStockAlertConditionKey(params: {
	stockId: number;
	condition: UserStockAlertCondition;
	range?: StockAlertRange | null;
	threshold?: number | null;
}): string {
	const { stockId, condition, range, threshold } = params;
	return [
		stockId,
		condition,
		range ?? "-",
		threshold === null || threshold === undefined ? "-" : threshold,
	].join(":");
}

/** One-line description of a subscription, shared by the list view and the DM. */
export function describeUserStockAlert(subscription: {
	condition: UserStockAlertCondition;
	range: StockAlertRange | null;
	threshold: number | null;
}): string {
	const { condition, range, threshold } = subscription;
	const label = USER_STOCK_ALERT_CONDITION_LABELS[condition];
	const rangeLabel = range ? STOCK_ALERT_RANGE_LABELS[range] : null;

	if (condition === "new_high" || condition === "new_low") {
		return `${label} (${rangeLabel})`;
	}

	const amount = formatUserStockAlertThreshold(condition, threshold ?? 0);
	const flow = readUserStockAlertFlow(condition);
	if (flow) {
		// Built from the direction rather than `label`: the select label spells out
		// the unit for the reader choosing it, which would read redundantly here
		// ("Bulk buying (share count) 250,000,000 shares per 5-min sweep").
		const direction = flow.direction === "buy" ? "Bulk buying" : "Bulk selling";
		return `${direction} ${amount} per ${USER_STOCK_ALERT_FLOW_WINDOW_MINUTES}-min sweep`;
	}
	if (
		(USER_STOCK_ALERT_PRICE_CONDITIONS as readonly string[]).includes(condition)
	) {
		return `${label} ${amount}`;
	}
	return `${label} ${amount} in ${rangeLabel}`;
}

/** Formats a change window in minutes for humans, e.g. 10080 -> "7 days". */
export function formatStockAlertWindow(windowMinutes: number): string {
	const range = STOCK_ALERT_CHANGE_WINDOW_RANGES[windowMinutes];
	if (range) return STOCK_ALERT_RANGE_LABELS[range];
	if (windowMinutes === 60) return "1 hour";
	return `${windowMinutes} minutes`;
}
