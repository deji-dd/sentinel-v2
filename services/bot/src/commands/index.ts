import type { ModuleKey } from "@sentinel/utils";
import {
	type ChatInputCommandInteraction,
	Collection,
	type SlashCommandBuilder,
	type SlashCommandOptionsOnlyBuilder,
	type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import { allianceMapCommand } from "./alliance-map";
import { assaultCheckCommand } from "./assault-check";
import { burnMapCommand } from "./burn-map";
import { configCommand } from "./config";
import { inviteCommand } from "./invite";
import { pingCommand } from "./ping";
import { purgeCommand } from "./purge";
import { verifyCommand } from "./verify";
import { verifyallCommand } from "./verifyall";

export type BotCommandData =
	| SlashCommandBuilder
	| SlashCommandOptionsOnlyBuilder
	| SlashCommandSubcommandsOnlyBuilder;

export type BotCommand = {
	data: BotCommandData;
	execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	module?: ModuleKey;
};

export const commandsList: BotCommand[] = [
	{ ...pingCommand, module: undefined },
	{ ...inviteCommand, module: undefined },
	{ ...configCommand, module: undefined },
	{ ...purgeCommand, module: undefined },
	{ ...verifyCommand, module: "verification" },
	{ ...verifyallCommand, module: "verification" },
	{ ...assaultCheckCommand, module: "territory" },
	{ ...allianceMapCommand, module: "territory" },
	{ ...burnMapCommand, module: "territory" },
];

export function buildCommandsCollection(): Collection<string, BotCommand> {
	const collection = new Collection<string, BotCommand>();
	for (const cmd of commandsList) {
		collection.set(cmd.data.name, cmd);
	}
	return collection;
}
