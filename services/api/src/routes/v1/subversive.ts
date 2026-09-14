import { db, eq, systemStates } from "@sentinel/database";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { fetchDiscordApi } from "../../lib/discord-auth";
import { authPlugin } from "../../middleware/auth";

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
	);
