import {
	createEmptyUserShopliftingAlertState,
	readShopliftingSecurity,
	type ShopliftingSecurityStatus,
	type ShopliftingShopSnapshot,
	USER_SHOPLIFTING_ALERT_COOLDOWN_MINUTES,
	type UserShopliftingAlertCondition,
	type UserShopliftingAlertEvent,
	type UserShopliftingAlertState,
	type UserShopliftingAlertSubscription,
	type UserShopliftingAlertTransition,
} from "@sentinel/schemas";

/**
 * Pure evaluation of personal shoplifting alerts.
 *
 * Split from the worker so every branch is testable without Torn, Discord or the
 * database. The semantics mirror the personal stock alerts:
 *
 * - The first poll **seeds** the subscription and emits nothing, so subscribing
 *   while guards are already on a break does not DM immediately.
 * - Alerts fire on both **edges**: one when the watched window opens and one when
 *   it closes, so a guard's 10–15 minute break produces two messages rather than
 *   one per poll. A cooldown backstop gates only the opening edge, so a recovery
 *   DM is never dropped.
 * - A condition the shop cannot satisfy is "no opinion": the state is left
 *   untouched rather than being marked as an edge.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerces a stored `state` JSON blob into a usable shape. */
export function normaliseUserShopliftingAlertState(
	raw: unknown,
): UserShopliftingAlertState {
	if (!isRecord(raw)) return createEmptyUserShopliftingAlertState();

	return {
		seeded: raw.seeded === true,
		wasTrue: typeof raw.wasTrue === "boolean" ? raw.wasTrue : null,
		lastAlertAt:
			typeof raw.lastAlertAt === "number" && Number.isFinite(raw.lastAlertAt)
				? raw.lastAlertAt
				: null,
	};
}

/**
 * Whether the subscription's condition currently holds, or null when the shop
 * does not publish the security measure it watches.
 */
export function shopliftingConditionHolds(
	condition: UserShopliftingAlertCondition,
	statuses: ShopliftingSecurityStatus[],
): boolean | null {
	const readings = readShopliftingSecurity(statuses);

	if (condition === "all_down") {
		// A store with no recognisable security cannot be "all down" — that is
		// missing data, not a clean window.
		if (statuses.length === 0) return null;
		return statuses.every((status) => status.disabled);
	}

	const kind = condition === "cameras_down" ? "cameras" : "guards";
	const reading = readings.find((entry) => entry.kind === kind);
	if (!reading || reading.total === 0) return null;

	return reading.disabled === reading.total;
}

/** Human-readable trigger for the DM. */
function describeTrigger(
	condition: UserShopliftingAlertCondition,
	shopName: string,
	statuses: ShopliftingSecurityStatus[],
	transition: UserShopliftingAlertTransition,
): string {
	const down = statuses
		.filter((status) => status.disabled)
		.map((status) => status.title)
		.join(", ");

	if (transition === "up") {
		switch (condition) {
			case "cameras_down":
				return `Cameras back online at ${shopName}.`;
			case "guards_down":
				return `Guards back at ${shopName}.`;
			case "all_down":
				return `All security restored at ${shopName}.`;
		}
	}

	switch (condition) {
		case "cameras_down":
			return `Cameras disabled at ${shopName}.`;
		case "guards_down":
			return `Guards on break at ${shopName}.`;
		case "all_down":
			return down.length > 0
				? `All security disabled at ${shopName} — ${down}.`
				: `All security disabled at ${shopName}.`;
	}
}

/** Builds the deliverable payload for one subscription. */
function buildEvent(
	subscription: UserShopliftingAlertSubscription,
	snapshot: ShopliftingShopSnapshot,
	transition: UserShopliftingAlertTransition,
): UserShopliftingAlertEvent {
	return {
		subscriptionId: subscription.id,
		discordUserId: subscription.discordUserId,
		condition: subscription.condition,
		transition,
		description: describeTrigger(
			subscription.condition,
			snapshot.name,
			snapshot.statuses,
			transition,
		),
		shopId: snapshot.shopId,
		shopName: snapshot.name,
		statuses: snapshot.statuses,
	};
}

/** One subscription's outcome for this poll. */
export interface UserShopliftingAlertEvaluation {
	/** The event to deliver, or null when nothing should be sent. */
	event: UserShopliftingAlertEvent | null;
	nextState: UserShopliftingAlertState;
}

/**
 * Evaluates one subscription against one shop snapshot.
 *
 * `nowMs` and the optional cooldown are injected so the tests can drive edge
 * cases without sleeping; production uses the shipped defaults.
 */
export function evaluateUserShopliftingAlert(params: {
	snapshot: ShopliftingShopSnapshot;
	subscription: UserShopliftingAlertSubscription;
	state: UserShopliftingAlertState | null;
	nowMs: number;
	cooldownMinutes?: number;
}): UserShopliftingAlertEvaluation {
	const { snapshot, subscription, nowMs } = params;
	const current = params.state ?? createEmptyUserShopliftingAlertState();
	const cooldownMinutes =
		params.cooldownMinutes ?? USER_SHOPLIFTING_ALERT_COOLDOWN_MINUTES;

	const holds = shopliftingConditionHolds(
		subscription.condition,
		snapshot.statuses,
	);

	// The shop does not publish this measure: leave the edge memory alone so a
	// later poll can still see a real transition.
	if (holds === null) {
		return { event: null, nextState: { ...current } };
	}

	const nextState: UserShopliftingAlertState = { ...current };

	if (!current.seeded) {
		nextState.seeded = true;
		nextState.wasTrue = holds;
		return { event: null, nextState };
	}

	const wasTrue = current.wasTrue === true;
	nextState.wasTrue = holds;

	// A state that neither rose nor fell is the same window, not a new event.
	if (holds === wasTrue) return { event: null, nextState };

	// The cooldown is a backstop against a flapping "down" edge. Recoveries are
	// never suppressed: if a down DM was sent, the matching "back" DM is owed.
	const coolingDown =
		holds &&
		current.lastAlertAt !== null &&
		cooldownMinutes > 0 &&
		nowMs - current.lastAlertAt < cooldownMinutes * 60_000;
	if (coolingDown) return { event: null, nextState };

	nextState.lastAlertAt = nowMs;
	return {
		event: buildEvent(subscription, snapshot, holds ? "down" : "up"),
		nextState,
	};
}
