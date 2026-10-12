import {
	createEmptyUserStockAlertState,
	describeUserStockAlert,
	formatStockAlertWindow,
	formatUserStockAlertThreshold,
	isUserStockAlertFlowCondition,
	readUserStockAlertFlow,
	STOCK_ALERT_RANGE_LABELS,
	STOCK_ALERT_RANGE_MINUTES,
	USER_STOCK_ALERT_COOLDOWN_MINUTES,
	USER_STOCK_ALERT_FLOW_WINDOW_MINUTES,
	type UserStockAlertEvent,
	type UserStockAlertFlowReading,
	type UserStockAlertState,
	type UserStockAlertSubscription,
} from "@sentinel/schemas";
import type { StockAlertSnapshot } from "./stock-alert-rules";

/**
 * Pure evaluation of **personal** stock alerts.
 *
 * Deliberately separate from `stock-alert-rules.ts`: guild alerts and personal
 * alerts answer different questions from the same snapshot. A guild rule asks
 * "is this market move notable enough to post?", whereas a subscription asks
 * "has this user's own condition just become true?" — and, crucially, the latter
 * must fire on the *crossing* so a price that parks above a threshold produces
 * one DM rather than one every five minutes.
 *
 * The flow conditions (`bulk_buy`, `bulk_sell`) are the one family that is not
 * about the price at all: they watch the change in a stock's outstanding share
 * count, which is the market's only visible trace of bulk buying and selling.
 * Their whole design is in `evaluateFlow`.
 *
 * Split from the worker for the same reason as the guild rules: every branch here
 * is testable without Torn, Discord or the database.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerces a stored `state` JSON blob into a usable shape.
 *
 * As with the guild state, a JSON column is untrusted input: a malformed row must
 * not crash the sweep, and must not read as "already seeded" — which would
 * silently swallow the first alert.
 */
export function normaliseUserStockAlertState(
	raw: unknown,
): UserStockAlertState {
	if (!isRecord(raw)) return createEmptyUserStockAlertState();

	return {
		seeded: raw.seeded === true,
		wasTrue: typeof raw.wasTrue === "boolean" ? raw.wasTrue : null,
		lastExtreme:
			typeof raw.lastExtreme === "number" && Number.isFinite(raw.lastExtreme)
				? raw.lastExtreme
				: null,
		lastShares:
			typeof raw.lastShares === "number" && Number.isFinite(raw.lastShares)
				? raw.lastShares
				: null,
		lastSharesAt:
			typeof raw.lastSharesAt === "number" && Number.isFinite(raw.lastSharesAt)
				? raw.lastSharesAt
				: null,
		lastAlertAt:
			typeof raw.lastAlertAt === "number" && Number.isFinite(raw.lastAlertAt)
				? raw.lastAlertAt
				: null,
	};
}

/**
 * The figures a subscription is judged on this cycle.
 *
 * Resolved up front so the trigger description and the delivered event can never
 * disagree about what was observed, and so a missing Torn figure is handled in
 * exactly one place.
 */
interface SubscriptionFacts {
	/** Percentage move across the subscription's range, when it has one. */
	changePct: number | null;
	/** The window extreme the subscription watches, when it watches one. */
	extreme: number | null;
	/** Current price, the fallback figure for every condition. */
	price: number;
	/** Outstanding shares, the figure the flow conditions are measured from. */
	shares: number | null;
}

function resolveFacts(
	snapshot: StockAlertSnapshot,
	subscription: UserStockAlertSubscription,
): SubscriptionFacts {
	const performance = subscription.range
		? snapshot.performance[subscription.range]
		: undefined;

	return {
		changePct:
			performance && Number.isFinite(performance.changePct)
				? performance.changePct
				: null,
		extreme: performance
			? subscription.condition === "new_high"
				? performance.high
				: subscription.condition === "new_low"
					? performance.low
					: null
			: null,
		price: snapshot.price,
		shares: snapshot.shares,
	};
}

/**
 * Whether the subscription's comparison currently holds, or null when the figure
 * it needs is unavailable.
 *
 * A null is treated as "no opinion" rather than "false": the state is left
 * untouched so the next cycle re-evaluates from the same edge instead of
 * manufacturing a crossing out of missing data.
 */
function evaluateComparison(
	subscription: UserStockAlertSubscription,
	facts: SubscriptionFacts,
): boolean | null {
	const { condition, threshold } = subscription;
	if (threshold === null) return null;

	switch (condition) {
		case "price_above":
			return facts.price > threshold;
		case "price_below":
			return facts.price < threshold;
		case "change_up":
			return facts.changePct === null ? null : facts.changePct >= threshold;
		case "change_down":
			return facts.changePct === null ? null : facts.changePct <= -threshold;
		default:
			return null;
	}
}

