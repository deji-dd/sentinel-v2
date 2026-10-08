import {
	and,
	db,
	eq,
	subversiveRwChannelConfigs,
	subversiveRwDisplayMessages,
} from "@sentinel/database";
import {
	RW_FRIENDLY_CATEGORY,
	type RwFriendlyLine,
	type RwFriendlyUpdate,
} from "@sentinel/schemas";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	MessageFlags,
	TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { paginateItems } from "./giveaway-helpers";
import { logger } from "./logger";

/**
 * Renders the friendly ranked-war display: the faction's **own** members who
 * allow revives.
 *
 * The mirror image of the primary displays' `revivable` bucket — where that one
 * lists opponents our members can revive, this one lists teammates who can be
 * revived by us, so revivers have a single place to look. Like every other
 * ranked-war display the bot is a pure renderer: the scheduler reads the own
 * roster and pushes it over IPC, and nothing here reads Torn.
 *
 * One persistent paginated embed per faction, tracked under
 * `RW_FRIENDLY_CATEGORY` so it can never collide with the four primary rows or
 * the travel embed sharing `subversive_rw_display_messages`.
 *
 * Unlike the primary displays this board does not sweep its channel, matching
 * the travel board: the sweep exists to clear four embeds that are posted
 * independently, and an author-gated sweep of an admin's channel is a large
 * blast radius for one message.
 */

/** Players shown per page, matching the other ranked-war displays. */
const ITEMS_PER_PAGE = 15;

/**
 * Shortest gap between two repaints of the same faction.
 *
 * The scheduler pushes on a one-second war cadence and each repaint edits one
 * message. Five seconds leaves room to spare against Discord's per-channel edit
 * budget while still feeling live.
 */
const MIN_RENDER_INTERVAL_MS = 5_000;

/** How long a roster stays usable for button pagination. */
const ROSTER_CACHE_TTL_MS = 120_000;

const PROFILE_URL = (id: number) =>
	`https://www.torn.com/profiles.php?XID=${id}`;

function customId(factionId: number, page: number): string {
	return `rw_friendly_page:${factionId}:${page}`;
}

/**
 * One member's row.
 *
 * Downed members carry their hospital timer — that is the actionable half of
 * this board. Everyone else carries last-seen, so a reviver can see who is even
 * around to be downed next. No battle stats and no attack link: this is our own
 * roster, so neither applies.
 */
function buildRow(line: RwFriendlyLine): string {
	const name = `[${line.name} [${line.id}]](${PROFILE_URL(line.id)})`;
	if (line.hospitalUntil !== null) {
		return `${name} • In hospital • Out <t:${line.hospitalUntil}:R>`;
	}
	if (line.lastSeenAt === 0) return `${name} • Last seen unknown`;
	return `${name} • Last seen <t:${line.lastSeenAt}:R>`;
}

/**
 * Builds the friendly revive embed and its pagination controls.
 *
 * Exported for tests: the exact title and row strings are the feature's
 * contract, so they are asserted directly rather than through a live channel.
 *
 * Green while anyone is listed, mirroring the faction monitoring revives
 * roster: the board existing at all means there is a revive to perform, and an
 * empty board is neutral rather than alarming.
 */
export function buildFriendlyPayload(
	factionId: number,
	factionName: string,
	members: RwFriendlyLine[],
	page = 1,
	itemsPerPage = ITEMS_PER_PAGE,
): {
	embeds: ReturnType<typeof createBaseEmbed>[];
	components: ActionRowBuilder<ButtonBuilder>[];
} {
	const { items, currentPage, totalPages } = paginateItems(
		members,
		page,
		itemsPerPage,
	);

	const description =
		members.length === 0
			? "No faction members currently allow revives."
			: items.map(buildRow).join("\n");

	const embed = createBaseEmbed(
		`${factionName} • ${members.length} revivable ${
			members.length === 1 ? "member" : "members"
		}`,
		description,
		members.length > 0 ? EMBED_COLORS.SUCCESS : EMBED_COLORS.PRIMARY,
	);

	embed.setFooter({
		text: `Sentinel • Page ${currentPage} of ${totalPages} • Total: ${members.length}`,
	});
	embed.setTimestamp();

	const components: ActionRowBuilder<ButtonBuilder>[] = [];
	if (totalPages > 1) {
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(customId(factionId, currentPage - 1))
				.setLabel("◀ Previous")
				.setStyle(ButtonStyle.Primary)
				.setDisabled(currentPage <= 1),
			new ButtonBuilder()
				.setCustomId(customId(factionId, currentPage))
				.setLabel(`${currentPage} / ${totalPages}`)
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(true),
			new ButtonBuilder()
				.setCustomId(customId(factionId, currentPage + 1))
				.setLabel("Next ▶")
				.setStyle(ButtonStyle.Primary)
				.setDisabled(currentPage >= totalPages),
		);
		components.push(row);
	}

	return { embeds: [embed], components };
}

