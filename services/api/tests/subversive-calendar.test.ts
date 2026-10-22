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
	like,
	subversiveCalendarEvents,
	subversiveRankedWars,
	tornCalendarActivities,
} from "@sentinel/database";

import { app } from "../src/app";
import {
	formatTornEventItem,
	getFactionCalendarEvents,
	getTornCalendarEvents,
	getUpcomingCalendarEvents,
	repairRolledActivity,
	resetTornCalendarCache,
	TORN_CALENDAR_ACCENT,
	tornCacheTtlMs,
	UPCOMING_WINDOW_DAYS,
} from "../src/lib/subversive-calendar";
import { pastEventError } from "../src/routes/v2/subversive";

/**
 * Coverage for the Subversive / Torn calendar.
 *
 * The formatting helpers are pure. Everything else deliberately exercises the
 * real database, because the interesting failures here are query-shaped: the
 * upcoming window has to cross the year boundary, and the calendar must show
 * only what the family scheduled rather than back-filling from the war ledger.
 */

const FACTION_ID = 2013;
const SECOND_FACTION_ID = 27312;
const YEAR = new Date().getUTCFullYear();
const TEST_EVENT_TITLE = "[test] calendar fixture";
const UPCOMING_TITLE_PREFIX = "[test] upcoming";
const TEST_WAR_ID = 999_000_001;

/** A moment no fixture uses, so its absence from the calendar is unambiguous. */
const TEST_WAR_START = new Date(Date.UTC(YEAR, 7, 7, 7, 7, 7));

