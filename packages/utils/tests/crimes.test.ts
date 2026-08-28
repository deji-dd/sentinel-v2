import { describe, expect, test } from "bun:test";
import {
	buildCrimeRulesFromDefinitions,
	calculateCrimeLogValue,
	DEFAULT_CRIME_DEFINITIONS,
	DEFAULT_CRIME_RULES,
	extractCrimeDataPayload,
	extractItemMarketPrice,
	getCrimeIdFromAction,
} from "../src/crimes";

describe("crimes utility", () => {
	describe("getCrimeIdFromAction and buildCrimeRulesFromDefinitions", () => {
		const sampleDefinitions = [
			{
				id: 1,
				name: "Search for Cash",
				subcrimes: [
					{ id: 1, name: "Search the trash" },
					{ id: 3, name: "Search the Junkyard" },
					{ id: 6, name: "Search the fountain" },
				],
			},
			{
				id: 2,
				name: "Bootlegging",
				subcrimes: [
					{ id: 7, name: "Sell dvd online" },
					{ id: 8, name: "Copy DVDs" },
					{ id: 9, name: "Sell Counterfeit DVDs" },
					{ id: 10, name: "Set Up Online Store" },
					{ id: 11, name: "Online Store" },
				],
			},
			{
				id: 3,
				name: "Graffiti",
				subcrimes: [{ id: 10, name: "Graffiti central" }],
			},
			{
				id: 4,
				name: "Shoplifting",
				subcrimes: [
					{ id: 15, name: "Shoplift a watch" },
					{ id: 16, name: "Cyber Force" },
					{ id: 17, name: "Big Al's Gun Shop" },
				],
			},
			{
				id: 5,
				name: "Pickpocketing",
				subcrimes: [{ id: 20, name: "Pickpocket a civilian" }],
			},
			{
				id: 6,
				name: "Card Skimming",
				subcrimes: [{ id: 25, name: "Skim atm card" }],
			},
			{
				id: 7,
				name: "Burglary",
				subcrimes: [
					{ id: 30, name: "Burgle a house" },
					{ id: 73, name: "Mobile Home - Case" },
					{ id: 74, name: "Mobile Home - Burgle" },
					{ id: 113, name: "Advertising Agency - Case" },
					{ id: 114, name: "Advertisement Agency - Burgle" },
				],
			},
			{
				id: 8,
				name: "Hustling",
				subcrimes: [
					{ id: 35, name: "Street hustle" },
					{ id: 36, name: "Find the Lady - Introduction" },
					{ id: 37, name: "Shell Game - Introduction" },
				],
			},
			{
				id: 9,
				name: "Disposal",
				subcrimes: [{ id: 40, name: "Dispose of vehicle" }],
			},
			{
				id: 10,
				name: "Cracking",
				subcrimes: [
					{ id: 45, name: "Crack a safe" },
					{ id: 46, name: "Brute force" },
				],
			},
			{
				id: 11,
				name: "Forgery",
				subcrimes: [
					{ id: 50, name: "Forge project step #1" },
					{ id: 227, name: "Begin License Plate project" },
					{ id: 229, name: "Step #2 : Plate background painting" },
					{ id: 232, name: "Step #5 : Plate letter painting" },
					{ id: 276, name: "Begin Passport project" },
				],
			},
			{
				id: 12,
				name: "Scamming",
				subcrimes: [
					{ id: 55, name: "Send spam emails" },
					{ id: 56, name: "Email Farming" },
				],
			},
			{
				id: 13,
				name: "Arson & Robbery",
				subcrimes: [
					{ id: 60, name: "Commit arson" },
					{ id: 61, name: "Rob a store" },
					{ id: 62, name: "Ignite fire" },
					{ id: 63, name: "Planting evidence" },
					{ id: 64, name: "Make Entry" },
					{ id: 328, name: "Inquire" },
					{ id: 333, name: "Stoke Fire" },
					{ id: 334, name: "Dampen Fire" },
					{ id: 335, name: "Collect" },
				],
			},
		];

		const rules = buildCrimeRulesFromDefinitions(sampleDefinitions);

		test("should correctly map valid crime actions to Crime IDs", () => {
			expect(getCrimeIdFromAction("Search the trash", rules)).toBe(1);
			expect(getCrimeIdFromAction("Sell dvd online", rules)).toBe(2);
			expect(getCrimeIdFromAction("Graffiti central", rules)).toBe(3);
			expect(getCrimeIdFromAction("Shoplift a watch", rules)).toBe(4);
			expect(getCrimeIdFromAction("shoplift from Cyber Force", rules)).toBe(4);
			expect(getCrimeIdFromAction("Pickpocket a civilian", rules)).toBe(5);
			expect(getCrimeIdFromAction("Skim atm card", rules)).toBe(6);
			expect(getCrimeIdFromAction("Burgle a house", rules)).toBe(7);
			expect(getCrimeIdFromAction("Street hustle", rules)).toBe(8);
			expect(getCrimeIdFromAction("Dispose of vehicle", rules)).toBe(9);
			expect(getCrimeIdFromAction("Crack a safe", rules)).toBe(10);
			expect(getCrimeIdFromAction("Forge project step #1", rules)).toBe(11);
			expect(getCrimeIdFromAction("Send spam emails", rules)).toBe(12);
			expect(getCrimeIdFromAction("Commit arson", rules)).toBe(13);
		});

		test("should handle English verb/gerund inflections like 'Brute force' -> 'brute forcing a password'", () => {
			expect(getCrimeIdFromAction("brute forcing a password", rules)).toBe(10);
			expect(getCrimeIdFromAction("Brute forced the encryption", rules)).toBe(
				10,
			);
			expect(getCrimeIdFromAction("Brute force a safe", rules)).toBe(10);
			expect(getCrimeIdFromAction("Cracking a safe", rules)).toBe(10);
			expect(getCrimeIdFromAction("Searching the trash", rules)).toBe(1);
			expect(getCrimeIdFromAction("searching the junk yard", rules)).toBe(1);
			expect(getCrimeIdFromAction("Search the junk yard", rules)).toBe(1);
			expect(getCrimeIdFromAction("Search the Junkyard", rules)).toBe(1);
			expect(getCrimeIdFromAction("searching the junkyard", rules)).toBe(1);
		});

		test("should handle Forgery project definitions like 'Begin License Plate project' -> 'painting a License Plate'", () => {
			expect(getCrimeIdFromAction("painting a License Plate", rules)).toBe(11);
			expect(getCrimeIdFromAction("painting a license plate", rules)).toBe(11);
			expect(getCrimeIdFromAction("Plate background painting", rules)).toBe(11);
			expect(getCrimeIdFromAction("Plate letter painting", rules)).toBe(11);
			expect(getCrimeIdFromAction("forging a Passport", rules)).toBe(11);
		});

		test("should prioritize multi-word subcrimes like 'Online Store' (ID 2) over single-word 'Collect' (ID 13)", () => {
			expect(
				getCrimeIdFromAction("collecting funds from an online store", rules),
			).toBe(2);
			expect(
				getCrimeIdFromAction("collecting from an online store", rules),
			).toBe(2);
			expect(getCrimeIdFromAction("Set up online store", rules)).toBe(2);
			expect(getCrimeIdFromAction("Copying DVDs", rules)).toBe(2);
			expect(getCrimeIdFromAction("Sell counterfeit DVDs", rules)).toBe(2);
		});

		test("should handle order-independent multi-word variations like 'Email Farming' -> 'farming email addresses'", () => {
			expect(getCrimeIdFromAction("farming email addresses", rules)).toBe(12);
			expect(getCrimeIdFromAction("farmed emails from website", rules)).toBe(
				12,
			);
			expect(getCrimeIdFromAction("Email farming campaign", rules)).toBe(12);
		});

		test("should handle subcrimes with hyphens and -tion verbal stems like 'Find the Lady - Introduction'", () => {
			expect(getCrimeIdFromAction("introducing Find the Lady", rules)).toBe(8);
			expect(getCrimeIdFromAction("introduce Find the Lady", rules)).toBe(8);
			expect(getCrimeIdFromAction("Playing Find the Lady", rules)).toBe(8);
			expect(getCrimeIdFromAction("Shell Game - Introduction", rules)).toBe(8);
		});

		test("should handle subcrime synonyms like 'Make Entry' -> 'breaching a Candle Shop'", () => {
			expect(
				getCrimeIdFromAction(
					"breaching a Candle Shop (A Treat for the Tricked)",
					rules,
				),
			).toBe(13);
			expect(getCrimeIdFromAction("making entry into warehouse", rules)).toBe(
				13,
			);
			expect(getCrimeIdFromAction("breach security door", rules)).toBe(13);
		});

		test("should prioritize higher priority rules like ID 13 even with sub-word collisions", () => {
			expect(getCrimeIdFromAction("Rob a store", rules)).toBe(13);
			expect(getCrimeIdFromAction("Ignite fire", rules)).toBe(13);
			expect(getCrimeIdFromAction("Planting evidence", rules)).toBe(13);
			expect(
				getCrimeIdFromAction(
					"igniting a Chiropractors Office (Back, Sack, and Crack)",
					rules,
				),
			).toBe(13);
			expect(
				getCrimeIdFromAction(
					"dampening a Mobile Home (Out with a Bang)",
					rules,
				),
			).toBe(13);
			expect(
				getCrimeIdFromAction("igniting a Mobile Home (Out with a Bang)", rules),
			).toBe(13);
			expect(
				getCrimeIdFromAction("stoking a Mobile Home (Out with a Bang)", rules),
			).toBe(13);
			expect(getCrimeIdFromAction("burgling a Mobile Home", rules)).toBe(7);
			expect(getCrimeIdFromAction("casing a Mobile Home", rules)).toBe(7);
			expect(
				getCrimeIdFromAction("burgling an advertising agency", rules),
			).toBe(7);
			expect(getCrimeIdFromAction("burgle an advertising agency", rules)).toBe(
				7,
			);
			expect(getCrimeIdFromAction("casing an advertising agency", rules)).toBe(
				7,
			);
		});

		test("should return 0 for unknown or empty actions or empty rules", () => {
			expect(getCrimeIdFromAction("", rules)).toBe(0);
			expect(getCrimeIdFromAction("   ", rules)).toBe(0);
			expect(getCrimeIdFromAction("invalid action text", rules)).toBe(0);
			expect(getCrimeIdFromAction("Search the trash", [])).toBe(0);
		});

		test("should use DEFAULT_CRIME_DEFINITIONS when definitions is empty or omitted", () => {
			expect(DEFAULT_CRIME_DEFINITIONS.length).toBe(13);
			expect(DEFAULT_CRIME_RULES.length).toBeGreaterThanOrEqual(13);

			// Fallback when called with no arguments or empty array
			const defaultRulesNoArgs = buildCrimeRulesFromDefinitions();
			expect(defaultRulesNoArgs.length).toBeGreaterThanOrEqual(13);
			expect(getCrimeIdFromAction("Search the trash", defaultRulesNoArgs)).toBe(
				1,
			);

			const defaultRulesEmptyArr = buildCrimeRulesFromDefinitions([]);
			expect(defaultRulesEmptyArr.length).toBeGreaterThanOrEqual(13);
			expect(
				getCrimeIdFromAction("Search the trash", defaultRulesEmptyArr),
			).toBe(1);

			// Calling getCrimeIdFromAction without rules argument uses DEFAULT_CRIME_RULES
			expect(getCrimeIdFromAction("Search the trash")).toBe(1);
			expect(getCrimeIdFromAction("Burgle a house")).toBe(7);
			expect(getCrimeIdFromAction("Commit arson")).toBe(13);
		});
	});

	describe("extractCrimeDataPayload", () => {
		test("should extract payload from flat object", () => {
			const raw = { crime_action: "Search trash", nerve: 2 };
			const result = extractCrimeDataPayload(raw);
			expect(result.action).toBe("Search trash");
			expect(result.nerve).toBe(2);
			expect(result.innerData).toEqual(raw);
		});

		test("should extract payload from nested data object", () => {
			const raw = {
				data: { crime_action: "Pickpocket", nerve: 4 },
			};
			const result = extractCrimeDataPayload(raw);
			expect(result.action).toBe("Pickpocket");
			expect(result.nerve).toBe(4);
			expect(result.innerData).toEqual(raw.data);
		});

		test("should handle invalid or non-object payloads gracefully", () => {
			expect(extractCrimeDataPayload(null)).toEqual({
				action: "",
				nerve: 0,
				innerData: null,
			});
			expect(extractCrimeDataPayload("string payload")).toEqual({
				action: "",
				nerve: 0,
				innerData: null,
			});
		});
	});

	describe("extractItemMarketPrice", () => {
		test("should extract market_value from top level", () => {
			expect(extractItemMarketPrice({ market_value: 25000 })).toBe(25000);
		});

		test("should extract market_price from top level", () => {
			expect(extractItemMarketPrice({ market_price: 18000 })).toBe(18000);
		});

		test("should extract market_price from nested value object", () => {
			expect(
				extractItemMarketPrice({
					value: { market_price: 350000, buy_price: 300000 },
				}),
			).toBe(350000);
		});

		test("should return 0 for missing or invalid price data", () => {
			expect(extractItemMarketPrice(null)).toBe(0);
			expect(extractItemMarketPrice({})).toBe(0);
			expect(extractItemMarketPrice({ name: "Unknown Item" })).toBe(0);
		});
	});

	describe("calculateCrimeLogValue", () => {
		test("should calculate net monetary value with item prices map", () => {
			const data = {
				money_gained: 5000,
				money_lost: 1000,
				items_gained: { "1": 2, "2": 1 }, // 2 * 2500 + 1 * 5000 = 10000
				items_lost: { "3": 1 }, // 1 * 1500 = 1500
			};
			const priceMap = new Map<string, number>([
				["1", 2500],
				["2", 5000],
				["3", 1500],
			]);
			// 5000 - 1000 + 10000 - 1500 = 12500
			expect(calculateCrimeLogValue(data, priceMap)).toBe(12500);
		});

		test("should calculate net monetary value with item prices record", () => {
			const data = {
				money_gained: 2000,
				money_lost: 500,
				items_gained: { "10": 3 }, // 3 * 400 = 1200
				items_lost: { "20": 2 }, // 2 * 300 = 600
			};
			const priceRecord = { "10": 400, "20": 300 };
			// 2000 - 500 + 1200 - 600 = 2100
			expect(calculateCrimeLogValue(data, priceRecord)).toBe(2100);
		});

		test("should default items to 0 when price map is omitted or item is unpriced", () => {
			const data = {
				money_gained: 5000,
				money_lost: 1000,
				items_gained: { "1": 2 },
				items_lost: { "3": 1 },
			};
			// 5000 - 1000 + 0 - 0 = 4000
			expect(calculateCrimeLogValue(data)).toBe(4000);
		});

		test("should return 0 for non-object or empty payload", () => {
			expect(calculateCrimeLogValue(null)).toBe(0);
			expect(calculateCrimeLogValue(undefined)).toBe(0);
			expect(calculateCrimeLogValue({})).toBe(0);
		});
	});
});