/** In-memory roster per faction, kept fresh by each IPC push. */
interface CachedFriendlyRoster {
	factionName: string;
	members: RwFriendlyLine[];
	timestamp: number;
}

const rosterCache = new Map<number, CachedFriendlyRoster>();

/**
 * Coalescing flag rather than a queue, matching the other displays: a render
 * already in flight reflects the newest payload it will see, and any push
 * landing mid-render is picked up by the trailing pass.
 */
const rendersInFlight = new Set<number>();
const repaintRequested = new Set<number>();
const lastRenderAtMs = new Map<number, number>();

/** Test seam: drops every piece of in-memory state. */
export function resetRwFriendlyDisplaysState(): void {
	rosterCache.clear();
	rendersInFlight.clear();
	repaintRequested.clear();
	lastRenderAtMs.clear();
}

/* ────────────────────────── persistence ────────────────────────── */

/**
 * Reads the tracked message id for this faction's friendly board.
 *
 * Scoped to `RW_FRIENDLY_CATEGORY` so it can never pick up one of the four
 * primary rows or the travel embed sharing this table.
 */
async function loadTrackedMessageId(factionId: number): Promise<string | null> {
	const [row] = await db
		.select({ messageId: subversiveRwDisplayMessages.messageId })
		.from(subversiveRwDisplayMessages)
		.where(
			and(
				eq(subversiveRwDisplayMessages.factionId, factionId),
				eq(subversiveRwDisplayMessages.category, RW_FRIENDLY_CATEGORY),
			),
		)
		.limit(1);

	return row?.messageId ?? null;
}

async function persistMessageId(
	factionId: number,
	messageId: string,
): Promise<void> {
	await db
		.insert(subversiveRwDisplayMessages)
		.values({ factionId, category: RW_FRIENDLY_CATEGORY, messageId })
		.onConflictDoUpdate({
			target: [
				subversiveRwDisplayMessages.factionId,
				subversiveRwDisplayMessages.category,
			],
			set: { messageId, updatedAt: new Date() },
		});
}

async function clearTrackedMessageId(factionId: number): Promise<void> {
	await db
		.delete(subversiveRwDisplayMessages)
		.where(
			and(
				eq(subversiveRwDisplayMessages.factionId, factionId),
				eq(subversiveRwDisplayMessages.category, RW_FRIENDLY_CATEGORY),
			),
		);
}

/* ────────────────────────── teardown ────────────────────────── */

/**
 * Deletes the friendly board and forgets its id.
 *
 * The id is cleared even when deletion fails: a message this bot can no longer
 * reach is worse than a missing row, and keeping the id would make the next war
 * try to edit a message that will never resolve.
 */
export async function teardownRwFriendlyDisplays(
	client: Client,
	factionId: number,
	channelId: string | null,
): Promise<number> {
	rosterCache.delete(factionId);

	const messageId = await loadTrackedMessageId(factionId);
	if (!messageId) return 0;

	let deleted = 0;
	if (channelId) {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;

		if (channel && "messages" in channel) {
			try {
				const message = await channel.messages
					.fetch(messageId)
					.catch(() => null);
				if (message) {
					await message.delete();
					deleted = 1;
				}
			} catch (err) {
				logger.warn(
					`Failed deleting ranked-war friendly board ${messageId}:`,
					err,
				);
			}
		}
	}

	await clearTrackedMessageId(factionId);
	return deleted;
}

/* ────────────────────────── rendering ────────────────────────── */

/**
 * Marks the friendly channel selection unusable when the selected channel has
 * gone away.
 *
 * Nulling the selection stops the scheduler repainting into a channel that no
 * longer exists, and lets an admin re-pick from the dashboard. Only this
 * faction's own column is cleared — the other two displays keep rendering into
 * their own, still-valid channels.
 */
async function invalidateChannelConfig(
	factionId: number,
	channelId: string,
	reason: string,
): Promise<void> {
	logger.warn(
		`Ranked-war friendly display channel ${channelId} for faction ${factionId} ${reason}. Clearing the selection.`,
	);
	await db
		.update(subversiveRwChannelConfigs)
		.set({ friendlyDisplaysChannelId: null, updatedAt: new Date() })
		.where(eq(subversiveRwChannelConfigs.factionId, factionId))
		.catch((err) =>
			logger.warn(
				`Failed clearing invalid friendly channel for faction ${factionId}:`,
				err,
			),
		);
}

