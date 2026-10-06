import {
	describeUserStockAlert,
	isStockAlertRange,
	isUserStockAlertCondition,
	MAX_USER_STOCK_ALERTS,
	STOCK_ALERT_RANGE_LABELS,
	STOCK_ALERT_RANGES,
	type StockAlertRange,
	USER_STOCK_ALERT_CONDITION_LABELS,
	USER_STOCK_ALERT_CONDITIONS,
	type UserStockAlertCondition,
} from "@sentinel/schemas";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type ChatInputCommandInteraction,
	type EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";
import {
	createUserStockAlert,
	deleteAllUserStockAlerts,
	deleteUserStockAlert,
	fetchStockUniverse,
	findStockOption,
	formatStockOption,
	listUserStockAlerts,
	type StockOption,
	UserStockAlertError,
	type UserStockAlertView,
} from "../lib/stock-alert-subscriptions";
import type { BotCommand } from ".";

/**
 * `/stock-alerts` — per-user Torn stock alerts delivered by DM.
 *
 * Deployed to the faction guild only (`scope: "faction"`): personal alerts are a
 * member-facing feature of that server, and the subscription rows are scoped to
 * the guild the command was run in.
 *
 * The whole flow is ephemeral and stateless. Nothing is kept between steps — the
 * chosen stock rides in the modal's `custom_id` and the chosen condition and range
 * are modal field values — so a bot restart mid-flow cannot corrupt a half-finished
 * setup, and no in-memory pending map has to be reaped.
 */

/** Discord's hard cap on the options a single string select may carry. */
const SELECT_OPTION_LIMIT = 25;

/** Custom-id prefixes. Kept together so the router in `interaction-create.ts` and
 * the handlers here cannot drift. */
export const STOCK_ALERT_STOCK_SELECT_ID = "stock_alert_stock_select";
export const STOCK_ALERT_MODAL_ID = "stock_alert_config_modal";
export const STOCK_ALERT_REMOVE_SELECT_ID = "stock_alert_remove_select";
export const STOCK_ALERT_CLEAR_CONFIRM_ID = "stock_alert_clear_confirm";
export const STOCK_ALERT_CLEAR_CANCEL_ID = "stock_alert_clear_cancel";

const MODAL_CONDITION_FIELD = "condition";
const MODAL_RANGE_FIELD = "range";
const MODAL_AMOUNT_FIELD = "amount";

/** Sentinel option value used to page through the stock list. */
const NEXT_PAGE_VALUE = "page:next";

/**
 * How many stocks one page of the picker may hold.
 *
 * One slot is reserved for the "show more" entry whenever the market does not fit
 * on a single page. That entry is itself an option, so a full page of 25 stocks
 * plus the paging entry is 26 options — a count Discord rejects outright, which
 * takes the whole command down rather than merely truncating the list. The market
 * is larger than 25 stocks, so this is the normal path, not an edge case.
 */
function optionCapacity(total: number): number {
	return total <= SELECT_OPTION_LIMIT
		? SELECT_OPTION_LIMIT
		: SELECT_OPTION_LIMIT - 1;
}

/**
 * Number of pages the market needs.
 *
 * Derived from `optionCapacity` rather than from the raw limit, so the page count
 * and the page contents can never disagree about how many stocks a page holds.
 */
function pageCount(total: number): number {
	return Math.max(1, Math.ceil(total / optionCapacity(total)));
}

function pageSlice(stocks: StockOption[], page: number): StockOption[] {
	const capacity = optionCapacity(stocks.length);
	const start = page * capacity;
	return stocks.slice(start, start + capacity);
}

/**
 * Builds the stock picker for one page.
 *
 * The page number lives in the `custom_id` rather than in the option values, so
 * selecting a stock always yields a plain numeric id no matter which page it came
 * from — the handler then has only one shape to parse.
 */
