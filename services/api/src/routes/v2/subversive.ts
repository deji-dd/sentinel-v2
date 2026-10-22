import type { SubversiveGuildConfigRow } from "@sentinel/database";
import {
	and,
	count,
	db,
	desc,
	eq,
	getServerTypeMappings,
	getSubversiveGuildConfig,
	gte,
	guildApiKeys,
	ilike,
	or,
	saveSubversiveGuildConfig,
	SUBVERSIVE_RECRUITMENT_CONFIG_ID,
	subversiveApiKeys,
	subversiveCalendarEvents,
	subversiveRankedWars,
	subversiveRecruitmentCandidates,
	subversiveRecruitmentConfigs,
	subversiveTargetFinderUsers,
	updateSubversiveAdminRoleIds,
	WORKER_STATE_IDS,
	workerState,
} from "@sentinel/database";
import {
	MAX_SUBVERSIVE_CHAIN_START,
	MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS,
	MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS,
	MIN_SUBVERSIVE_CHAIN_START,
	MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS,
} from "@sentinel/schemas";
import {
	encryptApiKey,
	hashApiKey,
	isValidApiKey,
	TornApiClient,
} from "@sentinel/torn-api";
import {
	getSubversiveFactionName,
	isSubversiveFamilyFaction,
	PRIMARY_SUBVERSIVE_FACTION_ID,
	resolveSubversiveFactionId,
	SUBVERSIVE_FAMILY_FACTION_IDS,
} from "@sentinel/utils";
import { Elysia, t } from "elysia";

import { env } from "../../config/env";
import {
	ChainConfigError,
	subversiveChainConfigManager,
} from "../../lib/chain-config-manager";
import { subversiveDibsManager } from "../../lib/dibs-manager";
import { dibsMessageStore } from "../../lib/dibs-message-store";
import { fetchDiscordApi } from "../../lib/discord-auth";
import { resolveDiscordTornUser } from "../../lib/resolve-discord-torn-user";
import {
	RwChannelConflictError,
	subversiveRwChannelManager,
} from "../../lib/rw-channel-manager";
import {
	notifySchedulerForceRun,
	notifySchedulerResetRecruitment,
} from "../../lib/scheduler-ipc";
import {
	categoryTitle,
	FACTION_CALENDAR_CATEGORIES,
	getFactionCalendarEvents,
	getTornCalendarEvents,
	getUpcomingCalendarEvents,
	isFactionCalendarCategory,
	STEADFAST_STATS,
	TORN_CALENDAR_ACCENT,
	UPCOMING_WINDOW_DAYS,
} from "../../lib/subversive-calendar";
import { hasActiveSubversiveKeys } from "../../lib/subversive-key-pool";
import { authPlugin } from "../../middleware/auth";
import { verifyGuildAdmin } from "./guilds";
import {
	resolveUserSession,
	serveUserscript,
} from "./subversive-target-finder";

interface DiscordGuild {
	id: string;
	name: string;
	icon: string | null;
	owner: boolean;
	permissions: string;
}

interface DiscordRole {
	id: string;
	name: string;
	color: number;
	position: number;
	permissions: string;
	managed: boolean;
}

interface DiscordGuildMember {
	user?: {
		id: string;
		username: string;
		global_name?: string | null;
		avatar: string | null;
		bot?: boolean;
	};
	nick?: string | null;
	roles: string[];
	permissions?: string;
}

const INVALID_DIBS_FACTION_ERROR =
	"Invalid factionId: dibs settings are only available for the Subversive family factions.";

/**
 * Reshapes a `subversive_guild_configs` row into the JSON this API has always
 * returned for the guild config.
 *
 * The columns are now separate, but the wire format is unchanged: `configuredAt`
 * and `updatedAt` stay ISO strings and `configuredBy` stays a nested object, so
 * existing dashboard consumers need no changes.
 */
function toGuildConfigResponse(row: SubversiveGuildConfigRow | null): {
	guildId: string;
	guildName: string | null;
	guildIcon: string | null;
	adminRoleIds: string[];
	configuredAt: string | null;
	configuredBy: { discordId: string | null; username: string | null };
	updatedAt: string;
} | null {
	if (!row) return null;
	return {
		guildId: row.guildId,
		guildName: row.guildName,
		guildIcon: row.guildIcon,
		adminRoleIds: row.adminRoleIds,
		configuredAt: row.configuredAt ? row.configuredAt.toISOString() : null,
		configuredBy: {
			discordId: row.configuredByDiscordId,
			username: row.configuredByUsername,
		},
		updatedAt: row.updatedAt.toISOString(),
	};
}

const INVALID_RW_CHANNELS_FACTION_ERROR =
	"Invalid factionId: ranked-war channels are only available for the Subversive family factions.";

const INVALID_CHAIN_FACTION_ERROR =
	"Invalid factionId: chain monitoring is only available for the Subversive family factions.";

/**
 * Validates an optional faction id coming from a request and resolves it to a
 * Subversive family faction. Defaults to Subversive Alliance (2013) when absent
 * so older clients keep working against the primary faction.
 *
 * Sets a 400 status and returns null when the id is not a family faction.
 */
function parseSubversiveFactionId(
	raw: number | null | undefined,
	set: { status?: number | string },
): number | null {
	if (raw === undefined || raw === null || Number.isNaN(raw)) {
		return PRIMARY_SUBVERSIVE_FACTION_ID;
	}
	if (!SUBVERSIVE_FAMILY_FACTION_IDS.includes(raw)) {
		set.status = 400;
		return null;
	}
	return raw;
}

/**
 * Resolves the faction that owns a dibs target so Discord button claims and
 * releases are evaluated against the owning faction's settings rather than
 * defaulting to Subversive Alliance.
 */
function resolveDibsFactionForTarget(targetId: number): number | undefined {
	return subversiveDibsManager.getDibsByTargetId(targetId)?.factionId;
}

// In-memory cache for Discord member lookups (30s TTL)
const memberCache = new Map<
	string,
	{ member: DiscordGuildMember | null; expiresAt: number }
>();

// In-memory cache for Discord bot guilds (60s TTL)
let cachedBotGuilds: { guilds: DiscordGuild[]; expiresAt: number } | null =
	null;
let inFlightBotGuildsPromise: Promise<DiscordGuild[] | null> | null = null;

async function getBotGuilds(
	botToken: string,
	forceFresh = false,
): Promise<DiscordGuild[]> {
	if (
		!forceFresh &&
		cachedBotGuilds &&
		cachedBotGuilds.expiresAt > Date.now()
	) {
		return cachedBotGuilds.guilds;
	}

	if (inFlightBotGuildsPromise) {
		const res = await inFlightBotGuildsPromise;
		if (res && res.length > 0) return res;
	}

	inFlightBotGuildsPromise = fetchDiscordApi<DiscordGuild[]>(
		"/users/@me/guilds",
		`Bot ${botToken}`,
	);

	try {
		const guilds = await inFlightBotGuildsPromise;
		if (guilds && Array.isArray(guilds) && guilds.length > 0) {
			cachedBotGuilds = {
				guilds,
				expiresAt: Date.now() + 60 * 1000,
			};
			return guilds;
		}
		if (cachedBotGuilds) {
			return cachedBotGuilds.guilds;
		}
		return guilds ?? [];
	} finally {
		inFlightBotGuildsPromise = null;
	}
}

