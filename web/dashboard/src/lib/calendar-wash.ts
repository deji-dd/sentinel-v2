import type { CalendarEvent } from "./calendar-events";

/**
 * The wash a day cell paints.
 *
 * A day cell is a timeline — midnight at the left edge, midnight at the right —
 * so an event paints the stretch of the day it actually covers rather than the
 * whole cell. A chain at 18:30 washes the evening, and a Torn activity anchored
 * at noon washes from the middle onwards, which is the difference between "this
 * day has something on it" and "this day has something on it from noon".
 *
 * Band edges are hard rather than feathered: an edge is a time, and a blurred
 * noon reads as sloppy rather than soft.
 */

/** Accent used when an event carries none. */
export const DEFAULT_EVENT_COLOR = "#228be6";

/** The width of a day cell, in the seconds it represents. */
const SECONDS_PER_DAY = 24 * 60 * 60;

/** Bands painted in one cell before the rest are left to the tooltip. */
export const MAX_WASH_BANDS = 4;

export interface WashBand {
	color: string;
	/** Where the band starts inside the day, 0 at midnight. */
	from: number;
	/** Where it ends, 1 at the following midnight. */
	to: number;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function percent(fraction: number): string {
	return `${(clamp01(fraction) * 100).toFixed(2)}%`;
}

/**
 * Where each event sits inside one day, as fractions of that day.
 *
 * Events are ordered left to right and capped, so a busy day degrades to its
 * earliest few rather than to an unreadable smear; the tooltip still lists them
 * all.
 */
export function dayWashBands(
	events: CalendarEvent[],
	dayStartSec: number,
): WashBand[] {
	return events
		.map((ev) => ({
			color: ev.color || DEFAULT_EVENT_COLOR,
			// The end is the last second the event covers, so an event ending at
			// 23:59:59 reaches the right edge of its day.
			from: clamp01((ev.startTimestamp - dayStartSec) / SECONDS_PER_DAY),
			to: clamp01((ev.endTimestamp + 1 - dayStartSec) / SECONDS_PER_DAY),
		}))
		.sort((a, b) => a.from - b.from)
		.slice(0, MAX_WASH_BANDS);
}

/**
 * The CSS `background` for a day cell: one colour band per event across the
 * stretch of the day that event covers, and nothing where the day is free.
 */
export function dayWashBackground(
	events: CalendarEvent[],
	dayStartSec: number,
): string {
	const bands = dayWashBands(events, dayStartSec);
	if (bands.length === 0) return "transparent";

	const stops: string[] = [];
	let painted = 0;

	for (const band of bands) {
		// Overlapping events never run the gradient backwards: a band starts where
		// the painted part of the day has reached, not behind it.
		const from = Math.max(band.from, painted);
		const to = Math.max(band.to, from);
		if (to <= from) continue;

		// An uncovered stretch stays flat rather than fading, so the band still
		// starts on a hard edge at the time the event does.
		if (from > painted) {
			stops.push(
				`transparent ${percent(painted)}`,
				`transparent ${percent(from)}`,
			);
		}
		stops.push(
			`${band.color} ${percent(from)}`,
			`${band.color} ${percent(to)}`,
		);
		painted = to;
	}

	if (painted < 1)
		stops.push(`transparent ${percent(painted)}`, "transparent 100%");

	return `linear-gradient(to right, ${stops.join(", ")})`;
}
