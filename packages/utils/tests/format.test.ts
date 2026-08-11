import { describe, expect, test } from "bun:test";
import { formatDuration } from "../src/format";

describe("format utility", () => {
	describe("formatDuration", () => {
		test("should format milliseconds under 1 second", () => {
			expect(formatDuration(0)).toBe("0ms");
			expect(formatDuration(45)).toBe("45ms");
			expect(formatDuration(999)).toBe("999ms");
		});

		test("should format seconds", () => {
			expect(formatDuration(1000)).toBe("1s");
			expect(formatDuration(1250)).toBe("1s 250ms");
			expect(formatDuration(59000)).toBe("59s");
		});

		test("should format minutes", () => {
			expect(formatDuration(60000)).toBe("1m");
			expect(formatDuration(65000)).toBe("1m 5s");
			expect(formatDuration(3599000)).toBe("59m 59s");
		});

		test("should format hours", () => {
			expect(formatDuration(3600000)).toBe("1h");
			expect(formatDuration(3665000)).toBe("1h 1m");
			expect(formatDuration(82800000)).toBe("23h");
		});

		test("should format days", () => {
			expect(formatDuration(86400000)).toBe("1d");
			expect(formatDuration(90000000)).toBe("1d 1h");
		});

		test("should handle NaN and negative numbers gracefully", () => {
			expect(formatDuration(Number.NaN)).toBe("0ms");
			expect(formatDuration(-500)).toBe("0ms");
		});
	});
});