function getBotInviteUrl(guildId?: string): string {
	const clientId = env.DISCORD_CLIENT_ID;
	const base = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands`;
	if (guildId) {
		return `${base}&guild_id=${guildId}&disable_guild_select=true`;
	}
	return base;
}

export async function getSubversiveTargetGuildId(): Promise<string> {
	const config = await getSubversiveGuildConfig();
	if (config?.guildId) return config.guildId;
	const serverTypes = await getServerTypeMappings();
	return serverTypes.faction ?? "";
}

export async function verifySubversiveAdmin(
	user: { role: string; discordId?: string | null } | null,
): Promise<boolean> {
	if (!user) return false;
	if (user.role === "owner" || user.role === "admin") return true;

	const targetGuildId = await getSubversiveTargetGuildId();
	return verifyGuildAdmin(user, targetGuildId);
}

/** Ranked War Enlistment is a whole Tuesday and nothing else. */
const RW_ENLISTMENT_WEEKDAY_UTC = 2; // Tuesday

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day `date` falls in. */
function startOfUtcDay(date: Date): Date {
	return new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
}

/**
 * A faction event as the dashboard is allowed to create it.
 *
 * Categories carry their own title and accent, so the only things the client
 * gets to decide are when the event happens, which faction it belongs to, and —
 * for Steadfast Change — which battlestats it asks for.
 */
interface FactionEventWrite {
	title: string;
	category: string;
	description: string;
	startTime: Date;
	endTime: Date;
	isAllDay: boolean;
	primaryStat: string | null;
	secondaryStat: string | null;
	factionId: number;
}

function isSteadfastStat(value: string): boolean {
	return (STEADFAST_STATS as readonly string[]).includes(value);
}

/**
 * The error a write that would place an event entirely in the past comes back
 * with, or `null` when the window is still ahead.
 *
 * "Entirely" is the whole rule, and it is deliberately measured at the end: an
 * event that has already started and is still running is a normal thing to put
 * on the calendar, so only a window that has closed is refused.
 *
 * `storedEnd` is when the event on the row already ends, for an update. An event
 * that has already ended is history — its notes still need correcting, and it
 * may even be extended back into the future — so the guard only fires when a
 * write *moves* a live or future event into the past. Without that exemption,
 * editing any past event would be impossible and the row would be stuck.
 */
export function pastEventError(
	endTime: Date,
	options?: { storedEnd?: Date | null; now?: Date },
): string | null {
	const now = options?.now ?? new Date();

	if (endTime.getTime() >= now.getTime()) return null;
	if (options?.storedEnd && options.storedEnd.getTime() < now.getTime()) {
		return null;
	}

	return "endTime is in the past: a calendar event cannot be scheduled for a window that has already passed.";
}

/**
 * Validates a create/update payload and normalises it into column values.
 *
 * Returns `{ error }` for anything the caller must reject, so both the POST and
 * the PUT answer identically instead of drifting apart. `existing` lets an event
 * sitting in a retired category be edited without forcing a re-categorisation.
 */
function resolveFactionEventWrite(
	body: {
		category?: string;
		description?: string;
		startTime?: string;
		endTime?: string;
		isAllDay?: boolean;
		primaryStat?: string | null;
		secondaryStat?: string | null;
		factionId?: number;
	},
	existing?: { category: string; title: string },
): { error: string } | { values: FactionEventWrite } {
	const category = body.category;

	if (category === undefined) {
		return { error: "category is required." };
	}
	if (!isFactionCalendarCategory(category)) {
		if (category !== existing?.category) {
			return {
				error: `category must be one of ${FACTION_CALENDAR_CATEGORIES.map((c) => c.value).join(", ")}.`,
			};
		}
	}

	const startDate =
		body.startTime === undefined ? null : new Date(body.startTime);
	const endDate = body.endTime === undefined ? null : new Date(body.endTime);

	if (startDate && Number.isNaN(startDate.getTime())) {
		return { error: "Invalid startTime format." };
	}
	if (endDate && Number.isNaN(endDate.getTime())) {
		return { error: "Invalid endTime format." };
	}
	if (!startDate || !endDate) {
		return { error: "startTime and endTime are required." };
	}

	let primaryStat: string | null = null;
	let secondaryStat: string | null = null;

	if (category === "steadfast_change") {
		const primary = body.primaryStat ?? "";
		const secondary = body.secondaryStat ?? "";

		if (!isSteadfastStat(primary) || !isSteadfastStat(secondary)) {
			return {
				error: `primaryStat and secondaryStat must each be one of ${STEADFAST_STATS.join(", ")}.`,
			};
		}
		if (primary === secondary) {
			return {
				error: "primaryStat and secondaryStat must be different stats.",
			};
		}

		primaryStat = primary;
		secondaryStat = secondary;
	}

	let start = startDate;
	let end = endDate;
	let isAllDay = body.isAllDay ?? false;

	if (category === "war") {
		// The enlistment date is all the caller has to get right: enlistment is a
		// whole Tuesday, so the day boundaries are the event's own and the time
		// inputs are not consulted at all.
		if (start.getUTCDay() !== RW_ENLISTMENT_WEEKDAY_UTC) {
			return { error: "Ranked War Enlistment must be on a Tuesday." };
		}

		start = startOfUtcDay(start);
		end = new Date(start.getTime() + MS_PER_DAY - 1000);
		isAllDay = true;
	} else if (category === "steadfast_change") {
		// A Steadfast Change is one whole day, so its date is the only thing the
		// caller decides — exactly as an enlistment's Tuesday is its own. The end
		// it sends is not consulted at all: the directive is "hold these stats for
		// this day", and a range would let the calendar describe a stat switch that
		// starts or stops mid-day.
		const startDay = startOfUtcDay(start);

		start = startDay;
		end = new Date(startDay.getTime() + MS_PER_DAY - 1000);
		isAllDay = true;
	} else if (end.getTime() < start.getTime()) {
		return { error: "endTime must be after startTime." };
	}

	return {
		values: {
			// A retired category keeps the title it was stored with; current ones
			// are titled by their category.
			title: isFactionCalendarCategory(category)
				? categoryTitle(category)
				: (existing?.title ?? categoryTitle(category)),
			category,
			description: body.description?.trim() ?? "",
			startTime: start,
			endTime: end,
			isAllDay,
			primaryStat,
			secondaryStat,
			factionId: resolveSubversiveFactionId(body.factionId),
		},
	};
}

export const subversiveRoutes = new Elysia({ prefix: "/subversive" })
	// ─── GET /script & /script.user.js (Public Subversive Userscript Download) ─
	.get("/script", async ({ query, set }) => {
		return serveUserscript(query, set);
	})
	.get("/script.user.js", async ({ query, set }) => {
		return serveUserscript(query, set);
	})
	.use(authPlugin)

	// ─── GET /api/v2/subversive/calendar (Public Torn & Faction Calendar) ───────
	.get(
		"/calendar",
		async ({ user, query, set }) => {
			const yearNum = query.year ?? new Date().getUTCFullYear();
			if (!Number.isInteger(yearNum) || yearNum < 1970 || yearNum > 2100) {
				set.status = 400;
				return {
					success: false,
					error: "year must be an integer between 1970 and 2100.",
				};
			}

			const factionId = query.factionId;
			if (factionId !== undefined && !isSubversiveFamilyFaction(factionId)) {
				set.status = 400;
				return {
					success: false,
					error: `factionId must be one of ${SUBVERSIVE_FAMILY_FACTION_IDS.join(", ")}.`,
				};
			}

			const canEdit = await verifySubversiveAdmin(user);

			// The cache-busting read is an admin convenience: it must not let an
			// anonymous visitor turn every request into a fresh database read.
			const refresh =
				canEdit && (query.refresh === "true" || query.refresh === "1");

			const torn = await getTornCalendarEvents({
				year: yearNum,
				forceFresh: refresh,
			});

			// Only what the family scheduled: the war ledger is not mirrored in, so
			// a finished ranked war never back-fills the calendar.
			const factionEvents = await getFactionCalendarEvents({
				year: yearNum,
				factionId,
			});

			// Its own query rather than a slice of the year above, because the window
			// runs from *now* and has to cross the year boundary in December instead
			// of stopping where the requested year does.
			const upcomingEvents = await getUpcomingCalendarEvents({
				factionId,
				forceFresh: refresh,
			});

			return {
				success: true,
				year: yearNum,
				serverTime: new Date().toISOString(),
				serverTimestamp: Math.floor(Date.now() / 1000),
				canEdit,
				tornEvents: torn.events,
				tornEventsSource: torn.source,
				factionEvents,
				/**
				 * What is live now or next, independent of the requested year, so the
				 * dashboard can show it in one place without reading a whole year.
				 */
				upcoming: {
					windowDays: UPCOMING_WINDOW_DAYS,
					events: upcomingEvents,
				},
				/**
				 * What the calendar's colours mean. Every faction category owns one
				 * fixed accent and every official Torn activity shares a single,
				 * deliberately different one, so the UI never has to guess and the
				 * form never has to ask for a colour.
				 */
				accentKey: {
					torn: { label: "Official Torn", color: TORN_CALENDAR_ACCENT },
					faction: FACTION_CALENDAR_CATEGORIES.map((category) => ({
						value: category.value,
						label: category.label,
						color: category.color,
					})),
				},
				categories: FACTION_CALENDAR_CATEGORIES.map(
					(category) => category.value,
				),
			};
		},
		{
			query: t.Object({
				year: t.Optional(t.Numeric()),
				factionId: t.Optional(t.Numeric()),
				refresh: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Subversive & Torn Calendar Events",
				description:
					"Publicly accessible calendar aggregating official Torn competitions/events and Subversive faction events, plus an 'upcoming' window of everything live now or starting in the next 30 days.",
			},
		},
	)

	// ─── POST /api/v2/subversive/calendar/events (Create Faction Event) ──────────
	.post(
		"/calendar/events",
		async ({ user, body, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin || !user) {
				set.status = 403;
				return {
					success: false,
					error: "Unauthorized: Subversive leadership or admin required.",
				};
			}

			const resolved = resolveFactionEventWrite(body);
			if ("error" in resolved) {
				set.status = 400;
				return { success: false, error: resolved.error };
			}

			// The calendar is a plan, so it refuses to be back-filled: a window that
			// has already closed is not something to schedule.
			const pastError = pastEventError(resolved.values.endTime);
			if (pastError) {
				set.status = 400;
				return { success: false, error: pastError };
			}

			const [created] = await db
				.insert(subversiveCalendarEvents)
				.values({
					...resolved.values,
					createdById: user.discordId ?? String(user.id),
					createdByName: user.username,
				})
				.returning();

			return { success: true, event: created };
		},
		{
			body: t.Object({
				description: t.Optional(t.String()),
				category: t.String(),
				startTime: t.String(),
				endTime: t.String(),
				isAllDay: t.Optional(t.Boolean()),
				primaryStat: t.Optional(t.Nullable(t.String())),
				secondaryStat: t.Optional(t.Nullable(t.String())),
				factionId: t.Optional(t.Number()),
			}),
			detail: {
				summary: "Create Subversive Faction Calendar Event",
				description:
					"Requires Subversive leadership or admin permissions. The category titles the event and fixes its accent; Ranked War Enlistment is pinned to the whole of a Tuesday and Steadfast Change to the whole of one day — neither consults the end it is sent — and a Steadfast Change must name two different battlestats. A window that has already passed is refused.",
			},
		},
	)

	// ─── PUT /api/v2/subversive/calendar/events/:id (Update Faction Event) ───────
	.put(
		"/calendar/events/:id",
		async ({ user, params, body, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin || !user) {
				set.status = 403;
				return {
					success: false,
					error: "Unauthorized: Subversive leadership or admin required.",
				};
			}

			const [existing] = await db
				.select()
				.from(subversiveCalendarEvents)
				.where(eq(subversiveCalendarEvents.id, params.id));

			if (!existing) {
				set.status = 404;
				return { success: false, error: "Event not found" };
			}

			// Omitted fields fall back to what is stored, so a partial update is
			// validated by the same rules as a create — a partial update can never
			// push the event into a state a create would have rejected.
			const resolved = resolveFactionEventWrite(
				{
					category: body.category ?? existing.category,
					description: body.description ?? existing.description,
					startTime: body.startTime ?? existing.startTime.toISOString(),
					endTime: body.endTime ?? existing.endTime.toISOString(),
					isAllDay: body.isAllDay ?? existing.isAllDay,
					primaryStat: body.primaryStat ?? existing.primaryStat,
					secondaryStat: body.secondaryStat ?? existing.secondaryStat,
					factionId: body.factionId ?? existing.factionId,
				},
				{ category: existing.category, title: existing.title },
			);

			if ("error" in resolved) {
				set.status = 400;
				return { success: false, error: resolved.error };
			}

			// A live or future event cannot be edited into the past. An event that
			// already ended stays editable — see {@link pastEventError}.
			const pastError = pastEventError(resolved.values.endTime, {
				storedEnd: existing.endTime,
			});
			if (pastError) {
				set.status = 400;
				return { success: false, error: pastError };
			}

			const [updated] = await db
				.update(subversiveCalendarEvents)
				.set({ ...resolved.values, updatedAt: new Date() })
				.where(eq(subversiveCalendarEvents.id, params.id))
				.returning();

			return { success: true, event: updated };
		},
		{
			params: t.Object({
				id: t.String(),
			}),
			body: t.Object({
				description: t.Optional(t.String()),
				category: t.Optional(t.String()),
				startTime: t.Optional(t.String()),
				endTime: t.Optional(t.String()),
				isAllDay: t.Optional(t.Boolean()),
				primaryStat: t.Optional(t.Nullable(t.String())),
				secondaryStat: t.Optional(t.Nullable(t.String())),
				factionId: t.Optional(t.Number()),
			}),
			detail: {
				summary: "Update Subversive Faction Calendar Event",
				description:
					"Requires Subversive leadership or admin permissions. Omitted fields keep their stored value and the result is validated by the create rules, so a Steadfast Change written here is pinned to one whole day too. An event that has not ended yet cannot be moved into the past.",
			},
		},
	)

	// ─── DELETE /api/v2/subversive/calendar/events/:id (Delete Faction Event) ────
	.delete(
		"/calendar/events/:id",
		async ({ user, params, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin || !user) {
				set.status = 403;
				return {
					success: false,
					error: "Unauthorized: Subversive leadership or admin required.",
				};
			}

			const [deleted] = await db
				.delete(subversiveCalendarEvents)
				.where(eq(subversiveCalendarEvents.id, params.id))
				.returning();

			if (!deleted) {
				set.status = 404;
				return { success: false, error: "Event not found" };
			}

			return { success: true, id: deleted.id };
		},
		{
			params: t.Object({
				id: t.String(),
			}),
			detail: {
				summary: "Delete Subversive Faction Calendar Event",
				description:
					"Requires Subversive leadership or admin permissions. Deletes an existing faction calendar event.",
			},
		},
	)

	// ─── GET /api/v1/subversive/status ─────────────────────────────────────────
	.get(
		"/status",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return {
					configured: false,
					isOwner: false,
					hasAdminAccess: false,
					reason: "unauthenticated",
					guild: null,
					adminRoleIds: [] as string[],
				};
			}

			const isOwner = user.role === "owner" || user.role === "admin";
			const targetGuildId = await getSubversiveTargetGuildId();

			const configData = await getSubversiveGuildConfig();
			const hasAdminAccess = await verifySubversiveAdmin(user);

			const botToken = env.DISCORD_TOKEN;
			let guildSummary: {
				id: string;
				name: string;
				icon: string | null;
			} | null = null;
			if (botToken && targetGuildId) {
				const g = await fetchDiscordApi<DiscordGuild>(
					`/guilds/${targetGuildId}`,
					`Bot ${botToken}`,
				);
				if (g) {
					guildSummary = {
						id: g.id,
						name: g.name,
						icon: g.icon
							? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`
							: null,
					};
				}
			}

			if (!guildSummary) {
				guildSummary = {
					id: targetGuildId,
					name: configData?.guildName ?? "Subversive Faction Family",
					icon: configData?.guildIcon ?? null,
				};
			}

			return {
				configured: true,
				isOwner,
				hasAdminAccess,
				reason: hasAdminAccess ? "ready" : "unauthorized",
				guild: guildSummary,
				adminRoleIds: configData?.adminRoleIds ?? [],
			};
		},
		{
			detail: {
				summary: "Subversive Dashboard Setup Status",
				description:
					"Checks if the Subversive faction server is configured and evaluates the current user's role access.",
			},
		},
	)

	// ─── GET /api/v1/subversive/available-guilds ──────────────────────────────
	.get(
		"/available-guilds",
		async ({ user, query, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Authentication required" };
			}

			// Limited strictly to bot owner for initial setup
			if (user.role !== "owner") {
				set.status = 403;
				return { error: "Forbidden: Only bot owner can manage server setup" };
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				return { guilds: [], botInviteUrl: getBotInviteUrl() };
			}

			const forceFresh = query.fresh === "true";
			const botGuilds = await getBotGuilds(botToken, forceFresh);

			const guilds = botGuilds.map((g) => ({
				id: g.id,
				name: g.name,
				icon: g.icon
					? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128`
					: null,
				botInGuild: true,
				owner: g.owner,
				userInGuild: true,
			}));

			return {
				guilds,
				botInviteUrl: getBotInviteUrl(),
			};
		},
		{
			query: t.Object({
				fresh: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Available Guilds for Subversive Setup",
				description:
					"Returns Discord servers where Sentinel is present, accessible only by the bot owner.",
			},
		},
	)

	// ─── GET /api/v1/subversive/guild-roles/:guildId ───────────────────────────
	.get(
		"/guild-roles/:guildId",
		async ({ params, user, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Authentication required" };
			}

			if (user.role !== "owner") {
				set.status = 403;
				return { error: "Forbidden: Only bot owner can view setup roles" };
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				set.status = 500;
				return { error: "Bot token not configured" };
			}

			const roles = await fetchDiscordApi<DiscordRole[]>(
				`/guilds/${params.guildId}/roles`,
				`Bot ${botToken}`,
			);

			if (!roles) {
				set.status = 502;
				return {
					error:
						"Failed to fetch roles from Discord. Verify Sentinel has proper permissions.",
				};
			}

			const filteredRoles = roles
				.filter((r) => r.name !== "@everyone")
				.sort((a, b) => b.position - a.position);

			return { roles: filteredRoles };
		},
		{
			params: t.Object({
				guildId: t.String(),
			}),
			detail: {
				summary: "Fetch Guild Roles for Subversive Setup",
				description:
					"Retrieves all non-@everyone roles for a given Discord guild.",
			},
		},
	)

	// ─── POST /api/v1/subversive/setup ────────────────────────────────────────
	.post(
		"/setup",
		async ({ body, user, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Authentication required" };
			}

			if (user.role !== "owner") {
				set.status = 403;
				return { error: "Forbidden: Only bot owner can configure the server" };
			}

			const { guildId, adminRoleIds } = body;
			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				set.status = 500;
				return { error: "Bot token not configured" };
			}

			const guildInfo = await fetchDiscordApi<DiscordGuild>(
				`/guilds/${guildId}`,
				`Bot ${botToken}`,
			);

			const guildName = guildInfo?.name ?? `Guild ${guildId}`;
			const guildIcon = guildInfo?.icon
				? `https://cdn.discordapp.com/icons/${guildId}/${guildInfo.icon}.png?size=128`
				: null;

			const cleanRoleIds = Array.from(
				new Set(
					(adminRoleIds ?? [])
						.map((id) => id.trim())
						.filter((id) => id.length > 0),
				),
			);

			// Field-scoped upsert: only the columns named here are written, so
			// binding a guild can no longer erase settings another writer owns
			// (the whole-blob version replaced the entire JSON object).
			await saveSubversiveGuildConfig({
				guildId,
				guildName,
				guildIcon,
				adminRoleIds: cleanRoleIds,
				configuredByDiscordId: user.discordId ?? null,
				configuredByUsername: user.username,
			});

			memberCache.clear();

			return {
				success: true,
				guildId,
				guildName,
				guildIcon,
				adminRoleIds: cleanRoleIds,
			};
		},
		{
			body: t.Object({
				guildId: t.String(),
				adminRoleIds: t.Array(t.String()),
			}),
			detail: {
				summary: "Configure Subversive Faction Guild",
				description:
					"Initializes the active Subversive Discord server and designates dashboard admin roles.",
			},
		},
	)

	// ─── POST /api/v1/subversive/verify-access ────────────────────────────────
	.post(
		"/verify-access",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return {
					success: false,
					configured: false,
					hasAdminAccess: false,
					reason: "unauthenticated",
				};
			}

			// A row in the typed table *is* "configured", so the old
			// `init`-flag-and-data check collapses to a null check.
			const configData = await getSubversiveGuildConfig();

			if (!configData?.guildId) {
				return {
					success: true,
					configured: false,
					hasAdminAccess: user.role === "owner",
					reason: "not_configured",
				};
			}

			if (user.discordId) {
				memberCache.delete(`${configData.guildId}:${user.discordId}`);
			}

			const hasAdminAccess = await verifySubversiveAdmin(user);

			return {
				success: true,
				configured: true,
				hasAdminAccess,
				reason: hasAdminAccess ? "ready" : "unauthorized",
			};
		},
		{
			detail: {
				summary: "Re-verify Access Permissions for Subversive",
				description:
					"Clears the in-memory cache for the current user and checks live Discord roles against designated Subversive admin roles.",
			},
		},
	)

	// ─── GET /api/v1/subversive/guild-channels ────────────────────────────────
	.get(
		"/guild-channels",
		async ({ user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const targetGuildId = await getSubversiveTargetGuildId();
			if (!targetGuildId) {
				return { channels: [] };
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				set.status = 500;
				return { error: "Bot token not configured" };
			}

			const channels = await fetchDiscordApi<
				Array<{
					id: string;
					name: string;
					type: number;
					position: number;
					parent_id: string | null;
				}>
			>(`/guilds/${targetGuildId}/channels`, `Bot ${botToken}`);

			if (!channels || !Array.isArray(channels)) {
				return { channels: [] };
			}

			// Type 0 = GUILD_TEXT, Type 5 = GUILD_ANNOUNCEMENT.
			// Categories (type 4) are kept so the dashboard can group channels under
			// their server section, and parent_id ties each channel to its category.
			// Consumers must filter by type themselves before rendering selectables.
			const groupedChannels = channels
				.filter((c) => c.type === 0 || c.type === 4 || c.type === 5)
				.map((c) => ({
					id: c.id,
					name: c.name,
					type: c.type,
					position: c.position,
					parent_id: c.parent_id,
				}))
				.sort((a, b) => a.position - b.position);

			return { channels: groupedChannels };
		},
		{
			detail: {
				summary: "List Guild Text Channels",
				description:
					"Retrieves available text channels from the Subversive Discord guild for alert configuration.",
			},
		},
	)

	// ─── GET /api/v1/subversive/recruitment/candidates ────────────────────────
	.get(
		"/recruitment/candidates",
		async ({ query, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const page = Math.max(1, Number(query.page ?? 1));
			const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)));
			const offset = (page - 1) * limit;

			const conditions = [];

			if (query.status && query.status !== "all") {
				conditions.push(
					eq(subversiveRecruitmentCandidates.status, query.status),
				);
			}

			if (query.search?.trim()) {
				const s = `%${query.search.trim()}%`;
				conditions.push(
					or(
						ilike(subversiveRecruitmentCandidates.playerName, s),
						ilike(subversiveRecruitmentCandidates.factionName, s),
					),
				);
			}

			const whereClause =
				conditions.length > 0
					? conditions.length === 1
						? (conditions[0] ?? undefined)
						: and(...conditions)
					: undefined;

			const [candidates, [totalRow], metricsRows] = await Promise.all([
				db
					.select()
					.from(subversiveRecruitmentCandidates)
					.where(whereClause)
					.orderBy(desc(subversiveRecruitmentCandidates.createdAt))
					.limit(limit)
					.offset(offset),
				db
					.select({ count: count() })
					.from(subversiveRecruitmentCandidates)
					.where(whereClause),
				db
					.select({
						status: subversiveRecruitmentCandidates.status,
						count: count(),
					})
					.from(subversiveRecruitmentCandidates)
					.groupBy(subversiveRecruitmentCandidates.status),
			]);

			const total = totalRow?.count ?? 0;
			const totalPages = Math.ceil(total / limit);

			const metricsMap = new Map(
				metricsRows.map((r) => [r.status, Number(r.count)]),
			);

			const [warsCountRow] = await db
				.select({ count: count() })
				.from(subversiveRankedWars);

			return {
				candidates,
				pagination: {
					page,
					limit,
					total,
					totalPages,
				},
				metrics: {
					total: Array.from(metricsMap.values()).reduce((a, b) => a + b, 0),
					new: metricsMap.get("new") ?? 0,
					contacted: metricsMap.get("contacted") ?? 0,
					rejected: metricsMap.get("rejected") ?? 0,
					recruited: metricsMap.get("recruited") ?? 0,
					totalWarsEvaluated: warsCountRow?.count ?? 0,
				},
			};
		},
		{
			query: t.Object({
				status: t.Optional(t.String()),
				search: t.Optional(t.String()),
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Recruitment Candidates",
				description:
					"Returns paginated candidate records filtered by status and player/faction search.",
			},
		},
	)

	// ─── PATCH /api/v1/subversive/recruitment/candidates/:id ──────────────────
	.patch(
		"/recruitment/candidates/:id",
		async ({ params, body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const [existing] = await db
				.select()
				.from(subversiveRecruitmentCandidates)
				.where(eq(subversiveRecruitmentCandidates.id, params.id));

			if (!existing) {
				set.status = 404;
				return { error: "Candidate not found" };
			}

			const updatePayload: {
				status?: string;
				notes?: string | null;
				updatedAt: Date;
			} = {
				updatedAt: new Date(),
			};

			if (body.status !== undefined) {
				updatePayload.status = body.status;
			}

			if (body.notes !== undefined) {
				updatePayload.notes = body.notes;
			}

			const [updated] = await db
				.update(subversiveRecruitmentCandidates)
				.set(updatePayload)
				.where(eq(subversiveRecruitmentCandidates.id, params.id))
				.returning();

			return { success: true, candidate: updated };
		},
		{
			params: t.Object({
				id: t.String(),
			}),
			body: t.Object({
				status: t.Optional(t.String()),
				notes: t.Optional(t.String()),
			}),
			detail: {
				summary: "Update Candidate Status/Notes",
				description:
					"Updates pipeline state or outreach notes for a recruitment candidate.",
			},
		},
	)

	// ─── GET /api/v1/subversive/recruitment/config ────────────────────────────
	.get(
		"/recruitment/config",
		async ({ user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const [config] = await db
				.select()
				.from(subversiveRecruitmentConfigs)
				.where(
					eq(subversiveRecruitmentConfigs.id, SUBVERSIVE_RECRUITMENT_CONFIG_ID),
				);

			// Typed columns always hold a value (the schema supplies defaults), so
			// there is no partial row to merge defaults into the way the JSON
			// blob required.
			if (config) {
				return {
					config: {
						minStats: config.minStats,
						minAttacks: config.minAttacks,
						minAttackPercentage: config.minAttackPercentage,
						notificationChannelId: config.notificationChannelId,
						notificationsEnabled: config.notificationsEnabled,
						termedClusterPercentage: config.termedClusterPercentage,
						autoScanEnabled: config.autoScanEnabled,
						excludedFactionIds: config.excludedFactionIds,
					},
				};
			}

			return {
				config: {
					minStats: 100_000_000,
					minAttacks: 25,
					minAttackPercentage: 8.0,
					notificationChannelId: null as string | null,
					notificationsEnabled: false,
					termedClusterPercentage: 60,
					autoScanEnabled: false,
					excludedFactionIds: [] as number[],
				},
			};
		},
		{
			detail: {
				summary: "Get Recruitment Configuration",
				description:
					"Returns active filter thresholds, alert settings, and termed war sensitivities.",
			},
		},
	)

	// ─── POST /api/v1/subversive/recruitment/config ───────────────────────────
	.post(
		"/recruitment/config",
		async ({ body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const cleanConfig = {
				minStats: Math.max(0, Number(body.minStats ?? 0)),
				minAttacks: Math.max(1, Number(body.minAttacks ?? 25)),
				minAttackPercentage: Math.max(
					0.1,
					Math.min(100, Number(body.minAttackPercentage ?? 8.0)),
				),
				notificationChannelId: body.notificationChannelId?.trim() || null,
				notificationsEnabled: Boolean(body.notificationsEnabled),
				termedClusterPercentage: Math.max(
					10,
					Math.min(100, Number(body.termedClusterPercentage ?? 60)),
				),
				autoScanEnabled: Boolean(body.autoScanEnabled ?? false),
				excludedFactionIds: Array.isArray(body.excludedFactionIds)
					? body.excludedFactionIds.map(Number).filter((n) => !Number.isNaN(n))
					: [],
			};

			const now = new Date();
			const updatedBy = user?.username ?? "system";

			await db
				.insert(subversiveRecruitmentConfigs)
				.values({
					id: SUBVERSIVE_RECRUITMENT_CONFIG_ID,
					...cleanConfig,
					updatedBy,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: subversiveRecruitmentConfigs.id,
					set: { ...cleanConfig, updatedBy, updatedAt: now },
				});

			return {
				success: true,
				config: {
					...cleanConfig,
					updatedAt: now.toISOString(),
					updatedBy,
				},
			};
		},
		{
			body: t.Object({
				minStats: t.Optional(t.Number()),
				minAttacks: t.Optional(t.Number()),
				minAttackPercentage: t.Optional(t.Number()),
				notificationChannelId: t.Optional(t.Nullable(t.String())),
				notificationsEnabled: t.Optional(t.Boolean()),
				termedClusterPercentage: t.Optional(t.Number()),
				autoScanEnabled: t.Optional(t.Boolean()),
				excludedFactionIds: t.Optional(t.Array(t.Number())),
			}),
			detail: {
				summary: "Save Recruitment Configuration",
				description:
					"Updates recruitment filter thresholds, alert settings, and sensitivity options.",
			},
		},
	)

	// ─── GET /api/v1/subversive/recruitment/wars ──────────────────────────────
	.get(
		"/recruitment/wars",
		async ({ query, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)));

			const wars = await db
				.select()
				.from(subversiveRankedWars)
				.orderBy(desc(subversiveRankedWars.id))
				.limit(limit);

			return { wars };
		},
		{
			query: t.Object({
				limit: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Evaluated Ranked Wars",
				description:
					"Returns recent ranked wars and their evaluation status (competitive, termed, forfeited).",
			},
		},
	)

	// ─── POST /api/v1/subversive/recruitment/scan-now ─────────────────────────
	.post(
		"/recruitment/scan-now",
		async ({ user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const hasKeys = await hasActiveSubversiveKeys();
			if (!hasKeys) {
				set.status = 400;
				return {
					error:
						"No active Torn API keys available in the Subversive script key pool. Please ensure at least one active user or system key is available.",
				};
			}

			const delivered = await notifySchedulerForceRun(
				"subversive:recruitment_worker",
			);

			return {
				success: true,
				message: delivered
					? "Recruitment scan triggered immediately via scheduler IPC."
					: "Scheduler IPC unreachable; scan will execute on next 5-minute cycle.",
			};
		},
		{
			detail: {
				summary: "Trigger Immediate Recruitment Scan",
				description:
					"Instructs the scheduler background worker to immediately poll ranked wars and process candidates.",
			},
		},
	)

	// ─── POST /api/v1/subversive/recruitment/reset-today ──────────────────────
	.post(
		"/recruitment/reset-today",
		async ({ user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			// Delete today's candidates and evaluated ranked wars starting 00:00:00 UTC
			const startOfCurrentDayUtc = new Date();
			startOfCurrentDayUtc.setUTCHours(0, 0, 0, 0);

			const deletedCandidates = await db
				.delete(subversiveRecruitmentCandidates)
				.where(
					gte(subversiveRecruitmentCandidates.createdAt, startOfCurrentDayUtc),
				)
				.returning({ id: subversiveRecruitmentCandidates.id });

			const deletedWars = await db
				.delete(subversiveRankedWars)
				.where(
					or(
						gte(subversiveRankedWars.evaluatedAt, startOfCurrentDayUtc),
						gte(subversiveRankedWars.end, startOfCurrentDayUtc),
					),
				)
				.returning({ id: subversiveRankedWars.id });

			// Clear the worker's state row so the next scan is treated as an initial
			// run for today. A missing row is exactly what the worker reads as "not
			// initialised", so this is the same signal the legacy row carried.
			await db
				.delete(workerState)
				.where(
					eq(workerState.workerId, WORKER_STATE_IDS.subversiveRecruitment),
				);

			// Notify scheduler to clear in-memory evaluatedWarIds cache
			const delivered = await notifySchedulerResetRecruitment();

			return {
				success: true,
				deletedCandidatesCount: deletedCandidates.length,
				deletedWarsCount: deletedWars.length,
				cacheCleared: delivered,
				message: `Reset today's recruitment cycle (${deletedCandidates.length} candidates, ${deletedWars.length} evaluated wars cleared).`,
			};
		},
		{
			detail: {
				summary: "Reset Recruitment Cycle for Today",
				description:
					"Deletes today's candidates, evaluated wars, and state tracking from 00:00 UTC, allowing ranked wars to be re-analyzed.",
			},
		},
	)

	// ─── GET /api/v1/subversive/guild-config ──────────────────────────────────
	.get(
		"/guild-config",
		async ({ user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const configData = await getSubversiveGuildConfig();

			const [recruitment] = await db
				.select({
					notificationChannelId:
						subversiveRecruitmentConfigs.notificationChannelId,
					notificationsEnabled:
						subversiveRecruitmentConfigs.notificationsEnabled,
				})
				.from(subversiveRecruitmentConfigs)
				.where(
					eq(subversiveRecruitmentConfigs.id, SUBVERSIVE_RECRUITMENT_CONFIG_ID),
				);

			return {
				guild: toGuildConfigResponse(configData),
				notificationChannelId: recruitment?.notificationChannelId ?? null,
				notificationsEnabled: recruitment?.notificationsEnabled ?? false,
			};
		},
		{
			detail: {
				summary: "Get Subversive Guild Configuration",
				description:
					"Returns connected Discord guild settings, admin roles, and notification channel.",
			},
		},
	)

	// ─── PUT /api/v1/subversive/guild-config ──────────────────────────────────
	.put(
		"/guild-config",
		async ({ body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const currentConfig = await getSubversiveGuildConfig();

			if (!currentConfig?.guildId) {
				set.status = 400;
				return {
					error:
						"Subversive guild is not yet initialized. Please run setup first.",
				};
			}

			// Only the role list is written: this endpoint edits admin roles and
			// nothing else, and the column-scoped update says exactly that. The
			// previous whole-blob upsert rewrote every field to achieve the same
			// result, which is how concurrent writers lost each other's changes.
			if (body.adminRoleIds !== undefined) {
				await updateSubversiveAdminRoleIds(
					currentConfig.guildId,
					body.adminRoleIds,
				);
			}

			if (
				body.notificationChannelId !== undefined ||
				body.notificationsEnabled !== undefined
			) {
				// Column-scoped too: the recruitment worker in another process
				// owns the scan thresholds, so this must not rewrite them.
				const now = new Date();
				await db
					.insert(subversiveRecruitmentConfigs)
					.values({
						id: SUBVERSIVE_RECRUITMENT_CONFIG_ID,
						...(body.notificationChannelId !== undefined
							? {
									notificationChannelId:
										body.notificationChannelId?.trim() || null,
								}
							: {}),
						...(body.notificationsEnabled !== undefined
							? { notificationsEnabled: Boolean(body.notificationsEnabled) }
							: {}),
						updatedBy: user?.username ?? "admin",
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: subversiveRecruitmentConfigs.id,
						set: {
							...(body.notificationChannelId !== undefined
								? {
										notificationChannelId:
											body.notificationChannelId?.trim() || null,
									}
								: {}),
							...(body.notificationsEnabled !== undefined
								? {
										notificationsEnabled: Boolean(body.notificationsEnabled),
									}
								: {}),
							updatedBy: user?.username ?? "admin",
							updatedAt: now,
						},
					});
			}

			memberCache.clear();

			return {
				success: true,
				guild: toGuildConfigResponse(await getSubversiveGuildConfig()),
			};
		},
		{
			body: t.Object({
				adminRoleIds: t.Optional(t.Array(t.String())),
				notificationChannelId: t.Optional(t.Nullable(t.String())),
				notificationsEnabled: t.Optional(t.Boolean()),
			}),
			detail: {
				summary: "Update Subversive Guild Configuration",
				description:
					"Updates admin roles and alert channel configuration for Subversive.",
			},
		},
	)

	// ─── GET /api/v1/subversive/dibs-config ───────────────────────────────────
	.get(
		"/dibs-config",
		async ({ user, set, query }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const factionId = parseSubversiveFactionId(query?.factionId, set);
			if (factionId === null) return { error: INVALID_DIBS_FACTION_ERROR };

			const config = await subversiveDibsManager.getConfig(factionId);
			return {
				factionId,
				factionName: getSubversiveFactionName(factionId),
				config,
			};
		},
		{
			query: t.Object({
				factionId: t.Optional(t.Numeric()),
			}),
			detail: {
				summary: "Get Subversive Dibs Configuration",
				description:
					"Returns hospital dibs settings for one family faction, including lead time, limits, and Discord channel.",
			},
		},
	)

	// ─── PUT /api/v1/subversive/dibs-config ───────────────────────────────────
	.put(
		"/dibs-config",
		async ({ body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const factionId = parseSubversiveFactionId(body.factionId, set);
			if (factionId === null) {
				return { error: INVALID_DIBS_FACTION_ERROR };
			}

			const { factionId: _ignored, ...patch } = body;
			const updated = await subversiveDibsManager.updateConfig(
				patch,
				user?.username ?? "admin",
				factionId,
			);
			return {
				success: true,
				factionId,
				factionName: getSubversiveFactionName(factionId),
				config: updated,
			};
		},
		{
			body: t.Object({
				factionId: t.Optional(t.Numeric()),
				enabled: t.Optional(t.Boolean()),
				channelId: t.Optional(t.Nullable(t.String())),
				claimLeadTime: t.Optional(t.Number({ minimum: 1, maximum: 60 })),
				maxDibsPerPerson: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
				postHospTimeoutSeconds: t.Optional(
					t.Number({ minimum: 5, maximum: 300 }),
				),
				autoDeleteOnDowned: t.Optional(t.Boolean()),
				channelMaintenanceEnabled: t.Optional(t.Boolean()),
				maxDibsMessageAgeHours: t.Optional(
					t.Number({ minimum: 1, maximum: 168 }),
				),
				sweepIntervalMinutes: t.Optional(
					t.Number({ minimum: 0, maximum: 1440 }),
				),
			}),
			detail: {
				summary: "Update Subversive Dibs Configuration",
				description:
					"Updates hospital dibs coordination settings for one family faction.",
			},
		},
	)

	// ─── GET /api/v1/subversive/rw-channels-config ────────────────────────────
	.get(
		"/rw-channels-config",
		async ({ user, set, query }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const factionId = parseSubversiveFactionId(query?.factionId, set);
			if (factionId === null) {
				return { error: INVALID_RW_CHANNELS_FACTION_ERROR };
			}

			const config = await subversiveRwChannelManager.getConfig(factionId);
			return {
				factionId,
				factionName: getSubversiveFactionName(factionId),
				config,
			};
		},
		{
			query: t.Object({
				factionId: t.Optional(t.Numeric()),
			}),
			detail: {
				summary: "Get Subversive Ranked-War Channel Selections",
				description:
					"Returns the Discord channels one family faction uses for ranked-war tooling.",
			},
		},
	)

	// ─── PUT /api/v1/subversive/rw-channels-config ────────────────────────────
	.put(
		"/rw-channels-config",
		async ({ body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const factionId = parseSubversiveFactionId(body.factionId, set);
			if (factionId === null) {
				return { error: INVALID_RW_CHANNELS_FACTION_ERROR };
			}

			const { factionId: _ignored, ...patch } = body;
			try {
				const updated = await subversiveRwChannelManager.updateConfig(
					patch,
					user?.username ?? "admin",
					factionId,
				);
				return {
					success: true,
					factionId,
					factionName: getSubversiveFactionName(factionId),
					config: updated,
				};
			} catch (err) {
				// Only the shared-channel case is a client mistake. Anything else
				// is a genuine failure and must not be reported as a bad request.
				if (err instanceof RwChannelConflictError) {
					set.status = 400;
					return { error: err.message };
				}
				throw err;
			}
		},
		{
			body: t.Object({
				factionId: t.Optional(t.Numeric()),
				primaryDisplaysChannelId: t.Optional(t.Nullable(t.String())),
				secondaryDisplaysChannelId: t.Optional(t.Nullable(t.String())),
				friendlyDisplaysChannelId: t.Optional(t.Nullable(t.String())),
			}),
			detail: {
				summary: "Update Subversive Ranked-War Channel Selections",
				description:
					"Routes ranked-war tooling channels for one family faction. The primary, secondary and friendly selections must all differ.",
			},
		},
	)

	// ─── GET /api/v2/subversive/chain-config ──────────────────────────────────
	.get(
		"/chain-config",
		async ({ user, set, query }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const factionId = parseSubversiveFactionId(query?.factionId, set);
			if (factionId === null) {
				return { error: INVALID_CHAIN_FACTION_ERROR };
			}

			const config = await subversiveChainConfigManager.getConfig(factionId);
			return {
				factionId,
				factionName: getSubversiveFactionName(factionId),
				config,
			};
		},
		{
			query: t.Object({
				factionId: t.Optional(t.Numeric()),
			}),
			detail: {
				summary: "Get Subversive Chain Monitor Configuration",
				description:
					"Returns chain-monitoring settings for one family faction: threshold, warning window, repeat interval, channel and role.",
			},
		},
	)

	// ─── PUT /api/v2/subversive/chain-config ──────────────────────────────────
	.put(
		"/chain-config",
		async ({ body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const factionId = parseSubversiveFactionId(body.factionId, set);
			if (factionId === null) {
				return { error: INVALID_CHAIN_FACTION_ERROR };
			}

			const { factionId: _ignored, ...patch } = body;
			try {
				const updated = await subversiveChainConfigManager.updateConfig(
					patch,
					user?.username ?? "admin",
					factionId,
				);

				// The scheduler reads the table on its next cycle. A force-run
				// applies a newly routed channel immediately instead of waiting
				// out the idle cadence.
				void notifySchedulerForceRun("subversive:chain_monitor");

				return {
					success: true,
					factionId,
					factionName: getSubversiveFactionName(factionId),
					config: updated,
				};
			} catch (err) {
				// Only validation failures are the admin's mistake. A database
				// failure must not be reported as a bad request.
				if (err instanceof ChainConfigError) {
					set.status = 400;
					return { error: err.message };
				}
				throw err;
			}
		},
		{
			body: t.Object({
				factionId: t.Optional(t.Numeric()),
				enabled: t.Optional(t.Boolean()),
				channelId: t.Optional(t.Nullable(t.String())),
				warningRoleId: t.Optional(t.Nullable(t.String())),
				minimumChainStart: t.Optional(
					t.Number({
						minimum: MIN_SUBVERSIVE_CHAIN_START,
						maximum: MAX_SUBVERSIVE_CHAIN_START,
					}),
				),
				chainTimeWarningSeconds: t.Optional(
					t.Number({
						minimum: MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS,
						maximum: MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS,
					}),
				),
				subsequentWarningIntervalSeconds: t.Optional(
					t.Number({
						minimum: 0,
						maximum: MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS,
					}),
				),
			}),
			detail: {
				summary: "Update Subversive Chain Monitor Configuration",
				description:
					"Updates chain-monitoring settings for one family faction. Warnings fire when the chain timer is at or below chainTimeWarningSeconds; subsequent warnings repeat every subsequentWarningIntervalSeconds (zero = first warning only).",
			},
		},
	)

	// ─── GET /api/v1/subversive/dibs/active ───────────────────────────────────
	.get(
		"/dibs/active",
		async () => {
			const dibs = subversiveDibsManager.getActiveDibs();
			return { dibs };
		},
		{
			detail: {
				summary: "List Active Dibs Claims",
				description: "Returns currently active hospital exit dibs claims.",
			},
		},
	)

	// ─── POST /api/v1/subversive/dibs/sweep ───────────────────────────────────
	.post(
		"/dibs/sweep",
		async ({ body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const factionId = parseSubversiveFactionId(body?.factionId, set);
			if (factionId === null) {
				return { error: INVALID_DIBS_FACTION_ERROR };
			}

			const liveMessageIds =
				await subversiveDibsManager.sweepDibsChannel(factionId);
			const tracked = await dibsMessageStore.list(factionId);
			const config = await subversiveDibsManager.getConfig(factionId);

			// null means the sweep was skipped (no channel configured or bot offline).
			if (liveMessageIds === null) {
				return {
					success: false,
					factionId,
					factionName: getSubversiveFactionName(factionId),
					skipped: !config.channelId
						? "no_channel_configured"
						: "bot_unreachable",
					trackedMessageCount: tracked.length,
					liveMessageCount: 0,
				};
			}

			return {
				success: true,
				factionId,
				factionName: getSubversiveFactionName(factionId),
				liveMessageCount: liveMessageIds.length,
				trackedMessageCount: tracked.length,
			};
		},
		{
			body: t.Optional(
				t.Object({
					factionId: t.Optional(t.Numeric()),
				}),
			),
			detail: {
				summary: "Sweep Subversive Dibs Channel",
				description:
					"Reconciles the dibs channel for one family faction by deleting orphaned and expired dibs callouts.",
			},
		},
	)

	// ─── POST /api/v1/subversive/dibs/claim ───────────────────────────────────
	.post(
		"/dibs/claim",
		async ({ body, headers, set }) => {
			const authHeader = headers.authorization;
			const token = authHeader?.startsWith("Bearer ")
				? authHeader.slice(7)
				: body.token;

			if (!token) {
				set.status = 401;
				return { error: "Unauthorized: Missing authentication token" };
			}

			const session = await resolveUserSession(token);
			if (!session) {
				set.status = 401;
				return { error: "Unauthorized: Invalid session" };
			}

			const result = await subversiveDibsManager.claimDibs(
				body.targetId,
				{
					tornId: session.tornId,
					tornName: session.tornName,
					platform: "script",
				},
				session.factionId,
			);

			if (!result.success) {
				set.status = 400;
				return { error: result.reason ?? "Failed to claim dibs" };
			}

			return { success: true, dibs: result.dibs };
		},
		{
			body: t.Object({
				targetId: t.Number(),
				token: t.Optional(t.String()),
			}),
			detail: {
				summary: "Claim Hospital Dibs (Userscript)",
				description:
					"Claims an eligible hospital queue target for the authenticated userscript player.",
			},
		},
	)

	// ─── POST /api/v1/subversive/dibs/release ─────────────────────────────────
	.post(
		"/dibs/release",
		async ({ body, headers, set }) => {
			const authHeader = headers.authorization;
			const token = authHeader?.startsWith("Bearer ")
				? authHeader.slice(7)
				: body.token;

			if (!token) {
				set.status = 401;
				return { error: "Unauthorized: Missing authentication token" };
			}

			const session = await resolveUserSession(token);
			if (!session) {
				set.status = 401;
				return { error: "Unauthorized: Invalid session" };
			}

			const result = await subversiveDibsManager.releaseDibs(
				body.targetId,
				{
					tornId: session.tornId,
				},
				session.factionId,
			);

			if (!result.success) {
				set.status = 400;
				return { error: result.reason ?? "Failed to release dibs" };
			}

			return { success: true };
		},
		{
			body: t.Object({
				targetId: t.Number(),
				token: t.Optional(t.String()),
			}),
			detail: {
				summary: "Release Hospital Dibs (Userscript)",
				description: "Releases a previously claimed hospital queue target.",
			},
		},
	)

	// ─── POST /api/v1/subversive/dibs/claim-discord ───────────────────────────
	.post(
		"/dibs/claim-discord",
		async ({ body, set }) => {
			// Resolve player's Torn info via Torn API / verifiedUsers cache
			const resolved = await resolveDiscordTornUser(body.discordUserId);
			if (!resolved) {
				set.status = 400;
				return {
					error:
						"Your Discord account is not verified with Torn. Please verify your Torn account first.",
				};
			}

			const result = await subversiveDibsManager.claimDibs(
				body.targetId,
				{
					discordId: body.discordUserId,
					discordTag: body.discordUsername,
					tornId: resolved.tornId,
					tornName: resolved.tornName,
					platform: "discord",
				},
				resolveDibsFactionForTarget(body.targetId),
			);

			if (!result.success) {
				set.status = 400;
				return { error: result.reason ?? "Failed to claim dibs" };
			}

			// Surface the owning faction's post-hospital lock so Discord replies
			// quote the correct timeout instead of a hardcoded value.
			const factionId = result.dibs?.factionId;
			const config = await subversiveDibsManager.getConfig(factionId);

			return {
				success: true,
				dibs: result.dibs,
				factionId: factionId ?? null,
				postHospTimeoutSeconds: config.postHospTimeoutSeconds,
			};
		},
		{
			body: t.Object({
				targetId: t.Number(),
				discordUserId: t.String(),
				discordUsername: t.String(),
			}),
			detail: {
				summary: "Claim Hospital Dibs (Discord)",
				description: "Claims dibs via Discord button click.",
			},
		},
	)

	// ─── POST /api/v1/subversive/dibs/release-discord ─────────────────────────
	.post(
		"/dibs/release-discord",
		async ({ body, set }) => {
			const resolved = await resolveDiscordTornUser(body.discordUserId);
			const result = await subversiveDibsManager.releaseDibs(
				body.targetId,
				{
					discordId: body.discordUserId,
					tornId: resolved?.tornId,
				},
				resolveDibsFactionForTarget(body.targetId),
			);

			if (!result.success) {
				set.status = 400;
				return { error: result.reason ?? "Failed to release dibs" };
			}

			return { success: true };
		},
		{
			body: t.Object({
				targetId: t.Number(),
				discordUserId: t.String(),
			}),
			detail: {
				summary: "Release Hospital Dibs (Discord)",
				description: "Releases dibs via Discord button click.",
			},
		},
	)

	// ─── POST /api/v1/subversive/dibs/record-message ──────────────────────────
	.post(
		"/dibs/record-message",
		async ({ body }) => {
			subversiveDibsManager.recordDiscordMessage(
				body.targetId,
				body.channelId,
				body.messageId,
			);
			return { success: true };
		},
		{
			body: t.Object({
				targetId: t.Number(),
				channelId: t.String(),
				messageId: t.String(),
			}),
			detail: {
				summary: "Record Discord Dibs Message ID",
				description:
					"Records Discord channel and message IDs for an active dibs target.",
			},
		},
	)
	.get(
		"/api-keys",
		async ({ user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const targetGuildId = await getSubversiveTargetGuildId();
			const [subversiveKeysRows, guildKeysRows, scriptUsers] =
				await Promise.all([
					db
						.select({
							id: subversiveApiKeys.id,
							tornId: subversiveApiKeys.tornId,
							tornName: subversiveApiKeys.tornName,
							isValid: subversiveApiKeys.isValid,
							invalidCount: subversiveApiKeys.invalidCount,
							donatedByDiscordId: subversiveApiKeys.donatedByDiscordId,
							donatedByDiscordTag: subversiveApiKeys.donatedByDiscordTag,
							lastUsedAt: subversiveApiKeys.lastUsedAt,
							createdAt: subversiveApiKeys.createdAt,
						})
						.from(subversiveApiKeys)
						.where(eq(subversiveApiKeys.guildId, targetGuildId))
						.orderBy(desc(subversiveApiKeys.createdAt)),
					db
						.select({
							id: guildApiKeys.id,
							tornId: guildApiKeys.tornId,
							tornName: guildApiKeys.tornName,
							isValid: guildApiKeys.isValid,
							invalidCount: guildApiKeys.invalidCount,
							donatedByDiscordId: guildApiKeys.donatedByDiscordId,
							donatedByDiscordTag: guildApiKeys.donatedByDiscordTag,
							lastUsedAt: guildApiKeys.lastUsedAt,
							createdAt: guildApiKeys.createdAt,
						})
						.from(guildApiKeys)
						.where(eq(guildApiKeys.guildId, targetGuildId))
						.orderBy(desc(guildApiKeys.createdAt)),
					db
						.select({
							tornId: subversiveTargetFinderUsers.tornId,
							tornName: subversiveTargetFinderUsers.tornName,
							isActive: subversiveTargetFinderUsers.isActive,
							lastSeenAt: subversiveTargetFinderUsers.lastSeenAt,
							createdAt: subversiveTargetFinderUsers.createdAt,
						})
						.from(subversiveTargetFinderUsers)
						.where(eq(subversiveTargetFinderUsers.isActive, true))
						.orderBy(desc(subversiveTargetFinderUsers.lastSeenAt)),
				]);

			const scriptKeys = scriptUsers.map((u) => ({
				id: `script_${u.tornId}`,
				tornId: u.tornId,
				tornName: u.tornName,
				isValid: u.isActive,
				invalidCount: 0,
				donatedByDiscordId: null,
				donatedByDiscordTag: "Script Pool",
				lastUsedAt: u.lastSeenAt,
				createdAt: u.createdAt,
			}));

			const seenIds = new Set<string>();
			const keys = [
				...scriptKeys,
				...subversiveKeysRows,
				...guildKeysRows,
			].filter((k) => {
				if (seenIds.has(k.id)) return false;
				seenIds.add(k.id);
				return true;
			});

			const hasScriptKeys = await hasActiveSubversiveKeys();

			return {
				keys,
				hasScriptKeys,
				scriptKeysCount: scriptUsers.length,
			};
		},
		{
			detail: {
				summary: "Fetch Subversive Guild API Keys",
				description:
					"Retrieves active API keys registered for the Subversive guild.",
			},
		},
	)

	// ─── POST /api/v1/subversive/api-keys ─────────────────────────────────────
	.post(
		"/api-keys",
		async ({ body, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const targetGuildId = await getSubversiveTargetGuildId();
			const trimmedKey = body.apiKey.trim();

			if (!isValidApiKey(trimmedKey)) {
				set.status = 400;
				return {
					error:
						"Invalid Torn API key format. Must be a 16-character alphanumeric string.",
				};
			}

			const pepper = process.env.API_KEY_HASH_PEPPER ?? "";
			const keyHash = hashApiKey(trimmedKey, pepper);

			const [existingKey] = await db
				.select()
				.from(subversiveApiKeys)
				.where(
					and(
						eq(subversiveApiKeys.guildId, targetGuildId),
						eq(subversiveApiKeys.apiKeyHash, keyHash),
					),
				);

			if (existingKey) {
				set.status = 400;
				return {
					error: "This API key has already been added to Subversive.",
				};
			}

			let tornUserId: number | null = null;
			let playerName = "Unknown";
			try {
				const client = new TornApiClient();
				const profile = await client.getRaw<{
					player_id?: number;
					name?: string;
				}>("user/", {
					apiKey: trimmedKey,
					queryParams: { selections: "profile" },
				});
				tornUserId = profile?.player_id ?? null;
				playerName = profile?.name ?? `Player ${tornUserId}`;
				if (!tornUserId) {
					set.status = 400;
					return {
						error: "Failed to extract valid Torn Player ID from Torn API key.",
					};
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Torn API verification failed.";
				set.status = 400;
				return {
					error: `Torn API Verification Failed: ${errorMessage}`,
				};
			}

			const masterKey = process.env.ENCRYPTION_KEY ?? "";
			const keyEncrypted = encryptApiKey(trimmedKey, masterKey);

			const [inserted] = await db
				.insert(subversiveApiKeys)
				.values({
					guildId: targetGuildId,
					tornId: tornUserId,
					tornName: playerName,
					apiKeyEncrypted: keyEncrypted,
					apiKeyHash: keyHash,
					isValid: true,
					invalidCount: 0,
					donatedByDiscordId: user?.discordId ?? null,
					donatedByDiscordTag: user?.username ?? "Dashboard Admin",
				})
				.returning({
					id: subversiveApiKeys.id,
					tornId: subversiveApiKeys.tornId,
					tornName: subversiveApiKeys.tornName,
					isValid: subversiveApiKeys.isValid,
					donatedByDiscordId: subversiveApiKeys.donatedByDiscordId,
					donatedByDiscordTag: subversiveApiKeys.donatedByDiscordTag,
					createdAt: subversiveApiKeys.createdAt,
				});

			return {
				success: true,
				key: inserted,
			};
		},
		{
			body: t.Object({
				apiKey: t.String(),
			}),
			detail: {
				summary: "Register Subversive Torn API Key",
				description: "Validates and encrypts a Torn API key for Subversive.",
			},
		},
	)

	// ─── DELETE /api/v1/subversive/api-keys/:id ───────────────────────────────
	.delete(
		"/api-keys/:id",
		async ({ params, user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}

			const targetGuildId = await getSubversiveTargetGuildId();

			const [deleted] = await db
				.delete(subversiveApiKeys)
				.where(
					and(
						eq(subversiveApiKeys.id, params.id),
						eq(subversiveApiKeys.guildId, targetGuildId),
					),
				)
				.returning({ id: subversiveApiKeys.id });

			if (!deleted) {
				const [deletedGuildKey] = await db
					.delete(guildApiKeys)
					.where(
						and(
							eq(guildApiKeys.id, params.id),
							eq(guildApiKeys.guildId, targetGuildId),
						),
					)
					.returning({ id: guildApiKeys.id });

				if (!deletedGuildKey) {
					set.status = 404;
					return { error: "API key not found." };
				}

				return { success: true, id: deletedGuildKey.id };
			}

			return { success: true, id: deleted.id };
		},
		{
			params: t.Object({
				id: t.String(),
			}),
			detail: {
				summary: "Delete Subversive API Key",
				description: "Removes a Torn API key from the Subversive guild vault.",
			},
		},
	);
