import { describe, expect, test } from "bun:test";
import {
	extractUserAndId,
	parseDepositLogs,
	parseSingleDepositLog,
	parseSingleSentLog,
	validateSentLogAgainstRequest,
} from "../src/lib/torn-log-parser";

describe("Torn Log Parser", () => {
	describe("extractUserAndId", () => {
		test("extracts name and ID from markdown link", () => {
			const res = extractUserAndId(
				"[Clitasaurus](https://www.torn.com/profiles.php?XID=2059853)",
			);
			expect(res.name).toBe("Clitasaurus");
			expect(res.tornId).toBe(2059853);
		});

		test("extracts name from plain text", () => {
			const res = extractUserAndId("Clitasaurus");
			expect(res.name).toBe("Clitasaurus");
			expect(res.tornId).toBeNull();
		});
	});

	describe("parseSingleDepositLog", () => {
		test("parses format 1 with quantity, item, donor link", () => {
			const log =
				"You were sent 16x Serotonin from [Clitasaurus](https://www.torn.com/profiles.php?XID=2059853)";
			const parsed = parseSingleDepositLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(16);
			expect(parsed?.itemName).toBe("Serotonin");
			expect(parsed?.donorName).toBe("Clitasaurus");
			expect(parsed?.donorTornId).toBe(2059853);
			expect(parsed?.message).toBeNull();
		});

		test("parses format 2 with timestamp, donor, quantity, item", () => {
			const log = "00:50:02 - 06/09/26 Clitasaurus sent 16x Serotonin to you";
			const parsed = parseSingleDepositLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(16);
			expect(parsed?.itemName).toBe("Serotonin");
			expect(parsed?.donorName).toBe("Clitasaurus");
			expect(parsed?.timestamp).toBe("00:50:02 - 06/09/26");
		});

		test("parses format 1 with 'a Parcel' and message", () => {
			const log =
				"You were sent a Parcel from [LinFeng](https://www.torn.com/profiles.php?XID=2399359) with the message: Adhesive Plastic - SED";
			const parsed = parseSingleDepositLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(1);
			expect(parsed?.itemName).toBe("Parcel");
			expect(parsed?.donorName).toBe("LinFeng");
			expect(parsed?.donorTornId).toBe(2399359);
			expect(parsed?.message).toBe("Adhesive Plastic - SED");
		});

		test("parses format 2 with timestamp, 'a Parcel' and message", () => {
			const log =
				"19:58:41 - 05/09/26 LinFeng sent a Parcel to you with the message: Adhesive Plastic - SED";
			const parsed = parseSingleDepositLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(1);
			expect(parsed?.itemName).toBe("Parcel");
			expect(parsed?.donorName).toBe("LinFeng");
			expect(parsed?.message).toBe("Adhesive Plastic - SED");
			expect(parsed?.timestamp).toBe("19:58:41 - 05/09/26");
		});

		test("parses format 1 with 'a Brick' and long message", () => {
			const log =
				"You were sent a Brick from [Bricks](https://www.torn.com/profiles.php?XID=4002816) with the message: Please use this brick if you do not have a hat to throw in the ring";
			const parsed = parseSingleDepositLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(1);
			expect(parsed?.itemName).toBe("Brick");
			expect(parsed?.donorName).toBe("Bricks");
			expect(parsed?.message).toBe(
				"Please use this brick if you do not have a hat to throw in the ring",
			);
		});

		test("parses format 1 with 'an Armor Cache'", () => {
			const log =
				"You were sent an Armor Cache from [ladyK](https://www.torn.com/profiles.php?XID=12345)";
			const parsed = parseSingleDepositLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(1);
			expect(parsed?.itemName).toBe("Armor Cache");
			expect(parsed?.donorName).toBe("ladyK");
		});
	});

	describe("parseDepositLogs (multiline)", () => {
		test("parses multiple lines at once", () => {
			const text = `
				00:50:02 - 06/09/26 Clitasaurus sent 16x Serotonin to you
				You were sent a Brick from [Bricks](https://www.torn.com/profiles.php?XID=4002816) with the message: Brick!
			`;
			const results = parseDepositLogs(text);
			expect(results).toHaveLength(2);
			expect(results[0]?.itemName).toBe("Serotonin");
			expect(results[0]?.quantity).toBe(16);
			expect(results[1]?.itemName).toBe("Brick");
			expect(results[1]?.quantity).toBe(1);
		});
	});

	describe("parseSingleSentLog & validateSentLogAgainstRequest", () => {
		test("parses 'You sent a Business Class Ticket to BabyLuST'", () => {
			const log =
				"04:37:52 - 04/09/26 You sent a Business Class Ticket to BabyLuST";
			const parsed = parseSingleSentLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(1);
			expect(parsed?.itemName).toBe("Business Class Ticket");
			expect(parsed?.recipientName).toBe("BabyLuST");
			expect(parsed?.timestamp).toBe("04:37:52 - 04/09/26");
			if (!parsed) throw new Error("Expected parsed log not to be null");

			// Case-sensitive exact match
			const valid = validateSentLogAgainstRequest(parsed, {
				recipientTornName: "BabyLuST",
				itemName: "Business Class Ticket",
				quantity: 1,
			});
			expect(valid.isValid).toBe(true);

			// Case-sensitive mismatch should fail
			const invalidCase = validateSentLogAgainstRequest(parsed, {
				recipientTornName: "babylust",
				itemName: "Business Class Ticket",
				quantity: 1,
			});
			expect(invalidCase.isValid).toBe(false);
			expect(invalidCase.error).toContain("Recipient mismatch");
		});

		test("parses '00:37:23 - 04/09/26 You sent 5x Flash Grenade to Fahquetu'", () => {
			const log = "00:37:23 - 04/09/26 You sent 5x Flash Grenade to Fahquetu";
			const parsed = parseSingleSentLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(5);
			expect(parsed?.itemName).toBe("Flash Grenade");
			expect(parsed?.recipientName).toBe("Fahquetu");
			if (!parsed) throw new Error("Expected parsed log not to be null");

			const valid = validateSentLogAgainstRequest(parsed, {
				recipientTornName: "Fahquetu",
				itemName: "Flash Grenade",
				quantity: 5,
			});
			expect(valid.isValid).toBe(true);

			// Quantity insufficient should fail
			const invalidQty = validateSentLogAgainstRequest(parsed, {
				recipientTornName: "Fahquetu",
				itemName: "Flash Grenade",
				quantity: 10,
			});
			expect(invalidQty.isValid).toBe(false);
			expect(invalidQty.error).toContain("Quantity mismatch");

			// Item mismatch should fail
			const invalidItem = validateSentLogAgainstRequest(parsed, {
				recipientTornName: "Fahquetu",
				itemName: "Smoke Grenade",
				quantity: 5,
			});
			expect(invalidItem.isValid).toBe(false);
			expect(invalidItem.error).toContain("Item mismatch");
		});

		test("parses '14:02:49 - 30/11/25 You sent an Armor Cache to ladyK'", () => {
			const log = "14:02:49 - 30/11/25 You sent an Armor Cache to ladyK";
			const parsed = parseSingleSentLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(1);
			expect(parsed?.itemName).toBe("Armor Cache");
			expect(parsed?.recipientName).toBe("ladyK");
			if (!parsed) throw new Error("Expected parsed log not to be null");

			const valid = validateSentLogAgainstRequest(parsed, {
				recipientTornName: "ladyK",
				itemName: "Armor Cache",
				quantity: 1,
			});
			expect(valid.isValid).toBe(true);
		});
	});
});
