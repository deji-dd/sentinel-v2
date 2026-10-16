import { describe, expect, it } from "bun:test";
import {
	type CalendarEvent,
	formatEventWindow,
	isWholeDayWindow,
	wholeDayWindow,
} from "./calendar-events";

/**
 * The wording rules for a window.
 *
 * The fixtures are real rows: Torn's whole-day activities and its 48-hour
 * weekend windows are both in the live data, and the two read very differently
 * once the clock is printed.
 */
function event(overrides: Partial<CalendarEvent>): CalendarEvent {
	return {
		id: "e1",
		title: "Chain",
		description: "",
		category: "chain",
		source: "faction",
		startTime: "2026-11-14T18:30:00.000Z",
		endTime: "2026-11-14T21:00:00.000Z",
		startTimestamp: 0,
		endTimestamp: 0,
		isAllDay: false,
		...overrides,
	};
}

describe("isWholeDayWindow", () => {
	it("reads whole days off the times, whatever the flag says", () => {
		// Torn's whole-day activities arrive with `isAllDay: false`.
		expect(
			isWholeDayWindow(
				event({
					startTime: "2026-10-25T00:00:00.000Z",
					endTime: "2026-11-01T23:59:59.000Z",
				}),
			),
		).toBe(true);

		// Torn's weekend windows are genuine 48 hours from midday.
		expect(
			isWholeDayWindow(
				event({
					startTime: "2026-01-31T12:00:00.000Z",
					endTime: "2026-02-02T11:59:59.000Z",
				}),
			),
		).toBe(false);

		// A stored all-day flag is enough on its own.
		expect(
			isWholeDayWindow(
				event({
					isAllDay: true,
					startTime: "2026-10-25T00:00:00.000Z",
					endTime: "2026-10-26T00:00:00.000Z",
				}),
			),
		).toBe(true);
	});
});

describe("formatEventWindow", () => {
	it("says all day instead of printing midnight to midnight", () => {
		expect(
			formatEventWindow(
				event({
					startTime: "2026-11-14T00:00:00.000Z",
					endTime: "2026-11-14T23:59:59.000Z",
				}),
			),
		).toBe("All day (TCT)");
	});

	it("keeps the clock for a window inside one day", () => {
		expect(formatEventWindow(event({}))).toBe("18:30 - 21:00 TCT");
	});

	it("names the days for a window that covers whole days", () => {
		// A week is not "all day", so the range speaks for itself.
		expect(
			formatEventWindow(
				event({
					startTime: "2026-10-25T00:00:00.000Z",
					endTime: "2026-11-01T23:59:59.000Z",
				}),
			),
		).toBe("Sun 25 Oct → Sun 1 Nov TCT");
	});

	it("reads a timed multi-day window clock-then-day at both ends", () => {
		expect(
			formatEventWindow(
				event({
					startTime: "2026-01-31T12:00:00.000Z",
					endTime: "2026-02-02T11:59:59.000Z",
				}),
			),
		).toBe("12:00 Sat 31 Jan → 11:59 Mon 2 Feb TCT");
	});

	it("reads Torn's noon-anchored personal-calendar events the same way", () => {
		// Trick or Treat, as the API serves it once it is on the noon anchor.
		expect(
			formatEventWindow(
				event({
					title: "Trick or Treat",
					source: "torn",
					startTime: "2026-10-25T12:00:00.000Z",
					endTime: "2026-11-02T11:59:59.000Z",
				}),
			),
		).toBe("12:00 Sun 25 Oct → 11:59 Mon 2 Nov TCT");
	});

	it("does not confuse a same-day window with a whole-day one", () => {
		// 00:00 to 06:00 is a slice of a day, not all of it.
		expect(
			formatEventWindow(
				event({
					startTime: "2026-11-14T00:00:00.000Z",
					endTime: "2026-11-14T06:00:00.000Z",
				}),
			),
		).toBe("00:00 - 06:00 TCT");
	});
});

/**
 * The window a one-day category — Ranked War Enlistment, Steadfast Change — is
 * written with. It has to be the whole of its date, because that is what the
 * calendar prints as "All day"; a window that stopped short of midnight would be
 * drawn as a slice of the afternoon instead.
 */
describe("wholeDayWindow", () => {
	it("covers midnight to the last second of the same day", () => {
		expect(wholeDayWindow("2026-10-13")).toEqual({
			startTime: "2026-10-13T00:00:00.000Z",
			endTime: "2026-10-13T23:59:59.000Z",
		});
	});

	it("is the shape the calendar reads back as a whole day", () => {
		const window = wholeDayWindow("2026-10-13");

		expect(
			isWholeDayWindow(
				event({
					startTime: window.startTime,
					endTime: window.endTime,
				}),
			),
		).toBe(true);

		expect(
			formatEventWindow(
				event({
					startTime: window.startTime,
					endTime: window.endTime,
				}),
			),
		).toBe("All day (TCT)");
	});
});
