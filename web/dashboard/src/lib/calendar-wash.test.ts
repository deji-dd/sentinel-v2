import { describe, expect, it } from "bun:test";

import type { CalendarEvent } from "./calendar-events";
import {
	dayWashBackground,
	dayWashBands,
	DEFAULT_EVENT_COLOR,
} from "./calendar-wash";

/**
 * The day wash is a timeline, so these tests assert the fractions rather than
 * the CSS text: where a band starts and ends is the whole point, and the string
 * around it is just how it reaches the browser.
 */

const DAY_START = Date.UTC(2026, 3, 20, 0, 0, 0) / 1000; // 20 Apr 2026, 00:00 TCT
const HOUR = 60 * 60;

function event(
	startHour: number,
	endHour: number,
	color = "#ff0000",
): CalendarEvent {
	const start = DAY_START + startHour * HOUR;
	const end = DAY_START + endHour * HOUR - 1; // the last second covered

	return {
		id: `${startHour}-${endHour}`,
		title: "Chain",
		description: "",
		category: "chain",
		source: "faction",
		startTime: new Date(start * 1000).toISOString(),
		endTime: new Date(end * 1000).toISOString(),
		startTimestamp: start,
		endTimestamp: end,
		isAllDay: false,
		color,
	};
}

function fractions(css: string): string[] {
	return css.match(/[\d.]+%/g) ?? [];
}

describe("dayWashBands", () => {
	it("covers the whole day for an all-day event", () => {
		const [band] = dayWashBands([event(0, 24)], DAY_START);

		expect(band?.from).toBe(0);
		expect(band?.to).toBe(1);
	});

	it("covers half the day for an event that starts at noon", () => {
		const [band] = dayWashBands([event(12, 24)], DAY_START);

		expect(band?.from).toBeCloseTo(0.5, 5);
		expect(band?.to).toBe(1);
	});

	it("measures an evening chain against the day it sits in", () => {
		const [band] = dayWashBands([event(18.5, 21)], DAY_START);

		expect(band?.from).toBeCloseTo(18.5 / 24, 5);
		expect(band?.to).toBeCloseTo(21 / 24, 5);
	});

	it("falls back to the default accent when an event has no colour", () => {
		const [band] = dayWashBands([{ ...event(9, 10), color: null }], DAY_START);

		expect(band?.color).toBe(DEFAULT_EVENT_COLOR);
	});
});

describe("dayWashBackground", () => {
	it("paints nothing for a day with no events", () => {
		expect(dayWashBackground([], DAY_START)).toBe("transparent");
	});

	it("paints a full-width band for an all-day event", () => {
		const css = dayWashBackground([event(0, 24)], DAY_START);

		expect(css).toBe(
			"linear-gradient(to right, #ff0000 0.00%, #ff0000 100.00%)",
		);
	});

	it("leaves the morning transparent for a noon-anchored event", () => {
		const css = dayWashBackground([event(12, 24)], DAY_START);

		// Transparent across the morning, then the accent from noon to midnight.
		expect(css).toBe(
			"linear-gradient(to right, transparent 0.00%, transparent 50.00%, #ff0000 50.00%, #ff0000 100.00%)",
		);
	});

	it("leaves the rest of the day transparent around an evening chain", () => {
		const css = dayWashBackground([event(18.5, 21)], DAY_START);

		expect(css).toContain("transparent 0.00%");
		expect(css).toContain("#ff0000 77.08%");
		expect(css).toContain("#ff0000 87.50%");
		expect(css).toContain("transparent 87.50%");
		expect(css).toContain("transparent 100%");
	});

	it("paints two events as two bands of one day", () => {
		const css = dayWashBackground(
			[event(9, 11, "#111111"), event(18, 20, "#222222")],
			DAY_START,
		);

		// Morning band, transparent afternoon, evening band.
		expect(css).toBe(
			"linear-gradient(to right, transparent 0.00%, transparent 37.50%, #111111 37.50%, #111111 45.83%, transparent 45.83%, transparent 75.00%, #222222 75.00%, #222222 83.33%, transparent 83.33%, transparent 100%)",
		);
	});

	it("keeps the stops in order when events overlap", () => {
		const css = dayWashBackground(
			[event(0, 12, "#111111"), event(6, 18, "#222222")],
			DAY_START,
		);
		const stops = fractions(css).map((value) => Number.parseFloat(value));

		expect(stops).toEqual([...stops].sort((a, b) => a - b));
		// The second band starts where the first ended, never behind it.
		expect(css).toContain("#222222 50.00%");
	});

	it("hands the rest of a busy day to the tooltip", () => {
		const events = [1, 5, 9, 13, 17, 21].map((hour) =>
			event(hour, hour + 1, `#${hour}${hour}${hour}${hour}${hour}${hour}`),
		);
		const css = dayWashBackground(events, DAY_START);

		// The first four are painted; the last two are not.
		expect(css).not.toContain("#21212121");
		expect(css).not.toContain("#17171717");
	});
});
