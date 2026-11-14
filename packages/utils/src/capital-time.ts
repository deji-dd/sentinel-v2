/**
 * Payout calendar arithmetic.
 *
 * All schedules are UTC. `daily` and `weekly` are fixed millisecond offsets;
 * `monthly` is a calendar month with day clamping, so a lot opened on the 31st
 * pays on the last day of a shorter month rather than silently skipping it.
 */

import type { CapitalPayoutFrequency } from "../../schemas/src/capital";

export const DAY_MS = 86_400_000;

function lastDayOfMonthUtc(year: number, monthIndex: number): number {
	return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Adds one payout interval to `from`.
 *
 * `monthly` clamps the day to the target month's last day; it never rolls into
 * the following month.
 */
export function addPayoutInterval(
	from: Date,
	frequency: CapitalPayoutFrequency,
): Date {
	const next = new Date(from.getTime());

	if (frequency === "daily") {
		next.setUTCDate(next.getUTCDate() + 1);
		return next;
	}

	if (frequency === "weekly") {
		next.setUTCDate(next.getUTCDate() + 7);
		return next;
	}

	const desiredDay = next.getUTCDate();
	next.setUTCDate(1);
	next.setUTCMonth(next.getUTCMonth() + 1);
	const maxDay = lastDayOfMonthUtc(next.getUTCFullYear(), next.getUTCMonth());
	next.setUTCDate(Math.min(desiredDay, maxDay));
	return next;
}

/** The next payout after `from`; null for `none`-style lots is not modelled. */
export function nextPayoutAt(
	from: Date,
	frequency: CapitalPayoutFrequency,
): Date {
	return addPayoutInterval(from, frequency);
}

/** Whole days between two instants, floored and never negative. */
export function daysBetween(from: Date, to: Date): number {
	const delta = to.getTime() - from.getTime();
	if (!Number.isFinite(delta) || delta <= 0) return 0;
	return Math.floor(delta / DAY_MS);
}

/** Clamps an arbitrary timestamp into a UTC bucket boundary. */
export function floorToUtcBucket(at: Date, bucketMinutes: number): Date {
	if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) {
		return new Date(at.getTime());
	}
	const bucketMs = bucketMinutes * 60_000;
	const floored = Math.floor(at.getTime() / bucketMs) * bucketMs;
	return new Date(floored);
}

/** True when `at` is at or after the due instant. */
export function isDue(at: Date, dueAt: Date): boolean {
	return at.getTime() >= dueAt.getTime();
}

/**
 * The next shared payout instant for a cadence.
 *
 * All lots with the same cadence pay on the same schedule: daily at 00:00 UTC,
 * weekly on Monday 00:00 UTC, monthly on the 1st at 00:00 UTC. Aligning dates
 * this way makes the payout queue one batch per cadence instead of one date per
 * deposit, which is materially easier to operate and to explain.
 */
export function nextAlignedPayoutAt(
	from: Date,
	frequency: CapitalPayoutFrequency,
): Date {
	const year = from.getUTCFullYear();
	const month = from.getUTCMonth();
	const day = from.getUTCDate();

	if (frequency === "daily") {
		return new Date(Date.UTC(year, month, day + 1, 0, 0, 0, 0));
	}

	if (frequency === "weekly") {
		const startOfDay = Date.UTC(year, month, day, 0, 0, 0, 0);
		const weekday = new Date(startOfDay).getUTCDay();
		let daysUntilMonday = (8 - weekday) % 7;
		if (daysUntilMonday === 0) daysUntilMonday = 7;
		return new Date(startOfDay + daysUntilMonday * DAY_MS);
	}

	return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
}

/**
 * Fraction of a cadence a period must accrue before its payout is eligible.
 *
 * Alignment alone would let a lot opened moments before a boundary pay a stub
 * period: a monthly deposit on the 31st would settle on the 1st, a daily
 * deposit at 23:59 would settle one minute later. Requiring half a cadence
 * fixes that while keeping the payout calendar shared across investors.
 * Raise to `1` for a strict "one full period" rule.
 */
export const MIN_PAYOUT_ACCRUAL_FRACTION = 0.5;

/**
 * The first aligned payout a period may settle on.
 *
 * `accrualStart` is when value began accruing (a lot's `openedAt`, or the
 * moment a prior payout reset its high-water mark). The returned boundary is
 * still a shared cadence boundary, so batching is unchanged; it simply skips
 * boundaries that arrive before the period has accrued the minimum fraction.
 *
 * `now` lets a backdated lot keep its *next* boundary in the future: the
 * minimum is measured from `accrualStart`, but the first candidate is the next
 * boundary at or after `now`.
 */
export function nextEligiblePayoutAt(
	accrualStart: Date,
	frequency: CapitalPayoutFrequency,
	now: Date = accrualStart,
): Date {
	const cadenceMs =
		addPayoutInterval(accrualStart, frequency).getTime() -
		accrualStart.getTime();
	const minimumMs = cadenceMs * MIN_PAYOUT_ACCRUAL_FRACTION;
	const base = now.getTime() > accrualStart.getTime() ? now : accrualStart;
	let next = nextAlignedPayoutAt(base, frequency);

	while (next.getTime() - accrualStart.getTime() < minimumMs) {
		next = nextAlignedPayoutAt(next, frequency);
	}

	return next;
}
