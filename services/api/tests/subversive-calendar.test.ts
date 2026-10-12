import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import {
	db,
	eq,
	subversiveCalendarEvents,
	subversiveRankedWars,
	tornCalendarActivities,
} from "@sentinel/database";
import { app } from "../src/app";
import {
	formatTornEventItem,
	getFactionCalendarEvents,
	getTornCalendarEvents,
	repairRolledActivity,
	resetTornCalendarCache,
	TORN_CALENDAR_ACCENT,
	tornCacheTtlMs,
} from "../src/lib/subversive-calendar";

/**
 * Coverage for the Subversive / Torn calendar.
 *
 * The formatting helpers are pure. Everything else deliberately exercises the
 * real database, because the interesting failures here are query-shaped: a
 * running ranked war is stored with `end IS NULL`, and the public calendar must
 * not leak the target score those rows carry.
 */

const FACTION_ID = 2013;
const YEAR = new Date().getUTCFullYear();
const TEST_WAR_ID = 999_000_001;
const TEST_EVENT_TITLE = "[test] calendar fixture";

/** A war Torn has not reported an end for yet — the live one. */
async function seedRunningWar(): Promise<void> {
	await db
		.delete(subversiveRankedWars)
		.where(eq(subversiveRankedWars.id, TEST_WAR_ID));
	await db.insert(subversiveRankedWars).values({
		id: TEST_WAR_ID,
		start: new Date(),
		end: null,
		target: 1234,
		status: "processed",
	});
}

async function adminCookie(): Promise<string> {
	const res = await app.handle(
		new Request("http://localhost/v2/auth/demo-login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "calendar_admin", role: "admin" }),
		}),
	);

	expect(res.status).toBe(200);
	return res.headers.get("set-cookie") ?? "";
}

async function cleanup(): Promise<void> {
	await db
		.delete(subversiveCalendarEvents)
		.where(eq(subversiveCalendarEvents.title, TEST_EVENT_TITLE));
	await db
		.delete(subversiveRankedWars)
		.where(eq(subversiveRankedWars.id, TEST_WAR_ID));
}

describe("Subversive & Torn Calendar Helper", () => {
	it("formats a raw Torn event with the official visual metadata", () => {
		const formatted = formatTornEventItem(
			{
				title: "Trick or Treat",
				description: "Dress up and attack others to fill your basket",
				start: 1792929600,
				end: 1793534400,
			},
			false,
		);

		expect(formatted.id).toContain("torn_ev");
		expect(formatted.title).toBe("Trick or Treat");
		expect(formatted.category).toBe("torn_event");
		expect(formatted.source).toBe("torn");
		// Every official activity shares one accent, whatever its badge says.
		expect(formatted.color).toBe(TORN_CALENDAR_ACCENT);
		expect(formatted.badge).toBe("Halloween");
		expect(formatted.editable).toBe(false);
		expect(formatted.startTimestamp).toBe(1792929600);
		expect(formatted.endTimestamp).toBe(1793534400);
		expect(new Date(formatted.startTime).toISOString()).toBe(
			new Date(1792929600 * 1000).toISOString(),
		);
	});

	it("marks a Torn competition as a competition", () => {
		const formatted = formatTornEventItem(
			{
				title: "Elimination",
				description: "Twelve teams enter. One team survives.",
				start: 1788609600,
				end: 1789732800,
			},
			true,
		);

		expect(formatted.id).toContain("torn_comp");
		expect(formatted.category).toBe("torn_competition");
		expect(formatted.badge).toBe("Tournament");
		expect(formatted.color).toBe(TORN_CALENDAR_ACCENT);
	});

	it("falls back to the Torn description when no metadata matches", () => {
		const formatted = formatTornEventItem(
			{
				title: "Some Brand New Torn Event",
				description: "Fresh from the calendar endpoint",
				start: 1792929600,
				end: 1793534400,
			},
			false,
		);

		expect(formatted.description).toBe("Fresh from the calendar endpoint");
		expect(formatted.badge).toBe("Torn Event");
	});
});

