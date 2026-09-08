import { describe, expect, it, mock } from "bun:test";
import type { ChatInputCommandInteraction, User } from "discord.js";
import { elimsCommandsList, normalCommandsList } from "../src/commands/index";
import { itemRequestHelpCommand } from "../src/commands/item-request-help";

describe("item-request-help command", () => {
	it("has correct command name and elims-only scope", () => {
		expect(itemRequestHelpCommand.data.name).toBe("item-request-help");
		expect(itemRequestHelpCommand.scope).toBe("elims");

		const foundInElims = elimsCommandsList.find(
			(cmd) => cmd.data.name === "item-request-help",
		);
		expect(foundInElims).toBeDefined();
		expect(foundInElims?.scope).toBe("elims");

		const foundInNormal = normalCommandsList.find(
			(cmd) => cmd.data.name === "item-request-help",
		);
		expect(foundInNormal).toBeUndefined();
	});

	it("executes without user option and replies with channel linkage and attachment", async () => {
		let replyPayload: { content?: string; files?: unknown[] } = {};

		const mockInteraction = {
			options: {
				getUser: mock(() => null),
			},
			reply: mock(async (payload: { content?: string; files?: unknown[] }) => {
				replyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		await itemRequestHelpCommand.execute(mockInteraction);

		expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
		expect(replyPayload.content).toBe("Use <#1546125572252504154>");
		expect(Array.isArray(replyPayload.files)).toBe(true);
		expect(replyPayload.files?.length).toBeGreaterThan(0);
	});

	it("executes with target user option and mentions the user", async () => {
		let replyPayload: { content?: string; files?: unknown[] } = {};

		const mockUser = {
			id: "9876543210",
			toString: () => "<@9876543210>",
		} as unknown as User;

		const mockInteraction = {
			options: {
				getUser: mock(() => mockUser),
			},
			reply: mock(async (payload: { content?: string; files?: unknown[] }) => {
				replyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		await itemRequestHelpCommand.execute(mockInteraction);

		expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
		expect(replyPayload.content).toBe(
			"<@9876543210> Use <#1546125572252504154>",
		);
	});
});
