import {
	db,
	desc,
	elimsMemberStats,
	elimsTeamPlayers,
	elimsTeams,
	eq,
	sql,
} from "@sentinel/database";
import {
	ActionRowBuilder,
	AttachmentBuilder,
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
} from "discord.js";
import {
	createBaseEmbed,
	createErrorEmbed,
	createSuccessEmbed,
	EMBED_COLORS,
} from "../lib/embeds";
import { logger } from "../lib/logger";
import type { BotCommand } from "./index";

export const ELIMS_TEAMS = [
	{ id: 70, name: "Brain Surgeons" },
	{ id: 80, name: "Conspiracy Theorists" },
	{ id: 81, name: "Inanimate Objects" },
	{ id: 82, name: "Gold Dust" },
	{ id: 83, name: "Reptilians" },
	{ id: 84, name: "Rocket Scientists" },
	{ id: 85, name: "Sticks and Stones" },
	{ id: 86, name: "APEX" },
	{ id: 87, name: "Touching Grass" },
	{ id: 88, name: "Nine Lives" },
	{ id: 89, name: "High Voltage" },
	{ id: 90, name: "Loose Cannons" },
] as const;

export const TEAM_BREAKDOWN_SELECT_ID = "elims_team_breakdown_select";

export function formatStatNumber(num: number): string {
	if (num >= 1_000_000_000_000_000) {
		return `${(num / 1_000_000_000_000_000).toFixed(2)}q`;
	}
	if (num >= 1_000_000_000_000) {
		return `${(num / 1_000_000_000_000).toFixed(2)}t`;
	}
	if (num >= 1_000_000_000) {
		return `${(num / 1_000_000_000).toFixed(2)}b`;
	}
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(2)}m`;
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}k`;
	}
	return num.toLocaleString();
}

export function escapeCsvField(
	val: string | number | null | undefined,
): string {
	if (val === null || val === undefined) return "";
	const str = String(val);
	if (
		str.includes(",") ||
		str.includes('"') ||
		str.includes("\n") ||
		str.includes("\r")
	) {
		return `"${str.replaceAll('"', '""')}"`;
	}
	return str;
}

export interface TeamBreakdownResult {
	teamName: string;
	teamId: number;
	playersCount: number;
	totalAttacks: number;
	csvContent: string;
	attachment: AttachmentBuilder;
}

/**
 * Queries cached tournament player and stats data from the database
 * to generate a per-member CSV breakdown for the given elimination team.
 */
export async function generateTeamBreakdown(
	teamId: number,
): Promise<TeamBreakdownResult> {
	// 1. Fetch team metadata
	const [teamRow] = await db
		.select({ id: elimsTeams.id, name: elimsTeams.name })
		.from(elimsTeams)
		.where(eq(elimsTeams.id, teamId));

	const matchedDefault = ELIMS_TEAMS.find((t) => t.id === teamId);
	const teamName = teamRow?.name ?? matchedDefault?.name ?? `Team ${teamId}`;

	// 2. Fetch cached players for the team
	const players = await db
		.select({
			id: elimsTeamPlayers.id,
			name: elimsTeamPlayers.name,
			level: elimsTeamPlayers.level,
			attacks: elimsTeamPlayers.attacks,
		})
		.from(elimsTeamPlayers)
		.where(eq(elimsTeamPlayers.teamId, teamId))
		.orderBy(desc(elimsTeamPlayers.attacks), desc(elimsTeamPlayers.level));

	// 3. Fetch cached member stats from elimsMemberStats
	const statsRows = await db
		.select({
			tornId: elimsMemberStats.tornId,
			bsEstimate: elimsMemberStats.bsEstimate,
			bsEstimateHuman: elimsMemberStats.bsEstimateHuman,
		})
		.from(elimsMemberStats)
		.where(sql`${elimsMemberStats.tornId} IS NOT NULL`);

	const statsMap = new Map<
		number,
		{ bsEstimate: number | null; bsEstimateHuman: string | null }
	>();
	for (const s of statsRows) {
		if (s.tornId !== null) {
			statsMap.set(s.tornId, {
				bsEstimate: s.bsEstimate,
				bsEstimateHuman: s.bsEstimateHuman,
			});
		}
	}

	// 4. Build CSV rows
	const headers = [
		"Name",
		"ID",
		"Level",
		"Profile Link",
		"Attacks Made",
		"Est. Stats",
	];
	const csvLines = [headers.join(",")];

	let totalAttacks = 0;
	for (const p of players) {
		const attacks = p.attacks ?? 0;
		totalAttacks += attacks;

		const profileLink = `https://www.torn.com/profiles.php?XID=${p.id}`;
		const stat = statsMap.get(p.id);

		let estStats = "N/A";
		if (stat?.bsEstimateHuman) {
			estStats = stat.bsEstimateHuman;
		} else if (typeof stat?.bsEstimate === "number" && stat.bsEstimate > 0) {
			estStats = formatStatNumber(stat.bsEstimate);
		}

		csvLines.push(
			[
				escapeCsvField(p.name),
				escapeCsvField(p.id),
				escapeCsvField(p.level),
				escapeCsvField(profileLink),
				escapeCsvField(attacks),
				escapeCsvField(estStats),
			].join(","),
		);
	}

	const csvContent = `${csvLines.join("\n")}\n`;
	const sanitizedSlug = teamName
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/(^-+|-+$)/g, "");
	const filename = `${sanitizedSlug || `team-${teamId}`}-breakdown.csv`;

	const attachment = new AttachmentBuilder(Buffer.from(csvContent, "utf-8"), {
		name: filename,
	});

	return {
		teamName,
		teamId,
		playersCount: players.length,
		totalAttacks,
		csvContent,
		attachment,
	};
}