describe("Torn rolled-over activities", () => {
	it("leaves a coherent interval alone", () => {
		const pair = { start: 1768780800, end: 1769385599 };

		expect(repairRolledActivity(pair)).toEqual(pair);
	});

	/**
	 * Torn rolled `start` into 2027 while `end` stayed in 2026 for these three
	 * rows. Left alone the pair places the activity on no day at all, and the
	 * year filter drops it, which is how Elimination vanished from its own year.
	 */
	it("pulls a rolled start back to the occurrence its end describes", () => {
		const elimination = repairRolledActivity({
			start: 1820145600, // 2027-09-05
			end: 1789732800, // 2026-09-18
		});

		expect(elimination.start).toBe(1788609600); // 2026-09-05
		expect(elimination.end).toBe(1789732800);
		expect(elimination.end - elimination.start).toBe(13 * 24 * 60 * 60);

		const roadTrip = repairRolledActivity({
			start: 1801396800, // 2027-01-31
			end: 1770033599, // 2026-02-02
		});

		// Two days to the second: `end` is the last second of the second day.
		expect(roadTrip.end - roadTrip.start).toBe(2 * 24 * 60 * 60 - 1);
		// The repaired start is the Saturday Torn's weekend event actually uses.
		expect(new Date(roadTrip.start * 1000).getUTCDay()).toBe(6);
	});

	it("returns an interval a single year cannot repair untouched", () => {
		// A start years ahead of its end is not a rollover; inventing an interval
		// would be worse than excluding it.
		const broken = { start: 1820145600, end: 1000000000 };

		expect(repairRolledActivity(broken)).toEqual(broken);
	});
});

describe("Torn calendar source", () => {
	it("reports its source and never invents dates", async () => {
		const result = await getTornCalendarEvents({ year: YEAR });

		expect(["database", "unavailable"]).toContain(result.source);

		if (result.source === "unavailable") {
			expect(result.events).toEqual([]);
			return;
		}

		expect(result.events.length).toBeGreaterThan(0);
		for (const event of result.events) {
			expect(event.source).toBe("torn");
			expect(event.editable).toBe(false);
			expect(event.startTimestamp).toBeLessThanOrEqual(event.endTimestamp);
		}
	});

	it("filters official events to the requested year", async () => {
		const inYear = await getTornCalendarEvents({ year: YEAR });

		// A window that cannot contain the running year's calendar.
		const empty = await getTornCalendarEvents({ year: 1970 });

		expect(empty.events).toEqual([]);
		expect(inYear.events.length).toBeGreaterThanOrEqual(empty.events.length);

		const startOfYear = Date.UTC(YEAR, 0, 1) / 1000;
		const endOfYear = Date.UTC(YEAR, 11, 31, 23, 59, 59) / 1000;
		for (const event of inYear.events) {
			expect(event.startTimestamp).toBeLessThanOrEqual(endOfYear);
			expect(event.endTimestamp).toBeGreaterThanOrEqual(startOfYear);
		}
	});
});

describe("Torn calendar snapshot cache", () => {
	let savedRows: Array<typeof tornCalendarActivities.$inferSelect> = [];

	const lateSync = {
		id: "event:1768780800:[test] late sync",
		title: "[test] late sync",
		description: "lands after the API already cached an empty table",
		type: "event",
		start: 1768780800,
		end: 1769385599,
		startTime: new Date(1768780800 * 1000),
		endTime: new Date(1769385599 * 1000),
	};

	beforeAll(async () => {
		savedRows = await db.select().from(tornCalendarActivities);
	});

	afterAll(async () => {
		setSystemTime();
		resetTornCalendarCache();
		await db.delete(tornCalendarActivities);
		if (savedRows.length > 0) {
			await db.insert(tornCalendarActivities).values(savedRows);
		}
	});

	/**
	 * The API service boots before the scheduler's 00:15 sync on every fresh
	 * environment, so the first read finds an empty table. Holding that verdict
	 * for the same 24 hours as a populated snapshot is what left the dashboard
	 * telling members that official Torn events "are not available yet" on a
	 * table the scheduler had already filled.
	 */
	it("retries an empty table instead of caching it for a day", async () => {
		await db.delete(tornCalendarActivities);
		resetTornCalendarCache();

		const empty = await getTornCalendarEvents({ year: YEAR, forceFresh: true });
		expect(empty.source).toBe("unavailable");
		expect(empty.events).toEqual([]);

		await db.insert(tornCalendarActivities).values(lateSync);

		// The cached verdict still stands a moment later: that is what members saw.
		const stillStale = await getTornCalendarEvents({ year: YEAR });
		expect(stillStale.source).toBe("unavailable");

		const emptyTtl = tornCacheTtlMs({ events: [], source: "unavailable" });
		const populatedTtl = tornCacheTtlMs({ events: [], source: "database" });
		expect(emptyTtl).toBeLessThan(populatedTtl);

		// Past the retry window it re-reads and reports the table it now finds.
		setSystemTime(Date.now() + emptyTtl + 1_000);

		const recovered = await getTornCalendarEvents({ year: YEAR });
		expect(recovered.source).toBe("database");
		expect(recovered.events.map((e) => e.title)).toContain(lateSync.title);
	});
});

