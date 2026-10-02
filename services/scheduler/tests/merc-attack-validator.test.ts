import { describe, expect, it } from "bun:test";
import {
	getProgressStateId,
	parseNextLinkParams,
} from "../src/workers/merc/merc-attack-validator-worker";

describe("Merc Attack Validator - Pagination & Progress Persistence", () => {
	describe("parseNextLinkParams", () => {
		it("correctly extracts to timestamp from a full Torn API next link", () => {
			const link =
				"https://api.torn.com/faction/attacks?filters=outgoing&sort=DESC&limit=100&to=1728123456";
			const params = parseNextLinkParams(link);

			expect(params.filters).toBe("outgoing");
			expect(params.sort).toBe("DESC");
			expect(params.limit).toBe(100);
			expect(params.to).toBe(1728123456);
		});

		it("correctly extracts to timestamp from a relative next link", () => {
			const link = "/faction/attacks?filters=outgoing&to=1728999888&sort=DESC";
			const params = parseNextLinkParams(link);

			expect(params.to).toBe(1728999888);
			expect(params.filters).toBe("outgoing");
			expect(params.sort).toBe("DESC");
		});

		it("filters out key, comment, and timestamp cache buster", () => {
			const link =
				"https://api.torn.com/faction/attacks?filters=outgoing&to=1728123456&key=SECRET&comment=BOT&timestamp=1234";
			const params = parseNextLinkParams(link);

			expect(params.key).toBeUndefined();
			expect(params.comment).toBeUndefined();
			expect(params.timestamp).toBeUndefined();
			expect(params.to).toBe(1728123456);
		});
	});

	describe("getProgressStateId", () => {
		it("generates deterministic state key using factionId", () => {
			const stateId = getProgressStateId("guild-123", {
				factionId: 2013,
				apiKey: "api-key-test",
			});
			expect(stateId).toBe("merc:attack_validator:guild-123:faction_2013");
		});

		it("generates deterministic state key using hashed apiKey if factionId is missing", () => {
			const stateId1 = getProgressStateId("guild-123", {
				apiKey: "api-key-abc-123",
			});
			const stateId2 = getProgressStateId("guild-123", {
				apiKey: "api-key-abc-123",
			});
			expect(stateId1).toBe(stateId2);
			expect(stateId1.startsWith("merc:attack_validator:guild-123:key_")).toBe(
				true,
			);
		});
	});
});
