import { describe, expect, it, mock } from "bun:test";
import type { StockAlertEvent } from "@sentinel/schemas";
import type { Client } from "discord.js";
import {
	buildStockAlertEmbed,
	handleSubversiveStockAlerts,
} from "../src/lib/stock-alert-distributor";

const CONTEXT = {
	dayHigh: 1015,
	dayLow: 990,
	allTimeHigh: 1210,
	allTimeLow: 400,
};

function changeEvent(patch: Partial<StockAlertEvent> = {}): StockAlertEvent {
	return {
		type: "change",
		alertKey: "change:30",
		stockId: 1,
		name: "Torn & Shanghai Banking",
		acronym: "TSB",
		price: 1005,
		windowLabel: "30 minutes",
		changePct: 0.5,
		referencePrice: 1000,
		referenceAt: 1_800_000_000_000,
		thresholdPct: 0.5,
		context: CONTEXT,
		...patch,
	};
}

function highEvent(patch: Partial<StockAlertEvent> = {}): StockAlertEvent {
	return {
		type: "high",
		alertKey: "high:24h",
		stockId: 1,
		name: "Torn & Shanghai Banking",
		acronym: "TSB",
		price: 1015,
		windowLabel: "24 hours",
		extreme: 1015,
		previousExtreme: 1010,
		context: CONTEXT,
		...patch,
	};
}

describe("Stock alert embeds", () => {
	it("renders a gain with a signed percentage and colour", () => {
		const embed = buildStockAlertEmbed(changeEvent()).toJSON();
		const fields = embed.fields ?? [];

		expect(embed.title).toBe("Stock Alert — Notable Move");
		expect(embed.color).toBe(0x10b981);
		expect(fields.find((f) => f.name === "Move")?.value).toContain("+0.50%");
		expect(fields.find((f) => f.name === "Move")?.value).toContain(
			"30 minutes",
		);
		expect(fields.find((f) => f.name === "Price")?.value).toBe("$1,005.00");
		expect(fields.find((f) => f.name === "24h Range")?.value).toBe(
			"$990.00 – $1,015.00",
		);
	});

	it("renders a drop in red with a negative percentage", () => {
		const embed = buildStockAlertEmbed(
			changeEvent({ changePct: -1.25, price: 987.5 }),
		).toJSON();

		expect(embed.color).toBe(0xef4444);
		expect(
			(embed.fields ?? []).find((f) => f.name === "Move")?.value,
		).toContain("-1.25%");
	});

	it("renders a new high with the extreme and what it replaced", () => {
		const embed = buildStockAlertEmbed(highEvent()).toJSON();
		const fields = embed.fields ?? [];

		expect(embed.title).toBe("Stock Alert — New 24 hours High");
		expect(embed.color).toBe(0x10b981);
		expect(fields.find((f) => f.name === "New 24 hours high")?.value).toBe(
			"**$1,015.00**",
		);
		expect(fields.find((f) => f.name === "Previous")?.value).toBe("$1,010.00");
		expect(fields.find((f) => f.name === "Change vs Previous")?.value).toBe(
			"+$5.00",
		);
	});

	it("renders a new low in red", () => {
		const embed = buildStockAlertEmbed(
			highEvent({
				type: "low",
				alertKey: "low:all_time",
				windowLabel: "all time",
				extreme: 395,
				previousExtreme: 400,
				price: 396,
			}),
		).toJSON();

		expect(embed.title).toBe("Stock Alert — New all time Low");
		expect(embed.color).toBe(0xef4444);
		expect(
			(embed.fields ?? []).find((f) => f.name === "New all time low")?.value,
		).toBe("**$395.00**");
	});
});

describe("Stock alert delivery", () => {
	function fakeClient(sent: Array<{ embeds: unknown[] }>): Client {
		const channel = {
			name: "stock-alerts",
			isTextBased: () => true,
			send: mock(async (payload: { embeds: unknown[] }) => {
				sent.push(payload);
				return {};
			}),
		};
		return {
			channels: {
				fetch: mock(async () => channel),
			},
		} as unknown as Client;
	}

	it("posts one message for a small batch", async () => {
		const sent: Array<{ embeds: unknown[] }> = [];

		const delivered = await handleSubversiveStockAlerts(fakeClient(sent), {
			notificationChannelId: "111111111111111111",
			alerts: [changeEvent(), highEvent()],
		});

		expect(delivered).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.embeds).toHaveLength(2);
	});

	it("chunks a large batch at Discord's ten-embed limit", async () => {
		const sent: Array<{ embeds: unknown[] }> = [];
		const alerts = Array.from({ length: 12 }, (_, index) =>
			changeEvent({ stockId: index + 1, alertKey: `change:${index}` }),
		);

		const delivered = await handleSubversiveStockAlerts(fakeClient(sent), {
			notificationChannelId: "111111111111111111",
			alerts,
		});

		expect(delivered).toBe(true);
		expect(sent).toHaveLength(2);
		expect(sent[0]?.embeds).toHaveLength(10);
		expect(sent[1]?.embeds).toHaveLength(2);
	});

	it("does nothing without a channel or without alerts", async () => {
		const sent: Array<{ embeds: unknown[] }> = [];
		const client = fakeClient(sent);

		expect(
			await handleSubversiveStockAlerts(client, {
				notificationChannelId: "",
				alerts: [changeEvent()],
			}),
		).toBe(false);
		expect(
			await handleSubversiveStockAlerts(client, {
				notificationChannelId: "111111111111111111",
				alerts: [],
			}),
		).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it("reports failure instead of throwing when the channel is unreachable", async () => {
		const client = {
			channels: {
				fetch: mock(async () => {
					throw new Error("Unknown Channel");
				}),
			},
		} as unknown as Client;

		expect(
			await handleSubversiveStockAlerts(client, {
				notificationChannelId: "111111111111111111",
				alerts: [changeEvent()],
			}),
		).toBe(false);
	});
});
