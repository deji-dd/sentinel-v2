import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { db, inArray, tornCalendarActivities } from "@sentinel/database";
import { runTornReferenceSync } from "../src/workers/torn/references";
import { removeSystemApiKey, seedSystemApiKey } from "./helpers/system-api-key";

/**
 * Regression coverage for the calendar half of the reference sync.
 *
 * Torn's `/torn/calendar` only ever describes the *running* year, and each row
 * is keyed by start timestamp plus title. That combination means a date Torn
 * moves arrives as a new row while the old one lingers, and every past year
 * accumulates forever — so the sync has to prune, not just upsert.
 */

const YEAR = new Date().getUTCFullYear();
const START = Math.floor(Date.UTC(YEAR, 3, 10, 12, 0, 0) / 1000);

const COMPETITION_ID = `competition:${START}:Test Elimination`;
const EVENT_ID = `event:${START}:Test Awareness Week`;
const STALE_ID = `event:${Math.floor(Date.UTC(YEAR - 1, 4, 1, 12, 0, 0) / 1000)}:Test Last Year`;

const MANAGED_IDS = [COMPETITION_ID, EVENT_ID, STALE_ID];

function calendarFetch(body: unknown): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = input.toString();
		const json = (payload: unknown) =>
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		if (url.includes("/torn/calendar")) return json(body);
		// Every other selection the worker asks for legitimately comes back empty.
		if (url.includes("/market")) return json({ pointsmarket: {} });
		return json({});
	}) as unknown as typeof fetch;
}

async function clearRows(): Promise<void> {
	await db
		.delete(tornCalendarActivities)
		.where(inArray(tornCalendarActivities.id, MANAGED_IDS));
}

describe("Torn reference sync — calendar", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		await seedSystemApiKey();
		await clearRows();
	});

	afterAll(async () => {
		await removeSystemApiKey();
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		await clearRows();
	});

	test("persists competitions and events, pruning what Torn no longer lists", async () => {
		await db.insert(tornCalendarActivities).values({
			id: STALE_ID,
			title: "Test Last Year",
			description: "no longer in Torn's running year",
			type: "event",
			start: START - 40_000_000,
			end: START - 39_000_000,
			startTime: new Date((START - 40_000_000) * 1000),
			endTime: new Date((START - 39_000_000) * 1000),
		});

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			calendarFetch({
				calendar: {
					competitions: [
						{
							title: "Test Elimination",
							description: "Twelve teams enter.",
							start: START,
							end: START + 86_400,
							fixed_start_time: true,
						},
					],
					events: [
						{
							title: "Test Awareness Week",
							description: "Increased awareness for one week",
							start: START,
							end: START + 604_800,
						},
					],
				},
			}),
		);

		await runTornReferenceSync();

		const rows = await db
			.select()
			.from(tornCalendarActivities)
			.where(inArray(tornCalendarActivities.id, MANAGED_IDS));

		const ids = rows.map((r) => r.id).sort();
		expect(ids).toEqual([COMPETITION_ID, EVENT_ID].sort());

		const competition = rows.find((r) => r.id === COMPETITION_ID);
		expect(competition?.type).toBe("competition");
		expect(competition?.title).toBe("Test Elimination");
		expect(competition?.fixedStartTime).toBe(true);

		const event = rows.find((r) => r.id === EVENT_ID);
		expect(event?.type).toBe("event");
		expect(event?.start).toBe(START);
		expect(event?.fixedStartTime).toBe(false);
	});

	test("keeps existing rows when Torn returns a partial calendar", async () => {
		// A response missing `competitions` is not evidence that every competition
		// was cancelled, so nothing may be pruned on the strength of it.
		await db.insert(tornCalendarActivities).values({
			id: STALE_ID,
			title: "Test Last Year",
			description: "must survive a partial payload",
			type: "event",
			start: START - 40_000_000,
			end: START - 39_000_000,
			startTime: new Date((START - 40_000_000) * 1000),
			endTime: new Date((START - 39_000_000) * 1000),
		});

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			calendarFetch({
				calendar: {
					events: [
						{
							title: "Test Awareness Week",
							description: "Increased awareness for one week",
							start: START,
							end: START + 604_800,
						},
					],
				},
			}),
		);

		await runTornReferenceSync();

		const rows = await db
			.select()
			.from(tornCalendarActivities)
			.where(inArray(tornCalendarActivities.id, MANAGED_IDS));
		const ids = rows.map((r) => r.id).sort();

		expect(ids).toEqual([EVENT_ID, STALE_ID].sort());
	});
});
