import {
	and,
	count,
	db,
	desc,
	type ElimsItemRequestConfig,
	elimsApiKeys,
	elimsItemRequests,
	elimsVerifiedUsers,
	eq,
	ilike,
	or,
	systemStates,
	tornItems,
	type WhitelistedItem,
} from "@sentinel/database";
import {
	encryptApiKey,
	hashApiKey,
	isValidApiKey,
	TornApiClient,
} from "@sentinel/torn-api";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import {
	resetElimsGuildViaIpc,
	syncElimsGuildViaIpc,
	syncElimsItemRequestsViaIpc,
} from "../../lib/bot-ipc";
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

interface DiscordChannel {
	id: string;
	name: string;
	type: number;
	position: number;
}

interface DiscordGuildMember {
	user?: {
		id: string;
		username: string;
		avatar: string | null;
	};
	roles: string[];
	permissions?: string;
}

interface ElimsConfigData {
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
const ELIMS_CONFIG_ID = "elims:guild_config";
const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";

// In-memory cache for Discord member lookups to prevent rate limiting (30s TTL)
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

// In-memory cache for Discord bot guilds to prevent rate-limit flickers (60s TTL)
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

async function verifyElimsAdmin(
	user: { role: string; discordId?: string | null } | null,
): Promise<boolean> {
	if (!user) return false;
	if (user.role === "owner") return true;

	const [existing] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, ELIMS_CONFIG_ID));

	if (!existing?.init || !existing.data) return false;
	const configData = existing.data as unknown as ElimsConfigData;
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

