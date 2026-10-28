import {
	describeUserShopliftingAlert,
	findShopliftingShop,
	isUserShopliftingAlertCondition,
	MAX_USER_SHOPLIFTING_ALERTS,
	SHOPLIFTING_SHOPS,
	shopliftingAlertConditionsForShop,
	USER_SHOPLIFTING_ALERT_CONDITION_LABELS,
	type UserShopliftingAlertCondition,
} from "@sentinel/schemas";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type ChatInputCommandInteraction,
	type EmbedBuilder,
	MessageFlags,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
} from "discord.js";

import type { BotCommand } from ".";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";
import {
	createUserShopliftingAlert,
	deleteAllUserShopliftingAlerts,
	deleteUserShopliftingAlert,
	listUserShopliftingAlerts,
	UserShopliftingAlertError,
	type UserShopliftingAlertView,
} from "../lib/shoplifting-alert-subscriptions";

/**
 * `/shoplifting-alerts` — per-user Torn shoplifting security alerts by DM.
 *
 * Mirrors `/stock-alerts`: the flow is ephemeral and stateless. The chosen shop
 * rides in the condition select's `custom_id`, so a bot restart mid-flow cannot
 * leave a half-finished setup behind.
 */

export const SHOPLIFTING_ALERT_SHOP_SELECT_ID = "shoplifting_alert_shop_select";
/** Prefix for the trigger select; the shop id follows the colon. */
export const SHOPLIFTING_ALERT_CONDITION_SELECT_ID =
	"shoplifting_alert_condition_select";
export const SHOPLIFTING_ALERT_REMOVE_SELECT_ID =
	"shoplifting_alert_remove_select";
export const SHOPLIFTING_ALERT_CLEAR_CONFIRM_ID =
	"shoplifting_alert_clear_confirm";
export const SHOPLIFTING_ALERT_CLEAR_CANCEL_ID =
	"shoplifting_alert_clear_cancel";

/** `custom_id` of the trigger select for one shop. */
export function conditionSelectId(shopId: number): string {
	return `${SHOPLIFTING_ALERT_CONDITION_SELECT_ID}:${shopId}`;
}

/** Reads the shop id back out of the trigger select's `custom_id`. */
export function parseConditionSelectId(customId: string): number | null {
	const raw = customId.split(":")[1];
	const shopId = Number(raw);
	return Number.isInteger(shopId) && shopId > 0 ? shopId : null;
}