async function renderRwFriendlyDisplays(
	client: Client,
	update: RwFriendlyUpdate,
): Promise<void> {
	const { factionId, channelId } = update;

	// The war ended: remove the board rather than leaving a finished war's
	// revive list on screen. The payload carries the last known channel so the
	// message can still be located.
	if (update.warState === "no_war") {
		await teardownRwFriendlyDisplays(client, factionId, channelId);
		return;
	}

	if (!channelId) {
		// The admin deselected the friendly channel. Whatever was rendered
		// belongs to the old selection and should not linger.
		await teardownRwFriendlyDisplays(client, factionId, null);
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
		await teardownRwFriendlyDisplays(client, factionId, channelId);
		return;
	}

	const payload = buildFriendlyPayload(
		factionId,
		update.factionName,
		update.members,
		1,
	);

	try {
		const trackedId = await loadTrackedMessageId(factionId);
		const existing = trackedId
			? await channel.messages.fetch(trackedId).catch(() => null)
			: null;

		if (existing) {
			await existing.edit({
				embeds: payload.embeds,
				components: payload.components,
			});
		} else {
			const sent = await channel.send({
				embeds: payload.embeds,
				components: payload.components,
			});
			await persistMessageId(factionId, sent.id);
		}
	} catch (err) {
		logger.error(
			`Failed rendering ranked-war friendly display for faction ${factionId}:`,
			err,
		);
	}
}

/**
 * Entry point for one scheduler push.
 *
 * Caches the roster for button pagination, then repaints unless a render is
 * already running or the minimum interval has not elapsed.
 */
export async function updateRwFriendlyDisplays(
	client: Client,
	update: RwFriendlyUpdate,
): Promise<void> {
	const factionId = update.factionId;

	// A war-ended teardown is terminal, not a repaint: run it immediately so it
	// is never swallowed by the render throttle or the roster cache.
	if (update.warState === "no_war") {
		try {
			await renderRwFriendlyDisplays(client, update);
		} catch (err) {
			logger.error(
				`Failed tearing down ranked-war friendly display for faction ${factionId}:`,
				err,
			);
		}
		return;
	}

	rosterCache.set(factionId, {
		factionName: update.factionName,
		members: update.members,
		timestamp: Date.now(),
	});

	if (rendersInFlight.has(factionId)) {
		repaintRequested.add(factionId);
		return;
	}

	if (
		Date.now() - (lastRenderAtMs.get(factionId) ?? 0) <
		MIN_RENDER_INTERVAL_MS
	) {
		return;
	}

	rendersInFlight.add(factionId);
	try {
		do {
			repaintRequested.delete(factionId);
			const current = rosterCache.get(factionId);
			if (!current) break;
			lastRenderAtMs.set(factionId, Date.now());
			await renderRwFriendlyDisplays(client, {
				...update,
				factionName: current.factionName,
				members: current.members,
			});
		} while (repaintRequested.has(factionId));
	} catch (err) {
		logger.error(
			`Failed updating ranked-war friendly display for faction ${factionId}:`,
			err,
		);
	} finally {
		rendersInFlight.delete(factionId);
	}
}

/* ────────────────────────── button pagination ────────────────────────── */

/**
 * Handles a page button press on the friendly board.
 *
 * Serves from the in-memory roster cache. A miss tells the operator to wait for
 * the next automatic repaint rather than answering with a page from a roster
 * that may be minutes old — a stale revive list sends people to the wrong
 * hospital bed.
 */
export async function handleRwFriendlyButton(
	interaction: ButtonInteraction,
): Promise<void> {
	if (!interaction.customId.startsWith("rw_friendly_page:")) return;

	const parts = interaction.customId.split(":");
	const factionId = Number(parts[1]);
	const page = Number.parseInt(parts[2] ?? "1", 10) || 1;

	if (!Number.isFinite(factionId)) return;

	try {
		const cached = rosterCache.get(factionId);
		if (!cached || Date.now() - cached.timestamp >= ROSTER_CACHE_TTL_MS) {
			await interaction.reply({
				content:
					"The revive board is no longer cached. Displays refresh automatically within a few seconds — try again.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await interaction.update(
			buildFriendlyPayload(factionId, cached.factionName, cached.members, page),
		);
	} catch (err) {
		logger.error(
			"Failed handling ranked-war friendly display pagination button:",
			err,
		);
	}
}