export function buildStockPicker(
	stocks: StockOption[],
	page: number,
): ActionRowBuilder<StringSelectMenuBuilder> {
	const pageStocks = pageSlice(stocks, page);
	const select = new StringSelectMenuBuilder()
		.setCustomId(`${STOCK_ALERT_STOCK_SELECT_ID}:${page}`)
		.setPlaceholder(
			pageCount(stocks.length) > 1
				? `Pick a stock (page ${page + 1} of ${pageCount(stocks.length)})`
				: "Pick a stock",
		)
		.addOptions(
			pageStocks.map((stock) => ({
				label: formatStockOption(stock).slice(0, 100),
				value: String(stock.id),
			})),
		);

	if (pageCount(stocks.length) > 1) {
		select.addOptions({
			label: "➡️ Show more stocks",
			value: NEXT_PAGE_VALUE,
		});
	}

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * The form a user fills in once a stock is chosen.
 *
 * Built as a whole because Discord's `Label` component is only reachable through
 * `ModalBuilder.addLabelComponents`, whose builders are not re-exported by this
 * version of discord.js — so the labels are constructed through the callback form
 * rather than by importing `LabelBuilder` from a package that is not a declared
 * dependency.
 *
 * The range and amount fields are optional because their relevance depends on the
 * trigger chosen in the same form; validation afterwards produces a specific
 * message for the combinations that need them, which is more useful than refusing
 * to submit.
 *
 * Note that the inner components carry no label of their own. A `Label` *is* the
 * label for its child, so Discord rejects the payload outright when the child also
 * sets one (`Cannot set label on a TextInput in a Label component`); the official
 * type documents the field as "Cannot be used in a label component". The hint a
 * text input would otherwise put in its own label therefore belongs in the Label's
 * description.
 */
export function buildAlertModal(stock: StockOption): ModalBuilder {
	const conditionSelect = new StringSelectMenuBuilder()
		.setCustomId(MODAL_CONDITION_FIELD)
		.setPlaceholder("What should trigger the alert?")
		.addOptions(
			USER_STOCK_ALERT_CONDITIONS.map((condition) => ({
				label: USER_STOCK_ALERT_CONDITION_LABELS[condition],
				value: condition,
			})),
		);

	const rangeSelect = new StringSelectMenuBuilder()
		.setCustomId(MODAL_RANGE_FIELD)
		.setPlaceholder("Range — for % change and high/low")
		.setMinValues(0)
		.setMaxValues(1)
		.setRequired(false)
		.addOptions(
			STOCK_ALERT_RANGES.map((range) => ({
				label: STOCK_ALERT_RANGE_LABELS[range],
				value: range,
			})),
		);

	const amountInput = new TextInputBuilder()
		.setCustomId(MODAL_AMOUNT_FIELD)
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(16)
		.setPlaceholder("e.g. 1200 or 5");

	return new ModalBuilder()
		.setCustomId(`${STOCK_ALERT_MODAL_ID}:${stock.id}`)
		.setTitle(`Alert: ${stock.acronym}`.slice(0, 45))
		.addLabelComponents(
			(label) =>
				label
					.setLabel("Trigger")
					.setDescription(
						"Price above/below need an amount. % change needs an amount and a range. High/low need a range.",
					)
					.setStringSelectMenuComponent(conditionSelect),
			(label) =>
				label
					.setLabel("Range")
					.setDescription("Ignored by the price above/below triggers.")
					.setStringSelectMenuComponent(rangeSelect),
			(label) =>
				label
					.setLabel("Amount")
					.setDescription("Dollars, or % for a percentage alert.")
					.setTextInputComponent(amountInput),
		);
}

/** Renders the user's alerts as a list embed. */
function buildListEmbed(
	views: UserStockAlertView[],
	stockNames: Map<number, string>,
): EmbedBuilder {
	const embed = createBaseEmbed(
		"Your Stock Alerts",
		undefined,
		EMBED_COLORS.PRIMARY,
	);

	if (views.length === 0) {
		embed.setDescription(
			"You have no personal stock alerts. Use `/stock-alerts add` to create one.",
		);
		return embed;
	}

	embed.setDescription(
		`${views.length} of ${MAX_USER_STOCK_ALERTS} alerts. You are DM'd when a condition fires.`,
	);
	embed.addFields(
		views.map((view, index) => ({
			name: `${index + 1}. ${stockNames.get(view.stockId) ?? `Stock ${view.stockId}`}`,
			value: describeUserStockAlert(view),
			inline: false,
		})),
	);

	return embed;
}

/** Loads the stock names a list embed needs, without failing the whole reply. */
async function resolveStockNames(
	views: UserStockAlertView[],
): Promise<Map<number, string>> {
	const universe = await fetchStockUniverse();
	const byId = new Map(universe.map((stock) => [stock.id, stock]));
	return new Map(
		views.map((view) => {
			const stock = byId.get(view.stockId);
			return [
				view.stockId,
				stock ? formatStockOption(stock) : `Stock ${view.stockId}`,
			];
		}),
	);
}

/** Says why the picker cannot be shown yet, in terms the user can act on. */
const UNIVERSE_UNAVAILABLE_MESSAGE =
	"The Torn stock list is unavailable right now. Please try again in a few minutes.";

// ─── Command ────────────────────────────────────────────────────────────────

export const stockAlertsCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("stock-alerts")
		.setDescription("Get a DM when a Torn stock hits a condition you choose.")
		.addSubcommand((subcommand) =>
			subcommand
				.setName("add")
				.setDescription("Create a personal stock alert."),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("list")
				.setDescription("Show your personal stock alerts."),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("remove")
				.setDescription("Delete one of your personal stock alerts."),
		)
		.addSubcommand((subcommand) =>
			subcommand
				.setName("clear")
				.setDescription("Delete all of your personal stock alerts."),
		),
	// Faction-guild only: personal stock alerts are a member feature of that
	// server, and subscriptions are scoped to the guild that created them.
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

/** `/stock-alerts add` — open the stock picker. */
async function handleAdd(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const stocks = await fetchStockUniverse();
	if (stocks.length === 0) {
		await interaction.editReply({
			embeds: [
				createErrorEmbed(
					"Stock List Unavailable",
					UNIVERSE_UNAVAILABLE_MESSAGE,
				),
			],
		});
		return;
	}

	const embed = createBaseEmbed(
		"New Stock Alert",
		"Pick the stock you want to watch. You will choose the condition on the next screen.",
		EMBED_COLORS.PRIMARY,
	);

	await interaction.editReply({
		embeds: [embed],
		components: [buildStockPicker(stocks, 0)],
	});
}

/** `/stock-alerts list` — the user's alerts. */
async function handleList(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const views = await listUserStockAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);
	const names = await resolveStockNames(views);

	await interaction.editReply({ embeds: [buildListEmbed(views, names)] });
}

