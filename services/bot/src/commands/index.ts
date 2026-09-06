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
import { dashboardCommand } from "./dashboard";
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

export type BotCommandScope = "normal" | "elims" | "both";

export type BotCommandData =
	| SlashCommandBuilder
	| SlashCommandOptionsOnlyBuilder
	| SlashCommandSubcommandsOnlyBuilder;

export type BotCommand = {
	data: BotCommandData;
	execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
	module?: BotModule;
	scope?: BotCommandScope;
};

// ─── Command Definitions with Explicit Separation ────────────────────────────

// 1. Normal Bot Commands (scoped strictly to standard Sentinel community & faction servers)
export const normalCommandsList: BotCommand[] = [
	{ ...pingCommand, scope: "both" },
	{ ...dashboardCommand, scope: "both" },
	{ ...configCommand, scope: "normal" },
	{ ...ttSelectorCommand, scope: "normal" },
	{ ...purgeCommand, scope: "normal" },
	{ ...verifyCommand, scope: "normal" },
	{ ...verifyallCommand, scope: "normal" },
	{ ...assaultCheckCommand, scope: "normal" },
	{ ...allianceMapCommand, scope: "normal" },
	{ ...burnMapCommand, scope: "normal" },
];

// 2. Elims Commands (scoped strictly to the active tournament operations guild)
export const elimsCommandsList: BotCommand[] = [
	{ ...dashboardCommand, scope: "both" },
	{ ...pingCommand, scope: "both" },
];

// Global list of all known bot commands for the dispatcher collection
export const commandsList: BotCommand[] = [
	...normalCommandsList.filter(
		(cmd) => !elimsCommandsList.some((e) => e.data.name === cmd.data.name),
	),
	...elimsCommandsList,
];

export function buildNormalCommandsCollection(): Collection<
	string,
	BotCommand
> {
	const collection = new Collection<string, BotCommand>();
	for (const cmd of normalCommandsList) {
		collection.set(cmd.data.name, cmd);
	}
	return collection;
}

export function buildElimsCommandsCollection(): Collection<string, BotCommand> {
	const collection = new Collection<string, BotCommand>();
	for (const cmd of elimsCommandsList) {
		collection.set(cmd.data.name, cmd);
	}
	return collection;
}

export function buildCommandsCollection(): Collection<string, BotCommand> {
	const collection = new Collection<string, BotCommand>();
	for (const cmd of commandsList) {
		collection.set(cmd.data.name, cmd);
	}
	return collection;
}
