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
 * The window a whole-day event covers, as the payload the API is sent.
 *
 * Midnight to the last second of the same UTC day — the shape
 * {@link isWholeDayWindow} recognises, and the shape Torn's own whole-day
 * activities arrive in. A one-day category (Ranked War Enlistment, Steadfast
 * Change) is therefore written as the day it is, rather than as a range the form
 * never asked for.
 */
export function wholeDayWindow(dateValue: string): {
	startTime: string;
	endTime: string;
} {
	return {
		startTime: new Date(`${dateValue}T00:00:00Z`).toISOString(),
		endTime: new Date(`${dateValue}T23:59:59Z`).toISOString(),
	};
}

/** Whether a window opens and closes on the same UTC day. */
function coversOneUtcDay(ev: CalendarEvent): boolean {
	return utcDayKey(ev.startTime) === utcDayKey(ev.endTime);
}

/**
 * The categories that are one whole day and nothing else.
 *
 * A Ranked War Enlistment is a Tuesday and a Steadfast Change a single day, so
 * the API pins both to the day's own boundaries and neither has a window a reader
 * needs telling about. Kept as category names because the suppression is a fact
 * about these events, not about the shape of a window — see
 * {@link showsEventWindow}.
 */
const ONE_DAY_EVENT_CATEGORIES: readonly string[] = ["war", "steadfast_change"];

/**
 * Whether an event's window is worth a line.
 *
 * A one-day category says everything its date can say, so "All day (TCT)" beside
 * that date is noise — which is what Ranked War Enlistment and Steadfast Change
 * are. Every other event keeps its line, including an ordinary all-day Chain,
 * because "All day" is not something its date implies.
 *
 * The window has to agree, though: a Steadfast Change written before the category
 * became one day still spans several days, and hiding *that* range would make a
 * multi-day event read as a single day. So the line is dropped only when the
 * category is one of the one-day ones *and* the window really is one whole day.
 */
export function showsEventWindow(ev: CalendarEvent): boolean {
	if (!ONE_DAY_EVENT_CATEGORIES.includes(ev.category)) return true;
	return !(coversOneUtcDay(ev) && isWholeDayWindow(ev));
}

/**
 * When an event runs, in one line.
 *
 * A whole-day window prints no clock at all — "00:00 - 23:59" is not information
 * about an event that lasts all day — and a window that really is a single day is
 * "All day". A longer whole-day window states the days it covers, because a week
 * is not "all day" by any reading. A timed window is written left to right as
 * clock-then-day at both ends, so a range reads the way it is meant to be read:
 *
 *   one day, whole day     All day (TCT)
 *   one day, timed         18:30 - 21:00 TCT
 *   over days, whole days  Mon 19 Jan → Sun 25 Jan TCT
 *   over days, timed       12:00 Sat 31 Jan → 11:59 Mon 2 Feb TCT
 *
 * Whether a caller should print this at all is {@link showsEventWindow}'s call.
 */
export function formatEventWindow(ev: CalendarEvent): string {
	const wholeDay = isWholeDayWindow(ev);

	if (coversOneUtcDay(ev)) {
		if (wholeDay) return "All day (TCT)";
		return `${formatClockTime(ev.startTime)} - ${formatClockTime(ev.endTime)} TCT`;
	}

	if (wholeDay) {
		return `${formatUtcDay(ev.startTime)} → ${formatUtcDay(ev.endTime)} TCT`;
	}

	return `${formatClockTime(ev.startTime)} ${formatUtcDay(ev.startTime)} → ${formatClockTime(ev.endTime)} ${formatUtcDay(ev.endTime)} TCT`;
}
