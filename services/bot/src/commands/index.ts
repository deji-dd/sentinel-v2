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
import { pingCommand } from "./ping";
import { purgeCommand } from "./purge";
import { ttSelectorCommand } from "./tt-selector";
import { verifyCommand } from "./verify";
import { verifyallCommand } from "./verifyall";

export type BotModule =
	| "verification"
	| "territory"
	| "reaction_roles"
	| "monitoring";

export type BotCommandData =
	| SlashCommandBuilder
	| SlashCommandOptionsOnlyBuilder
	| SlashCommandSubcommandsOnlyBuilder;

export type BotCommand = {
	data: BotCommandData;
	execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	module?: BotModule;
};

export const commandsList: BotCommand[] = [
	pingCommand,
	configCommand,
	ttSelectorCommand,
	purgeCommand,
	verifyCommand,
	verifyallCommand,
	assaultCheckCommand,
	allianceMapCommand,
	burnMapCommand,
];

export function buildCommandsCollection(): Collection<string, BotCommand> {
	const collection = new Collection<string, BotCommand>();
	for (const cmd of commandsList) {
		collection.set(cmd.data.name, cmd);
	}
	return collection;
}
