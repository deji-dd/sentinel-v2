import { describe, expect, test } from "bun:test";
import {
	extractUserAndId,
	parseArmoryChatInput,
	parseBuyLogLine,
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

		test("extracts name and ID from bracket notation 'Name [12345]'", () => {
			const res = extractUserAndId("LinFeng [2399359]");
			expect(res.name).toBe("LinFeng");
			expect(res.tornId).toBe(2399359);
		});
	});

	describe("parseSingleDepositLog", () => {
		test("parses '23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you'", () => {
			const log = "23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you";
			const parsed = parseSingleDepositLog(log);
			expect(parsed).not.toBeNull();
			expect(parsed?.quantity).toBe(2);
			expect(parsed?.itemName).toBe("Vicodin");
			expect(parsed?.donorName).toBe("Lunette");
			expect(parsed?.donorTornId).toBeNull();
			expect(parsed?.timestamp).toBe("23:14:09 - 06/09/26");
			expect(parsed?.message).toBeNull();
		});
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

		test("parses user's 5-line multi-deposit batch with mixed messages and items", () => {
			const text = `23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you
00:50:02 - 06/09/26 Clitasaurus sent 16x Serotonin to you
19:58:41 - 05/09/26 LinFeng sent a Parcel to you with the message: Adhesive Plastic - SED
19:57:50 - 05/09/26 Sting3r sent a Parcel to you
18:22:51 - 05/09/26 Bricks sent a Brick to you with the message: Please use this brick if you do not have a hat to throw in the ring`;
			const results = parseDepositLogs(text);
			expect(results).toHaveLength(5);

			expect(results[0]?.itemName).toBe("Vicodin");
			expect(results[0]?.quantity).toBe(2);
			expect(results[0]?.donorName).toBe("Lunette");
			expect(results[0]?.timestamp).toBe("23:14:09 - 06/09/26");

			expect(results[1]?.itemName).toBe("Serotonin");
			expect(results[1]?.quantity).toBe(16);
			expect(results[1]?.donorName).toBe("Clitasaurus");

			expect(results[2]?.itemName).toBe("Parcel");
			expect(results[2]?.quantity).toBe(1);
			expect(results[2]?.donorName).toBe("LinFeng");
			expect(results[2]?.message).toBe("Adhesive Plastic - SED");

			expect(results[3]?.itemName).toBe("Parcel");
			expect(results[3]?.quantity).toBe(1);
			expect(results[3]?.donorName).toBe("Sting3r");
			expect(results[3]?.message).toBeNull();

			expect(results[4]?.itemName).toBe("Brick");
			expect(results[4]?.quantity).toBe(1);
			expect(results[4]?.donorName).toBe("Bricks");
			expect(results[4]?.message).toBe(
				"Please use this brick if you do not have a hat to throw in the ring",
			);
		});

		test("parses trade log with multiple items and [view] suffix", () => {
			const log =
				"05:36:39 - 11/12/25 The-Don-Salieri traded 100x Flash Grenade, 150x Pepper Spray, 18x Xanax to you [view]";
			const results = parseDepositLogs(log);
			expect(results).toHaveLength(3);

			expect(results[0]?.itemName).toBe("Flash Grenade");
			expect(results[0]?.quantity).toBe(100);
			expect(results[0]?.donorName).toBe("The-Don-Salieri");
			expect(results[0]?.timestamp).toBe("05:36:39 - 11/12/25");

			expect(results[1]?.itemName).toBe("Pepper Spray");
			expect(results[1]?.quantity).toBe(150);
			expect(results[1]?.donorName).toBe("The-Don-Salieri");

			expect(results[2]?.itemName).toBe("Xanax");
			expect(results[2]?.quantity).toBe(18);
			expect(results[2]?.donorName).toBe("The-Don-Salieri");
		});

		test("parses second trade log with 5 medical items", () => {
			const log =
				"21:08:11 - 09/12/25 The-Don-Salieri traded 100x First Aid Kit, 20x Ipecac Syrup, 100x Morphine, 100x Small First Aid Kit, 35x Xanax to you [view]";
			const results = parseDepositLogs(log);
			expect(results).toHaveLength(5);

			expect(results[0]?.itemName).toBe("First Aid Kit");
			expect(results[0]?.quantity).toBe(100);
			expect(results[1]?.itemName).toBe("Ipecac Syrup");
			expect(results[1]?.quantity).toBe(20);
			expect(results[2]?.itemName).toBe("Morphine");
			expect(results[2]?.quantity).toBe(100);
			expect(results[3]?.itemName).toBe("Small First Aid Kit");
			expect(results[3]?.quantity).toBe(100);
			expect(results[4]?.itemName).toBe("Xanax");
			expect(results[4]?.quantity).toBe(35);
			expect(results[4]?.timestamp).toBe("21:08:11 - 09/12/25");
		});

		test("parses trade log with cash and items with message attached", () => {
			const log =
				"The-Don-Salieri [12345] traded 50x Flash Grenade, $5,000,000, 10x Vicodin to you with the message: Good luck [view]";
			const results = parseDepositLogs(log);
			expect(results).toHaveLength(3);

			expect(results[0]?.itemName).toBe("Money");
			expect(results[0]?.quantity).toBe(5000000);
			expect(results[0]?.donorName).toBe("The-Don-Salieri");
			expect(results[0]?.donorTornId).toBe(12345);
			expect(results[0]?.message).toBe("Good luck");

			expect(results[1]?.itemName).toBe("Flash Grenade");
			expect(results[1]?.quantity).toBe(50);
			expect(results[1]?.donorName).toBe("The-Don-Salieri");
			expect(results[1]?.donorTornId).toBe(12345);
			expect(results[1]?.message).toBe("Good luck");

			expect(results[2]?.itemName).toBe("Vicodin");
			expect(results[2]?.quantity).toBe(10);
			expect(results[2]?.donorName).toBe("The-Don-Salieri");
			expect(results[2]?.donorTornId).toBe(12345);
			expect(results[2]?.message).toBe("Good luck");
		});

		test("parses direct money sent: '01:39:19 - 07/09/26 wrxodus sent $42,743,465 to you'", () => {
			const log = "01:39:19 - 07/09/26 wrxodus sent $42,743,465 to you";
			const results = parseDepositLogs(log);
			expect(results).toHaveLength(1);
			expect(results[0]?.itemName).toBe("Money");
			expect(results[0]?.quantity).toBe(42743465);
			expect(results[0]?.donorName).toBe("wrxodus");
			expect(results[0]?.timestamp).toBe("01:39:19 - 07/09/26");
		});

		test("parses direct money received: 'You were sent $42,743,465 from wrxodus'", () => {
			const log = "You were sent $42,743,465 from wrxodus";
			const results = parseDepositLogs(log);
			expect(results).toHaveLength(1);
			expect(results[0]?.itemName).toBe("Money");
			expect(results[0]?.quantity).toBe(42743465);
			expect(results[0]?.donorName).toBe("wrxodus");
		});

		test("parses pure money trade: '22:24:33 - 07/09/26 Friddles traded $150,000,000 to you [view]'", () => {
			const log =
				"22:24:33 - 07/09/26 Friddles traded $150,000,000 to you [view]";
			const results = parseDepositLogs(log);
			expect(results).toHaveLength(1);
			expect(results[0]?.itemName).toBe("Money");
			expect(results[0]?.quantity).toBe(150000000);
			expect(results[0]?.donorName).toBe("Friddles");
			expect(results[0]?.timestamp).toBe("22:24:33 - 07/09/26");
		});
	});

	describe("parseBuyLogLine", () => {
		test("parses bazaar purchase: '17:57:08 - 07/09/26 You bought a Donator Pack on BLS-Envoy's bazaar at $23,560,000 each for a total of $23,560,000'", () => {
			const log =
				"17:57:08 - 07/09/26 You bought a Donator Pack on BLS-Envoy's bazaar at $23,560,000 each for a total of $23,560,000";
			const buy = parseBuyLogLine(log);
			expect(buy).not.toBeNull();
			expect(buy?.itemName).toBe("Donator Pack");
			expect(buy?.quantity).toBe(1);
			expect(buy?.totalCost).toBe(23560000);
			expect(buy?.priceEach).toBe(23560000);
			expect(buy?.source).toBe("BLS-Envoy's bazaar");
			expect(buy?.timestamp).toBe("17:57:08 - 07/09/26");
		});

		test("parses item market purchase: '07:09:10 - 05/09/26 You bought 249x Smoke Grenade on the item market from someone at $90,500 each for a total of $22,534,500'", () => {
			const log =
				"07:09:10 - 05/09/26 You bought 249x Smoke Grenade on the item market from someone at $90,500 each for a total of $22,534,500";
			const buy = parseBuyLogLine(log);
			expect(buy).not.toBeNull();
			expect(buy?.itemName).toBe("Smoke Grenade");
			expect(buy?.quantity).toBe(249);
			expect(buy?.totalCost).toBe(22534500);
			expect(buy?.priceEach).toBe(90500);
			expect(buy?.source).toBe("the item market from someone");
			expect(buy?.timestamp).toBe("07:09:10 - 05/09/26");
		});

		test("parses pharmacy store purchase: '05:10:17 - 05/09/26 You bought 20x Serotonin at $1,300,000 each for a total of $26,000,000 from Pharmacy'", () => {
			const log =
				"05:10:17 - 05/09/26 You bought 20x Serotonin at $1,300,000 each for a total of $26,000,000 from Pharmacy";
			const buy = parseBuyLogLine(log);
			expect(buy).not.toBeNull();
			expect(buy?.itemName).toBe("Serotonin");
			expect(buy?.quantity).toBe(20);
			expect(buy?.totalCost).toBe(26000000);
			expect(buy?.priceEach).toBe(1300000);
			expect(buy?.source).toBe("Pharmacy");
			expect(buy?.timestamp).toBe("05:10:17 - 05/09/26");
		});
	});

	describe("parseArmoryChatInput", () => {
		test("parses mixed deposits and purchases in a single paste batch", () => {
			const input = `
01:39:19 - 07/09/26 wrxodus sent $42,743,465 to you
17:57:08 - 07/09/26 You bought a Donator Pack on BLS-Envoy's bazaar at $23,560,000 each for a total of $23,560,000
23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you
			`;
			const res = parseArmoryChatInput(input);
			expect(res.deposits).toHaveLength(2);
			expect(res.deposits[0]?.itemName).toBe("Money");
			expect(res.deposits[0]?.quantity).toBe(42743465);
			expect(res.deposits[1]?.itemName).toBe("Vicodin");
			expect(res.deposits[1]?.quantity).toBe(2);

			expect(res.buys).toHaveLength(1);
			expect(res.buys[0]?.itemName).toBe("Donator Pack");
			expect(res.buys[0]?.totalCost).toBe(23560000);
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