/**
 * Human-readable headline for the DM, describing what just happened.
 *
 * `flow` carries the flow figures for the two flow conditions and is null for
 * every other one; the switch stays exhaustive so adding a condition without
 * deciding what it says is a compile error rather than a silent empty message.
 */
function describeTrigger(
	subscription: UserStockAlertSubscription,
	facts: SubscriptionFacts,
	previousExtreme: number | null,
	flow: { flowShares: number; flowPct: number } | null,
): string {
	const { condition, threshold } = subscription;

	switch (condition) {
		case "price_above":
			return `Price rose above ${formatUserStockAlertThreshold(condition, threshold ?? 0)} — now $${facts.price.toFixed(2)}.`;
		case "price_below":
			return `Price fell below ${formatUserStockAlertThreshold(condition, threshold ?? 0)} — now $${facts.price.toFixed(2)}.`;
		case "change_up":
		case "change_down":
			return `${describeUserStockAlert(subscription)} — now ${(facts.changePct ?? 0).toFixed(2)}%.`;
		case "new_high":
			return `${describeUserStockAlert(subscription)} — beat ${
				previousExtreme === null
					? "no recorded high"
					: `$${previousExtreme.toFixed(2)}`
			} with $${(facts.extreme ?? facts.price).toFixed(2)}.`;
		case "new_low":
			return `${describeUserStockAlert(subscription)} — broke ${
				previousExtreme === null
					? "no recorded low"
					: `$${previousExtreme.toFixed(2)}`
			} down to $${(facts.extreme ?? facts.price).toFixed(2)}.`;
		case "bulk_buy":
		case "bulk_buy_shares":
		case "bulk_sell":
		case "bulk_sell_shares":
			return flow === null
				? describeUserStockAlert(subscription)
				: `${describeUserStockAlert(subscription)} — ${formatSignedShares(flow.flowShares)} shares (${formatSignedPct(flow.flowPct)} of the float) at $${facts.price.toFixed(2)}.`;
	}
}

/**
 * Builds the deliverable payload.
 *
 * The market event is a real `StockAlertEvent` so the bot renders the DM with the
 * same embed builder it uses for channel posts — one representation, two
 * destinations.
 */
function buildEvent(
	subscription: UserStockAlertSubscription,
	snapshot: StockAlertSnapshot,
	facts: SubscriptionFacts,
	previousExtreme: number | null,
	nowMs: number,
): UserStockAlertEvent {
	const { condition, range, threshold } = subscription;
	const isExtreme = condition === "new_high" || condition === "new_low";
	const isPercent = condition === "change_up" || condition === "change_down";
	const rangeMinutes = range ? STOCK_ALERT_RANGE_MINUTES[range] : null;
	const performance = range ? snapshot.performance[range] : undefined;

	return {
		subscriptionId: subscription.id,
		discordUserId: subscription.discordUserId,
		condition,
		description: describeTrigger(subscription, facts, previousExtreme, null),
		event: {
			type:
				condition === "new_high"
					? "high"
					: condition === "new_low"
						? "low"
						: "change",
			alertKey: `user:${condition}:${range ?? "-"}:${threshold ?? "-"}`,
			stockId: snapshot.stockId,
			name: snapshot.name,
			acronym: snapshot.acronym,
			price: snapshot.price,
			windowLabel: range ? STOCK_ALERT_RANGE_LABELS[range] : "now",
			// A price alert has no range of its own, so it opens at the daily period.
			range: range ?? undefined,
			changePct: isPercent ? (facts.changePct ?? undefined) : undefined,
			referencePrice: performance?.start,
			referenceAt:
				rangeMinutes === null ? undefined : nowMs - rangeMinutes * 60_000,
			thresholdPct: isPercent ? (threshold ?? undefined) : undefined,
			extreme: isExtreme ? (facts.extreme ?? undefined) : undefined,
			previousExtreme: isExtreme ? (previousExtreme ?? undefined) : undefined,
			context: {
				ranges:
					range && performance
						? [
								{
									range,
									label: STOCK_ALERT_RANGE_LABELS[range],
									high: performance.high,
									low: performance.low,
								},
							]
						: [],
			},
		},
	};
}

/** e.g. `+345,120,977` or `-12,004,551`, for reads like "shares issued". */
function formatSignedShares(value: number): string {
	const sign = value >= 0 ? "+" : "-";
	return `${sign}${Math.abs(value).toLocaleString("en-US")}`;
}

/** e.g. `+1.31%` or `-0.42%`. */
function formatSignedPct(value: number): string {
	const sign = value >= 0 ? "+" : "";
	return `${sign}${value.toFixed(2)}%`;
}

