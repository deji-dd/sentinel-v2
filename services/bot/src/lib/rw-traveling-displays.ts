import {
	and,
	db,
	eq,
	subversiveRwChannelConfigs,
	subversiveRwDisplayMessages,
} from "@sentinel/database";
import {
	RW_TRAVELING_CATEGORY,
	type RwOpponentLine,
	type RwTravelingBuckets,
	type RwTravelingUpdate,
	TRAVEL_DESTINATION_LABELS,
	type TravelDestination,
} from "@sentinel/schemas";
import { formatNumber } from "@sentinel/utils";
import {
	ActionRowBuilder,
	type Client,
	MessageFlags,
	StringSelectMenuBuilder as SelectMenu,
	type StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

/**
 * Renders the secondary ranked-war display: where the opposing roster is
 * currently flying.
 *
 * Like the primary displays, the bot is a pure renderer — the scheduler groups
 * the airborne roster and pushes it over IPC. Nothing here reads Torn.
 *
 * A single persistent embed is maintained per faction, carrying one bold field
 * per active destination plus a select menu that expands a destination into an
 * ephemeral player list.
 */

/**
 * Shortest gap between two repaints of the same faction.
 *
 * The scheduler pushes on a one-second war cadence and each repaint edits one
 * message. Five seconds leaves room to spare against Discord's per-channel
 * edit budget while still feeling live.
 */
const MIN_RENDER_INTERVAL_MS = 5_000;

/** How long a destination roster stays usable for a select-menu press. */
const ROSTER_CACHE_TTL_MS = 120_000;

const PROFILE_URL = (id: number) =>
	`https://www.torn.com/profiles.php?XID=${id}`;

function customId(factionId: number): string {
	return `rw_traveling_select:${factionId}`;
}

const playerRow = (line: RwOpponentLine) =>
	`[${line.name} [${line.id}]](${PROFILE_URL(line.id)}) • ${formatNumber(
		line.estimatedBs,
	)}`;

/**
 * Builds the persistent travel embed.
 *
 * One field per active destination, bolded name with a plain count as the
 * value. When nobody is airborne the embed keeps the same title and says so in
 * the description instead — a titled empty state reads better than an embed
 * that silently loses its fields.
 *
 * Field count is bounded by Torn's 12 destinations, well under Discord's
 * 25-field limit.
 */
export function buildTravelingEmbed(
	opponentFactionName: string,
	destinations: RwTravelingBuckets,
): ReturnType<typeof createBaseEmbed> {
	const embed = createBaseEmbed(
		`${opponentFactionName} • Players traveling`,
		destinations.length === 0 ? "Nobody is currently flying" : undefined,
		EMBED_COLORS.PRIMARY,
	);

	for (const { destination, players } of destinations) {
		embed.addFields({
			name: `**${TRAVEL_DESTINATION_LABELS[destination]}**`,
			value: `${players.length} ${players.length === 1 ? "person" : "people"} flying here`,
			inline: true,
		});
	}

	return embed;
}

/**
 * Builds the destination select menu.
 *
 * Only destinations with at least one airborne player are offered: a dropdown
 * full of empty destinations would answer every selection with an empty list.
 * Returns null when nobody is flying, since an empty select is not a legal
 * component.
 */
export function buildTravelingSelectRow(
	factionId: number,
	destinations: RwTravelingBuckets,
): ActionRowBuilder<StringSelectMenuBuilder> | null {
	if (destinations.length === 0) return null;

	const select = new SelectMenu()
		.setCustomId(customId(factionId))
		.setPlaceholder("Select a destination for player details...")
		.addOptions(
			destinations.map(({ destination, players }) => ({
				label: TRAVEL_DESTINATION_LABELS[destination],
				// Discord caps option labels at 100 chars and values at 100.
				// The label is already a fixed short name, so reuse it as the
				// value and let the handler map back through the roster cache.
				value: destination,
				description: `${players.length} flying`,
			})),
		);

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/**
 * Builds the ephemeral detail embed shown when a destination is selected.
 *
 * Uses the raw destination rather than the display label here: the label exists
 * to disambiguate "Torn" from a country inside the embed field list and the
 * dropdown, but interpolated into a sentence it produces "Traveling to
 * Returning to Torn". On its own "Traveling to Torn" already reads correctly.
 *
 * Returns null when the destination is unknown or empty so the caller can
 * answer with a plain message instead of a contentless embed.
 */
export function buildTravelingDestinationEmbed(
	opponentFactionName: string,
	destination: TravelDestination,
	players: RwOpponentLine[],
): ReturnType<typeof createBaseEmbed> | null {
	if (players.length === 0) return null;

	return createBaseEmbed(
		`${opponentFactionName} • Traveling to ${destination}`,
		players.map(playerRow).join("\n"),
		EMBED_COLORS.PRIMARY,
	);
}

/** Test seam: drops every piece of in-memory state. */
export function resetRwTravelingState(): void {
	rosterCache.clear();
	rendersInFlight.clear();
	repaintRequested.clear();
	lastRenderAtMs.clear();
}

/* ────────────────────────── roster cache ────────────────────────── */

interface CachedTravelRoster {
	opponentFactionName: string;
	destinations: RwTravelingBuckets;
	timestamp: number;
}

const rosterCache = new Map<number, CachedTravelRoster>();

/**
 * Coalescing flag rather than a queue. A render already in flight reflects the
 * newest payload it will see, and any push landing mid-render is picked up by
 * the trailing pass. Queueing would build an unbounded backlog at a one-second
 * cadence.
 */
const rendersInFlight = new Set<number>();
const repaintRequested = new Set<number>();
const lastRenderAtMs = new Map<number, number>();

/* ────────────────────────── persistence ────────────────────────── */

/**
 * Reads the tracked message id for this faction's travel embed.
 *
 * Scoped to the `traveling` category so it can never collide with the four
 * primary rows sharing this table.
 */
async function loadTrackedMessageId(factionId: number): Promise<string | null> {
	const [row] = await db
		.select({ messageId: subversiveRwDisplayMessages.messageId })
		.from(subversiveRwDisplayMessages)
		.where(
			and(
				eq(subversiveRwDisplayMessages.factionId, factionId),
				eq(subversiveRwDisplayMessages.category, RW_TRAVELING_CATEGORY),
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
		.values({ factionId, category: RW_TRAVELING_CATEGORY, messageId })
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
				eq(subversiveRwDisplayMessages.category, RW_TRAVELING_CATEGORY),
			),
		);
}

/* ────────────────────────── teardown ────────────────────────── */

/**
 * Deletes the travel embed and forgets its id.
 *
 * The id is cleared even when deletion fails: a message this bot can no longer
 * reach is worse than a missing row, and keeping the id would make the next war
 * try to edit a message that will never resolve.
 */
export async function teardownRwTravelingDisplays(
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
					`Failed deleting ranked-war travel embed ${messageId}:`,
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
 * Marks the channel selection unusable when the selected channel has gone away.
 *
 * Nulling the selection stops the scheduler repainting into a channel that no
 * longer exists, and lets an admin re-pick from the dashboard. Without this a
 * deleted secondary channel would sit in the config forever, since the read
 * path cannot distinguish "deleted" from "configured but empty".
 */
async function invalidateChannelConfig(
	factionId: number,
	channelId: string,
	reason: string,
): Promise<void> {
	logger.warn(
		`Ranked-war secondary display channel ${channelId} for faction ${factionId} ${reason}. Clearing the selection.`,
	);
	await db
		.update(subversiveRwChannelConfigs)
		.set({ secondaryDisplaysChannelId: null, updatedAt: new Date() })
		.where(eq(subversiveRwChannelConfigs.factionId, factionId))
		.catch((err) =>
			logger.warn(
				`Failed clearing invalid secondary channel for faction ${factionId}:`,
				err,
			),
		);
}

async function renderRwTravelingDisplays(
	client: Client,
	update: RwTravelingUpdate,
): Promise<void> {
	const { factionId, channelId } = update;

	// The war ended: remove the embed rather than leaving a finished war's
	// travel data on screen. The payload carries the last known channel so the
	// message can still be located.
	if (update.warState === "no_war") {
		await teardownRwTravelingDisplays(client, factionId, channelId);
		return;
	}

	if (!channelId) {
		// The admin deselected the secondary channel. Whatever was rendered
		// belongs to the old selection and should not linger.
		await teardownRwTravelingDisplays(client, factionId, null);
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
		await teardownRwTravelingDisplays(client, factionId, channelId);
		return;
	}

	const embed = buildTravelingEmbed(
		update.opponentFactionName,
		update.destinations,
	);
	const selectRow = buildTravelingSelectRow(factionId, update.destinations);
	const components = selectRow ? [selectRow] : [];

	try {
		const trackedId = await loadTrackedMessageId(factionId);
		const existing = trackedId
			? await channel.messages.fetch(trackedId).catch(() => null)
			: null;

		if (existing) {
			await existing.edit({ embeds: [embed], components });
		} else {
			const sent = await channel.send({ embeds: [embed], components });
			await persistMessageId(factionId, sent.id);
		}
	} catch (err) {
		logger.error(
			`Failed rendering ranked-war travel display for faction ${factionId}:`,
			err,
		);
	}
}

/**
 * Entry point for one scheduler push.
 *
 * Caches the roster for select-menu presses, then repaints unless a render is
 * already running or the minimum interval has not elapsed.
 */
export async function updateRwTravelingDisplays(
	client: Client,
	update: RwTravelingUpdate,
): Promise<void> {
	const factionId = update.factionId;

	// A war-ended teardown is terminal, not a repaint: run it immediately so it
	// is never swallowed by the render throttle or the roster cache.
	if (update.warState === "no_war") {
		try {
			await renderRwTravelingDisplays(client, update);
		} catch (err) {
			logger.error(
				`Failed tearing down ranked-war travel display for faction ${factionId}:`,
				err,
			);
		}
		return;
	}

	rosterCache.set(factionId, {
		opponentFactionName: update.opponentFactionName,
		destinations: update.destinations,
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
			await renderRwTravelingDisplays(client, {
				...update,
				opponentFactionName: current.opponentFactionName,
				destinations: current.destinations,
			});
		} while (repaintRequested.has(factionId));
	} catch (err) {
		logger.error(
			`Failed updating ranked-war travel display for faction ${factionId}:`,
			err,
		);
	} finally {
		rendersInFlight.delete(factionId);
	}
}

/* ────────────────────────── select menu ────────────────────────── */

function isTravelDestination(value: string): value is TravelDestination {
	return value in TRAVEL_DESTINATION_LABELS;
}

/**
 * Handles a destination selection on the travel embed.
 *
 * Serves from the in-memory roster cache. Torn reports no arrival time for a
 * traveling player (`status.until` is null), so the list cannot show an ETA —
 * it is a snapshot of who is currently inbound.
 */
export async function handleRwTravelingSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	if (!interaction.customId.startsWith("rw_traveling_select:")) return;

	const factionId = Number(interaction.customId.split(":")[1]);
	const destination = interaction.values[0];

	if (
		!Number.isFinite(factionId) ||
		!destination ||
		!isTravelDestination(destination)
	) {
		return;
	}

	try {
		const cached = rosterCache.get(factionId);
		if (!cached || Date.now() - cached.timestamp >= ROSTER_CACHE_TTL_MS) {
			await interaction.reply({
				content:
					"That travel roster is no longer cached. The display refreshes automatically within a few seconds — try again.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const bucket = cached.destinations.find(
			(d) => d.destination === destination,
		);
		const embed = bucket
			? buildTravelingDestinationEmbed(
					cached.opponentFactionName,
					bucket.destination,
					bucket.players,
				)
			: null;

		// The destination can vanish between renders, so answer with a plain
		// message rather than an embed with no content.
		await interaction.reply({
			...(embed
				? { embeds: [embed] }
				: {
						content: "Nobody is currently flying to that destination.",
					}),
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Failed handling ranked-war travel destination select:", err);
	}
}
