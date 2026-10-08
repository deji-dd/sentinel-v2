import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { db, eq, tornStocks } from "@sentinel/database";
import { runTornReferenceSync } from "../src/workers/torn/references";
import { removeSystemApiKey, seedSystemApiKey } from "./helpers/system-api-key";

/**
 * Regression coverage for the stock half of the reference sync.
 *
 * The v2 payload identifies each stock with `id`. An earlier revision filtered on
 * `stock_id`, which no v2 response contains, so the filter matched nothing and
 * `torn_stocks` stayed empty while the worker reported success. These tests pin
 * the shape that is actually returned by `/torn?selections=stocks`.
 */

const TEST_STOCK_ID = 999_001;

const STOCK_PAYLOAD = {
	id: TEST_STOCK_ID,
	name: "Test Holdings",
	acronym: "TST",
	images: { logo: "https://example.test/logo.svg", full: "full.svg" },
	market: { price: 123.45, cap: 1_000, shares: 500, investors: 12 },
	bonus: {
		passive: false,
		frequency: 31,
		requirement: 1000,
		description: "$1,000",
	},
};

describe("Torn reference sync — stocks", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		// The sync resolves a Torn key from the shared pool before each request, so
		// without a key of its own it aborts before reaching the mocked `fetch` —
		// on a database with no keys, which is every clean checkout and every CI
		// run. Seeding one makes this file independent of the machine's data.
		await seedSystemApiKey();
	});

	afterAll(async () => {
		await removeSystemApiKey();
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		await db.delete(tornStocks).where(eq(tornStocks.id, String(TEST_STOCK_ID)));
	});

	test("persists stocks returned by /torn with the v2 `id` field", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url = input.toString();
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});

			// Only the stocks selection is exercised here; every other selection the
			// worker requests legitimately comes back empty.
			if (url.includes("/torn?")) {
				return json({ stocks: [STOCK_PAYLOAD] });
			}
			if (url.includes("/market")) {
				return json({ pointsmarket: {} });
			}
			return json({});
		}) as unknown as typeof fetch);

		await runTornReferenceSync();

		const row = await db.query.tornStocks.findFirst({
			where: eq(tornStocks.id, String(TEST_STOCK_ID)),
		});

		expect(row).toBeDefined();
		expect(row?.name).toBe("Test Holdings");
		expect(row?.acronym).toBe("TST");
		expect(row?.market).toEqual(STOCK_PAYLOAD.market);
		expect(row?.bonus).toEqual(STOCK_PAYLOAD.bonus);
		expect(row?.images).toEqual(STOCK_PAYLOAD.images);
	});

	test("ignores malformed stock entries instead of writing empty rows", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url = input.toString();
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});

			if (url.includes("/torn?")) {
				return json({ stocks: [{ name: "No id here" }, null] });
			}
			if (url.includes("/market")) {
				return json({ pointsmarket: {} });
			}
			return json({});
		}) as unknown as typeof fetch);

		await runTornReferenceSync();

		// Scoped to the malformed entries themselves. This used to assert the whole
		// table was empty, which only held on a database where nothing had ever
		// written a stock row — so anyone who had run the API (which refreshes prices
		// on demand) saw it fail for the wrong reason, and it could not distinguish
		// "wrote nothing" from "wrote nothing new".
		const malformed = await db.query.tornStocks.findFirst({
			where: eq(tornStocks.name, "No id here"),
		});
		expect(malformed).toBeUndefined();

		const testRow = await db.query.tornStocks.findFirst({
			where: eq(tornStocks.id, String(TEST_STOCK_ID)),
		});
		expect(testRow).toBeUndefined();
	});
});
