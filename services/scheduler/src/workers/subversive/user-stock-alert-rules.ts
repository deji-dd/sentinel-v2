import {
	createEmptyUserStockAlertState,
	describeUserStockAlert,
	formatUserStockAlertThreshold,
	STOCK_ALERT_RANGE_LABELS,
	STOCK_ALERT_RANGE_MINUTES,
	USER_STOCK_ALERT_COOLDOWN_MINUTES,
	type UserStockAlertEvent,
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

/** Human-readable headline for the DM, describing what just happened. */
function describeTrigger(
	subscription: UserStockAlertSubscription,
	facts: SubscriptionFacts,
	previousExtreme: number | null,
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
		description: describeTrigger(subscription, facts, previousExtreme),
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
 *   (whether the comparison holds, the current extreme) and emits nothing, so
 *   subscribing to an already-true condition does not DM the moment the row is
 *   written.
 * - Comparison conditions fire on the **rising edge** only. A price that parks
 *   above a threshold is announced once; it must fall back below and cross again
 *   to be announced a second time.
 * - Extreme conditions fire when Torn's range high/low beats the one recorded for
 *   this subscription, and the record is advanced either way so a peak is
 *   announced once rather than on every cycle that still sees it.
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
	const nextState: UserStockAlertState = { ...current };
	const facts = resolveFacts(snapshot, subscription);

	const coolingDown =
		current.lastAlertAt !== null &&
		cooldownMinutes > 0 &&
		nowMs - current.lastAlertAt < cooldownMinutes * 60_000;

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