describe("Faction calendar events", () => {
	let eventId = "";

	beforeAll(async () => {
		await cleanup();

		const [inserted] = await db
			.insert(subversiveCalendarEvents)
			.values({
				title: TEST_EVENT_TITLE,
				description: "fixture event",
				category: "meeting",
				startTime: new Date(Date.UTC(YEAR, 5, 10, 18, 0, 0)),
				endTime: new Date(Date.UTC(YEAR, 5, 10, 19, 0, 0)),
				factionId: FACTION_ID,
			})
			.returning();

		eventId = inserted?.id ?? "";
	});

	afterAll(async () => {
		await cleanup();
	});

	it("returns stored faction events as editable", async () => {
		const events = await getFactionCalendarEvents({
			year: YEAR,
			factionId: FACTION_ID,
		});

		const stored = events.find((e) => e.id === eventId);

		expect(stored).toBeDefined();
		expect(stored?.source).toBe("faction");
		expect(stored?.editable).toBe(true);
		expect(stored?.title).toBe(TEST_EVENT_TITLE);
		expect(stored?.color).toBeTruthy();
	});

	it("includes a running ranked war, whose end is NULL", async () => {
		await seedRunningWar();

		const withWars = await getFactionCalendarEvents({
			year: YEAR,
			includeRankedWars: true,
		});
		const war = withWars.find((e) => e.id === `rw_${TEST_WAR_ID}`);

		expect(war).toBeDefined();
		expect(war?.category).toBe("war");
		// Mirrored rows have no calendar row behind them, so the UI must not
		// offer edit or delete.
		expect(war?.editable).toBe(false);
	});

	it("omits ranked wars unless the caller opts in", async () => {
		const withoutWars = await getFactionCalendarEvents({ year: YEAR });

		expect(withoutWars.some((e) => e.id === `rw_${TEST_WAR_ID}`)).toBe(false);
	});
});

