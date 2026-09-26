import {
	and,
	count,
	db,
	desc,
	eq,
	gte,
	ilike,
	or,
	subversiveApiKeys,
	subversiveRankedWars,
	subversiveRecruitmentCandidates,
	systemStates,
} from "@sentinel/database";
import {
	encryptApiKey,
	hashApiKey,
	isValidApiKey,
	TornApiClient,
} from "@sentinel/torn-api";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { subversiveDibsManager } from "../../lib/dibs-manager";
import { fetchDiscordApi } from "../../lib/discord-auth";
import { resolveDiscordTornUser } from "../../lib/resolve-discord-torn-user";
import {
	notifySchedulerForceRun,
	notifySchedulerResetRecruitment,
} from "../../lib/scheduler-ipc";
import { authPlugin } from "../../middleware/auth";
import { resolveUserSession } from "./subversive-target-finder";

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

interface SubversiveConfigData {
	guildId: string;
	guildName: string;
	guildIcon: string | null;
	adminRoleIds: string[];
	configuredAt: string;
	configuredBy: {
		discordId: string;
		username: string;
	};
	updatedAt: string;
}

const ADMINISTRATOR_PERMISSION = 0x8;
const SUBVERSIVE_CONFIG_ID = "subversive:guild_config";

// In-memory cache for Discord member lookups (30s TTL)
const memberCache = new Map<
	string,
	{ member: DiscordGuildMember | null; expiresAt: number }
>();

function getCachedMember(
	cacheKey: string,
): DiscordGuildMember | null | undefined {
	const cached = memberCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.member;
	}
	return undefined;
}

function setCachedMember(
	cacheKey: string,
	member: DiscordGuildMember | null,
): void {
	memberCache.set(cacheKey, {
		member,
		expiresAt: Date.now() + 30 * 1000,
	});
}

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

export async function verifySubversiveAdmin(
	user: { role: string; discordId?: string | null } | null,
): Promise<boolean> {
	if (!user) return false;
	if (user.role === "owner") return true;

	const [existing] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

	if (!existing?.init || !existing.data) return false;
	const configData = existing.data as unknown as SubversiveConfigData;
	if (!configData.guildId || !user.discordId) return false;

	const botToken = env.DISCORD_TOKEN;
	if (!botToken) return env.NODE_ENV === "development";

	const cacheKey = `${configData.guildId}:${user.discordId}`;
	let member = getCachedMember(cacheKey);
	if (member === undefined) {
		member = await fetchDiscordApi<DiscordGuildMember>(
			`/guilds/${configData.guildId}/members/${user.discordId}`,
			`Bot ${botToken}`,
		);
		setCachedMember(cacheKey, member);
	}
	if (!member) return false;

	if (member.permissions) {
		try {
			const perms = BigInt(member.permissions);
			if ((perms & BigInt(ADMINISTRATOR_PERMISSION)) !== 0n) return true;
		} catch {
			// ignore
		}
	}

	const userRoles = member.roles ?? [];
	const targetRoleSet = new Set(configData.adminRoleIds ?? []);
	return userRoles.some((r) => targetRoleSet.has(r));
}

