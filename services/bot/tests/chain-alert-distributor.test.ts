import { describe, expect, it, mock } from "bun:test";

import type { SubversiveChainAlertPayload } from "@sentinel/schemas";
import type { Client } from "discord.js";

import {
	buildChainAlertContent,
	buildChainAlertEmbed,
	handleSubversiveChainAlert,
} from "../src/lib/chain-alert-distributor";

function payload(
	patch: Partial<SubversiveChainAlertPayload> = {},
): SubversiveChainAlertPayload {
	return {
		factionId: 2013,
		factionName: "Subversive Alliance",
		channelId: "111111111111111111",
		warningRoleId: "222222222222222222",
		chainCurrent: 42,
		chainMax: 100,
		timeoutSeconds: 30,
		modifier: 1.2,
		warningNumber: 1,
		targets: [
			{ id: 7001, name: "EasyOne", level: 20, estimatedBs: 1_500_000 },
			{ id: 7002, name: "EasyTwo", level: 21, estimatedBs: 2_500_000 },
			{ id: 7003, name: "EasyThree", level: 22, estimatedBs: 3_500_000 },
		],
		...patch,
	};
}

describe("chain alert embeds", () => {
	it("mentions the configured role and nothing else", () => {
		expect(buildChainAlertContent(payload())).toBe("<@&222222222222222222>");
		expect(
			buildChainAlertContent(payload({ warningRoleId: null })),
		).toBeUndefined();
	});

	it("renders the chain, timer and all three targets", () => {
		const embed = buildChainAlertEmbed(payload()).toJSON();
		const fields = embed.fields ?? [];

		expect(embed.title).toBe("Chain Warning — Subversive Alliance [2013]");
		expect(fields.find((field) => field.name === "Chain")?.value).toBe(
			"**42** / 100",
		);
		expect(
			fields.find((field) => field.name === "Time Remaining")?.value,
		).toContain("**30s**");
		expect(fields.find((field) => field.name === "Chain Modifier")?.value).toBe(
			"1.20x",
		);

		const targets =
			fields.find((field) => field.name === "Low-Stat Okay Targets")?.value ??
			"";
		expect(targets).toContain("EasyOne [7001]");
		expect(targets).toContain("EasyTwo [7002]");
		expect(targets).toContain("EasyThree [7003]");
		expect(targets).toContain(
			"https://www.torn.com/page.php?sid=attack&user2ID=7001",
		);
	});

	it("renders a fallback line when the target pool has nothing eligible", () => {
		const embed = buildChainAlertEmbed(payload({ targets: [] })).toJSON();
		const targets = (embed.fields ?? []).find(
			(field) => field.name === "Low-Stat Okay Targets",
		)?.value;

		expect(targets).toBe(
			"No okay targets are currently in the target-finder pool.",
		);
	});

	it("uses the danger colour when the chain is nearly gone", () => {
		const embed = buildChainAlertEmbed(
			payload({ timeoutSeconds: 10 }),
		).toJSON();
		expect(embed.color).toBe(0xef4444);
	});
});

describe("chain alert delivery", () => {
	it("sends one message with the role-scoped mention policy", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const channel = {
			name: "chain-alerts",
			isTextBased: () => true,
			send: mock(async (message: Record<string, unknown>) => {
				sent.push(message);
				return {};
			}),
		};
		const client = {
			channels: { fetch: mock(async () => channel) },
		} as unknown as Client;

		const delivered = await handleSubversiveChainAlert(client, payload());

		expect(delivered).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toBe("<@&222222222222222222>");
		expect(sent[0]?.allowedMentions).toEqual({
			parse: [],
			roles: ["222222222222222222"],
		});
		expect(sent[0]?.embeds).toHaveLength(1);
	});

	it("omits content and role mentions when no role is configured", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const channel = {
			name: "chain-alerts",
			isTextBased: () => true,
			send: mock(async (message: Record<string, unknown>) => {
				sent.push(message);
				return {};
			}),
		};
		const client = {
			channels: { fetch: mock(async () => channel) },
		} as unknown as Client;

		await handleSubversiveChainAlert(client, payload({ warningRoleId: null }));

		expect(sent[0]?.content).toBeUndefined();
		expect(sent[0]?.allowedMentions).toEqual({ parse: [], roles: [] });
	});

	it("reports failure instead of throwing when the channel is unreachable", async () => {
		const client = {
			channels: {
				fetch: mock(async () => {
					throw new Error("Unknown Channel");
				}),
			},
		} as unknown as Client;

		expect(await handleSubversiveChainAlert(client, payload())).toBe(false);
	});

	it("rejects a non-text channel", async () => {
		const client = {
			channels: {
				fetch: mock(async () => ({ isTextBased: () => false })),
			},
		} as unknown as Client;

		expect(await handleSubversiveChainAlert(client, payload())).toBe(false);
	});
});