describe("GET /v2/subversive/calendar", () => {
	beforeAll(async () => {
		await seedRunningWar();
	});

	afterAll(async () => {
		await cleanup();
	});

	it("rejects a non-numeric year instead of failing on it", async () => {
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=abc`),
		);

		// Elysia's schema validation answers 422; the explicit range check below
		// answers 400. Either way it must not reach the query layer.
		expect([400, 422]).toContain(res.status);
	});

	it("rejects a fractional year", async () => {
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=1.5`),
		);

		expect(res.status).toBe(400);
	});

	it("rejects an out-of-range year", async () => {
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=999999`),
		);

		expect(res.status).toBe(400);
	});

	it("rejects a faction id outside the family", async () => {
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?factionId=4242`),
		);

		expect(res.status).toBe(400);
	});

	it("serves anonymous visitors without ranked war target data", async () => {
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=${YEAR}`),
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			success: boolean;
			canEdit: boolean;
			tornEventsSource: string;
			tornEvents: Array<{ editable: boolean }>;
			factionEvents: Array<{ id: string }>;
		};

		expect(json.success).toBe(true);
		expect(json.canEdit).toBe(false);
		expect(["database", "unavailable"]).toContain(json.tornEventsSource);
		expect(json.factionEvents.some((e) => e.id.startsWith("rw_"))).toBe(false);
	});

	it("serves ranked war entries to a signed-in user", async () => {
		const cookie = await adminCookie();
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=${YEAR}`, {
				headers: { cookie },
			}),
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			canEdit: boolean;
			factionEvents: Array<{ id: string }>;
		};

		expect(json.canEdit).toBe(true);
		expect(json.factionEvents.some((e) => e.id === `rw_${TEST_WAR_ID}`)).toBe(
			true,
		);
	});

	it("publishes the accent key the calendar paints with", async () => {
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=${YEAR}`),
		);
		const json = (await res.json()) as {
			accentKey: {
				torn: { label: string; color: string };
				faction: Array<{ value: string; label: string; color: string }>;
			};
		};

		const labels = json.accentKey.faction.map((c) => c.label);
		const colors = json.accentKey.faction.map((c) => c.color);

		// Categories are the titles, so the labels are the whole vocabulary.
		expect(labels).toEqual([
			"Ranked War Enlistment",
			"Chain",
			"Competition",
			"Steadfast Change",
		]);
		// One accent each, and Torn's is its own.
		expect(new Set(colors).size).toBe(colors.length);
		expect(colors).not.toContain(json.accentKey.torn.color);
	});
});

const TUESDAY = "2026-10-13"; // a Tuesday
const WEDNESDAY = "2026-10-14";

describe("Faction calendar event writes", () => {
	let cookie = "";
	const createdIds: string[] = [];

	interface WriteResponse {
		success: boolean;
		error?: string;
		event?: {
			id: string;
			title: string;
			category: string;
			startTime: string;
			endTime: string;
			isAllDay: boolean;
			primaryStat: string | null;
			secondaryStat: string | null;
		};
	}

	const post = async (
		body: Record<string, unknown>,
	): Promise<{ status: number; json: WriteResponse }> => {
		const res = await app.handle(
			new Request("http://localhost/v2/subversive/calendar/events", {
				method: "POST",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({
					startTime: `${TUESDAY}T12:00:00.000Z`,
					endTime: `${TUESDAY}T14:00:00.000Z`,
					...body,
				}),
			}),
		);
		const json = (await res.json()) as WriteResponse;
		if (json.event?.id) createdIds.push(json.event.id);
		return { status: res.status, json };
	};

	beforeAll(async () => {
		cookie = await adminCookie();
	});

	afterAll(async () => {
		for (const id of createdIds) {
			await db
				.delete(subversiveCalendarEvents)
				.where(eq(subversiveCalendarEvents.id, id));
		}
	});

	it("titles the event from the category instead of asking for one", async () => {
		const { status, json } = await post({ category: "chain" });

		expect(status).toBe(200);
		expect(json.event?.title).toBe("Chain");
		expect(json.event?.category).toBe("chain");
	});

	it("refuses a category the form no longer offers", async () => {
		const { status, json } = await post({ category: "meeting" });

		expect(status).toBe(400);
		expect(json.error).toContain("category must be one of");
	});

	it("pins a Ranked War Enlistment to the Tuesday 12:00 TCT window", async () => {
		// Whatever time the caller sends, the window is the enlistment's own.
		const { status, json } = await post({
			category: "war",
			startTime: `${TUESDAY}T09:37:00.000Z`,
			endTime: `${TUESDAY}T09:37:00.000Z`,
		});

		expect(status).toBe(200);
		expect(json.event?.title).toBe("Ranked War Enlistment");
		expect(json.event?.startTime).toBe(`${TUESDAY}T12:00:00.000Z`);
		expect(json.event?.endTime).toBe(`${TUESDAY}T13:00:00.000Z`);
	});

	it("refuses an enlistment that is not on a Tuesday", async () => {
		const { status, json } = await post({
			category: "war",
			startTime: `${WEDNESDAY}T12:00:00.000Z`,
			endTime: `${WEDNESDAY}T13:00:00.000Z`,
		});

		expect(status).toBe(400);
		expect(json.error).toContain("Tuesday");
	});

	it("keeps the two battlestats a Steadfast Change asks for", async () => {
		const { status, json } = await post({
			category: "steadfast_change",
			primaryStat: "speed",
			secondaryStat: "dexterity",
		});

		expect(status).toBe(200);
		expect(json.event?.title).toBe("Steadfast Change");
		expect(json.event?.primaryStat).toBe("speed");
		expect(json.event?.secondaryStat).toBe("dexterity");
	});

	/**
	 * A Steadfast Change is a whole-day directive: whatever slice of a day the
	 * caller sends, the event covers full days so the calendar never shows a
	 * stat switch that starts at 09:37.
	 */
	it("spans whole days for a Steadfast Change", async () => {
		const { status, json } = await post({
			category: "steadfast_change",
			primaryStat: "strength",
			secondaryStat: "speed",
			startTime: "2026-10-13T09:37:00.000Z",
			endTime: "2026-10-15T16:04:00.000Z",
		});

		expect(status).toBe(200);
		expect(json.event?.startTime).toBe("2026-10-13T00:00:00.000Z");
		expect(json.event?.endTime).toBe("2026-10-15T23:59:59.000Z");
		expect(json.event?.isAllDay).toBe(true);
	});

	it("refuses a Steadfast Change that ends before it starts", async () => {
		const { status, json } = await post({
			category: "steadfast_change",
			primaryStat: "strength",
			secondaryStat: "speed",
			startTime: "2026-10-15T00:00:00.000Z",
			endTime: "2026-10-13T00:00:00.000Z",
		});

		expect(status).toBe(400);
		expect(json.error).toContain("endTime");
	});

	it("leaves a timed Chain event timed", async () => {
		const { json } = await post({
			category: "chain",
			startTime: "2026-10-13T18:30:00.000Z",
			endTime: "2026-10-13T21:00:00.000Z",
		});

		expect(json.event?.startTime).toBe("2026-10-13T18:30:00.000Z");
		expect(json.event?.endTime).toBe("2026-10-13T21:00:00.000Z");
		expect(json.event?.isAllDay).toBe(false);
	});

	it("refuses a Steadfast Change whose stats are missing or identical", async () => {
		const missing = await post({ category: "steadfast_change" });
		expect(missing.status).toBe(400);
		expect(missing.json.error).toContain("primaryStat");

		const duplicated = await post({
			category: "steadfast_change",
			primaryStat: "speed",
			secondaryStat: "speed",
		});
		expect(duplicated.status).toBe(400);
		expect(duplicated.json.error).toContain("different");
	});

	it("drops battlestats from a category that has none", async () => {
		const { json } = await post({
			category: "competition",
			primaryStat: "speed",
			secondaryStat: "defense",
		});

		expect(json.event?.primaryStat).toBeNull();
		expect(json.event?.secondaryStat).toBeNull();
	});

	/**
	 * Events created before the categories were cut down still exist. Editing one
	 * must not force it into a new category — but it must still be possible to
	 * move it onto one.
	 */
	it("lets a retired-category event be edited, and re-categorised on request", async () => {
		const [legacy] = await db
			.insert(subversiveCalendarEvents)
			.values({
				title: "Legacy Meeting",
				description: "created before the categories changed",
				category: "meeting",
				startTime: new Date(Date.UTC(YEAR, 5, 10, 18, 0, 0)),
				endTime: new Date(Date.UTC(YEAR, 5, 10, 19, 0, 0)),
				factionId: FACTION_ID,
			})
			.returning();

		const legacyId = legacy?.id ?? "";
		expect(legacyId).not.toBe("");

		const kept = await app.handle(
			new Request(
				`http://localhost/v2/subversive/calendar/events/${legacyId}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json", cookie },
					body: JSON.stringify({ description: "still a meeting" }),
				},
			),
		);

		expect(kept.status).toBe(200);
		const keptJson = (await kept.json()) as WriteResponse;
		expect(keptJson.event?.category).toBe("meeting");
		expect(keptJson.event?.title).toBe("Legacy Meeting");

		const moved = await app.handle(
			new Request(
				`http://localhost/v2/subversive/calendar/events/${legacyId}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json", cookie },
					body: JSON.stringify({ category: "competition" }),
				},
			),
		);

		expect(moved.status).toBe(200);
		const movedJson = (await moved.json()) as WriteResponse;
		expect(movedJson.event?.category).toBe("competition");
		expect(movedJson.event?.title).toBe("Competition");

		await db
			.delete(subversiveCalendarEvents)
			.where(eq(subversiveCalendarEvents.id, legacyId));
	});
});
