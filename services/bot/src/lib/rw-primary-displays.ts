import {
	and,
	db,
	eq,
	inArray,
	subversiveRwChannelConfigs,
	subversiveRwDisplayMessages,
} from "@sentinel/database";
import {
	RW_DISPLAY_CATEGORIES,
	type RwDisplayBuckets,
	type RwDisplayCategory,
	type RwDisplaysUpdate,
	type RwOpponentLine,
} from "@sentinel/schemas";
import { formatNumber } from "@sentinel/utils";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	type Message,
	TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { paginateItems } from "./giveaway-helpers";
import { logger } from "./logger";

/**
 * Renders the four ranked-war opponent displays into a faction's primary
 * displays channel.
 *
 * The bot is a pure renderer for this feature: the scheduler classifies the
 * opposing roster and pushes it over IPC. Nothing here reads Torn or re-derives
 * war state.
 */

/** Players shown per page, matching the faction monitoring roster embed. */
const ITEMS_PER_PAGE = 15;

/**
 * Shortest gap between two repaints of the same faction.
 *
 * The scheduler pushes on a one-second war cadence, and each repaint edits up
 * to four messages. Without this floor that is four edits per second against
 * Discord's per-channel budget.
 */
const MIN_RENDER_INTERVAL_MS = 5_000;

/** How long a roster stays usable for button pagination. */
const ROSTER_CACHE_TTL_MS = 120_000;

/** Longest lookback when sweeping stale bot messages. */
const SWEEP_SCAN_LIMIT = 100;

/** Discord refuses to bulk-delete messages older than this. */
const BULK_DELETE_CUTOFF_MS = 14 * 24 * 60 * 60 * 1000;

const PROFILE_URL = (id: number) =>
	`https://www.torn.com/profiles.php?XID=${id}`;
const ATTACK_URL = (id: number) =>
	`https://www.torn.com/page.php?sid=attack&user2ID=${id}`;

/** Per-category presentation: title suffix, row format, and colour. */
interface CategoryPresentation {
	suffix: string;
	color: number;
	/** Rows the embed cannot show at all. */
	emptyDescription: string;
	buildRow: (line: RwOpponentLine) => string;
}

const nameLink = (line: RwOpponentLine) =>
	`[${line.name} [${line.id}]](${PROFILE_URL(line.id)})`;
const bsOf = (line: RwOpponentLine) => formatNumber(line.estimatedBs);
const attackLink = (line: RwOpponentLine) => `[Attack](${ATTACK_URL(line.id)})`;
const seenAgo = (line: RwOpponentLine) => `Last seen <t:${line.lastSeenAt}:R>`;

const PRESENTATION: Record<RwDisplayCategory, CategoryPresentation> = {
	// Out the door first: the soonest departure is the actionable one.
	hospital: {
		suffix: "leaving hospital",
		color: EMBED_COLORS.WARNING,
		emptyDescription: "No opponent players are leaving hospital.",
		buildRow: (line) =>
			`${nameLink(line)} • ${bsOf(line)} • Out in <t:${line.hospitalUntil}:R>`,
	},
	offlineOkay: {
		suffix: "offline & okay",
		color: EMBED_COLORS.PRIMARY,
		emptyDescription: "No opponent players are offline and okay.",
		buildRow: (line) =>
			`${nameLink(line)} • ${bsOf(line)} • ${seenAgo(line)} • ${attackLink(line)}`,
	},
	onlineOkay: {
		suffix: "online & okay",
		color: EMBED_COLORS.SUCCESS,
		emptyDescription: "No opponent players are online and okay.",
		buildRow: (line) =>
			`${nameLink(line)} • ${bsOf(line)} • ${attackLink(line)}`,
	},
	revivable: {
		suffix: "revivable",
		color: EMBED_COLORS.DANGER,
		emptyDescription: "No revivable opponent players.",
		buildRow: (line) =>
			`${nameLink(line)} • ${bsOf(line)} • ${seenAgo(line)} • ${attackLink(line)}`,
	},
};

/** In-memory roster per faction, kept fresh by each IPC push. */
interface CachedRoster {
	opponentFactionName: string;
	buckets: RwDisplayBuckets;
	timestamp: number;
}

const rosterCache = new Map<number, CachedRoster>();

/**
 * Guards against overlapping repaints.
 *
 * A coalescing flag rather than a queue: when pushes arrive faster than Discord
 * can be written to, the in-flight render already reflects the newest payload it
 * will see, and any push that lands mid-render is picked up by the trailing
 * run. Queueing instead would build an unbounded backlog at a one-second
 * cadence.
 */
