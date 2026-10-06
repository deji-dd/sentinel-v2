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
	type MessageActionRowComponentBuilder,
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
/** Prefix for the picker's Previous/Next buttons; the target page follows the colon. */
export const STOCK_ALERT_STOCK_PAGE_ID = "stock_alert_stock_page";

const MODAL_CONDITION_FIELD = "condition";
const MODAL_RANGE_FIELD = "range";
const MODAL_AMOUNT_FIELD = "amount";

/**
 * Number of pages the market needs.
 *
 * Paging is done with buttons rather than a sentinel entry inside the list, so every
 * page gets the full 25 slots for stocks. A "show more" option would have made a
 * full page 26 options, which Discord rejects outright rather than truncating.
 */
function pageCount(total: number): number {
	return Math.max(1, Math.ceil(total / SELECT_OPTION_LIMIT));
}

function pageSlice(stocks: StockOption[], page: number): StockOption[] {
	const start = page * SELECT_OPTION_LIMIT;
	return stocks.slice(start, start + SELECT_OPTION_LIMIT);
}

/**
 * Clamps a requested page into the range the market actually has.
 *
 * Page numbers come back from a button's `custom_id`, which is untrusted input: a
 * stale message from before a redeploy, or a hand-crafted id, can name a page that
 * does not exist or is not a number at all. Without this an unparseable page
 * propagates silently — `slice(NaN, NaN)` yields no stocks at all and the
 * placeholder renders "page NaN of 2" — so every page is clamped to something real
 * before it is used.
 */
function clampPage(page: number, total: number): number {
	if (!Number.isFinite(page)) return 0;
	const lastPage = pageCount(total) - 1;
	return Math.min(Math.max(Math.trunc(page), 0), lastPage);
}

/**
 * Builds the stock picker for one page.
 *
 * No page number travels in the `custom_id` any more: paging is handled by the
 * Previous/Next buttons, so the select only ever reports which stock was chosen and
 * the handler has no page to parse — and therefore no page to get wrong.
 */
export function buildStockPicker(
	stocks: StockOption[],
	page: number,
): ActionRowBuilder<StringSelectMenuBuilder> {
	const current = clampPage(page, stocks.length);
	const total = pageCount(stocks.length);

	const select = new StringSelectMenuBuilder()
		.setCustomId(STOCK_ALERT_STOCK_SELECT_ID)
		.setPlaceholder(
			total > 1
				? `Pick a stock (page ${current + 1} of ${total})`
				: "Pick a stock",
		)
		.addOptions(
			pageSlice(stocks, current).map((stock) => ({
				label: formatStockOption(stock).slice(0, 100),
				value: String(stock.id),
			})),
		);

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * The picker plus its paging controls, as the rows a message needs.
 *
 * The buttons are disabled at the ends rather than wrapping around: with only two
 * or three pages, a wrap makes it impossible to tell which page you are looking at
 * from the controls alone.
 */
export function buildStockPickerRows(
	stocks: StockOption[],
	page: number,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
	const current = clampPage(page, stocks.length);
	const total = pageCount(stocks.length);
	const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
		buildStockPicker(stocks, current),
	];

	if (total > 1) {
		rows.push(
			new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`${STOCK_ALERT_STOCK_PAGE_ID}:${current - 1}`)
					.setLabel("Previous")
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(current === 0),
				new ButtonBuilder()
					.setCustomId(`${STOCK_ALERT_STOCK_PAGE_ID}:${current + 1}`)
					.setLabel("Next")
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(current === total - 1),
			),
		);
	}

	return rows;
}

/** The embed that sits above the picker, shared by every page of it. */
export function buildPickerEmbed(): EmbedBuilder {
	return createBaseEmbed(
		"New Stock Alert",
		"Pick the stock you want to watch. You will choose the condition on the next screen.",
		EMBED_COLORS.PRIMARY,
	);
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

	await interaction.editReply({
		embeds: [buildPickerEmbed()],
		components: buildStockPickerRows(stocks, 0),
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

/**
 * Previous/Next pressed: re-render the picker on the requested page.
 *
 * The target page travels in the button's `custom_id`, so the message can be
 * rebuilt without keeping any state between interactions. The requested page is
 * clamped rather than trusted: it arrives from Discord, but a message rendered
 * before a redeploy could name a page that no longer exists.
 */
export async function handleStockAlertPageButton(
	interaction: ButtonInteraction,
): Promise<void> {
	await interaction.deferUpdate();

	const requested = Number(interaction.customId.split(":")[1]);
	const stocks = await fetchStockUniverse();

	if (stocks.length === 0) {
		await interaction.editReply({
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

	await interaction.editReply({
		embeds: [buildPickerEmbed()],
		components: buildStockPickerRows(stocks, requested),
	});
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
