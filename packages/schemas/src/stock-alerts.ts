/**
 * Torn stock-market alerting for the Subversive family factions.
 *
 * Configuration is stored per family faction (2013 / 27312) in
 * `subversive_stock_alert_configs`, mirroring how ranked-war channels and dibs
 * settings are scoped, so each faction routes its own alerts to its own channel
 * with its own sensitivity.
 *
 * Alerting is intentionally *not* a single static threshold: a rule is a
 * `{ windowMinutes, thresholdPct }` pair, so a faction can ask for both
 * "0.5% in 30 minutes" and "1% in an hour" at the same time.
 */

/**
 * Change windows a rule may use, in minutes.
 *
 * Every entry is derived from data Torn already publishes, so no local price
 * history is required: windows up to an hour are measured against the
 * `chart.history` series (1-minute resolution, last hour) returned by
 * `/torn/{stockId}/stocks`, and 1440 (one day) uses that response's
 * `chart.performance.last_day` figures.
 */
export const STOCK_ALERT_CHANGE_WINDOW_MINUTES = [
	5, 10, 15, 20, 30, 45, 60, 1440,
] as const;

export type StockAlertChangeWindowMinutes =
	(typeof STOCK_ALERT_CHANGE_WINDOW_MINUTES)[number];

/**
 * High/low windows an alert can be raised for.
 *
 * `24h` is Torn's rolling `last_day` high/low, `all_time` its `all_time`
 * counterpart. Both are maintained by Torn, so alerts work from the first poll
 * instead of waiting for a locally-built history to fill up.
 */
export const STOCK_ALERT_WINDOWS = ["24h", "all_time"] as const;

export type StockAlertWindow = (typeof STOCK_ALERT_WINDOWS)[number];

/** One "notable move" rule: a percentage threshold over a minute window. */
export interface StockAlertChangeRule {
	/** Window length in minutes; must be one of `STOCK_ALERT_CHANGE_WINDOW_MINUTES`. */
	windowMinutes: number;
	/** Absolute percentage move that makes the window notable (e.g. 0.5 = 0.5%). */
	thresholdPct: number;
}

/** A faction's stock-alert settings. */
export interface SubversiveStockAlertConfig {
	/** Master switch. Alerts also require a `channelId` to actually be posted. */
	enabled: boolean;
	/** Discord snowflake of the alert channel, or null when unrouted. */
	channelId: string | null;
	/**
	 * Notable-move rules. An empty list disables change alerts while leaving
	 * high/low alerting active.
	 */
	changeRules: StockAlertChangeRule[];
	/** Which high/low windows raise an alert. */
	highLowWindows: StockAlertWindow[];
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
export const MAX_STOCK_ALERT_THRESHOLD_PCT = 25;
export const MAX_STOCK_ALERT_COOLDOWN_MINUTES = 1440;

/**
 * Factory defaults: disabled and unrouted, so deploying the feature never starts
 * posting until an admin opts in. The two rules cover the common cases — a quick
 * half-percent flick and a slower one-percent drift.
 */
export const DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG: SubversiveStockAlertConfig =
	{
		enabled: false,
		channelId: null,
		changeRules: [
			{ windowMinutes: 30, thresholdPct: 0.5 },
			{ windowMinutes: 60, thresholdPct: 1 },
		],
		highLowWindows: ["24h", "all_time"],
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
	/** Highest/lowest price seen per window, seeded from Torn's own figures. */
	extremes: Partial<Record<StockAlertWindow, { high: number; low: number }>>;
	/** Epoch-ms timestamp of the last emitted alert per alert key. */
	lastAlertAt: Record<string, number>;
}

/** Window high/low context attached to every alert for the embed body. */
export interface StockAlertMarketContext {
	dayHigh: number;
	dayLow: number;
	allTimeHigh: number;
	allTimeLow: number;
}

/** A single alertable event, shared by the worker, IPC transport and the bot. */
export interface StockAlertEvent {
	type: "change" | "high" | "low";
	/** Stable identity for the alert kind, e.g. `change:30`, `high:24h`. */
	alertKey: string;
	stockId: number;
	name: string;
	acronym: string;
	/** Price observed when the alert was raised. */
	price: number;
	/** Human-readable window, e.g. "30 minutes", "1 hour", "all time". */
	windowLabel: string;
	/** Change alerts: signed percentage move and the price it is measured from. */
	changePct?: number;
	referencePrice?: number;
	referenceAt?: number;
	thresholdPct?: number;
	/** High/low alerts: the new extreme and the one it replaced. */
	extreme?: number;
	previousExtreme?: number;
	/** Window high/low context for the embed body. */
	context: StockAlertMarketContext;
}

/** Payload of one batched alert delivery for a single Discord channel. */
export interface StockAlertBatchPayload {
	notificationChannelId: string;
	alerts: StockAlertEvent[];
}

/** Formats a change window in minutes for humans, e.g. 1440 -> "24 hours". */
export function formatStockAlertWindow(windowMinutes: number): string {
	if (windowMinutes === 1440) return "24 hours";
	if (windowMinutes === 60) return "1 hour";
	return `${windowMinutes} minutes`;
}