/** A war sitting in the ledger — the rows the calendar used to mirror. */
async function seedRankedWar(): Promise<void> {
	await db
		.delete(subversiveRankedWars)
		.where(eq(subversiveRankedWars.id, TEST_WAR_ID));
	await db.insert(subversiveRankedWars).values({
		id: TEST_WAR_ID,
		start: TEST_WAR_START,
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
		.delete(subversiveCalendarEvents)
		.where(like(subversiveCalendarEvents.title, `${UPCOMING_TITLE_PREFIX}%`));
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

	/**
	 * Torn fixes some of its activities to a real time and leaves the rest on
	 * personal calendar time, where the midnight in `/torn/calendar` is only a
	 * placeholder — its per-user calendar endpoint reports those as starting at
	 * 12:00 TCT.
	 */
	it("reads a midnight-fixed Torn activity as all day", () => {
		// Awareness Awareness Week: fixed_start_time true, 00:00 → 23:59:59.
		const week = formatTornEventItem({
			title: "Awareness Awareness Week",
			description: "",
			start: 1768780800,
			end: 1769385599,
			fixedStartTime: true,
		});

		expect(week.isAllDay).toBe(true);
		expect(week.startTime).toBe("2026-01-19T00:00:00.000Z");
	});

	it("leaves a fixed noon window exactly as Torn sent it", () => {
		// Weekend Road Trip: fixed_start_time true, 12:00 → 11:59:59 two days on.
		const weekend = formatTornEventItem({
			title: "Weekend Road Trip",
			description: "",
			start: 1769860800,
			end: 1770033599,
			fixedStartTime: true,
		});

		expect(weekend.isAllDay).toBe(false);
		expect(weekend.startTime).toBe("2026-01-31T12:00:00.000Z");
		expect(weekend.endTime).toBe("2026-02-02T11:59:59.000Z");
	});

	it("gives a personal-calendar day entry the 48 hours it really runs", () => {
		// World Diabetes Day: Torn describes one day, 00:00 → 23:59:59 on 14 Nov.
		// Torn City Times announced these as 48-hour events from noon TCT.
		const diabetes = formatTornEventItem({
			title: "World Diabetes Day",
			description: "Candy effects are tripled",
			start: 1794614400,
			end: 1794700799,
			fixedStartTime: false,
		});

		expect(diabetes.startTime).toBe("2026-11-14T12:00:00.000Z");
		expect(diabetes.endTime).toBe("2026-11-16T11:59:59.000Z");
		expect(diabetes.endTimestamp - diabetes.startTimestamp).toBe(
			48 * 60 * 60 - 1,
		);
		expect(diabetes.isAllDay).toBe(false);
	});

	it("keeps a personal-calendar entry that already runs longer", () => {
		// Trick or Treat: eight days in Torn's own window, eight days out — the
		// 48-hour floor never shortens an activity.
		const halloween = formatTornEventItem({
			title: "Trick or Treat",
			description: "",
			start: 1792886400,
			end: 1793577599,
			fixedStartTime: false,
		});

		expect(halloween.startTime).toBe("2026-10-25T12:00:00.000Z");
		expect(halloween.endTime).toBe("2026-11-02T11:59:59.000Z");
		expect(halloween.endTimestamp - halloween.startTimestamp).toBe(
			1793577599 - 1792886400,
		);
	});

	it("keeps Torn's raw start in the id, so an id never moves", () => {
		const shifted = formatTornEventItem({
			title: "World Diabetes Day",
			description: "",
			start: 1794614400,
			end: 1794700799,
			fixedStartTime: false,
		});

		expect(shifted.id).toContain("1794614400");
		expect(shifted.startTimestamp).not.toBe(1794614400);
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

	/**
	 * The calendar used to mirror `subversive_ranked_wars` in, which back-filled
	 * it with wars that were already over. Only what the family scheduled belongs
	 * on the calendar, so nothing derived from the ledger is served.
	 */
	it("never mirrors the ranked-war ledger into the calendar", async () => {
		await seedRankedWar();

		const warStartSec = Math.floor(TEST_WAR_START.getTime() / 1000);
		const lists = [
			await getFactionCalendarEvents({ year: YEAR }),
			await getFactionCalendarEvents({ year: YEAR, factionId: FACTION_ID }),
			await getUpcomingCalendarEvents({ now: TEST_WAR_START }),
		];

		for (const events of lists) {
			expect(events.some((e) => e.id.startsWith("rw_"))).toBe(false);
			expect(events.some((e) => e.startTimestamp === warStartSec)).toBe(false);
		}
	});
});

/**
 * The window the dashboard's "Upcoming" panel reads.
 *
 * Everything here is checked against an injected `now`, because the whole point
 * of the query is where its edges fall — a window read from the wall clock could
 * only ever be asserted relative to itself.
 */
describe("Upcoming calendar window", () => {
	const HOUR_MS = 60 * 60 * 1000;
	const DAY_MS = 24 * HOUR_MS;
	const NOW = new Date(Date.UTC(YEAR, 4, 15, 12, 0, 0)); // 15 May, 12:00 TCT

	const createdIds: string[] = [];

	async function seed(
		label: string,
		startMs: number,
		endMs: number,
		factionId: number = FACTION_ID,
	): Promise<string> {
		const [row] = await db
			.insert(subversiveCalendarEvents)
			.values({
				title: `${UPCOMING_TITLE_PREFIX} ${label}`,
				description: "upcoming window fixture",
				category: "chain",
				startTime: new Date(startMs),
				endTime: new Date(endMs),
				factionId,
			})
			.returning();

		const id = row?.id ?? "";
		createdIds.push(id);
		return id;
	}

	let idLive = "";
	let idSoon = "";
	let idInsideEdge = "";
	let idEnded = "";
	let idBeyondWindow = "";
	let idOtherFaction = "";

	beforeAll(async () => {
		await cleanup();

		idLive = await seed(
			"live",
			NOW.getTime() - 2 * HOUR_MS,
			NOW.getTime() + 2 * HOUR_MS,
		);
		idSoon = await seed(
			"soon",
			NOW.getTime() + 5 * DAY_MS,
			NOW.getTime() + 5 * DAY_MS + HOUR_MS,
		);
		idInsideEdge = await seed(
			"inside edge",
			NOW.getTime() + (UPCOMING_WINDOW_DAYS - 1) * DAY_MS,
			NOW.getTime() + (UPCOMING_WINDOW_DAYS - 1) * DAY_MS + HOUR_MS,
		);
		idEnded = await seed(
			"ended",
			NOW.getTime() - 3 * DAY_MS,
			NOW.getTime() - 2 * DAY_MS,
		);
		idBeyondWindow = await seed(
			"beyond window",
			NOW.getTime() + 45 * DAY_MS,
			NOW.getTime() + 45 * DAY_MS + HOUR_MS,
		);
		idOtherFaction = await seed(
			"other faction",
			NOW.getTime() + 3 * DAY_MS,
			NOW.getTime() + 3 * DAY_MS + HOUR_MS,
			SECOND_FACTION_ID,
		);
	});

	afterAll(async () => {
		await cleanup();
	});

	it("keeps what is live or inside the window, and drops what is not", async () => {
		const ids = (
			await getUpcomingCalendarEvents({ now: NOW, factionId: FACTION_ID })
		).map((e) => e.id);

		expect(ids).toContain(idLive);
		expect(ids).toContain(idSoon);
		expect(ids).toContain(idInsideEdge);
		// A chain that started yesterday is over; a chain three weeks out is not a
		// plan yet.
		expect(ids).not.toContain(idEnded);
		expect(ids).not.toContain(idBeyondWindow);
		// The window is scoped to the faction asked for.
		expect(ids).not.toContain(idOtherFaction);
	});

	it("orders the window by start time", async () => {
		const events = await getUpcomingCalendarEvents({
			now: NOW,
			factionId: FACTION_ID,
		});
		const starts = events.map((e) => e.startTimestamp);

		expect(starts).toEqual([...starts].sort((a, b) => a - b));
		// The live chain is under way, so it is the first thing on the list.
		expect(events[0]?.id).toBe(idLive);
	});

	it("shows a live event until it ends, not just until it starts", async () => {
		const duringWindow = await getUpcomingCalendarEvents({
			now: new Date(NOW.getTime() + 1 * HOUR_MS),
			factionId: FACTION_ID,
		});

		expect(duringWindow.map((e) => e.id)).toContain(idLive);

		const afterEnd = await getUpcomingCalendarEvents({
			now: new Date(NOW.getTime() + 3 * HOUR_MS),
			factionId: FACTION_ID,
		});

		expect(afterEnd.map((e) => e.id)).not.toContain(idLive);
	});

	/**
	 * Read in late December, a year-scoped query describes a window that is almost
	 * entirely behind `now`, so the panel would empty out exactly when members
	 * most need to see what January holds.
	 */
	it("crosses the year boundary instead of stopping at the requested year", async () => {
		const december = new Date(Date.UTC(YEAR, 11, 20, 12, 0, 0));
		const januaryEvent = await seed(
			"next year",
			Date.UTC(YEAR + 1, 0, 3, 18, 0, 0),
			Date.UTC(YEAR + 1, 0, 3, 19, 0, 0),
		);

		const upcoming = await getUpcomingCalendarEvents({
			now: december,
			factionId: FACTION_ID,
		});
		const yearScoped = await getFactionCalendarEvents({ year: YEAR });

		expect(upcoming.map((e) => e.id)).toContain(januaryEvent);
		expect(yearScoped.map((e) => e.id)).not.toContain(januaryEvent);
	});
});

describe("GET /v2/subversive/calendar", () => {
	beforeAll(async () => {
		await seedRankedWar();
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

	it("serves the same calendar to anonymous visitors as to members", async () => {
		const anonymous = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=${YEAR}`),
		);

		expect(anonymous.status).toBe(200);
		const json = (await anonymous.json()) as {
			success: boolean;
			canEdit: boolean;
			tornEventsSource: string;
			tornEvents: Array<{ editable: boolean }>;
			factionEvents: Array<{ id: string }>;
			upcoming: { windowDays: number; events: Array<{ id: string }> };
		};

		expect(json.success).toBe(true);
		expect(json.canEdit).toBe(false);
		expect(["database", "unavailable"]).toContain(json.tornEventsSource);
		// Nothing on the calendar is derived from the war ledger any more, so there
		// is nothing to withhold from a signed-out visitor.
		expect(json.factionEvents.some((e) => e.id.startsWith("rw_"))).toBe(false);

		const cookie = await adminCookie();
		const member = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=${YEAR}`, {
				headers: { cookie },
			}),
		);
		const memberJson = (await member.json()) as {
			canEdit: boolean;
			factionEvents: Array<{ id: string }>;
		};

		expect(memberJson.canEdit).toBe(true);
		expect(memberJson.factionEvents.map((e) => e.id)).toEqual(
			json.factionEvents.map((e) => e.id),
		);
	});

	it("publishes the upcoming window alongside the year", async () => {
		const res = await app.handle(
			new Request(`http://localhost/v2/subversive/calendar?year=${YEAR}`),
		);
		const json = (await res.json()) as {
			upcoming: {
				windowDays: number;
				events: Array<{
					id: string;
					startTimestamp: number;
					endTimestamp: number;
				}>;
			};
		};

		expect(json.upcoming.windowDays).toBe(UPCOMING_WINDOW_DAYS);

		const nowSec = Math.floor(Date.now() / 1000);
		for (const event of json.upcoming.events) {
			// Every entry is either live now or still ahead: an event that has ended
			// is not upcoming, whatever year it sits in.
			expect(event.endTimestamp).toBeGreaterThanOrEqual(nowSec);
			expect(event.startTimestamp).toBeLessThanOrEqual(
				nowSec + UPCOMING_WINDOW_DAYS * 24 * 60 * 60,
			);
			expect(event.id.startsWith("rw_")).toBe(false);
		}
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

/** The Monday before {@link TUESDAY}: every write fixture below is still ahead of it. */
const FIXTURE_CLOCK = new Date("2026-10-12T08:00:00.000Z");

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
		// The fixtures below are fixed to October 2026 and a create is refused once
		// its window has passed, so the clock is pinned rather than chased. Left on
		// the wall clock, `TUESDAY` quietly becomes history and these tests start
		// failing on a date instead of on a change.
		setSystemTime(FIXTURE_CLOCK);
		cookie = await adminCookie();
	});

	afterAll(async () => {
		setSystemTime();
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

	it("pins a Ranked War Enlistment to the whole Tuesday", async () => {
		// Whatever times the caller sends, the day is the enlistment's own: it runs
		// from midnight to the last second of the Tuesday it is dated.
		const { status, json } = await post({
			category: "war",
			startTime: `${TUESDAY}T09:37:00.000Z`,
			endTime: `${TUESDAY}T09:37:00.000Z`,
		});

		expect(status).toBe(200);
		expect(json.event?.title).toBe("Ranked War Enlistment");
		expect(json.event?.startTime).toBe(`${TUESDAY}T00:00:00.000Z`);
		expect(json.event?.endTime).toBe(`${TUESDAY}T23:59:59.000Z`);
		// A whole-day event, so the calendar paints the whole cell rather than an
		// hour of it.
		expect(json.event?.isAllDay).toBe(true);
	});

	it("refuses an enlistment that is not on a Tuesday", async () => {
		const { status, json } = await post({
			category: "war",
			startTime: `${WEDNESDAY}T12:00:00.000Z`,
			endTime: `${WEDNESDAY}T12:00:00.000Z`,
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
	 * A Steadfast Change is one whole day: whatever slice of a day the caller
	 * sends, the event covers that day and no more, so the calendar never shows a
	 * stat switch that starts at 09:37.
	 */
	it("pins a Steadfast Change to the whole of one day", async () => {
		const { status, json } = await post({
			category: "steadfast_change",
			primaryStat: "strength",
			secondaryStat: "speed",
			startTime: "2026-10-13T09:37:00.000Z",
			endTime: "2026-10-13T16:04:00.000Z",
		});

		expect(status).toBe(200);
		expect(json.event?.startTime).toBe("2026-10-13T00:00:00.000Z");
		expect(json.event?.endTime).toBe("2026-10-13T23:59:59.000Z");
		expect(json.event?.isAllDay).toBe(true);
	});

	/**
	 * Nothing asks for a range any more, so an end date is ignored rather than
	 * honoured — an older dashboard bundle still sending one gets the single day
	 * the event starts on. Ignoring beats refusing here: a caller cannot be told
	 * its range is wrong when a range is no longer part of the request.
	 */
	it("ignores the end a Steadfast Change is sent", async () => {
		const spanning = await post({
			category: "steadfast_change",
			primaryStat: "strength",
			secondaryStat: "speed",
			startTime: "2026-10-13T00:00:00.000Z",
			endTime: "2026-10-15T23:59:59.000Z",
		});

		expect(spanning.status).toBe(200);
		expect(spanning.json.event?.startTime).toBe("2026-10-13T00:00:00.000Z");
		expect(spanning.json.event?.endTime).toBe("2026-10-13T23:59:59.000Z");

		const backwards = await post({
			category: "steadfast_change",
			primaryStat: "strength",
			secondaryStat: "speed",
			startTime: "2026-10-15T00:00:00.000Z",
			endTime: "2026-10-13T00:00:00.000Z",
		});

		expect(backwards.status).toBe(200);
		expect(backwards.json.event?.startTime).toBe("2026-10-15T00:00:00.000Z");
		expect(backwards.json.event?.endTime).toBe("2026-10-15T23:59:59.000Z");
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

/**
 * The calendar is a plan, not a log: an event window that has already closed is
 * refused, so the grid cannot be back-filled (which is also what the removed
 * ranked-war mirror used to do by accident).
 */
describe("pastEventError", () => {
	const now = new Date("2026-10-12T08:00:00.000Z");

	it("passes a window that is still ahead", () => {
		expect(pastEventError(new Date("2026-10-12T09:00:00.000Z"), { now })).toBe(
			null,
		);
		expect(pastEventError(new Date("2027-01-01T00:00:00.000Z"), { now })).toBe(
			null,
		);
	});

	it("refuses a window that has closed", () => {
		expect(
			pastEventError(new Date("2026-10-11T23:59:59.000Z"), { now }),
		).toContain("past");
	});

	it("exempts an event that had already ended, and only that one", () => {
		// Already history: correcting its notes must stay possible.
		expect(
			pastEventError(new Date("2026-10-01T00:00:00.000Z"), {
				now,
				storedEnd: new Date("2026-09-30T00:00:00.000Z"),
			}),
		).toBeNull();

		// A live event dragged back into the past is exactly what the guard is for,
		// however far back it is dragged.
		expect(
			pastEventError(new Date("2026-10-01T00:00:00.000Z"), {
				now,
				storedEnd: new Date("2026-10-20T00:00:00.000Z"),
			}),
		).toContain("past");
	});
});

describe("Faction calendar event writes refuse the past", () => {
	const PAST_WINDOW = {
		startTime: "2026-10-05T12:00:00.000Z",
		endTime: "2026-10-05T14:00:00.000Z",
	};

	let cookie = "";
	const createdIds: string[] = [];

	const send = async (
		method: "POST" | "PUT",
		id: string | null,
		body: Record<string, unknown>,
	): Promise<{
		status: number;
		json: { success: boolean; error?: string; event?: { id: string } };
	}> => {
		const res = await app.handle(
			new Request(
				`http://localhost/v2/subversive/calendar/events${id ? `/${id}` : ""}`,
				{
					method,
					headers: { "Content-Type": "application/json", cookie },
					body: JSON.stringify(body),
				},
			),
		);
		const json = (await res.json()) as {
			success: boolean;
			error?: string;
			event?: { id: string };
		};
		if (json.event?.id) createdIds.push(json.event.id);
		return { status: res.status, json };
	};

	beforeAll(async () => {
		setSystemTime(FIXTURE_CLOCK);
		cookie = await adminCookie();
	});

	afterAll(async () => {
		setSystemTime();
		for (const id of createdIds) {
			await db
				.delete(subversiveCalendarEvents)
				.where(eq(subversiveCalendarEvents.id, id));
		}
	});

	it("refuses a create whose window has already closed", async () => {
		const { status, json } = await send("POST", null, {
			category: "chain",
			...PAST_WINDOW,
		});

		expect(status).toBe(400);
		expect(json.error).toContain("past");
		expect(json.event).toBeUndefined();
	});

	it("still accepts a chain that is running right now", async () => {
		// The rule is about windows that have closed, not about start times.
		const { status, json } = await send("POST", null, {
			category: "chain",
			startTime: "2026-10-12T06:00:00.000Z",
			endTime: "2026-10-12T11:00:00.000Z",
		});

		expect(status).toBe(200);
		expect(json.event?.id).toBeTruthy();
	});

	it("refuses to move an event that has not ended into the past", async () => {
		const created = await send("POST", null, {
			category: "chain",
			startTime: `${TUESDAY}T18:00:00.000Z`,
			endTime: `${TUESDAY}T20:00:00.000Z`,
		});
		const id = created.json.event?.id ?? "";
		expect(id).not.toBe("");

		const { status, json } = await send("PUT", id, PAST_WINDOW);

		expect(status).toBe(400);
		expect(json.error).toContain("past");
	});

	it("lets an event that already ended be corrected", async () => {
		// The API refuses to create this row, so it is seeded directly — which is
		// also how every event that is already history got there.
		const [past] = await db
			.insert(subversiveCalendarEvents)
			.values({
				title: "[test] upcoming past row",
				description: "scheduled before the guard existed",
				category: "chain",
				startTime: new Date(PAST_WINDOW.startTime),
				endTime: new Date(PAST_WINDOW.endTime),
				factionId: FACTION_ID,
			})
			.returning();

		const id = past?.id ?? "";
		expect(id).not.toBe("");

		const { status, json } = await send("PUT", id, {
			description: "corrected after the fact",
		});

		expect(status).toBe(200);
		expect(json.success).toBe(true);

		// And once it is history, it does not reappear as upcoming.
		const upcoming = await getUpcomingCalendarEvents({ now: FIXTURE_CLOCK });
		expect(upcoming.map((e) => e.id)).not.toContain(id);

		await db
			.delete(subversiveCalendarEvents)
			.where(eq(subversiveCalendarEvents.id, id));
	});
});
