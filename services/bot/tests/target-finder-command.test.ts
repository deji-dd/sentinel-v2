import { describe, expect, it, mock, spyOn } from "bun:test";

import * as databaseModule from "@sentinel/database";
import type { ChatInputCommandInteraction } from "discord.js";
import { normalCommandsList } from "../src/commands/index";
import { targetFinderCommand } from "../src/commands/target-finder";

describe("Subversive Target Finder Discord Command", () => {
	it("has correct command name and normal guild scope", () => {
		expect(targetFinderCommand.data.name).toBe("target-finder");
		expect(targetFinderCommand.scope).toBe("normal");

		const foundInNormal = normalCommandsList.find(
			(cmd) => cmd.data.name === "target-finder",
		);
		expect(foundInNormal).toBeDefined();
	});

	it("executes in Subversive guild and replies with prod install link in production", async () => {
		let replyPayload: Record<string, unknown> = {};

		const mockInteraction = {
			guildId: "subversive-guild-123",
			reply: mock(async (payload: Record<string, unknown>) => {
				replyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		const originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";

		const subversiveSpy = spyOn(
			databaseModule,
			"isSubversiveGuildAsync",
		).mockImplementation(async () => true);

		try {
			await targetFinderCommand.execute(mockInteraction);

			expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
			expect(replyPayload.flags).toBe(64); // MessageFlags.Ephemeral

			const embeds = replyPayload.embeds as Array<{
				data: { title?: string; description?: string };
			}>;
			const embed = embeds?.[0]?.data;
			expect(embed).toBeDefined();
			expect(embed?.title).toContain("Target Finder");
			expect(embed?.description).toContain(
				"https://subversive.blasted-labs.tech/api/v1/target-finder/script",
			);
			expect(embed?.description).not.toContain("localhost:3000");

			const componentsRows = replyPayload.components as Array<{
				components: Array<{ data: { url?: string; label?: string } }>;
			}>;
			const components = componentsRows?.[0]?.components;
			expect(components?.length).toBe(1);
			expect(components?.[0]?.data.url).toBe(
				"https://subversive.blasted-labs.tech/api/v1/target-finder/script.user.js",
			);
			expect(components?.[0]?.data.label).toBe("Install Script");
		} finally {
			process.env.NODE_ENV = originalEnv;
			subversiveSpy.mockRestore();
		}
	});

	it("executes in Subversive guild and replies with dev install link in development", async () => {
		let replyPayload: Record<string, unknown> = {};

		const mockInteraction = {
			guildId: "subversive-guild-123",
			reply: mock(async (payload: Record<string, unknown>) => {
				replyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		const originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";

		const subversiveSpy = spyOn(
			databaseModule,
			"isSubversiveGuildAsync",
		).mockImplementation(async () => true);

		try {
			await targetFinderCommand.execute(mockInteraction);

			expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
			expect(replyPayload.flags).toBe(64);

			const embeds = replyPayload.embeds as Array<{
				data: { title?: string; description?: string };
			}>;
			const embed = embeds?.[0]?.data;
			expect(embed).toBeDefined();
			expect(embed?.description).toContain(
				"http://localhost:3000/api/v1/target-finder/script.user.js?env=dev",
			);

			const componentsRows = replyPayload.components as Array<{
				components: Array<{ data: { url?: string; label?: string } }>;
			}>;
			const components = componentsRows?.[0]?.components;
			expect(components?.length).toBe(1);
			expect(components?.[0]?.data.url).toBe(
				"http://localhost:3000/api/v1/target-finder/script.user.js?env=dev",
			);
		} finally {
			process.env.NODE_ENV = originalEnv;
			subversiveSpy.mockRestore();
		}
	});

	it("rejects execution in non-subversive server when in production", async () => {
		let replyPayload: Record<string, unknown> = {};

		const mockInteraction = {
			guildId: "random-unauthorized-guild",
			reply: mock(async (payload: Record<string, unknown>) => {
				replyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		const originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		const subversiveSpy = spyOn(
			databaseModule,
			"isSubversiveGuildAsync",
		).mockImplementation(async () => false);

		try {
			await targetFinderCommand.execute(mockInteraction);

			expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
			const embeds = replyPayload.embeds as Array<{ data: { title?: string } }>;
			const embed = embeds?.[0]?.data;
			expect(embed?.title).toContain("Unauthorized");
		} finally {
			process.env.NODE_ENV = originalEnv;
			subversiveSpy.mockRestore();
		}
	});
});