/**
 * The window a flow alert actually measured, in minutes.
 *
 * A skipped or slow cycle makes this longer than the nominal cadence, so the
 * alert reports what it measured rather than what the schedule promised.
 */
function flowWindowMinutes(previousAt: number | null, nowMs: number): number {
	if (previousAt === null) return USER_STOCK_ALERT_FLOW_WINDOW_MINUTES;
	const elapsed = (nowMs - previousAt) / 60_000;
	if (!Number.isFinite(elapsed) || elapsed < 1) return 1;
	return Math.round(elapsed);
}

/**
 * Builds the deliverable payload for a flow alert.
 *
 * The market event carries `type: "flow"` so the shared embed builder renders net
 * shares and the share of the float, rather than presenting a share flow as if it
 * were a price move.
 */
function buildFlowEvent(input: {
	subscription: UserStockAlertSubscription;
	snapshot: StockAlertSnapshot;
	flowShares: number;
	flowPct: number;
	windowMinutes: number;
	flow: UserStockAlertFlowReading;
}): UserStockAlertEvent {
	const { subscription, snapshot, flowShares, flowPct, windowMinutes, flow } =
		input;
	const { condition, threshold } = subscription;

	return {
		subscriptionId: subscription.id,
		discordUserId: subscription.discordUserId,
		condition,
		// Described through the shared trigger describer, so the DM and the
		// subscription list can never disagree about what the alert watches.
		description: describeTrigger(
			subscription,
			resolveFacts(snapshot, subscription),
			null,
			{ flowShares, flowPct },
		),
		event: {
			type: "flow",
			alertKey: `user:${condition}:-:${threshold ?? "-"}`,
			stockId: snapshot.stockId,
			name: snapshot.name,
			acronym: snapshot.acronym,
			price: snapshot.price,
			windowLabel: formatStockAlertWindow(windowMinutes),
			// A flow alert has no Torn range behind it: the window is the gap
			// between two sweeps, so the embed opens at the daily chart period.
			range: undefined,
			flowShares,
			flowPct,
			outstandingShares: snapshot.shares ?? undefined,
			// Carried in the unit the subscription chose, so the DM can state the
			// rule it fired under without re-reading the row.
			flowThresholdPct:
				flow.unit === "pct" ? (threshold ?? undefined) : undefined,
			flowThresholdShares:
				flow.unit === "shares" ? (threshold ?? undefined) : undefined,
			// No range context: the reader asked about market flow, not about
			// where the price sits inside a window they never chose.
			context: { ranges: [] },
		},
	};
}

/**
 * Evaluates a flow subscription against the change in outstanding shares.
 *
 * Two things differ from the price comparisons on purpose:
 *
 * - **Every sweep is a new window.** The baseline is advanced whether or not the
 *   message survives the cooldown, so a dumped block is announced once and the
 *   next sweep measures from the new share count. There is no rising-edge memory
 *   to keep — the previous baseline *is* the edge, which is also what stops a
 *   flow from re-announcing itself while it stands.
 * - **A missing share count is "no opinion".** The baseline is left untouched, so
 *   the next sweep measures from the last figure Torn actually published instead
 *   of manufacturing a flow out of a gap in the data.
 */
function evaluateFlow(input: {
	subscription: UserStockAlertSubscription;
	snapshot: StockAlertSnapshot;
	state: UserStockAlertState;
	nowMs: number;
	coolingDown: boolean;
}): UserStockAlertEvaluation {
	const { subscription, snapshot, state, nowMs } = input;
	const { shares } = snapshot;
	const { threshold } = subscription;
	const flow = readUserStockAlertFlow(subscription.condition);

	if (
		flow === null ||
		shares === null ||
		shares <= 0 ||
		threshold === null ||
		!Number.isFinite(threshold)
	) {
		return { event: null, nextState: { ...state } };
	}

	const nextState: UserStockAlertState = {
		...state,
		lastShares: shares,
		lastSharesAt: nowMs,
	};

	const previousShares = state.lastShares;
	// Seeding records the baseline only: without it, subscribing would announce
	// every outstanding share as a fresh bulk buy on the first sweep.
	if (!state.seeded || previousShares === null || previousShares <= 0) {
		nextState.seeded = true;
		return { event: null, nextState };
	}

	const flowShares = shares - previousShares;
	const flowPct = (flowShares / previousShares) * 100;
	// One comparison for all four flow conditions: the reading decides which
	// figure the threshold is measured against, and the direction decides which
	// side of zero counts. Both figures are signed the same way, so negating the
	// measurement is all a sell condition needs.
	const measured = flow.unit === "shares" ? flowShares : flowPct;
	const triggered =
		(flow.direction === "buy" ? measured : -measured) >= threshold;

	if (!triggered) return { event: null, nextState };
	if (input.coolingDown) return { event: null, nextState };

	nextState.lastAlertAt = nowMs;
	return {
		event: buildFlowEvent({
			subscription,
			snapshot,
			flowShares,
			flowPct,
			windowMinutes: flowWindowMinutes(state.lastSharesAt, nowMs),
			flow,
		}),
		nextState,
	};
}

