import { describe, expect, test } from "bun:test";
import { isModuleEnabled, normalizeModules } from "../src/modules";

describe("modules utility", () => {
	describe("normalizeModules", () => {
		test("should normalize valid module keys and aliases", () => {
			const input = ["verify", "territories", "REACTION_ROLES"];
			const result = normalizeModules(input);
			expect(result).toEqual(["verification", "territory", "reaction_role"]);
		});

		test("should deduplicate alias variations into canonical keys", () => {
			const input = ["verification", "verify", "verifications"];
			const result = normalizeModules(input);
			expect(result).toEqual(["verification"]);
		});

		test("should ignore unknown modules", () => {
			const input = ["unknown_module", "invalid"];
			expect(normalizeModules(input)).toEqual([]);
		});

		test("should handle null, undefined, and non-string inputs", () => {
			expect(normalizeModules(null)).toEqual([]);
			expect(normalizeModules(undefined)).toEqual([]);
			// @ts-expect-error testing runtime resilience
			expect(normalizeModules([123, null, "verify"])).toEqual(["verification"]);
		});
	});

	describe("isModuleEnabled", () => {
		test("should return true if module or alias is in enabled list", () => {
			const enabled = ["verification", "territory"];
			expect(isModuleEnabled(enabled, "verify")).toBe(true);
			expect(isModuleEnabled(enabled, "territories")).toBe(true);
			expect(isModuleEnabled(enabled, "verification")).toBe(true);
		});

		test("should return false if module is not in enabled list", () => {
			const enabled = ["verification"];
			expect(isModuleEnabled(enabled, "territory")).toBe(false);
			expect(isModuleEnabled(enabled, "reaction_role")).toBe(false);
		});

		test("should return false for unknown targets or invalid inputs", () => {
			expect(isModuleEnabled(["verification"], "unknown_module")).toBe(false);
			expect(isModuleEnabled(null, "verification")).toBe(false);
			expect(isModuleEnabled(undefined, "verification")).toBe(false);
			expect(isModuleEnabled([], "verification")).toBe(false);
		});
	});
});
