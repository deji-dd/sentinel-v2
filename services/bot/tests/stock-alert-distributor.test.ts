import { describe, expect, it, mock } from "bun:test";
import type { StockAlertEvent, UserStockAlertEvent } from "@sentinel/schemas";
import type { Client } from "discord.js";
import {
	buildStockAlertEmbed,
	buildStockMarketUrl,
	handleSubversiveStockAlerts,
	handleUserStockAlerts,
} from "../src/lib/stock-alert-distributor";

/** The ranges a guild tracks, in the order the worker reports them. */
const CONTEXT = {
	ranges: [
		{ range: "24h" as const, label: "24 hours", high: 1015, low: 990 },
		{ range: "all_time" as const, label: "all time", high: 1210, low: 400 },
	],
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
		range: "24h",
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
		// One field listing every tracked range, rather than the two hardcoded
		// fields the feature used to render.
		const ranges = fields.find((f) => f.name === "Ranges")?.value ?? "";
		expect(ranges).toContain("**24 hours:** $990.00 – $1,015.00");
		expect(ranges).toContain("**all time:** $400.00 – $1,210.00");
	});

	it("names a single tracked range after that range", () => {
		const embed = buildStockAlertEmbed(
			changeEvent({
				context: {
					ranges: [{ range: "30d", label: "30 days", high: 1100, low: 850 }],
				},
			}),
		).toJSON();

		const field = (embed.fields ?? []).find((f) => f.name === "30 days Range");
		expect(field?.value).toBe("**30 days:** $850.00 – $1,100.00");
	});

	it("omits the range field when no range is tracked", () => {
		const embed = buildStockAlertEmbed(
			changeEvent({ context: { ranges: [] } }),
		).toJSON();

		const names = (embed.fields ?? []).map((f) => f.name);
		expect(names).not.toContain("Ranges");
	});

	it("links a stock to its chart at the period matching the alert", () => {
		const embed = buildStockAlertEmbed(highEvent()).toJSON();
		const stock = (embed.fields ?? []).find((f) => f.name === "Stock")?.value;

		// Torn's own page, opened on the stock and the day period the alert is about.
		expect(stock).toContain(
			"https://www.torn.com/page.php?sid=stocks&stockID=1&tab=price&period=day",
		);
	});

	it("maps every range onto Torn's own period spelling", () => {
		expect(buildStockMarketUrl(7, "1h")).toContain("period=hour");
		expect(buildStockMarketUrl(7, "24h")).toContain("period=day");
		expect(buildStockMarketUrl(7, "7d")).toContain("period=week");
		expect(buildStockMarketUrl(7, "30d")).toContain("period=month");
		expect(buildStockMarketUrl(7, "1y")).toContain("period=year");
		// Torn spells all-time without the underscore.
		expect(buildStockMarketUrl(7, "all_time")).toContain("period=alltime");
	});

	it("falls back to the daily period for an intraday move", () => {
		// An intraday rule is measured from the minute history, so it carries no
		// range; the daily chart is the sensible landing view.
		const embed = buildStockAlertEmbed(
			changeEvent({ range: undefined }),
		).toJSON();
		const stock = (embed.fields ?? []).find((f) => f.name === "Stock")?.value;

		expect(stock).toContain("period=day");
		expect(buildStockMarketUrl(3, undefined)).toContain(
			"stockID=3&tab=price&period=day",
		);
	});

	it("links a long-window move to that window's chart", () => {
		const embed = buildStockAlertEmbed(
			changeEvent({
				alertKey: "change:10080",
				windowLabel: "7 days",
				range: "7d",
				changePct: 8,
			}),
		).toJSON();
		const stock = (embed.fields ?? []).find((f) => f.name === "Stock")?.value;

		expect(stock).toContain("period=week");
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

describe("Personal stock alert delivery", () => {
	/** A user alert wrapping a market event, as the scheduler sends it. */
	function userAlert(
		discordUserId: string,
		patch: Partial<UserStockAlertEvent> = {},
	): UserStockAlertEvent {
		return {
			subscriptionId: `sub-${discordUserId}`,
			discordUserId,
			condition: "price_above",
			description: "Price rose above $1,200.00 — now $1,250.00.",
			event: highEvent({ alertKey: `user:price_above:-:1200` }),
			...patch,
		};
	}

	/** A client whose `users.fetch` yields a DM-able user per id. */
	function fakeDmClient(
		options: { failFor?: Set<string>; failWith?: unknown } = {},
	): { client: Client; dms: Array<{ userId: string; embeds: unknown[] }> } {
		const dms: Array<{ userId: string; embeds: unknown[] }> = [];

		const client = {
			users: {
				fetch: mock(async (userId: string) => {
					if (options.failFor?.has(userId)) throw options.failWith;
					return {
						id: userId,
						send: mock(async (payload: { embeds: unknown[] }) => {
							dms.push({ userId, embeds: payload.embeds });
							return {};
						}),
					};
				}),
			},
		} as unknown as Client;

		return { client, dms };
	}

	it("sends one DM per user, batching that user's alerts", async () => {
		const { client, dms } = fakeDmClient();

		const delivered = await handleUserStockAlerts(client, {
			alerts: [
				userAlert("111111111111111111"),
				userAlert("111111111111111111", { subscriptionId: "sub-2" }),
				userAlert("222222222222222222"),
			],
		});

		expect(delivered).toBe(2);
		expect(dms).toHaveLength(2);
		const first = dms.find((dm) => dm.userId === "111111111111111111");
		expect(first?.embeds).toHaveLength(2);
	});

	it("titles a personal alert differently from a channel post", async () => {
		const { client, dms } = fakeDmClient();

		await handleUserStockAlerts(client, {
			alerts: [userAlert("111111111111111111")],
		});

		// The distributor hands Discord builders to `send`, so the assertion reads
		// the serialised form the API would receive.
		const embed = dms[0]?.embeds[0] as { toJSON(): { title?: string } };
		expect(embed.toJSON().title).toBe("Your Stock Alert — New 24 hours High");
	});

	it("keeps going when one user has direct messages closed", async () => {
		const { client, dms } = fakeDmClient({
			failFor: new Set(["111111111111111111"]),
			// Discord's code for a closed DM channel.
			failWith: Object.assign(new Error("Cannot send messages to this user"), {
				code: 50007,
			}),
		});

		const delivered = await handleUserStockAlerts(client, {
			alerts: [
				userAlert("111111111111111111"),
				userAlert("222222222222222222"),
			],
		});

		// The blocked user is skipped without costing the other their DM.
		expect(delivered).toBe(1);
		expect(dms.map((dm) => dm.userId)).toEqual(["222222222222222222"]);
	});

	it("does nothing when there is nothing to deliver", async () => {
		const { client, dms } = fakeDmClient();

		expect(await handleUserStockAlerts(client, { alerts: [] })).toBe(0);
		expect(dms).toHaveLength(0);
	});
});
