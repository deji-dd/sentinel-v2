/**
 * The shape of a calendar entry and the one wording every view uses to say when
 * it runs.
 *
 * Kept away from the page because the wording is the fiddly part — Torn's own
 * activities and the family's events describe their windows in two different
 * conventions, and all three views (the day tooltip, the day list and the
 * upcoming panel) have to agree about them.
 */

export interface CalendarEvent {
	id: string;
	title: string;
	description: string;
	category: string;
	source: "torn" | "faction";
	startTime: string; // ISO
	endTime: string; // ISO
	startTimestamp: number; // Unix seconds
	endTimestamp: number; // Unix seconds
	isAllDay: boolean;
	color?: string | null;
	badge?: string | null;
	/** Display label for `category`, which is also the event's title. */
	categoryLabel?: string;
	/** Battlestats a Steadfast Change asks members to hold. */
	primaryStat?: string | null;
	secondaryStat?: string | null;
	factionId?: number;
	createdById?: string | null;
	createdByName?: string | null;
	/**
	 * Only stored faction events can be changed. Torn's own activities are read
	 * straight from Torn's calendar table, so the API marks them `false` and the
	 * UI hides edit/delete for them.
	 */
	editable?: boolean;
}

/** `HH:MM` in Torn City Time (UTC). */
export function formatClockTime(iso: string): string {
	return new Date(iso).toLocaleTimeString("en-US", {
		timeZone: "UTC",
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** `Sat 31 Jan` — a compact UTC day, for ranges that need their dates named. */
export function formatUtcDay(iso: string): string {
	return new Date(iso).toLocaleDateString("en-GB", {
		timeZone: "UTC",
		weekday: "short",
		day: "numeric",
		month: "short",
	});
}

/** `YYYY-MM-DD` for a UTC date, so two instants can be compared by day. */
function utcDayKey(iso: string): string {
	const date = new Date(iso);
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Whether a window covers whole days rather than a slice of the clock.
 *
 * The times decide, not `isAllDay`: Torn has no such flag, so its whole-day
 * activities arrive as 00:00 to 23:59 while the stored flag says they are timed,
 * and a faction event can be stored either way. Midnight to the last second of a
 * day is the one shape both conventions agree on.
 */
export function isWholeDayWindow(ev: CalendarEvent): boolean {
	if (ev.isAllDay) return true;

	const start = new Date(ev.startTime);
	const end = new Date(ev.endTime);

	return (
		start.getUTCHours() === 0 &&
		start.getUTCMinutes() === 0 &&
		start.getUTCSeconds() === 0 &&
		end.getUTCHours() === 23 &&
		end.getUTCMinutes() === 59 &&
		end.getUTCSeconds() === 59
	);
}

/**
 * When an event runs, in one line.
 *
 * A whole-day window prints no clock at all — "00:00 - 23:59" is not information
 * about an event that lasts all day. "All day" is kept for a window that really
 * is a single day, because a week-long event is not "all day" by any reading; a
 * longer whole-day window just states the days it covers. A timed window is
 * written left to right as clock-then-day at both ends, so a range reads the way
 * it is meant to be read:
 *
 *   one day, whole day     All day (TCT)
 *   one day, timed         18:30 - 21:00 TCT
 *   over days, whole days  Mon 19 Jan → Sun 25 Jan TCT
 *   over days, timed       12:00 Sat 31 Jan → 11:59 Mon 2 Feb TCT
 */
export function formatEventWindow(ev: CalendarEvent): string {
	const wholeDay = isWholeDayWindow(ev);
	const oneDay = utcDayKey(ev.startTime) === utcDayKey(ev.endTime);

	if (oneDay) {
		if (wholeDay) return "All day (TCT)";
		return `${formatClockTime(ev.startTime)} - ${formatClockTime(ev.endTime)} TCT`;
	}

	if (wholeDay) {
		return `${formatUtcDay(ev.startTime)} → ${formatUtcDay(ev.endTime)} TCT`;
	}

	return `${formatClockTime(ev.startTime)} ${formatUtcDay(ev.startTime)} → ${formatClockTime(ev.endTime)} ${formatUtcDay(ev.endTime)} TCT`;
}
