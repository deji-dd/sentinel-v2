import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { db, eq, tornStocks } from "@sentinel/database";
import { runTornReferenceSync } from "../src/workers/torn/references";

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

		const rows = await db.select().from(tornStocks);
		expect(rows).toHaveLength(0);
	});
});