/** One subscription's outcome for this cycle. */
export interface UserStockAlertEvaluation {
	/** The event to deliver, or null when nothing should be sent. */
	event: UserStockAlertEvent | null;
	nextState: UserStockAlertState;
}

/**
 * Evaluates one subscription against one stock.
 *
 * Semantics:
 *
 * - The first evaluation is a **seeding** cycle. It records the current truth
 *   (whether the comparison holds, the current extreme, the current share count)
 *   and emits nothing, so subscribing to an already-true condition does not DM the
 *   moment the row is written.
 * - Comparison conditions fire on the **rising edge** only. A price that parks
 *   above a threshold is announced once; it must fall back below and cross again
 *   to be announced a second time.
 * - Extreme conditions fire when Torn's range high/low beats the one recorded for
 *   this subscription, and the record is advanced either way so a peak is
 *   announced once rather than on every cycle that still sees it.
 * - Flow conditions (`bulk_buy`, `bulk_sell`) fire when the change in outstanding
 *   shares since the previous sweep crosses the threshold in the chosen
 *   direction, and the baseline is advanced every sweep — see `evaluateFlow`.
 * - `USER_STOCK_ALERT_COOLDOWN_MINUTES` is a backstop, not the primary throttle:
 *   a price oscillating across a threshold can still only produce one DM an hour.
 */
export function evaluateUserStockAlert(params: {
	snapshot: StockAlertSnapshot;
	subscription: UserStockAlertSubscription;
	state: UserStockAlertState | null;
	nowMs: number;
	cooldownMinutes?: number;
}): UserStockAlertEvaluation {
	const { snapshot, subscription, nowMs } = params;
	const cooldownMinutes =
		params.cooldownMinutes ?? USER_STOCK_ALERT_COOLDOWN_MINUTES;
	const current = params.state ?? createEmptyUserStockAlertState();

	const coolingDown =
		current.lastAlertAt !== null &&
		cooldownMinutes > 0 &&
		nowMs - current.lastAlertAt < cooldownMinutes * 60_000;

	// Dispatched before the price facts are resolved: a flow subscription reads
	// none of them, and every guild member's subscription is evaluated on every
	// stock on every sweep.
	if (isUserStockAlertFlowCondition(subscription.condition)) {
		return evaluateFlow({
			subscription,
			snapshot,
			state: current,
			nowMs,
			coolingDown,
		});
	}

	const nextState: UserStockAlertState = { ...current };
	const facts = resolveFacts(snapshot, subscription);

	if (
		subscription.condition === "new_high" ||
		subscription.condition === "new_low"
	) {
		if (facts.extreme === null) {
			return { event: null, nextState };
		}

		if (!current.seeded) {
			nextState.seeded = true;
			nextState.lastExtreme = facts.extreme;
			return { event: null, nextState };
		}

		const previousExtreme = current.lastExtreme;
		const isNew =
			previousExtreme === null ||
			(subscription.condition === "new_high"
				? facts.extreme > previousExtreme
				: facts.extreme < previousExtreme);

		if (!isNew) return { event: null, nextState };

		// Advanced whether or not the message survives the cooldown, so a peak is
		// announced once instead of on every cycle that still sees it.
		nextState.lastExtreme = facts.extreme;
		if (coolingDown) return { event: null, nextState };

		nextState.lastAlertAt = nowMs;
		return {
			event: buildEvent(subscription, snapshot, facts, previousExtreme, nowMs),
			nextState,
		};
	}

	const holds = evaluateComparison(subscription, facts);
	// No figure to judge with: leave the edge memory untouched so the next cycle
	// re-evaluates from the same state, and do not mark it seeded.
	if (holds === null) return { event: null, nextState };

	if (!current.seeded) {
		nextState.seeded = true;
		nextState.wasTrue = holds;
		return { event: null, nextState };
	}

	const wasTrue = current.wasTrue === true;
	nextState.wasTrue = holds;

	// Rising edge only.
	if (!holds || wasTrue) return { event: null, nextState };
	if (coolingDown) return { event: null, nextState };

	nextState.lastAlertAt = nowMs;
	return {
		event: buildEvent(subscription, snapshot, facts, null, nowMs),
		nextState,
	};
}
