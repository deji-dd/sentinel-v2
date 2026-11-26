import { describe, expect, it } from "bun:test";

import { calculateOptimalCadence } from "../src/workers/torn/territory-activity";

describe("territory activity dynamic cadence", () => {
	it("keeps the 30 req/min/key pacing for small key pools", () => {
		expect(calculateOptimalCadence(1, 11)).toBe(30);
		expect(calculateOptimalCadence(3, 11)).toBe(7.5);
	});

	it("clamps the minimum cadence to one second with an abundance of keys", () => {
		expect(calculateOptimalCadence(30, 11)).toBe(1);
		expect(calculateOptimalCadence(1000, 11)).toBe(1);
	});
});
