import { describe, expect, test } from "bun:test";
import {
	calculateCrimeLogValue,
	extractCrimeDataPayload,
	getCrimeIdFromAction,
} from "../src/crimes";

describe("crimes utility", () => {
	describe("getCrimeIdFromAction", () => {
		test("should correctly map valid crime actions to Crime IDs", () => {
			expect(getCrimeIdFromAction("Search the trash")).toBe(1);
			expect(getCrimeIdFromAction("Sell dvd online")).toBe(2);
			expect(getCrimeIdFromAction("Graffiti central")).toBe(3);
			expect(getCrimeIdFromAction("Shoplift a watch")).toBe(4);
			expect(getCrimeIdFromAction("Pickpocket a civilian")).toBe(5);
			expect(getCrimeIdFromAction("Skim atm card")).toBe(6);
			expect(getCrimeIdFromAction("Burgle a house")).toBe(7);
			expect(getCrimeIdFromAction("Street hustle")).toBe(8);
			expect(getCrimeIdFromAction("Dispose of vehicle")).toBe(9);
			expect(getCrimeIdFromAction("Crack a safe")).toBe(10);
			expect(getCrimeIdFromAction("Forge project step #1")).toBe(11);
			expect(getCrimeIdFromAction("Send spam emails")).toBe(12);
			expect(getCrimeIdFromAction("Commit arson")).toBe(13);
		});

		test("should prioritize higher priority rules like ID 13", () => {
			expect(getCrimeIdFromAction("Rob a store")).toBe(13);
			expect(getCrimeIdFromAction("Ignite fire")).toBe(13);
		});

		test("should return 0 for unknown or empty actions", () => {
			expect(getCrimeIdFromAction("")).toBe(0);
			expect(getCrimeIdFromAction("   ")).toBe(0);
			expect(getCrimeIdFromAction("invalid action text")).toBe(0);
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

	describe("calculateCrimeLogValue", () => {
		test("should calculate net monetary value correctly", () => {
			const data = {
				money_gained: 5000,
				money_lost: 1000,
				items_gained: { "1": 2, "2": 1 }, // 3 items * 1000 = 3000
				items_lost: { "3": 1 }, // 1 item * 1000 = 1000
			};
			// 5000 - 1000 + 3000 - 1000 = 6000
			expect(calculateCrimeLogValue(data)).toBe(6000);
		});

		test("should return 0 for non-object or empty payload", () => {
			expect(calculateCrimeLogValue(null)).toBe(0);
			expect(calculateCrimeLogValue(undefined)).toBe(0);
			expect(calculateCrimeLogValue({})).toBe(0);
		});
	});
});