/** `/stock-alerts remove` — pick one of the user's alerts to delete. */
async function handleRemove(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const views = await listUserStockAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);

	if (views.length === 0) {
		await interaction.editReply({
			embeds: [buildListEmbed([], new Map())],
		});
		return;
	}

	const names = await resolveStockNames(views);
	const select = new StringSelectMenuBuilder()
		.setCustomId(STOCK_ALERT_REMOVE_SELECT_ID)
		.setPlaceholder("Pick an alert to delete")
		.addOptions(
			views.slice(0, SELECT_OPTION_LIMIT).map((view) => ({
				label: `${names.get(view.stockId) ?? view.stockId}`.slice(0, 100),
				description: describeUserStockAlert(view).slice(0, 100),
				value: view.id,
			})),
		);

	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				"Remove A Stock Alert",
				"Choose the alert you want to stop receiving.",
				EMBED_COLORS.WARNING,
			),
		],
		components: [
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
		],
	});
}

/** `/stock-alerts clear` — confirm before deleting everything. */
async function handleClear(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const views = await listUserStockAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);

	if (views.length === 0) {
		await interaction.editReply({
			embeds: [buildListEmbed([], new Map())],
		});
		return;
	}

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(STOCK_ALERT_CLEAR_CONFIRM_ID)
			.setLabel(`Delete all ${views.length}`)
			.setStyle(ButtonStyle.Danger),
		new ButtonBuilder()
			.setCustomId(STOCK_ALERT_CLEAR_CANCEL_ID)
			.setLabel("Cancel")
			.setStyle(ButtonStyle.Secondary),
	);

	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				"Delete All Stock Alerts?",
				`This removes all ${views.length} of your personal stock alerts. It cannot be undone.`,
				EMBED_COLORS.DANGER,
			),
		],
		components: [row],
	});
}

// ─── Interaction handlers ───────────────────────────────────────────────────

/**
 * Stock chosen: show the configuration form.
 *
 * The picker selection is acknowledged by the modal itself — a modal must be the
 * first response to a component interaction, so there is deliberately no
 * `deferUpdate` here.
 */