export function createTeamSelectActionRow(): ActionRowBuilder<StringSelectMenuBuilder> {
	const selectMenu = new StringSelectMenuBuilder()
		.setCustomId(TEAM_BREAKDOWN_SELECT_ID)
		.setPlaceholder("Select an Elimination team...")
		.addOptions(
			ELIMS_TEAMS.map((t) => ({
				label: t.name,
				value: String(t.id),
				description: `Team ID: ${t.id}`,
			})),
		);

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		selectMenu,
	);
}

/**
 * Handles dropdown select interactions when the user picks a team from the select menu.
 */
export async function handleTeamBreakdownSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	const selectedValue = interaction.values[0];
	if (!selectedValue) return;

	const teamId = Number.parseInt(selectedValue, 10);
	if (Number.isNaN(teamId)) {
		await interaction.reply({
			embeds: [
				createErrorEmbed("Invalid Selection", "The selected team is invalid."),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferUpdate();

	try {
		const result = await generateTeamBreakdown(teamId);

		const embed = createSuccessEmbed(
			`Team Breakdown — ${result.teamName}`,
			`Exported member breakdown for **${result.teamName}** (ID: ${result.teamId}).\n\n` +
				`• **Total Members**: ${result.playersCount.toLocaleString()}\n` +
				`• **Total Attacks**: ${result.totalAttacks.toLocaleString()}\n\n` +
				"Download the attached CSV file below.",
		);

		await interaction.editReply({
			embeds: [embed],
			files: [result.attachment],
			components: [],
		});
	} catch (err) {
		logger.error("Failed to generate team breakdown from select menu:", err);
		const errorEmbed = createErrorEmbed(
			"Export Failed",
			"An error occurred while generating the team breakdown CSV.",
		);
		await interaction.editReply({
			embeds: [errorEmbed],
			components: [],
		});
	}
}

export const teamBreakdownCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("team-breakdown")
		.setDescription(
			"Export a per-member breakdown CSV for an elimination team.",
		)
		.addIntegerOption((option) =>
			option
				.setName("team")
				.setDescription("Optional: directly choose the elimination team")
				.setRequired(false)
				.addChoices(
					...ELIMS_TEAMS.map((t) => ({
						name: `${t.name} (${t.id})`,
						value: t.id,
					})),
				),
		),
	scope: "elims",

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Guild Only",
						"This command can only be used within the tournament server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const selectedTeamId = interaction.options.getInteger("team");

		// If no team option was chosen directly, prompt with interactive select menu
		if (selectedTeamId === null) {
			const selectRow = createTeamSelectActionRow();
			const embed = createBaseEmbed(
				"Elimination Team Breakdown",
				"Please select an elimination team from the dropdown below to generate the per-member CSV breakdown.",
				EMBED_COLORS.PRIMARY,
			);

			await interaction.reply({
				embeds: [embed],
				components: [selectRow],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Direct team specified in slash command
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const result = await generateTeamBreakdown(selectedTeamId);

			const embed = createSuccessEmbed(
				`Team Breakdown — ${result.teamName}`,
				`Exported member breakdown for **${result.teamName}** (ID: ${result.teamId}).\n\n` +
					`• **Total Members**: ${result.playersCount.toLocaleString()}\n` +
					`• **Total Attacks**: ${result.totalAttacks.toLocaleString()}\n\n` +
					"Download the attached CSV file below.",
			);

			await interaction.editReply({
				embeds: [embed],
				files: [result.attachment],
			});
		} catch (err) {
			logger.error(
				`Failed to generate team breakdown for team ${selectedTeamId}:`,
				err,
			);
			const errorEmbed = createErrorEmbed(
				"Export Failed",
				"An error occurred while generating the team breakdown CSV.",
			);
			await interaction.editReply({
				embeds: [errorEmbed],
			});
		}
	},
};