/** The shop picker, shown by `/shoplifting-alerts add`. */
export function buildShopSelect(): ActionRowBuilder<StringSelectMenuBuilder> {
	const select = new StringSelectMenuBuilder()
		.setCustomId(SHOPLIFTING_ALERT_SHOP_SELECT_ID)
		.setPlaceholder("Pick a shop")
		.addOptions(
			SHOPLIFTING_SHOPS.map((shop) => ({
				label: shop.name,
				value: String(shop.id),
			})),
		);

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/** The trigger picker for one shop, filtered to triggers that can fire there. */
export function buildConditionSelect(
	shopId: number,
): ActionRowBuilder<StringSelectMenuBuilder> {
	const conditions = shopliftingAlertConditionsForShop(shopId);

	const select = new StringSelectMenuBuilder()
		.setCustomId(conditionSelectId(shopId))
		.setPlaceholder("What should trigger the alert?")
		.addOptions(
			conditions.map((condition) => ({
				label: USER_SHOPLIFTING_ALERT_CONDITION_LABELS[condition],
				value: condition,
				description:
					condition === "all_down"
						? "Every security measure at this shop is disabled"
						: condition === "guards_down"
							? "Guards have gone on their break"
							: "Every camera at this shop is disabled",
			})),
		);

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/** Renders the user's alerts as a list embed. */
function buildListEmbed(views: UserShopliftingAlertView[]): EmbedBuilder {
	const embed = createBaseEmbed(
		"Your Shoplifting Alerts",
		undefined,
		EMBED_COLORS.PRIMARY,
	);

	if (views.length === 0) {
		embed.setDescription(
			"You have no personal shoplifting alerts. Use `/shoplifting-alerts add` to create one.",
		);
		return embed;
	}

	embed.setDescription(
		`${views.length} of ${MAX_USER_SHOPLIFTING_ALERTS} alerts. You are DM'd when the selected security goes down.`,
	);
	embed.addFields(
		views.map((view, index) => ({
			name: `${index + 1}. ${findShopliftingShop(view.shopId)?.name ?? `Shop ${view.shopId}`}`,
			value: `${USER_SHOPLIFTING_ALERT_CONDITION_LABELS[view.condition]} — you are DM'd when it goes down and when it recovers.`,
			inline: false,
		})),
	);

	return embed;
}

// ─── Command ────────────────────────────────────────────────────────────────

export const shopliftingAlertsCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("shoplifting-alerts")
		.setDescription("Get a DM when a Torn shoplifting shop's security is down.")
		.addSubcommand((subcommand) =>
			subcommand
				.setName("add")
				.setDescription("Create a personal shoplifting security alert."),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("list")
				.setDescription("Show your personal shoplifting alerts."),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("remove")
				.setDescription("Delete one of your shoplifting alerts."),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("clear")
				.setDescription("Delete all of your shoplifting alerts."),
		),
	// Faction-guild only, matching `/stock-alerts`: subscriptions are scoped to
	// the guild that created them.
	scope: "faction",
	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		const subcommand = interaction.options.getSubcommand();

		switch (subcommand) {
			case "add":
				await handleAdd(interaction);
				return;
			case "list":
				await handleList(interaction);
				return;
			case "remove":
				await handleRemove(interaction);
				return;
			case "clear":
				await handleClear(interaction);
				return;
			default:
				await interaction.reply({
					embeds: [
						createErrorEmbed(
							"Unknown Subcommand",
							"That subcommand is not supported.",
						),
					],
					flags: MessageFlags.Ephemeral,
				});
		}
	},
};

/** `/shoplifting-alerts add` — open the shop picker. */
async function handleAdd(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				"New Shoplifting Alert",
				"Pick the shop you want to watch. You will choose the trigger on the next screen.",
				EMBED_COLORS.PRIMARY,
			),
		],
		components: [buildShopSelect()],
	});
}

/** `/shoplifting-alerts list` — the user's alerts. */
async function handleList(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const views = await listUserShopliftingAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);

	await interaction.editReply({ embeds: [buildListEmbed(views)] });
}

/** `/shoplifting-alerts remove` — pick one of the user's alerts to delete. */
async function handleRemove(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const views = await listUserShopliftingAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);

	if (views.length === 0) {
		await interaction.editReply({ embeds: [buildListEmbed([])] });
		return;
	}

	const select = new StringSelectMenuBuilder()
		.setCustomId(SHOPLIFTING_ALERT_REMOVE_SELECT_ID)
		.setPlaceholder("Pick an alert to delete")
		.addOptions(
			views.slice(0, 25).map((view) => ({
				label: describeUserShopliftingAlert(view).slice(0, 100),
				value: view.id,
			})),
		);

	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				"Remove A Shoplifting Alert",
				"Choose the alert you want to stop receiving.",
				EMBED_COLORS.WARNING,
			),
		],
		components: [
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
		],
	});
}

/** `/shoplifting-alerts clear` — confirm before deleting everything. */
async function handleClear(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const views = await listUserShopliftingAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);

	if (views.length === 0) {
		await interaction.editReply({ embeds: [buildListEmbed([])] });
		return;
	}

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(SHOPLIFTING_ALERT_CLEAR_CONFIRM_ID)
			.setLabel(`Delete all ${views.length}`)
			.setStyle(ButtonStyle.Danger),
		new ButtonBuilder()
			.setCustomId(SHOPLIFTING_ALERT_CLEAR_CANCEL_ID)
			.setLabel("Cancel")
			.setStyle(ButtonStyle.Secondary),
	);

	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				"Delete All Shoplifting Alerts?",
				`This removes all ${views.length} of your personal shoplifting alerts. It cannot be undone.`,
				EMBED_COLORS.DANGER,
			),
		],
		components: [row],
	});
}

// ─── Interaction handlers ───────────────────────────────────────────────────