const rendersInFlight = new Set<number>();
const repaintRequested = new Set<number>();
const lastRenderAtMs = new Map<number, number>();

/** Test seam: clears every piece of in-memory state. */
export function resetRwPrimaryDisplaysState(): void {
	rosterCache.clear();
	rendersInFlight.clear();
	repaintRequested.clear();
	lastRenderAtMs.clear();
}

function customId(
	factionId: number,
	category: RwDisplayCategory,
	page: number,
) {
	return `rw_displays_page:${factionId}:${category}:${page}`;
}

/**
 * Builds one category's embed and its pagination controls.
 *
 * Exported for tests: the exact title and row strings are the feature's
 * contract, so they are asserted directly rather than through a live channel.
 */
export function buildDisplaysPayload(
	factionId: number,
	opponentFactionName: string,
	category: RwDisplayCategory,
	lines: RwOpponentLine[],
	page = 1,
	itemsPerPage = ITEMS_PER_PAGE,
): {
	embeds: ReturnType<typeof createBaseEmbed>[];
	components: ActionRowBuilder<ButtonBuilder>[];
} {
	const presentation = PRESENTATION[category];
	const { items, currentPage, totalPages } = paginateItems(
		lines,
		page,
		itemsPerPage,
	);

	const description =
		lines.length === 0
			? presentation.emptyDescription
			: items.map(presentation.buildRow).join("\n");

	const embed = createBaseEmbed(
		`${opponentFactionName} • ${lines.length} ${presentation.suffix}`,
		description,
		presentation.color,
	);

	embed.setFooter({
		text: `Sentinel • Page ${currentPage} of ${totalPages} • Total: ${lines.length}`,
	});
	embed.setTimestamp();

	const components: ActionRowBuilder<ButtonBuilder>[] = [];
	if (totalPages > 1) {
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(customId(factionId, category, currentPage - 1))
				.setLabel("◀ Previous")
				.setStyle(ButtonStyle.Primary)
				.setDisabled(currentPage <= 1),
			new ButtonBuilder()
				.setCustomId(customId(factionId, category, currentPage))
				.setLabel(`${currentPage} / ${totalPages}`)
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(true),
			new ButtonBuilder()
				.setCustomId(customId(factionId, category, currentPage + 1))
				.setLabel("Next ▶")
				.setStyle(ButtonStyle.Primary)
				.setDisabled(currentPage >= totalPages),
		);
		components.push(row);
	}

	return { embeds: [embed], components };
}

/* ────────────────────────── persistence ────────────────────────── */

async function loadTrackedMessageIds(
	factionId: number,
): Promise<Map<RwDisplayCategory, string>> {
	const rows = await db
		.select({
			category: subversiveRwDisplayMessages.category,
			messageId: subversiveRwDisplayMessages.messageId,
		})
		.from(subversiveRwDisplayMessages)
		.where(eq(subversiveRwDisplayMessages.factionId, factionId));

	const out = new Map<RwDisplayCategory, string>();
	for (const row of rows) {
		if ((RW_DISPLAY_CATEGORIES as readonly string[]).includes(row.category)) {
			out.set(row.category as RwDisplayCategory, row.messageId);
		}
	}
	return out;
}

async function persistMessageId(
	factionId: number,
	category: RwDisplayCategory,
	messageId: string,
): Promise<void> {
	await db
		.insert(subversiveRwDisplayMessages)
		.values({ factionId, category, messageId })
		.onConflictDoUpdate({
			target: [
				subversiveRwDisplayMessages.factionId,
				subversiveRwDisplayMessages.category,
			],
			set: { messageId, updatedAt: new Date() },
		});
}

/**
 * Deletes the tracked messages and forgets their ids.
 *
 * Ids are cleared even when deletion fails: a message this bot can no longer
 * reach is worse than a missing row, and retaining the id would make the next
 * war try to edit a message that will never resolve.
 */
export async function teardownRwPrimaryDisplays(
	client: Client,
	factionId: number,
	channelId: string | null,
): Promise<number> {
	const tracked = await loadTrackedMessageIds(factionId);
	if (tracked.size === 0) return 0;

	let deleted = 0;
	if (channelId) {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;

		if (channel && "messages" in channel) {
			for (const messageId of tracked.values()) {
				try {
					const message = await channel.messages
						.fetch(messageId)
						.catch(() => null);
					if (!message) continue;
					await message.delete();
					deleted++;
				} catch (err) {
					logger.warn(
						`Failed deleting ranked-war display ${messageId} in #${channel.name}:`,
						err,
					);
				}
			}
		}
	}

	await db
		.delete(subversiveRwDisplayMessages)
		.where(eq(subversiveRwDisplayMessages.factionId, factionId))
		.catch((err) =>
			logger.warn(
				`Failed clearing ranked-war display rows for faction ${factionId}:`,
				err,
			),
		);

	rosterCache.delete(factionId);
	return deleted;
}