export const subversiveRoutes = new Elysia({ prefix: "/subversive" })
	.use(authPlugin)

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

			const isOwner = user.role === "owner";

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				return {
					configured: false,
					isOwner,
					hasAdminAccess: isOwner,
					reason: "not_configured",
					guild: null,
					adminRoleIds: [] as string[],
				};
			}

			const configData = existing.data as unknown as SubversiveConfigData;
			if (!configData.guildId) {
				return {
					configured: false,
					isOwner,
					hasAdminAccess: isOwner,
					reason: "not_configured",
					guild: null,
					adminRoleIds: [] as string[],
				};
			}

			const hasAdminAccess = await verifySubversiveAdmin(user);

			return {
				configured: true,
				isOwner,
				hasAdminAccess,
				reason: hasAdminAccess ? "ready" : "unauthorized",
				guild: {
					id: configData.guildId,
					name: configData.guildName,
					icon: configData.guildIcon,
				},
				adminRoleIds: configData.adminRoleIds ?? [],
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

			const configPayload: SubversiveConfigData = {
				guildId,
				guildName,
				guildIcon,
				adminRoleIds: cleanRoleIds,
				configuredAt: new Date().toISOString(),
				configuredBy: {
					discordId: user.discordId ?? "",
					username: user.username,
				},
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: SUBVERSIVE_CONFIG_ID,
					init: true,
					data: configPayload as unknown as Record<string, unknown>,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: true,
						data: configPayload as unknown as Record<string, unknown>,
						updatedAt: new Date(),
					},
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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				return {
					success: true,
					configured: false,
					hasAdminAccess: user.role === "owner",
					reason: "not_configured",
				};
			}

			const configData = existing.data as unknown as SubversiveConfigData;
			if (!configData.guildId) {
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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			const configData = existing?.data as SubversiveConfigData | undefined;

			if (!configData?.guildId) {
				return { channels: [] };
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				set.status = 500;
				return { error: "Bot token not configured" };
			}

			const channels = await fetchDiscordApi<
				Array<{ id: string; name: string; type: number }>
			>(`/guilds/${configData.guildId}/channels`, `Bot ${botToken}`);

			if (!channels || !Array.isArray(channels)) {
				return { channels: [] };
			}

			// Type 0 = GUILD_TEXT, Type 5 = GUILD_ANNOUNCEMENT
			const textChannels = channels
				.filter((c) => c.type === 0 || c.type === 5)
				.map((c) => ({
					id: c.id,
					name: c.name,
				}))
				.sort((a, b) => a.name.localeCompare(b.name));

			return { channels: textChannels };
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

			const [entry] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "subversive:recruitment_config"));

			const defaultConfig = {
				minStats: 100_000_000,
				minAttacks: 25,
				minAttackPercentage: 8.0,
				notificationChannelId: null as string | null,
				notificationsEnabled: false,
				termedClusterPercentage: 60,
				autoScanEnabled: false,
				excludedFactionIds: [] as number[],
			};

			if (entry?.init && entry.data) {
				return {
					config: {
						...defaultConfig,
						...(entry.data as Record<string, unknown>),
					},
				};
			}

			return { config: defaultConfig };
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
				updatedAt: new Date().toISOString(),
				updatedBy: user?.username ?? "system",
			};

			await db
				.insert(systemStates)
				.values({
					id: "subversive:recruitment_config",
					init: true,
					data: cleanConfig as unknown as Record<string, unknown>,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: true,
						data: cleanConfig as unknown as Record<string, unknown>,
						updatedAt: new Date(),
					},
				});

			return { success: true, config: cleanConfig };
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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			const configData = existing?.data as SubversiveConfigData | undefined;
			if (!configData?.guildId) {
				set.status = 400;
				return { error: "Subversive guild is not configured." };
			}

			const [keyCount] = await db
				.select({ count: count() })
				.from(subversiveApiKeys)
				.where(
					and(
						eq(subversiveApiKeys.guildId, configData.guildId),
						eq(subversiveApiKeys.isValid, true),
					),
				);

			if (!keyCount || keyCount.count === 0) {
				set.status = 400;
				return {
					error:
						"No active Torn API keys configured for Subversive. System keys cannot be used for guild recruitment. Please add a Torn API key in Guild Configuration.",
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

			// Reset the state row in systemStates so next scan is treated as initial run for today
			await db
				.delete(systemStates)
				.where(eq(systemStates.id, "subversive:recruitment_state"));

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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			const configData = (existing?.data ??
				null) as unknown as SubversiveConfigData | null;

			const [recruitmentEntry] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "subversive:recruitment_config"));

			const recruitmentData = recruitmentEntry?.data as
				| Record<string, unknown>
				| undefined;

			return {
				guild: configData,
				notificationChannelId:
					(recruitmentData?.notificationChannelId as string | null) ?? null,
				notificationsEnabled: Boolean(
					recruitmentData?.notificationsEnabled ?? false,
				),
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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			if (!existing?.data) {
				set.status = 400;
				return {
					error:
						"Subversive guild is not yet initialized. Please run setup first.",
				};
			}

			const currentConfig = existing.data as unknown as SubversiveConfigData;
			const updatedConfig: SubversiveConfigData = {
				...currentConfig,
				adminRoleIds: body.adminRoleIds ?? currentConfig.adminRoleIds,
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: SUBVERSIVE_CONFIG_ID,
					init: true,
					data: updatedConfig as unknown as Record<string, unknown>,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						data: updatedConfig as unknown as Record<string, unknown>,
						updatedAt: new Date(),
					},
				});

			if (
				body.notificationChannelId !== undefined ||
				body.notificationsEnabled !== undefined
			) {
				const [recEntry] = await db
					.select()
					.from(systemStates)
					.where(eq(systemStates.id, "subversive:recruitment_config"));

				const existingRec = (recEntry?.data ?? {}) as Record<string, unknown>;
				const updatedRec = {
					...existingRec,
					...(body.notificationChannelId !== undefined
						? {
								notificationChannelId:
									body.notificationChannelId?.trim() || null,
							}
						: {}),
					...(body.notificationsEnabled !== undefined
						? { notificationsEnabled: Boolean(body.notificationsEnabled) }
						: {}),
					updatedAt: new Date().toISOString(),
					updatedBy: user?.username ?? "admin",
				};

				await db
					.insert(systemStates)
					.values({
						id: "subversive:recruitment_config",
						init: true,
						data: updatedRec,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoUpdate({
						target: systemStates.id,
						set: {
							data: updatedRec,
							updatedAt: new Date(),
						},
					});
			}

			memberCache.clear();

			return {
				success: true,
				guild: updatedConfig,
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
		async ({ user, set }) => {
			const hasAdmin = await verifySubversiveAdmin(user);
			if (!hasAdmin) {
				set.status = 403;
				return { error: "Forbidden: Subversive admin access required" };
			}
			const config = await subversiveDibsManager.getConfig();
			return { config };
		},
		{
			detail: {
				summary: "Get Subversive Dibs Configuration",
				description:
					"Returns hospital dibs settings including lead time, limits, and Discord channel.",
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
			const updated = await subversiveDibsManager.updateConfig(
				body,
				user?.username ?? "admin",
			);
			return { success: true, config: updated };
		},
		{
			body: t.Object({
				enabled: t.Optional(t.Boolean()),
				channelId: t.Optional(t.Nullable(t.String())),
				claimLeadTime: t.Optional(t.Number({ minimum: 1, maximum: 60 })),
				maxDibsPerPerson: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
				postHospTimeoutSeconds: t.Optional(
					t.Number({ minimum: 5, maximum: 300 }),
				),
				autoDeleteOnDowned: t.Optional(t.Boolean()),
			}),
			detail: {
				summary: "Update Subversive Dibs Configuration",
				description: "Updates hospital dibs coordination settings.",
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

			const result = await subversiveDibsManager.claimDibs(body.targetId, {
				tornId: session.tornId,
				tornName: session.tornName,
				platform: "script",
			});

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

			const result = await subversiveDibsManager.releaseDibs(body.targetId, {
				tornId: session.tornId,
			});

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

			const result = await subversiveDibsManager.claimDibs(body.targetId, {
				discordId: body.discordUserId,
				discordTag: body.discordUsername,
				tornId: resolved.tornId,
				tornName: resolved.tornName,
				platform: "discord",
			});

			if (!result.success) {
				set.status = 400;
				return { error: result.reason ?? "Failed to claim dibs" };
			}

			return { success: true, dibs: result.dibs };
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
			const result = await subversiveDibsManager.releaseDibs(body.targetId, {
				discordId: body.discordUserId,
				tornId: resolved?.tornId,
			});

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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				set.status = 400;
				return { error: "Subversive guild is not configured." };
			}

			const configData = existing.data as unknown as SubversiveConfigData;
			const keys = await db
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
				.where(eq(subversiveApiKeys.guildId, configData.guildId))
				.orderBy(desc(subversiveApiKeys.createdAt));

			return { keys };
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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				set.status = 400;
				return { error: "Subversive guild is not configured." };
			}

			const configData = existing.data as unknown as SubversiveConfigData;
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
						eq(subversiveApiKeys.guildId, configData.guildId),
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
					guildId: configData.guildId,
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

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, SUBVERSIVE_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				set.status = 400;
				return { error: "Subversive guild is not configured." };
			}

			const configData = existing.data as unknown as SubversiveConfigData;

			const [deleted] = await db
				.delete(subversiveApiKeys)
				.where(
					and(
						eq(subversiveApiKeys.id, params.id),
						eq(subversiveApiKeys.guildId, configData.guildId),
					),
				)
				.returning({ id: subversiveApiKeys.id });

			if (!deleted) {
				set.status = 404;
				return { error: "API key not found." };
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