export async function handleStockAlertStockSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	const page = Number(interaction.customId.split(":")[0]);

	// "Show more stocks" pages the picker rather than choosing a stock, which is
	// why the page lives in the custom id: the list can be re-rendered without
	// keeping any server-side state.
	if (interaction.values[0] === NEXT_PAGE_VALUE) {
		const stocks = await fetchStockUniverse();
		const total = pageCount(stocks.length);
		if (stocks.length === 0) {
			await interaction.update({
				embeds: [
					createErrorEmbed(
						"Stock List Unavailable",
						UNIVERSE_UNAVAILABLE_MESSAGE,
					),
				],
				components: [],
			});
			return;
		}

		const nextPage = (Math.max(0, page) + 1) % total;

		await interaction.update({
			embeds: [
				createBaseEmbed(
					"New Stock Alert",
					"Pick the stock you want to watch. You will choose the condition on the next screen.",
					EMBED_COLORS.PRIMARY,
				),
			],
			components: [buildStockPicker(stocks, nextPage)],
		});
		return;
	}

	const stockId = Number(interaction.values[0]);
	if (!Number.isInteger(stockId) || stockId <= 0) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Invalid Stock",
					"That stock could not be read. Try again.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const stock = await findStockOption(stockId);
	if (!stock) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Unknown Stock",
					"That stock is no longer in the Torn market.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.showModal(buildAlertModal(stock));
}

/** Form submitted: validate, store, and confirm ephemerally. */
export async function handleStockAlertModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	const stockId = Number(interaction.customId.split(":")[1]);
	const rawCondition = interaction.fields.getStringSelectValues(
		MODAL_CONDITION_FIELD,
	)[0];
	// A select left blank arrives as an empty list, not as a null.
	const rawRange =
		interaction.fields.getStringSelectValues(MODAL_RANGE_FIELD)[0] ?? null;
	const rawAmount = interaction.fields
		.getTextInputValue(MODAL_AMOUNT_FIELD)
		.trim();

	if (!Number.isInteger(stockId) || stockId <= 0) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Invalid Stock",
					"That stock could not be read. Try again.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!isUserStockAlertCondition(rawCondition)) {
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

	const condition: UserStockAlertCondition = rawCondition;
	const range: StockAlertRange | null =
		rawRange && isStockAlertRange(rawRange) ? rawRange : null;
	// Blank means "no amount", which validation turns into a specific complaint
	// for the conditions that need one.
	const threshold = rawAmount === "" ? null : Number(rawAmount);

	if (threshold !== null && !Number.isFinite(threshold)) {
		await interaction.reply({
			embeds: [
				createErrorEmbed(
					"Invalid Amount",
					"The Amount field must be a number (for example `1200` or `5`).",
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

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	try {
		const created = await createUserStockAlert({
			guildId: interaction.guildId,
			discordUserId: interaction.user.id,
			stockId,
			condition,
			range,
			threshold,
		});

		const stock = await findStockOption(created.stockId);
		const embed = createBaseEmbed(
			"Stock Alert Created",
			`You will be DM'd when this fires. Check your privacy settings allow direct messages from this server's members.`,
			EMBED_COLORS.SUCCESS,
		);
		embed.addFields({
			name: stock ? formatStockOption(stock) : `Stock ${created.stockId}`,
			value: describeUserStockAlert(created),
			inline: false,
		});

		await interaction.editReply({ embeds: [embed] });
	} catch (err) {
		const message =
			err instanceof UserStockAlertError
				? err.message
				: "Something went wrong saving that alert. Please try again.";
		if (!(err instanceof UserStockAlertError)) {
			logger.error("Failed to create a personal stock alert:", err);
		}
		await interaction.editReply({
			embeds: [createErrorEmbed("Could Not Save Alert", message)],
		});
	}
}

/** Remove menu submitted: delete the chosen alert. */
export async function handleStockAlertRemoveSelect(
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

	const removed = await deleteUserStockAlert(alertId, interaction.user.id);

	await interaction.editReply({
		embeds: [
			removed
				? createBaseEmbed(
						"Stock Alert Removed",
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
export async function handleStockAlertClearConfirm(
	interaction: ButtonInteraction,
): Promise<void> {
	await interaction.deferUpdate();

	const removed = await deleteAllUserStockAlerts(
		interaction.guildId ?? "",
		interaction.user.id,
	);

	await interaction.editReply({
		embeds: [
			createBaseEmbed(
				"Stock Alerts Cleared",
				`Removed ${removed} personal stock alert${removed === 1 ? "" : "s"}.`,
				EMBED_COLORS.SUCCESS,
			),
		],
		components: [],
	});
}

/** Clear cancelled: leave the alerts alone. */
export async function handleStockAlertClearCancel(
	interaction: ButtonInteraction,
): Promise<void> {
	await interaction.update({
		embeds: [
			createBaseEmbed(
				"Nothing Changed",
				"Your stock alerts were left as they were.",
				EMBED_COLORS.PRIMARY,
			),
		],
		components: [],
	});
}