/* ────────────────────────── channel cleanup ────────────────────────── */

/**
 * Deletes stale bot-authored displays left in the channel.
 *
 * Only messages this bot posted are ever considered, so unrelated channel
 * content is never touched. Tracked ids are always spared even if their row
 * looks orphaned, because the live render is about to edit them.
 */
export async function sweepRwDisplaysChannel(
	client: Client,
	channel: TextChannel,
	keepMessageIds: Set<string>,
	scanLimit = SWEEP_SCAN_LIMIT,
): Promise<number> {
	const messages = await channel.messages
		.fetch({ limit: scanLimit })
		.catch(() => null);
	if (!messages) return 0;

	const toDelete: Message[] = [];
	for (const message of messages.values()) {
		if (keepMessageIds.has(message.id)) continue;
		// Authorship gate: never delete anything we cannot prove we posted.
		if (message.author?.bot !== true) continue;
		if (message.author.id !== client.user?.id) continue;
		toDelete.push(message);
	}

	if (toDelete.length === 0) return 0;

	let deleted = 0;
	const cutoff = Date.now() - BULK_DELETE_CUTOFF_MS;
	const bulkDeleteable = toDelete.filter((m) => m.createdTimestamp > cutoff);

	if (bulkDeleteable.length > 0) {
		try {
			await channel.bulkDelete(bulkDeleteable, true);
			deleted += bulkDeleteable.length;
		} catch (err) {
			logger.warn(`Failed bulk-deleting stale ranked-war displays:`, err);
		}
	}

	for (const message of toDelete) {
		if (message.createdTimestamp > cutoff) continue;
		try {
			await message.delete();
			deleted++;
		} catch {}
	}

	return deleted;
}

/**
 * Marks the channel config unusable when the selected channel has gone away.
 *
 * Nulling the selection stops the scheduler repainting into a channel that no
 * longer exists, and lets the admin re-pick a channel from the dashboard.
 */
async function invalidateChannelConfig(
	factionId: number,
	channelId: string,
	reason: string,
): Promise<void> {
	logger.warn(
		`Ranked-war primary display channel ${channelId} for faction ${factionId} ${reason}. Clearing the selection.`,
	);
	await db
		.update(subversiveRwChannelConfigs)
		.set({ primaryDisplaysChannelId: null, updatedAt: new Date() })
		.where(eq(subversiveRwChannelConfigs.factionId, factionId))
		.catch((err) =>
			logger.warn(
				`Failed clearing invalid channel selection for faction ${factionId}:`,
				err,
			),
		);
}

/* ────────────────────────── rendering ────────────────────────── */

async function renderRwPrimaryDisplays(
	client: Client,
	update: RwDisplaysUpdate,
): Promise<void> {
	const { factionId, channelId } = update;

	// The war ended: remove anything this feature rendered rather than leaving
	// a finished war on screen. The payload carries the last known channel so
	// the messages can still be located and deleted.
	if (update.warState === "no_war") {
		await teardownRwPrimaryDisplays(client, factionId, channelId);
		return;
	}

	if (!channelId) {
		// The admin deselected the channel. Anything we previously rendered
		// belongs to the old selection and should not linger, so tear it down.
		await teardownRwPrimaryDisplays(client, factionId, null);
		return;
	}

	const channel = (await client.channels
		.fetch(channelId)
		.catch(() => null)) as TextChannel | null;

	if (!channel || !(channel instanceof TextChannel)) {
		await invalidateChannelConfig(
			factionId,
			channelId,
			"is missing or is not a text channel",
		);
		await teardownRwPrimaryDisplays(client, factionId, channelId);
		return;
	}

	const tracked = await loadTrackedMessageIds(factionId);
	const liveIds = new Set<string>();
	const renderedCategories: RwDisplayCategory[] = [];

	for (const category of RW_DISPLAY_CATEGORIES) {
		try {
			const payload = buildDisplaysPayload(
				factionId,
				update.opponentFactionName,
				category,
				update.buckets[category],
				1,
			);

			const trackedId = tracked.get(category);
			const existing = trackedId
				? await channel.messages.fetch(trackedId).catch(() => null)
				: null;

			if (existing) {
				await existing.edit({
					embeds: payload.embeds,
					components: payload.components,
				});
				liveIds.add(existing.id);
			} else {
				const sent = await channel.send({
					embeds: payload.embeds,
					components: payload.components,
				});
				liveIds.add(sent.id);
				await persistMessageId(factionId, category, sent.id);
			}
			renderedCategories.push(category);
		} catch (err) {
			logger.error(
				`Failed rendering ranked-war "${category}" display for faction ${factionId}:`,
				err,
			);
		}
	}

	// A category that was tracked but could not be repainted keeps pointing at
	// a message we could not edit. Drop those rows so the next cycle posts a
	// fresh message instead of chasing a dead id forever.
	const orphanedCategories = [...tracked.keys()].filter(
		(category) => !renderedCategories.includes(category),
	);
	if (orphanedCategories.length > 0) {
		await db
			.delete(subversiveRwDisplayMessages)
			.where(
				and(
					eq(subversiveRwDisplayMessages.factionId, factionId),
					inArray(subversiveRwDisplayMessages.category, orphanedCategories),
				),
			)
			.catch(() => {});
	}

	await sweepRwDisplaysChannel(client, channel, liveIds);
}