export const elimsRoutes = new Elysia({ prefix: "/elims" })
	.use(authPlugin)

	// ─── GET /api/v1/elims/status ─────────────────────────────────────────────
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
				};
			}

			const isOwner = user.role === "owner";

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				return {
					configured: false,
					isOwner,
					hasAdminAccess: isOwner,
					reason: "not_configured",
					guild: null,
				};
			}

			const configData = existing.data as unknown as ElimsConfigData;
			if (!configData.guildId) {
				return {
					configured: false,
					isOwner,
					hasAdminAccess: isOwner,
					reason: "not_configured",
					guild: null,
				};
			}

			// Owner always has full access
			if (isOwner) {
				return {
					configured: true,
					isOwner: true,
					hasAdminAccess: true,
					reason: "ok",
					guild: {
						id: configData.guildId,
						name: configData.guildName,
						icon: configData.guildIcon,
					},
					adminRoleIds: configData.adminRoleIds,
					configuredBy: configData.configuredBy,
				};
			}

			// If non-owner has no discordId, they cannot be verified in the Discord server
			if (!user.discordId) {
				return {
					configured: true,
					isOwner: false,
					hasAdminAccess: false,
					reason: "no_discord_account",
					guild: {
						id: configData.guildId,
						name: configData.guildName,
						icon: configData.guildIcon,
					},
				};
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				// Local dev without bot token allows user access
				return {
					configured: true,
					isOwner: false,
					hasAdminAccess: env.NODE_ENV === "development",
					reason: env.NODE_ENV === "development" ? "ok" : "bot_offline",
					guild: {
						id: configData.guildId,
						name: configData.guildName,
						icon: configData.guildIcon,
					},
				};
			}

			// Check member status in guild with caching
			const cacheKey = `${configData.guildId}:${user.discordId}`;
			let member = getCachedMember(cacheKey);

			if (member === undefined) {
				member = await fetchDiscordApi<DiscordGuildMember>(
					`/guilds/${configData.guildId}/members/${user.discordId}`,
					`Bot ${botToken}`,
				);
				setCachedMember(cacheKey, member);
			}

			if (!member) {
				return {
					configured: true,
					isOwner: false,
					hasAdminAccess: false,
					reason: "not_in_guild",
					guild: {
						id: configData.guildId,
						name: configData.guildName,
						icon: configData.guildIcon,
					},
				};
			}

			// Check administrator permission bit
			let hasDiscordAdmin = false;
			if (member.permissions) {
				try {
					const perms = BigInt(member.permissions);
					hasDiscordAdmin = (perms & BigInt(ADMINISTRATOR_PERMISSION)) !== 0n;
				} catch {
					// bitwise fallback
				}
			}

			// Check configured admin roles
			const userRoles = member.roles ?? [];
			const targetRoleSet = new Set(configData.adminRoleIds ?? []);
			const hasAdminRole = userRoles.some((r) => targetRoleSet.has(r));

			const hasAdminAccess = hasDiscordAdmin || hasAdminRole;

			return {
				configured: true,
				isOwner: false,
				hasAdminAccess,
				reason: hasAdminAccess ? "ok" : "missing_role",
				guild: {
					id: configData.guildId,
					name: configData.guildName,
					icon: configData.guildIcon,
				},
				adminRoleIds: hasAdminAccess ? configData.adminRoleIds : undefined,
				configuredBy: configData.configuredBy,
			};
		},
		{
			detail: {
				summary: "Get Elims Status",
				description:
					"Returns elims server setup status and verifies the user's role permissions.",
			},
		},
	)

	// ─── GET /api/v1/elims/available-guilds ───────────────────────────────────
	.get(
		"/available-guilds",
		async ({ user, query, cookie, set }) => {
			if (user?.role !== "owner") {
				set.status = 403;
				return {
					error:
						"Only the Sentinel owner can configure the elims discord server.",
				};
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				return { guilds: [], botInviteUrl: getBotInviteUrl() };
			}

			const discordMetaCookie = cookie.discord_meta?.value;
			let userAccessToken: string | null = null;
			if (discordMetaCookie) {
				try {
					const parsed =
						typeof discordMetaCookie === "string"
							? (JSON.parse(discordMetaCookie) as { accessToken?: string })
							: (discordMetaCookie as { accessToken?: string });
					userAccessToken = parsed.accessToken ?? null;
				} catch {
					// Fallback
				}
			}

			const forceFresh = query?.fresh === "true";
			const [botGuilds, userGuilds] = await Promise.all([
				getBotGuilds(botToken, forceFresh),
				userAccessToken
					? fetchDiscordApi<DiscordGuild[]>(
							"/users/@me/guilds",
							`Bearer ${userAccessToken}`,
						)
					: Promise.resolve(null),
			]);

			const userGuildMap = new Map((userGuilds ?? []).map((g) => [g.id, g]));

			const mappedGuilds = (botGuilds ?? []).map((g) => ({
				id: g.id,
				name: g.name,
				icon: g.icon,
				botInGuild: true,
				owner: g.owner,
				userInGuild: userGuildMap.has(g.id),
			}));

			return {
				guilds: mappedGuilds,
				botInviteUrl: getBotInviteUrl(),
			};
		},
		{
			query: t.Object({
				fresh: t.Optional(t.String()),
			}),
			detail: {
				summary: "Available Guilds for Elims",
				description:
					"Returns guilds where Sentinel is present, for owner selection.",
			},
		},
	)

	// ─── GET /api/v1/elims/guild-roles/:guildId ───────────────────────────────
	.get(
		"/guild-roles/:guildId",
		async ({ params, user, set }) => {
			if (user?.role !== "owner") {
				set.status = 403;
				return { error: "Only the Sentinel owner can inspect guild roles." };
			}

			const { guildId } = params;
			if (!/^\d{17,20}$/.test(guildId)) {
				set.status = 400;
				return { error: "Invalid Discord Guild ID format." };
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				return { roles: [] };
			}

			const roles = await fetchDiscordApi<DiscordRole[]>(
				`/guilds/${guildId}/roles`,
				`Bot ${botToken}`,
			);

			if (!roles) {
				set.status = 404;
				return {
					error:
						"Failed to fetch roles. Make sure Sentinel is added to this server.",
				};
			}

			// Filter out @everyone role (role ID equals guild ID or name === '@everyone')
			const selectableRoles = roles
				.filter((r) => r.id !== guildId && r.name !== "@everyone")
				.sort((a, b) => b.position - a.position)
				.map((r) => ({
					id: r.id,
					name: r.name,
					color: r.color,
					position: r.position,
					managed: r.managed,
				}));

			return { roles: selectableRoles };
		},
		{
			params: t.Object({
				guildId: t.String(),
			}),
			detail: {
				summary: "Fetch Guild Roles",
				description:
					"Fetches non-everyone roles for the selected guild via Discord bot token.",
			},
		},
	)

	// ─── POST /api/v1/elims/setup ─────────────────────────────────────────────
	.post(
		"/setup",
		async ({ body, user, set }) => {
			if (user?.role !== "owner") {
				set.status = 403;
				return {
					error: "Only the Sentinel owner can configure the elims server.",
				};
			}

			const { guildId, adminRoleIds } = body;
			if (!/^\d{17,20}$/.test(guildId)) {
				set.status = 400;
				return { error: "Invalid Discord Guild ID." };
			}

			if (!Array.isArray(adminRoleIds)) {
				set.status = 400;
				return { error: "adminRoleIds must be an array of role IDs." };
			}

			// Validate guild presence via Discord API
			const botToken = env.DISCORD_TOKEN;
			let guildName = `Discord Server (${guildId})`;
			let guildIcon: string | null = null;

			if (botToken) {
				const liveGuild = await fetchDiscordApi<DiscordGuild>(
					`/guilds/${guildId}`,
					`Bot ${botToken}`,
				);

				if (!liveGuild) {
					set.status = 400;
					return {
						error:
							"Sentinel is not in the specified server, or the server was not found.",
					};
				}

				guildName = liveGuild.name;
				guildIcon = liveGuild.icon;
			}

			// Sanitize role IDs (remove @everyone or duplicates)
			const cleanRoleIds = Array.from(
				new Set(
					adminRoleIds.filter((id) => id !== guildId && /^\d{17,20}$/.test(id)),
				),
			);

			const configPayload: ElimsConfigData = {
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
					id: ELIMS_CONFIG_ID,
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

			// Invalidate member cache so subsequent checks use fresh config
			memberCache.clear();

			// Instant update to bot via IPC
			void syncElimsGuildViaIpc(guildId, { adminRoleIds: cleanRoleIds });

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
				summary: "Configure Elims Guild",
				description:
					"Initializes the active Elims Discord server and designates dashboard admin roles.",
			},
		},
	)

	// ─── POST /api/v1/elims/verify-access ─────────────────────────────────────
	.post(
		"/verify-access",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return { success: false, error: "Unauthenticated" };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				return {
					success: true,
					configured: false,
					hasAdminAccess: user.role === "owner",
					reason: "not_configured",
				};
			}

			const configData = existing.data as unknown as ElimsConfigData;
			const isOwner = user.role === "owner";

			if (isOwner) {
				return {
					success: true,
					configured: true,
					hasAdminAccess: true,
					reason: "ok",
				};
			}

			if (!user.discordId) {
				return {
					success: true,
					configured: true,
					hasAdminAccess: false,
					reason: "no_discord_account",
				};
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				return {
					success: true,
					configured: true,
					hasAdminAccess: env.NODE_ENV === "development",
					reason: env.NODE_ENV === "development" ? "ok" : "bot_offline",
				};
			}

			// Clear cache for this user to force live check
			const cacheKey = `${configData.guildId}:${user.discordId}`;
			memberCache.delete(cacheKey);

			const member = await fetchDiscordApi<DiscordGuildMember>(
				`/guilds/${configData.guildId}/members/${user.discordId}`,
				`Bot ${botToken}`,
			);
			setCachedMember(cacheKey, member);

			if (!member) {
				return {
					success: true,
					configured: true,
					hasAdminAccess: false,
					reason: "not_in_guild",
				};
			}

			let hasDiscordAdmin = false;
			if (member.permissions) {
				try {
					const perms = BigInt(member.permissions);
					hasDiscordAdmin = (perms & BigInt(ADMINISTRATOR_PERMISSION)) !== 0n;
				} catch {
					// bitwise fallback
				}
			}

			const userRoles = member.roles ?? [];
			const targetRoleSet = new Set(configData.adminRoleIds ?? []);
			const hasAdminRole = userRoles.some((r) => targetRoleSet.has(r));
			const hasAdminAccess = hasDiscordAdmin || hasAdminRole;

			return {
				success: true,
				configured: true,
				hasAdminAccess,
				reason: hasAdminAccess ? "ok" : "missing_role",
			};
		},
		{
			detail: {
				summary: "Force Re-check Elims Access",
				description:
					"Bypasses cache and re-queries Discord API for real-time role checks.",
			},
		},
	)

	// ─── PUT /api/v1/elims/settings ───────────────────────────────────────────
	.put(
		"/settings",
		async ({ body, user, set }) => {
			if (user?.role !== "owner") {
				set.status = 403;
				return {
					error: "Only the Sentinel owner can modify elims server settings.",
				};
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				set.status = 400;
				return { error: "Elims server is not initialized yet." };
			}

			const currentData = existing.data as unknown as ElimsConfigData;

			const cleanRoleIds = body.adminRoleIds
				? Array.from(
						new Set(
							body.adminRoleIds.filter(
								(id) => id !== currentData.guildId && /^\d{17,20}$/.test(id),
							),
						),
					)
				: currentData.adminRoleIds;

			const updatedData: ElimsConfigData = {
				...currentData,
				adminRoleIds: cleanRoleIds,
				updatedAt: new Date().toISOString(),
			};

			await db
				.update(systemStates)
				.set({
					data: updatedData as unknown as Record<string, unknown>,
					updatedAt: new Date(),
				})
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			memberCache.clear();

			// Instant update to bot via IPC
			void syncElimsGuildViaIpc(updatedData.guildId, {
				adminRoleIds: updatedData.adminRoleIds,
			});

			return {
				success: true,
				guildId: updatedData.guildId,
				guildName: updatedData.guildName,
				adminRoleIds: updatedData.adminRoleIds,
			};
		},
		{
			body: t.Object({
				adminRoleIds: t.Array(t.String()),
			}),
			detail: {
				summary: "Update Elims Server Settings",
				description:
					"Updates the list of designated admin role IDs for the Elims server.",
			},
		},
	)

	// ─── POST /api/v1/elims/reset ─────────────────────────────────────────────
	.post(
		"/reset",
		async ({ user, set }) => {
			if (user?.role !== "owner" && env.NODE_ENV !== "development") {
				set.status = 403;
				return { error: "Forbidden" };
			}

			await db.delete(systemStates).where(eq(systemStates.id, ELIMS_CONFIG_ID));
			memberCache.clear();

			// Instant update to bot via IPC
			void resetElimsGuildViaIpc();

			return { success: true, message: "Elims guild configuration reset." };
		},
		{
			detail: {
				summary: "Reset Elims Guild Config",
				description:
					"Removes configured elims tournament guild for testing and re-initialization.",
			},
		},
	)

	// ─── GET /api/v1/elims/guild-channels/:guildId ────────────────────────────
	.get(
		"/guild-channels/:guildId",
		async ({ params, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}
			const { guildId } = params;
			if (!/^\d{17,20}$/.test(guildId)) {
				set.status = 400;
				return { error: "Invalid Discord Guild ID format." };
			}
			const botToken = env.DISCORD_TOKEN;
			if (!botToken) return { channels: [] };

			const channels = await fetchDiscordApi<DiscordChannel[]>(
				`/guilds/${guildId}/channels`,
				`Bot ${botToken}`,
			);
			if (!channels) {
				set.status = 404;
				return { error: "Failed to fetch guild channels." };
			}
			// Filter for text & announcement channels (types 0 and 5)
			const textChannels = channels
				.filter((c) => c.type === 0 || c.type === 5)
				.sort((a, b) => a.position - b.position)
				.map((c) => ({
					id: c.id,
					name: c.name,
					type: c.type,
				}));

			return { channels: textChannels };
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "Fetch Guild Text Channels",
				description:
					"Fetches text and announcement channels for the active guild.",
			},
		},
	)

	// ─── GET /api/v1/elims/api-keys ───────────────────────────────────────────
	.get(
		"/api-keys",
		async ({ user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				set.status = 400;
				return { error: "Elims guild is not configured." };
			}

			const configData = existing.data as unknown as ElimsConfigData;
			const keys = await db
				.select({
					id: elimsApiKeys.id,
					tornId: elimsApiKeys.tornId,
					tornName: elimsApiKeys.tornName,
					isValid: elimsApiKeys.isValid,
					invalidCount: elimsApiKeys.invalidCount,
					lastUsedAt: elimsApiKeys.lastUsedAt,
					createdAt: elimsApiKeys.createdAt,
				})
				.from(elimsApiKeys)
				.where(eq(elimsApiKeys.guildId, configData.guildId))
				.orderBy(desc(elimsApiKeys.createdAt));

			return { keys };
		},
		{
			detail: {
				summary: "Fetch Elims Guild API Keys",
				description:
					"Retrieves active API keys configured for the tournament guild.",
			},
		},
	)

	// ─── POST /api/v1/elims/api-keys ──────────────────────────────────────────
	.post(
		"/api-keys",
		async ({ body, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				set.status = 400;
				return { error: "Elims guild is not configured." };
			}

			const configData = existing.data as unknown as ElimsConfigData;
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

			// Check duplicate key for this guild
			const [existingKey] = await db
				.select()
				.from(elimsApiKeys)
				.where(
					and(
						eq(elimsApiKeys.guildId, configData.guildId),
						eq(elimsApiKeys.apiKeyHash, keyHash),
					),
				);

			if (existingKey) {
				set.status = 400;
				return {
					error: "This API key has already been added to this guild.",
				};
			}

			// Verify key against Torn API v1 profile
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
				.insert(elimsApiKeys)
				.values({
					guildId: configData.guildId,
					tornId: tornUserId,
					tornName: playerName,
					apiKeyEncrypted: keyEncrypted,
					apiKeyHash: keyHash,
					isValid: true,
					invalidCount: 0,
				})
				.returning({
					id: elimsApiKeys.id,
					tornId: elimsApiKeys.tornId,
					tornName: elimsApiKeys.tornName,
					isValid: elimsApiKeys.isValid,
					createdAt: elimsApiKeys.createdAt,
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
				summary: "Add Elims Guild API Key",
				description:
					"Validates and registers a new Torn API key for the elims tournament guild.",
			},
		},
	)

	// ─── DELETE /api/v1/elims/api-keys/:id ────────────────────────────────────
	.delete(
		"/api-keys/:id",
		async ({ params, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			if (!existing?.init || !existing.data) {
				set.status = 400;
				return { error: "Elims guild is not configured." };
			}

			const configData = existing.data as unknown as ElimsConfigData;

			const [existingKey] = await db
				.select()
				.from(elimsApiKeys)
				.where(
					and(
						eq(elimsApiKeys.id, params.id),
						eq(elimsApiKeys.guildId, configData.guildId),
					),
				);

			if (!existingKey) {
				set.status = 404;
				return { error: "API key not found." };
			}

			await db
				.delete(elimsApiKeys)
				.where(
					and(
						eq(elimsApiKeys.id, params.id),
						eq(elimsApiKeys.guildId, configData.guildId),
					),
				);

			return { success: true, message: "API key removed." };
		},
		{
			params: t.Object({ id: t.String() }),
			detail: {
				summary: "Delete Elims Guild API Key",
				description:
					"Removes a Torn API key configured for the tournament guild.",
			},
		},
	)

	// ─── GET /api/v1/elims/item-requests/config ───────────────────────────────
	.get(
		"/item-requests/config",
		async ({ user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));

			if (!existing?.data) {
				const defaultConfig: ElimsItemRequestConfig = {
					requestChannelId: null,
					grantingChannelId: null,
					requesterRoleIds: [],
					managerRoleIds: [],
					allowedItems: [],
					embedMessageId: null,
					updatedAt: new Date().toISOString(),
				};
				return { config: defaultConfig };
			}

			return {
				config: existing.data as unknown as ElimsItemRequestConfig,
			};
		},
		{
			detail: {
				summary: "Get Item Requests Configuration",
				description:
					"Returns configured channels, roles, and whitelisted requestable items.",
			},
		},
	)

	// ─── PUT /api/v1/elims/item-requests/config ───────────────────────────────
	.put(
		"/item-requests/config",
		async ({ body, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}

			const configPayload: ElimsItemRequestConfig = {
				requestChannelId: body.requestChannelId ?? null,
				grantingChannelId: body.grantingChannelId ?? null,
				requesterRoleIds: body.requesterRoleIds ?? [],
				managerRoleIds: body.managerRoleIds ?? [],
				allowedItems: body.allowedItems ?? [],
				embedMessageId: body.embedMessageId ?? null,
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: ELIMS_ITEM_REQUESTS_CONFIG_ID,
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

			// Instant update to bot via IPC
			const [elimsGuildState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			const elimsGuildData = elimsGuildState?.data as unknown as
				| ElimsConfigData
				| undefined;
			if (elimsGuildData?.guildId) {
				void syncElimsItemRequestsViaIpc(
					elimsGuildData.guildId,
					configPayload as unknown as Record<string, unknown>,
				);
			}

			return { success: true, config: configPayload };
		},
		{
			body: t.Object({
				requestChannelId: t.Nullable(t.String()),
				grantingChannelId: t.Nullable(t.String()),
				requesterRoleIds: t.Array(t.String()),
				managerRoleIds: t.Array(t.String()),
				allowedItems: t.Array(
					t.Object({
						id: t.String(),
						name: t.String(),
						category: t.String(),
						marketPrice: t.Optional(t.Number()),
						image: t.Optional(t.String()),
					}),
				),
				embedMessageId: t.Optional(t.Nullable(t.String())),
			}),
			detail: {
				summary: "Update Item Requests Configuration",
				description:
					"Updates request/grant channels, requester/manager roles, and whitelisted items.",
			},
		},
	)

	// ─── GET /api/v1/elims/item-requests/items/search ─────────────────────────
	.get(
		"/item-requests/items/search",
		async ({ query, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const q = (query.q ?? "").trim();
			const items = q
				? await db
						.select()
						.from(tornItems)
						.where(ilike(tornItems.name, `%${q}%`))
						.limit(25)
				: await db.select().from(tornItems).limit(25);

			const mapped: WhitelistedItem[] = items.map((it) => {
				const d = (it.data ?? {}) as Record<string, unknown>;
				const v = (d.value ?? {}) as Record<string, unknown>;
				return {
					id: it.id,
					name: it.name ?? "Unknown Item",
					category: (d.type ?? d.category ?? "General") as string,
					marketPrice: Number(v.market_price ?? v.buy_price ?? 0),
					image: typeof d.image === "string" ? d.image : undefined,
				};
			});

			return { items: mapped };
		},
		{
			query: t.Object({
				q: t.Optional(t.String()),
			}),
			detail: {
				summary: "Search Torn Items for Whitelist",
				description:
					"Search Torn items by name with market price and thumbnail.",
			},
		},
	)

	// ─── GET /api/v1/elims/item-requests/logs ─────────────────────────────────
	.get(
		"/item-requests/logs",
		async ({ query, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const page = Math.max(1, Number(query.page ?? 1));
			const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
			const offset = (page - 1) * limit;

			const conditions = [];

			if (query.status && query.status !== "all") {
				conditions.push(eq(elimsItemRequests.status, query.status));
			}
			if (query.isTest === "true") {
				conditions.push(eq(elimsItemRequests.isTest, true));
			} else if (query.isTest === "false") {
				conditions.push(eq(elimsItemRequests.isTest, false));
			}
			if (query.search?.trim()) {
				const s = `%${query.search.trim()}%`;
				conditions.push(
					or(
						ilike(elimsItemRequests.discordUsername, s),
						ilike(elimsItemRequests.itemName, s),
						ilike(elimsItemRequests.id, s),
					),
				);
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			const [totalResult] = await db
				.select({ count: count() })
				.from(elimsItemRequests)
				.where(whereClause);

			const total = Number(totalResult?.count ?? 0);
			const totalPages = Math.max(1, Math.ceil(total / limit));

			const rawLogs = await db
				.select({
					id: elimsItemRequests.id,
					guildId: elimsItemRequests.guildId,
					discordUserId: elimsItemRequests.discordUserId,
					discordUsername: elimsItemRequests.discordUsername,
					tornId: elimsItemRequests.tornId,
					tornName: elimsItemRequests.tornName,
					itemId: elimsItemRequests.itemId,
					itemName: elimsItemRequests.itemName,
					itemCategory: elimsItemRequests.itemCategory,
					quantity: elimsItemRequests.quantity,
					status: elimsItemRequests.status,
					isTest: elimsItemRequests.isTest,
					reason: elimsItemRequests.reason,
					requestMessageId: elimsItemRequests.requestMessageId,
					grantingMessageId: elimsItemRequests.grantingMessageId,
					dmSent: elimsItemRequests.dmSent,
					handledByDiscordId: elimsItemRequests.handledByDiscordId,
					handledByUsername: elimsItemRequests.handledByUsername,
					handledByTornId: elimsItemRequests.handledByTornId,
					handledByTornName: elimsItemRequests.handledByTornName,
					handledAt: elimsItemRequests.handledAt,
					metadata: elimsItemRequests.metadata,
					createdAt: elimsItemRequests.createdAt,
					updatedAt: elimsItemRequests.updatedAt,
					handlerVerifiedTornId: elimsVerifiedUsers.tornId,
					handlerVerifiedTornName: elimsVerifiedUsers.tornName,
				})
				.from(elimsItemRequests)
				.leftJoin(
					elimsVerifiedUsers,
					eq(
						elimsItemRequests.handledByDiscordId,
						elimsVerifiedUsers.discordId,
					),
				)
				.where(whereClause)
				.orderBy(desc(elimsItemRequests.createdAt))
				.limit(limit)
				.offset(offset);

			const logs = rawLogs.map((row) => ({
				id: row.id,
				guildId: row.guildId,
				discordUserId: row.discordUserId,
				discordUsername: row.discordUsername,
				tornId: row.tornId,
				tornName: row.tornName,
				itemId: row.itemId,
				itemName: row.itemName,
				itemCategory: row.itemCategory,
				quantity: row.quantity,
				status: row.status,
				isTest: row.isTest,
				reason: row.reason,
				requestMessageId: row.requestMessageId,
				grantingMessageId: row.grantingMessageId,
				dmSent: row.dmSent,
				handledByDiscordId: row.handledByDiscordId,
				handledByUsername: row.handledByUsername,
				handledByTornId:
					row.handledByTornId ?? row.handlerVerifiedTornId ?? null,
				handledByTornName:
					row.handledByTornName ?? row.handlerVerifiedTornName ?? null,
				handledAt: row.handledAt,
				metadata: row.metadata,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
			}));

			return {
				logs,
				pagination: {
					page,
					limit,
					total,
					totalPages,
				},
			};
		},
		{
			query: t.Object({
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
				status: t.Optional(t.String()),
				isTest: t.Optional(t.String()),
				search: t.Optional(t.String()),
			}),
			detail: {
				summary: "Paginated Item Requests History",
				description:
					"Fetches paginated item request logs with status, test indicator, and user info.",
			},
		},
	)

	// ─── GET /api/v1/elims/item-requests/logs/export ──────────────────────────
	.get(
		"/item-requests/logs/export",
		async ({ query, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const conditions = [];

			if (query.status && query.status !== "all") {
				conditions.push(eq(elimsItemRequests.status, query.status));
			}
			if (query.isTest === "true") {
				conditions.push(eq(elimsItemRequests.isTest, true));
			} else if (query.isTest === "false") {
				conditions.push(eq(elimsItemRequests.isTest, false));
			}
			if (query.search?.trim()) {
				const s = `%${query.search.trim()}%`;
				conditions.push(
					or(
						ilike(elimsItemRequests.discordUsername, s),
						ilike(elimsItemRequests.itemName, s),
						ilike(elimsItemRequests.id, s),
					),
				);
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			const rawExportLogs = await db
				.select({
					id: elimsItemRequests.id,
					guildId: elimsItemRequests.guildId,
					discordUserId: elimsItemRequests.discordUserId,
					discordUsername: elimsItemRequests.discordUsername,
					tornId: elimsItemRequests.tornId,
					tornName: elimsItemRequests.tornName,
					itemId: elimsItemRequests.itemId,
					itemName: elimsItemRequests.itemName,
					itemCategory: elimsItemRequests.itemCategory,
					quantity: elimsItemRequests.quantity,
					status: elimsItemRequests.status,
					isTest: elimsItemRequests.isTest,
					reason: elimsItemRequests.reason,
					handledByDiscordId: elimsItemRequests.handledByDiscordId,
					handledByUsername: elimsItemRequests.handledByUsername,
					handledByTornId: elimsItemRequests.handledByTornId,
					handledByTornName: elimsItemRequests.handledByTornName,
					handledAt: elimsItemRequests.handledAt,
					createdAt: elimsItemRequests.createdAt,
					handlerVerifiedTornId: elimsVerifiedUsers.tornId,
					handlerVerifiedTornName: elimsVerifiedUsers.tornName,
				})
				.from(elimsItemRequests)
				.leftJoin(
					elimsVerifiedUsers,
					eq(
						elimsItemRequests.handledByDiscordId,
						elimsVerifiedUsers.discordId,
					),
				)
				.where(whereClause)
				.orderBy(desc(elimsItemRequests.createdAt));

			const headers = [
				"Request ID",
				"Created At (UTC)",
				"Status",
				"Discord User ID",
				"Discord Username",
				"Torn ID",
				"Torn Name",
				"Item ID",
				"Item Name",
				"Category",
				"Quantity",
				"Is Test",
				"Handled By Discord ID",
				"Handled By Username",
				"Handled By Torn ID",
				"Handled By Torn Name",
				"Handled At (UTC)",
				"Reason",
			];

			const escapeCell = (val: unknown): string => {
				if (val === null || val === undefined) return "";
				const str = val instanceof Date ? val.toISOString() : String(val);
				if (
					str.includes(",") ||
					str.includes('"') ||
					str.includes("\n") ||
					str.includes("\r")
				) {
					return `"${str.replace(/"/g, '""')}"`;
				}
				return str;
			};

			const csvRows = [headers.join(",")];

			for (const r of rawExportLogs) {
				const handledByTornId =
					r.handledByTornId ?? r.handlerVerifiedTornId ?? null;
				const handledByTornName =
					r.handledByTornName ?? r.handlerVerifiedTornName ?? null;

				csvRows.push(
					[
						escapeCell(r.id),
						escapeCell(r.createdAt),
						escapeCell(r.status),
						escapeCell(r.discordUserId),
						escapeCell(r.discordUsername),
						escapeCell(r.tornId),
						escapeCell(r.tornName),
						escapeCell(r.itemId),
						escapeCell(r.itemName),
						escapeCell(r.itemCategory),
						escapeCell(r.quantity),
						escapeCell(r.isTest ? "TRUE" : "FALSE"),
						escapeCell(r.handledByDiscordId),
						escapeCell(r.handledByUsername),
						escapeCell(handledByTornId),
						escapeCell(handledByTornName),
						escapeCell(r.handledAt),
						escapeCell(r.reason),
					].join(","),
				);
			}

			const csvContent = csvRows.join("\r\n");
			const timestamp = new Date().toISOString().slice(0, 10);

			return new Response(csvContent, {
				headers: {
					"Content-Type": "text/csv; charset=utf-8",
					"Content-Disposition": `attachment; filename="elims-item-requests-${timestamp}.csv"`,
				},
			});
		},
		{
			query: t.Object({
				status: t.Optional(t.String()),
				isTest: t.Optional(t.String()),
				search: t.Optional(t.String()),
			}),
			detail: {
				summary: "Export Item Requests History as CSV",
				description:
					"Exports all or filtered item requests logs as a downloadable CSV file.",
			},
		},
	)

	// ─── PATCH /api/v1/elims/item-requests/logs/:id/test ──────────────────────
	.patch(
		"/item-requests/logs/:id/test",
		async ({ params, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const [existing] = await db
				.select()
				.from(elimsItemRequests)
				.where(eq(elimsItemRequests.id, params.id));

			if (!existing) {
				set.status = 404;
				return { error: "Log entry not found." };
			}

			const [updated] = await db
				.update(elimsItemRequests)
				.set({
					isTest: !existing.isTest,
					updatedAt: new Date(),
				})
				.where(eq(elimsItemRequests.id, params.id))
				.returning();

			return { success: true, item: updated };
		},
		{
			params: t.Object({ id: t.String() }),
			detail: {
				summary: "Toggle Test Flag on Request Log",
				description:
					"Toggles the is_test flag on a given item request log entry.",
			},
		},
	);
