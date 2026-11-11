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