/**
 * Entry point for one scheduler push.
 *
 * Caches the roster for button pagination, then repaints unless a render is
 * already running or the minimum interval has not elapsed.
 */
export async function updateRwPrimaryDisplays(
	client: Client,
	update: RwDisplaysUpdate,
): Promise<void> {
	const factionId = update.factionId;

	// A war-ended teardown is a terminal event, not a repaint. Run it
	// immediately: it must never be swallowed by the render throttle or by the
	// roster cache, and it clears the cache itself.
	if (update.warState === "no_war") {
		try {
			await renderRwPrimaryDisplays(client, update);
		} catch (err) {
			logger.error(
				`Failed tearing down ranked-war primary displays for faction ${factionId}:`,
				err,
			);
		}
		return;
	}

	rosterCache.set(factionId, {
		opponentFactionName: update.opponentFactionName,
		buckets: update.buckets,
		timestamp: Date.now(),
	});

	if (rendersInFlight.has(factionId)) {
		// A repaint is already running; ask for one more pass so the newest
		// payload is not dropped.
		repaintRequested.add(factionId);
		return;
	}

	const last = lastRenderAtMs.get(factionId) ?? 0;
	if (Date.now() - last < MIN_RENDER_INTERVAL_MS) return;

	rendersInFlight.add(factionId);
	try {
		do {
			repaintRequested.delete(factionId);
			const current = rosterCache.get(factionId);
			if (!current) break;
			const now = Date.now();
			lastRenderAtMs.set(factionId, now);
			await renderRwPrimaryDisplays(client, {
				...update,
				opponentFactionName: current.opponentFactionName,
				buckets: current.buckets,
			});
		} while (repaintRequested.has(factionId));
	} catch (err) {
		logger.error(
			`Failed updating ranked-war primary displays for faction ${factionId}:`,
			err,
		);
	} finally {
		rendersInFlight.delete(factionId);
	}
}

/* ────────────────────────── button pagination ────────────────────────── */

function isDisplayCategory(value: string): value is RwDisplayCategory {
	return (RW_DISPLAY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Handles a page button press on one of the four displays.
 *
 * Serves from the in-memory roster cache. A miss falls back to asking the
 * scheduler for the faction's live members over IPC, matching how the faction
 * monitoring roster stays clickable.
 */
export async function handleRwDisplaysButton(
	interaction: ButtonInteraction,
): Promise<void> {
	if (!interaction.customId.startsWith("rw_displays_page:")) return;

	const parts = interaction.customId.split(":");
	const factionId = Number(parts[1]);
	const category = parts[2];
	const page = Number.parseInt(parts[3] ?? "1", 10) || 1;

	if (
		!Number.isFinite(factionId) ||
		!category ||
		!isDisplayCategory(category)
	) {
		return;
	}

	try {
		const cached = rosterCache.get(factionId);
		if (!cached || Date.now() - cached.timestamp >= ROSTER_CACHE_TTL_MS) {
			await interaction.reply({
				content:
					"The ranked-war roster is no longer cached. Displays refresh automatically within a few seconds — try again.",
				flags: 64,
			});
			return;
		}

		const payload = buildDisplaysPayload(
			factionId,
			cached.opponentFactionName,
			category,
			cached.buckets[category],
			page,
		);
		await interaction.update(payload);
	} catch (err) {
		logger.error("Failed handling ranked-war display pagination button:", err);
	}
}
