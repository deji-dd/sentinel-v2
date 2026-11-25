import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";

import {
	db,
	eq,
	POINTS_MARKET_PRICE_KEY,
	tornMarketPrices,
} from "@sentinel/database";

import { runTornReferenceSync } from "../src/workers/torn/references";
import { removeSystemApiKey, seedSystemApiKey } from "./helpers/system-api-key";

/**
 * The points price is a single shared scalar read by the TT selector and the
 * stocks ledger, so these tests restore whatever row was there before rather
 * than leaving a mocked price behind for other suites.
 */
const DAILY_PRICE = 33_454;
const OLDER_DAILY_PRICE = 33_277;
const LISTED_PRICE = 31_359;
const TIMESTAMP = Math.floor(Date.now() / 1000);

const MARKET_PAYLOAD = {
	pointsmarket: { "1": { cost: LISTED_PRICE, quantity: 100 } },
};

function pointsFetch(history: unknown, listings: unknown): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = input.toString();
		const json = (payload: unknown) =>
			new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		if (url.includes("/market/pointshistory")) return json(history);
		if (url.includes("/market")) return json(listings);
		return json({});
	}) as unknown as typeof fetch;
}

async function readPointsPrice(): Promise<number | undefined> {
	const row = await db.query.tornMarketPrices.findFirst({
		where: eq(tornMarketPrices.refKey, POINTS_MARKET_PRICE_KEY),
	});
	return row?.price;
}

describe("Torn reference sync — points price", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let originalPrice: typeof tornMarketPrices.$inferSelect | undefined;

	beforeEach(async () => {
		await seedSystemApiKey();
		originalPrice = await db.query.tornMarketPrices.findFirst({
			where: eq(tornMarketPrices.refKey, POINTS_MARKET_PRICE_KEY),
		});
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		if (originalPrice) {
			await db
				.insert(tornMarketPrices)
				.values(originalPrice)
				.onConflictDoUpdate({
					target: tornMarketPrices.refKey,
					set: {
						price: originalPrice.price,
						updatedAt: originalPrice.updatedAt,
					},
				});
		} else {
			await db
				.delete(tornMarketPrices)
				.where(eq(tornMarketPrices.refKey, POINTS_MARKET_PRICE_KEY));
		}
	});

	afterAll(async () => {
		await removeSystemApiKey();
	});

	test("uses Torn's newest daily average instead of the live listings", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			pointsFetch(
				{
					pointshistory: [
						{
							timestamp: TIMESTAMP,
							price: DAILY_PRICE,
							circulation: 330_090_827,
						},
						{
							timestamp: TIMESTAMP - 86_400,
							price: OLDER_DAILY_PRICE,
							circulation: 329_874_350,
						},
					],
				},
				MARKET_PAYLOAD,
			),
		);

		await runTornReferenceSync();

		expect(await readPointsPrice()).toBe(DAILY_PRICE);
	});

	test("skips a day with no sales and uses the last priced bar", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			pointsFetch(
				{
					pointshistory: [
						{ timestamp: TIMESTAMP, price: null, circulation: 330_090_827 },
						{
							timestamp: TIMESTAMP - 86_400,
							price: OLDER_DAILY_PRICE,
							circulation: 329_874_350,
						},
					],
				},
				MARKET_PAYLOAD,
			),
		);

		await runTornReferenceSync();

		expect(await readPointsPrice()).toBe(OLDER_DAILY_PRICE);
	});

	test("falls back to the listed-market VWAP when history has no price", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			pointsFetch(
				{
					pointshistory: [
						{ timestamp: TIMESTAMP, price: null, circulation: null },
					],
				},
				MARKET_PAYLOAD,
			),
		);

		await runTornReferenceSync();

		expect(await readPointsPrice()).toBe(LISTED_PRICE);
	});
});
