import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db, eq, travelDestinations } from "@sentinel/database";
import { runTravelSync } from "../src/workers/torn/abroad-stocks";

describe("Torn Abroad Stocks Sync Worker", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	const TEST_COUNTRY_CODE = "TEST_HAWAII";

	beforeEach(async () => {
		await db
			.delete(travelDestinations)
			.where(eq(travelDestinations.id, TEST_COUNTRY_CODE));
	});

	afterEach(async () => {
		if (fetchSpy) {
			fetchSpy.mockRestore();
		}
		await db
			.delete(travelDestinations)
			.where(eq(travelDestinations.id, TEST_COUNTRY_CODE));
	});

	test("fetches YATA export and updates travel destinations with timestamped stock history", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL | Request,
		) => {
			const urlStr = url.toString();
			if (urlStr.includes("yata.yt/api/v1/travel/export")) {
				return new Response(
					JSON.stringify({
						stocks: {
							[TEST_COUNTRY_CODE]: {
								update: Math.floor(Date.now() / 1000),
								country: "Hawaii",
								stocks: [
									{
										id: 260,
										name: "Plumeria Flower",
										quantity: 120,
										cost: 400,
									},
								],
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch);

		await runTravelSync();

		const dest = await db.query.travelDestinations.findFirst({
			where: eq(travelDestinations.id, TEST_COUNTRY_CODE),
		});

		expect(dest).toBeDefined();
		if (dest) {
			expect(dest.name).toBe("Hawaii");
			const stocks = dest.stocks as unknown as {
				id: number;
				name: string;
				quantity: number;
				cost: number;
				history: { timestamp: number; quantity: number }[];
			}[];
			expect(stocks.length).toBe(1);
			expect(stocks[0]?.name).toBe("Plumeria Flower");
			expect(stocks[0]?.quantity).toBe(120);
			expect(stocks[0]?.history.length).toBe(1);
		}
	});
});