/** Shop chosen: show the trigger picker for it. */
export async function handleShopliftingAlertShopSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	const shopId = Number(interaction.values[0]);
	const conditions = Number.isInteger(shopId)
		? shopliftingAlertConditionsForShop(shopId)
		: [];

	if (conditions.length === 0) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Unknown Shop",
					"That shop is no longer available. Try `/shoplifting-alerts add` again.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferUpdate();

	const shop = SHOPLIFTING_SHOPS.find((entry) => entry.id === shopId);
	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				shop?.name ?? "Shoplifting Alert",
				"Choose which security window should DM you. You are alerted when it opens and when it recovers.",
				EMBED_COLORS.PRIMARY,
			),
		],
		components: [buildConditionSelect(shopId)],
	});
}

/** Trigger chosen: validate, store, and confirm ephemerally. */
export async function handleShopliftingAlertConditionSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	const shopId = parseConditionSelectId(interaction.customId);
	const rawCondition = interaction.values[0];

	if (shopId === null || shopId <= 0) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Invalid Shop",
					"That shop could not be read. Try `/shoplifting-alerts add` again.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!isUserShopliftingAlertCondition(rawCondition)) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Missing Trigger",
					"Pick what should trigger the alert and submit the form again.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!interaction.guildId) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Server Unavailable",
					"This command only works inside the faction server.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const condition: UserShopliftingAlertCondition = rawCondition;
	await interaction.deferUpdate();

	try {
		const created = await createUserShopliftingAlert({
			guildId: interaction.guildId,
			discordUserId: interaction.user.id,
			shopId,
			condition,
		});

		const embed = createBaseEmbed(
			"Shoplifting Alert Created",
			"You will be DM'd when this window opens and when it closes again. Check your privacy settings allow direct messages from this server's members.",
			EMBED_COLORS.SUCCESS,
		);
		embed.addFields({
			name: describeUserShopliftingAlert(created),
			value:
				"Alerts fire on both transitions, so one break produces one message when it starts and one when it ends.",
			inline: false,
		});

		await interaction.editReply({ embeds: [embed], components: [] });
	} catch (err) {
		const message =
			err instanceof UserShopliftingAlertError
				? err.message
				: "Something went wrong saving that alert. Please try again.";
		if (!(err instanceof UserShopliftingAlertError)) {
			logger.error("Failed to create a personal shoplifting alert:", err);
		}
		await interaction.editReply({
			embeds: [createErrorEmbed("Could Not Save Alert", message)],
			components: [],
		});
	}
}

/** Remove menu submitted: delete the chosen alert. */
export async function handleShopliftingAlertRemoveSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	const alertId = interaction.values[0];
	await interaction.deferUpdate();

	if (!alertId) {
		await interaction.editReply({
			embeds: [
				createErrorEmbed("Nothing Selected", "Pick an alert to delete."),
			],
			components: [],
		});
		return;
	}

	const removed = await deleteUserShopliftingAlert(
		alertId,
		interaction.user.id,
	);

	await interaction.editReply({
		embeds: [
			removed
				? createBaseEmbed(
						"Shoplifting Alert Removed",
						"That alert will no longer DM you.",
						EMBED_COLORS.SUCCESS,
					)
				: createErrorEmbed(
						"Alert Not Found",
						"That alert no longer exists — it may already have been removed.",
					),
		],
		components: [],
	});
}

/** Clear confirmed: delete every alert the user owns in this guild. */
export async function handleShopliftingAlertClearConfirm(
	interaction: ButtonInteraction,
): Promise<void> {
	await interaction.deferUpdate();

	const removed = await deleteAllUserShopliftingAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);

	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				"Shoplifting Alerts Cleared",
				`Removed ${removed} personal shoplifting alert${removed === 1 ? "" : "s"}.`,
				EMBED_COLORS.SUCCESS,
			),
		],
		components: [],
	});
}

/** Clear cancelled: leave the alerts alone. */
export async function handleShopliftingAlertClearCancel(
	interaction: ButtonInteraction,
): Promise<void> {
	await interaction.update({
		embeds: [
			createBaseEmbed(
				"Nothing Changed",
				"Your shoplifting alerts were left as they were.",
				EMBED_COLORS.PRIMARY,
			),
		],
		components: [],
	});
}
