import {
	and,
	count,
	db,
	desc,
	type ElimsItemRequestConfig,
	elimsApiKeys,
	elimsArmoryDeposits,
	elimsItemRequests,
	elimsMemberStats,
	elimsTeamPlayers,
	elimsTeamSnapshots,
	elimsTeams,
	eq,
	getArmoryStock,
	getStockHolders,
	guildConfigs,
	ilike,
	inArray,
	or,
	type SQL,
	sql,
	systemStates,
	tornItems,
	verificationLogs,
	verifiedUsers,
	type WhitelistedItem,
} from "@sentinel/database";
import {
	encryptApiKey,
	getElimsKeyPool,
	hashApiKey,
	isValidApiKey,
	TornApiClient,
} from "@sentinel/torn-api";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import {
	assignElimsStatRolesViaIpc,
	requestSchedulerAction,
	resetElimsGuildViaIpc,
	syncElimsGuildViaIpc,
	syncElimsItemRequestsViaIpc,
	syncElimsKeyDonationViaIpc,
} from "../../lib/bot-ipc";
import { fetchDiscordApi } from "../../lib/discord-auth";
import { getElimsAttackMatrixSnapshot } from "../../lib/elims-attack-stats";
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
		global_name?: string | null;
		avatar: string | null;
		bot?: boolean;
	};
	nick?: string | null;
	roles: string[];
	permissions?: string;
}

const guildMemberCache = new Map<
	string,
	{
		timestamp: number;
		members: Array<{
			id: string;
			username: string;
			displayName: string;
			avatar: string | null;
		}>;
	}
>();

interface ElimsConfigData {
	guildId: string;
	guildName: string;
	guildIcon: string | null;
	adminRoleIds: string[];
	keyDonationChannelId?: string | null;
	keyDonationEmbedMessageId?: string | null;
	teamRoleId?: string | null;
	autoSyncTeamStats?: boolean;
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

export async function verifyElimsAdmin(
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

export interface ElimsUserItem {
	id: number | string;
	name: string;
	tornId?: number | null;
	tornName?: string | null;
	discordId?: string;
	discordName?: string;
}

export interface ElimsUsersQuery {
	type?: string;
	strict?: string;
	fresh?: string;
}

let elimsUsersCache: {
	timestamp: number;
	data: Array<{
		id: number | string;
		name: string;
		tornId: number | null;
		tornName: string | null;
		discordId: string;
		discordName: string;
	}>;
} | null = null;

export async function fetchElimsUsers(
	query: ElimsUsersQuery = {},
): Promise<ElimsUserItem[]> {
	const [existing] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, ELIMS_CONFIG_ID));

	const configData = existing?.data as unknown as ElimsConfigData | undefined;
	const guildId = configData?.guildId;
	if (!guildId) {
		return [];
	}

	const bypassCache = query.fresh === "true";
	let rawUsers =
		elimsUsersCache &&
		!bypassCache &&
		Date.now() - elimsUsersCache.timestamp < 60_000
			? elimsUsersCache.data
			: null;

	if (!rawUsers) {
		// 1. Fetch verified users linked through verification_logs for this guild
		const verifiedLogUsers = await db
			.selectDistinctOn([verificationLogs.discordId], {
				discordId: verificationLogs.discordId,
				tornId: verifiedUsers.tornId,
				tornName: verifiedUsers.tornName,
				newNickname: verificationLogs.newNickname,
			})
			.from(verificationLogs)
			.innerJoin(
				verifiedUsers,
				eq(verificationLogs.discordId, verifiedUsers.discordId),
			)
			.where(eq(verificationLogs.guildId, guildId));

		// 2. Fetch stored elims_member_stats for this guild
		const memberStatsRows = await db
			.select({
				discordId: elimsMemberStats.discordId,
				discordUsername: elimsMemberStats.discordUsername,
				discordNickname: elimsMemberStats.discordNickname,
				tornId: elimsMemberStats.tornId,
				tornName: elimsMemberStats.tornName,
			})
			.from(elimsMemberStats)
			.where(eq(elimsMemberStats.guildId, guildId));

		const knownByDiscordId = new Map<
			string,
			{
				tornId: number | null;
				tornName: string | null;
				discordName: string | null;
			}
		>();

		for (const row of verifiedLogUsers) {
			knownByDiscordId.set(row.discordId, {
				tornId: row.tornId,
				tornName: row.tornName,
				discordName: row.tornName || row.newNickname,
			});
		}

		for (const row of memberStatsRows) {
			const prev = knownByDiscordId.get(row.discordId);
			knownByDiscordId.set(row.discordId, {
				tornId: row.tornId ?? prev?.tornId ?? null,
				tornName: row.tornName ?? prev?.tornName ?? null,
				discordName:
					row.discordNickname ||
					row.discordUsername ||
					prev?.discordName ||
					null,
			});
		}

		// 3. Attempt to fetch live members from Discord REST API
		const botToken = env.DISCORD_TOKEN;
		let liveMembers: Array<{
			id: string;
			username: string;
			displayName: string;
		}> | null = null;

		if (botToken) {
			const allFetched: Array<{
				id: string;
				username: string;
				displayName: string;
			}> = [];
			let after: string | undefined;

			for (let page = 0; page < 5; page++) {
				const queryStr = `limit=1000${after ? `&after=${after}` : ""}`;
				const batch = await fetchDiscordApi<DiscordGuildMember[]>(
					`/guilds/${guildId}/members?${queryStr}`,
					`Bot ${botToken}`,
				);

				if (!batch || !Array.isArray(batch) || batch.length === 0) break;

				for (const m of batch) {
					if (!m.user || m.user.bot) continue;
					allFetched.push({
						id: m.user.id,
						username: m.user.username,
						displayName: m.nick || m.user.global_name || m.user.username,
					});
				}

				if (batch.length < 1000) break;
				const lastMember = batch[batch.length - 1];
				after = lastMember?.user?.id;
				if (!after) break;
			}

			if (allFetched.length > 0) {
				liveMembers = allFetched;
			}
		}

		const combined: Array<{
			id: number | string;
			name: string;
			tornId: number | null;
			tornName: string | null;
			discordId: string;
			discordName: string;
		}> = [];

		if (liveMembers && liveMembers.length > 0) {
			for (const m of liveMembers) {
				const known = knownByDiscordId.get(m.id);
				const tornId = known?.tornId ?? null;
				const tornName = known?.tornName ?? null;
				const discordId = m.id;
				const discordName = m.displayName || known?.discordName || m.username;

				combined.push({
					id: tornId ?? discordId,
					name: tornName || discordName,
					tornId,
					tornName,
					discordId,
					discordName,
				});
			}
		} else {
			for (const [discordId, info] of knownByDiscordId.entries()) {
				const tornId = info.tornId;
				const tornName = info.tornName;
				const discordName = info.discordName || tornName || "Unknown";

				combined.push({
					id: tornId ?? discordId,
					name: tornName || discordName,
					tornId,
					tornName,
					discordId,
					discordName,
				});
			}
		}

		combined.sort((a, b) =>
			String(a.name).localeCompare(String(b.name), undefined, {
				sensitivity: "base",
			}),
		);

		elimsUsersCache = {
			timestamp: Date.now(),
			data: combined,
		};
		rawUsers = combined;
	}

	const type = query.type?.toLowerCase();
	const isStrict = query.strict === "true";

	if (type === "discord") {
		return rawUsers.map((u) => ({
			id: u.discordId,
			name: u.discordName,
			...(isStrict
				? {}
				: {
						tornId: u.tornId,
						tornName: u.tornName,
						discordId: u.discordId,
						discordName: u.discordName,
					}),
		}));
	}

	if (type === "torn") {
		return rawUsers
			.filter((u) => u.tornId !== null)
			.map((u) => ({
				id: u.tornId as number,
				name: u.tornName ?? u.name,
				...(isStrict
					? {}
					: {
							tornId: u.tornId,
							tornName: u.tornName,
							discordId: u.discordId,
							discordName: u.discordName,
						}),
			}));
	}

	if (isStrict) {
		return rawUsers.map((u) => ({
			id: u.id,
			name: u.name,
		}));
	}

	return rawUsers;
}

export const elimsRoutes = new Elysia({ prefix: "/elims" })
	.use(authPlugin)

	// ─── GET /api/v1/elims/users ───────────────────────────────────────────────
	.get(
		"/users",
		async ({ query, set }) => {
			set.headers["access-control-allow-origin"] = "*";
			set.headers["access-control-allow-methods"] = "GET, OPTIONS";
			set.headers["access-control-allow-headers"] = "*";
			return await fetchElimsUsers(query);
		},
		{
			query: t.Object({
				type: t.Optional(t.String()),
				strict: t.Optional(t.String()),
				fresh: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Elims Server Users",
				description:
					"Public endpoint returning a JSON array of current users in the Elims server with name and id fields.",
			},
		},
	)

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

			const safeBotGuilds: DiscordGuild[] = botGuilds ? [...botGuilds] : [];
			const botGuildIds = new Set(safeBotGuilds.map((g) => g.id));

			// Direct lookup for authorized guilds not returned in /users/@me/guilds
			const authorizedRows = await db
				.select({ guildId: guildConfigs.guildId })
				.from(guildConfigs)
				.where(eq(guildConfigs.authorized, true));

			for (const row of authorizedRows) {
				if (!botGuildIds.has(row.guildId)) {
					const directGuild = await fetchDiscordApi<DiscordGuild>(
						`/guilds/${row.guildId}`,
						`Bot ${botToken}`,
					);
					if (directGuild) {
						safeBotGuilds.push(directGuild);
						botGuildIds.add(directGuild.id);
					}
				}
			}

			const userGuildMap = new Map((userGuilds ?? []).map((g) => [g.id, g]));

			const mappedGuilds = safeBotGuilds.map((g) => ({
				id: g.id,
				name: g.name,
				icon: g.icon,
				botInGuild: true,
				owner: g.owner,
				userInGuild: userGuildMap.has(g.id),
			}));

			for (const row of authorizedRows) {
				if (!botGuildIds.has(row.guildId)) {
					mappedGuilds.push({
						id: row.guildId,
						name: `Authorized Server (${row.guildId})`,
						icon: null,
						botInGuild: true,
						owner: false,
						userInGuild: userGuildMap.has(row.guildId),
					});
				}
			}

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

	// ─── GET /api/v1/elims/guild-members/:guildId ─────────────────────────────
	.get(
		"/guild-members/:guildId",
		async ({ params, query, user, set }) => {
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
			if (!botToken) return { members: [] };

			const cacheKey = `members_${guildId}`;
			const bypassCache = query.fresh === "true";
			const cached = guildMemberCache.get(cacheKey);
			if (
				!bypassCache &&
				cached &&
				Date.now() - cached.timestamp < 3 * 60 * 1000
			) {
				return { members: cached.members };
			}

			const allMembers: Array<{
				id: string;
				username: string;
				displayName: string;
				avatar: string | null;
			}> = [];

			let after: string | undefined;
			for (let page = 0; page < 3; page++) {
				const queryStr = `limit=1000${after ? `&after=${after}` : ""}`;
				const batch = await fetchDiscordApi<DiscordGuildMember[]>(
					`/guilds/${guildId}/members?${queryStr}`,
					`Bot ${botToken}`,
				);

				if (!batch || !Array.isArray(batch) || batch.length === 0) break;

				for (const m of batch) {
					if (!m.user || m.user.bot) continue;
					allMembers.push({
						id: m.user.id,
						username: m.user.username,
						displayName: m.nick || m.user.global_name || m.user.username,
						avatar: m.user.avatar
							? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`
							: null,
					});
				}

				if (batch.length < 1000) break;
				after = batch[batch.length - 1]?.user?.id;
				if (!after) break;
			}

			allMembers.sort((a, b) =>
				a.displayName.localeCompare(b.displayName, undefined, {
					sensitivity: "base",
				}),
			);

			guildMemberCache.set(cacheKey, {
				timestamp: Date.now(),
				members: allMembers,
			});

			return { members: allMembers };
		},
		{
			params: t.Object({ guildId: t.String() }),
			query: t.Object({ fresh: t.Optional(t.String()) }),
			detail: {
				summary: "Fetch Guild Members",
				description:
					"Fetches non-bot members of the guild for user search and blacklisting.",
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
					donatedByDiscordId: elimsApiKeys.donatedByDiscordId,
					donatedByDiscordTag: elimsApiKeys.donatedByDiscordTag,
					lastUsedAt: elimsApiKeys.lastUsedAt,
					createdAt: elimsApiKeys.createdAt,
				})
				.from(elimsApiKeys)
				.where(eq(elimsApiKeys.guildId, configData.guildId))
				.orderBy(desc(elimsApiKeys.createdAt));

			return {
				keys,
				channelId: configData.keyDonationChannelId ?? null,
			};
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
					donatedByDiscordId: user?.discordId ?? null,
					donatedByDiscordTag: user?.username ?? "Dashboard Admin",
				})
				.returning({
					id: elimsApiKeys.id,
					tornId: elimsApiKeys.tornId,
					tornName: elimsApiKeys.tornName,
					isValid: elimsApiKeys.isValid,
					donatedByDiscordId: elimsApiKeys.donatedByDiscordId,
					donatedByDiscordTag: elimsApiKeys.donatedByDiscordTag,
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

	// ─── GET /api/v1/elims/api-keys/channel ───────────────────────────────────
	.get(
		"/api-keys/channel",
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
			return { channelId: configData.keyDonationChannelId ?? null };
		},
		{
			detail: {
				summary: "Get Key Donation Channel",
				description: "Fetches the configured channel for API key donations.",
			},
		},
	)

	// ─── PUT /api/v1/elims/api-keys/channel ───────────────────────────────────
	.put(
		"/api-keys/channel",
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
			const newChannelId = body.channelId ? body.channelId.trim() : null;

			const updatedConfig: ElimsConfigData = {
				...configData,
				keyDonationChannelId: newChannelId,
				keyDonationEmbedMessageId:
					newChannelId !== configData.keyDonationChannelId
						? null
						: configData.keyDonationEmbedMessageId,
				updatedAt: new Date().toISOString(),
			};

			await db
				.update(systemStates)
				.set({
					data: updatedConfig as unknown as Record<string, unknown>,
					updatedAt: new Date(),
				})
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			void syncElimsKeyDonationViaIpc(configData.guildId);

			return { success: true, channelId: newChannelId };
		},
		{
			body: t.Object({
				channelId: t.Nullable(t.String()),
			}),
			detail: {
				summary: "Update Key Donation Channel",
				description:
					"Configures the channel where the persistent key donation embed will be posted.",
			},
		},
	)

	// ─── POST /api/v1/elims/api-keys/channel/sync ─────────────────────────────
	.post(
		"/api-keys/channel/sync",
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
			void syncElimsKeyDonationViaIpc(configData.guildId);

			return { success: true, message: "Sync signal dispatched to bot." };
		},
		{
			detail: {
				summary: "Sync Key Donation Embed",
				description:
					"Triggers the bot to immediately refresh or repost the persistent key donation embed.",
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
					storageChannelId: null,
					storageEmbedMessageId: null,
					stockHoldersChannelId: null,
					stockHolderMessageIds: {},
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

			const [existingState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
			const existingConfig =
				existingState?.data as unknown as ElimsItemRequestConfig | null;

			// If request channel changed, old embed cannot be reused; otherwise preserve existing embedMessageId
			const channelChanged =
				existingConfig?.requestChannelId &&
				body.requestChannelId !== undefined &&
				body.requestChannelId !== existingConfig.requestChannelId;

			const embedMessageId = channelChanged
				? null
				: (body.embedMessageId ?? existingConfig?.embedMessageId ?? null);

			// If storage channel changed, old embed cannot be reused; otherwise preserve existing storageEmbedMessageId
			const storageChannelChanged =
				existingConfig?.storageChannelId &&
				body.storageChannelId !== undefined &&
				body.storageChannelId !== existingConfig.storageChannelId;

			const storageEmbedMessageId = storageChannelChanged
				? null
				: (body.storageEmbedMessageId ??
					existingConfig?.storageEmbedMessageId ??
					null);

			// If stock holders channel changed, message IDs cannot be reused
			const stockHoldersChannelChanged =
				existingConfig?.stockHoldersChannelId &&
				body.stockHoldersChannelId !== undefined &&
				body.stockHoldersChannelId !== existingConfig.stockHoldersChannelId;

			const stockHolderMessageIds = stockHoldersChannelChanged
				? {}
				: (body.stockHolderMessageIds ??
					existingConfig?.stockHolderMessageIds ??
					{});

			const configPayload: ElimsItemRequestConfig = {
				requestChannelId: body.requestChannelId ?? null,
				grantingChannelId: body.grantingChannelId ?? null,
				storageChannelId: body.storageChannelId ?? null,
				storageEmbedMessageId,
				stockHoldersChannelId: body.stockHoldersChannelId ?? null,
				stockHolderMessageIds,
				requesterRoleIds: body.requesterRoleIds ?? [],
				managerRoleIds: body.managerRoleIds ?? [],
				allowedItems: body.allowedItems ?? [],
				blacklistedUserIds: body.blacklistedUserIds ?? [],
				embedMessageId,
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
				storageChannelId: t.Optional(t.Nullable(t.String())),
				storageEmbedMessageId: t.Optional(t.Nullable(t.String())),
				stockHoldersChannelId: t.Optional(t.Nullable(t.String())),
				stockHolderMessageIds: t.Optional(t.Record(t.String(), t.String())),
				requesterRoleIds: t.Array(t.String()),
				managerRoleIds: t.Array(t.String()),
				allowedItems: t.Array(
					t.Object({
						id: t.String(),
						name: t.String(),
						category: t.String(),
						marketPrice: t.Optional(t.Number()),
						image: t.Optional(t.String()),
						maxRequestable: t.Optional(t.Number()),
						disabled: t.Optional(t.Boolean()),
					}),
				),
				blacklistedUserIds: t.Optional(t.Array(t.String())),
				embedMessageId: t.Optional(t.Nullable(t.String())),
			}),
			detail: {
				summary: "Update Item Requests Configuration",
				description:
					"Updates request/grant/storage/stock-holders channels, requester/manager roles, and whitelisted items.",
			},
		},
	)

	// ─── GET /api/v1/elims/item-requests/stock-holders ─────────────────────────
	.get(
		"/item-requests/stock-holders",
		async ({ user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}

			const [elimsGuildState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));
			const elimsGuildData = elimsGuildState?.data as unknown as
				| ElimsConfigData
				| undefined;
			const targetGuildId = elimsGuildData?.guildId;
			if (!targetGuildId) {
				return { holders: [] };
			}

			const holders = await getStockHolders(targetGuildId, false);
			return { holders };
		},
		{
			detail: {
				summary: "Get Elims Stock Holders",
				description:
					"Returns all active item stock holders and their allocations.",
			},
		},
	)

	// ─── GET /api/v1/elims/item-requests/storage/inventory ────────────────────
	.get(
		"/item-requests/storage/inventory",
		async ({ user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const [elimsGuildState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			const elimsGuildData = elimsGuildState?.data as unknown as
				| ElimsConfigData
				| undefined;
			let guildId = elimsGuildData?.guildId ?? "";
			if (!guildId) {
				const [deposit] = await db
					.select({ guildId: elimsArmoryDeposits.guildId })
					.from(elimsArmoryDeposits)
					.limit(1);
				if (deposit?.guildId) {
					guildId = deposit.guildId;
				}
			}

			const liveStockMap = await getArmoryStock(guildId, false);
			const testStockMap = await getArmoryStock(guildId, true);

			const liveList = Array.from(liveStockMap.values());
			const testList = Array.from(testStockMap.values());

			// Enrich items with image, marketPrice, and category from tornItems
			const allItemIds = new Set<string>();
			for (const s of [...liveList, ...testList]) {
				if (s.itemId && s.itemId !== "money") {
					allItemIds.add(s.itemId);
				}
			}

			if (allItemIds.size > 0) {
				const dbItems = await db
					.select({
						id: tornItems.id,
						name: tornItems.name,
						data: tornItems.data,
					})
					.from(tornItems)
					.where(inArray(tornItems.id, Array.from(allItemIds)));

				const tornItemById = new Map(dbItems.map((it) => [it.id, it]));
				const tornItemByName = new Map(
					dbItems.map((it) => [it.name?.trim().toLowerCase() ?? "", it]),
				);

				for (const s of [...liveList, ...testList]) {
					const ti =
						tornItemById.get(s.itemId) ??
						tornItemByName.get(s.itemName.trim().toLowerCase());
					if (ti) {
						const d = (ti.data ?? {}) as Record<string, unknown>;
						const v = (d.value ?? {}) as Record<string, unknown>;
						if (!s.category || s.category === "General") {
							s.category = (d.type ??
								d.category ??
								s.category ??
								"General") as string;
						}
						s.image = typeof d.image === "string" ? d.image : undefined;
						s.marketPrice = Number(v.market_price ?? v.buy_price ?? 0);
					}
				}
			}

			return {
				inventory: {
					live: liveList,
					test: testList,
				},
				live: liveList,
				test: testList,
			};
		},
		{
			detail: {
				summary: "Get Armory Stock Inventory",
				description:
					"Returns current available item stockpile for Live and Test modes.",
			},
		},
	)

	// ─── GET /api/v1/elims/item-requests/deposits ─────────────────────────────
	.get(
		"/item-requests/deposits",
		async ({ query, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const [elimsGuildState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			const elimsGuildData = elimsGuildState?.data as unknown as
				| ElimsConfigData
				| undefined;
			const guildId = elimsGuildData?.guildId ?? "";

			const page = Math.max(1, Number(query.page ?? 1));
			const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
			const offset = (page - 1) * limit;

			const conditions: SQL<unknown>[] = [
				eq(elimsArmoryDeposits.guildId, guildId),
			];

			if (query.isTest === "true") {
				conditions.push(eq(elimsArmoryDeposits.isTest, true));
			} else if (query.isTest === "false") {
				conditions.push(eq(elimsArmoryDeposits.isTest, false));
			}

			if (query.search?.trim()) {
				const s = `%${query.search.trim()}%`;
				const searchFilter = or(
					ilike(elimsArmoryDeposits.tornName, s),
					ilike(elimsArmoryDeposits.discordUsername, s),
					ilike(elimsArmoryDeposits.itemName, s),
					ilike(elimsArmoryDeposits.itemCategory, s),
				);
				if (searchFilter) {
					conditions.push(searchFilter);
				}
			}

			const whereClause = and(...conditions);

			const [totalResult] = await db
				.select({ count: count() })
				.from(elimsArmoryDeposits)
				.where(whereClause);

			const total = Number(totalResult?.count ?? 0);
			const totalPages = Math.max(1, Math.ceil(total / limit));

			const deposits = await db
				.select()
				.from(elimsArmoryDeposits)
				.where(whereClause)
				.orderBy(desc(elimsArmoryDeposits.createdAt))
				.limit(limit)
				.offset(offset);

			return {
				deposits: deposits.map((d) => ({
					id: d.id,
					discordUserId: d.discordUserId,
					discordUsername: d.discordUsername,
					tornId: d.tornId,
					tornName: d.tornName,
					itemId: d.itemId,
					itemName: d.itemName,
					itemCategory: d.itemCategory,
					quantity: d.quantity,
					rawLog: d.rawLog,
					logTimestamp: d.logTimestamp,
					logMessage: d.logMessage,
					isTest: d.isTest,
					status: d.status,
					createdAt: d.createdAt.toISOString(),
				})),
				pagination: {
					total,
					page,
					limit,
					totalPages,
				},
			};
		},
		{
			query: t.Object({
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
				isTest: t.Optional(t.String()),
				search: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Armory Deposit History",
				description:
					"Fetches paginated depositer log history for the active guild.",
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
				.select()
				.from(elimsItemRequests)
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
				handledByTornId: row.handledByTornId,
				handledByTornName: row.handledByTornName,
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
				.select()
				.from(elimsItemRequests)
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
						escapeCell(r.handledByTornId),
						escapeCell(r.handledByTornName),
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
	)

	// ─── PATCH /api/v1/elims/item-requests/deposits/:id/test ──────────────────
	.patch(
		"/item-requests/deposits/:id/test",
		async ({ params, user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden" };
			}

			const [existing] = await db
				.select()
				.from(elimsArmoryDeposits)
				.where(eq(elimsArmoryDeposits.id, params.id));

			if (!existing) {
				set.status = 404;
				return { error: "Deposit entry not found." };
			}

			const [updated] = await db
				.update(elimsArmoryDeposits)
				.set({
					isTest: !existing.isTest,
					updatedAt: new Date(),
				})
				.where(eq(elimsArmoryDeposits.id, params.id))
				.returning();

			return { success: true, item: updated };
		},
		{
			params: t.Object({ id: t.String() }),
			detail: {
				summary: "Toggle Test Flag on Deposit Log",
				description:
					"Toggles the is_test flag on a given armory deposit entry.",
			},
		},
	)

	// ─── POST /api/v1/elims/item-requests/clear-logs ──────────────────────────
	.post(
		"/item-requests/clear-logs",
		async ({ user, set }) => {
			if (user?.role !== "owner") {
				set.status = 403;
				return { error: "Only the Sentinel owner can clear tournament logs." };
			}

			const [elimsGuildState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			const elimsGuildData = elimsGuildState?.data as unknown as
				| ElimsConfigData
				| undefined;
			const guildId = elimsGuildData?.guildId ?? "";

			if (!guildId) {
				set.status = 400;
				return { error: "No active Elims server configured." };
			}

			// Clear all requests and deposits for this server
			const [deletedReqs, deletedDeps] = await Promise.all([
				db
					.delete(elimsItemRequests)
					.where(eq(elimsItemRequests.guildId, guildId))
					.returning({ id: elimsItemRequests.id }),
				db
					.delete(elimsArmoryDeposits)
					.where(eq(elimsArmoryDeposits.guildId, guildId))
					.returning({ id: elimsArmoryDeposits.id }),
			]);

			// Sync with bot so armory storage channel updates live stock immediately
			void syncElimsItemRequestsViaIpc(guildId);

			return {
				success: true,
				clearedRequests: deletedReqs.length,
				clearedDeposits: deletedDeps.length,
				message: `Cleared ${deletedReqs.length} item request(s) and ${deletedDeps.length} armory deposit(s).`,
			};
		},
		{
			detail: {
				summary: "Clear All Item Requests & Armory Deposits (Owner Only)",
				description:
					"Permanently removes all item requests and armory deposits for the active tournament guild.",
			},
		},
	)

	// ─── GET /api/v1/elims/hourly-activity ───────────────────────────────────
	.get(
		"/hourly-activity",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			// 1. Fetch all 12 teams
			const teams = await db.select().from(elimsTeams).orderBy(elimsTeams.id);

			// 1. Current hourly activity (most recent snapshot per team per hour)
			const curRows = await db.execute<{
				team_id: number;
				hour_tct: number;
				current_activity: number;
			}>(sql`
				SELECT DISTINCT ON (team_id, hour_tct)
					team_id,
					hour_tct,
					(CASE WHEN eliminated THEN 0 WHEN active_count > 0 THEN active_count ELSE GREATEST(0, attacks / 10) END)::int as current_activity
				FROM elims_team_snapshots
				ORDER BY team_id, hour_tct, captured_at DESC
			`);

			// 2. Average hourly activity (mean across all historical snapshots per team per hour)
			const avgRows = await db.execute<{
				team_id: number;
				hour_tct: number;
				avg_activity: number;
			}>(sql`
				SELECT 
					team_id, 
					hour_tct, 
					ROUND(AVG(CASE WHEN eliminated THEN 0 WHEN active_count > 0 THEN active_count ELSE GREATEST(0, attacks / 10) END))::int as avg_activity
				FROM elims_team_snapshots
				GROUP BY team_id, hour_tct
			`);

			const teamCurrentMap = new Map<number, number[]>();
			const teamAverageMap = new Map<number, number[]>();

			for (const t of teams) {
				teamCurrentMap.set(t.id, new Array(24).fill(0));
				teamAverageMap.set(t.id, new Array(24).fill(0));
			}

			for (const row of curRows) {
				const arr = teamCurrentMap.get(row.team_id);
				if (arr && row.hour_tct >= 0 && row.hour_tct < 24) {
					arr[row.hour_tct] = row.current_activity;
				}
			}

			for (const row of avgRows) {
				const arr = teamAverageMap.get(row.team_id);
				if (arr && row.hour_tct >= 0 && row.hour_tct < 24) {
					arr[row.hour_tct] = row.avg_activity;
				}
			}

			const benchmarkHourly = new Array(24).fill(0);
			const benchmarkCounts = new Array(24).fill(0);

			for (const row of avgRows) {
				if (row.hour_tct >= 0 && row.hour_tct < 24) {
					benchmarkHourly[row.hour_tct] =
						(benchmarkHourly[row.hour_tct] ?? 0) + row.avg_activity;
					benchmarkCounts[row.hour_tct] =
						(benchmarkCounts[row.hour_tct] ?? 0) + 1;
				}
			}

			for (let h = 0; h < 24; h++) {
				const c = benchmarkCounts[h] ?? 0;
				if (c > 0) {
					benchmarkHourly[h] = Math.round((benchmarkHourly[h] ?? 0) / c);
				}
			}

			// 3. Build chronological live timeline for the AreaChart
			// Grab up to 360 most recent snapshots (30 cycles * 12 teams)
			const recentSnapshots = await db
				.select()
				.from(elimsTeamSnapshots)
				.orderBy(desc(elimsTeamSnapshots.capturedAt))
				.limit(360);

			// Group by timestamp (rounded to 5s slice so all teams in the same cycle share the same time slice)
			const timelineMap = new Map<number, Record<string, unknown>>();

			for (const s of recentSnapshots) {
				const timeMs = s.capturedAt.getTime();
				const sliceKey = Math.floor(timeMs / 5000) * 5000;
				let point = timelineMap.get(sliceKey);
				if (!point) {
					const dateObj = new Date(sliceKey);
					const timeLabel = new Intl.DateTimeFormat("en-GB", {
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
						timeZone: "UTC",
					}).format(dateObj);

					point = {
						timestamp: dateObj.toISOString(),
						timeLabel,
						epoch: sliceKey,
					};
					timelineMap.set(sliceKey, point);
				}

				point[`${s.teamId}_active`] = s.activeCount;
				point[`${s.teamId}_score`] = s.score;
				point[`${s.teamId}_attacks`] = s.attacks;
				point[`${s.teamId}_lives`] = s.lives;
				point[`${s.teamId}_eliminated`] = s.eliminated;
			}

			// Sort chronological ascending (oldest to newest)
			const liveTimeline = Array.from(timelineMap.entries())
				.sort(([a], [b]) => a - b)
				.map(([, pt]) => pt);

			const teamReports = teams.map((team) => {
				const currentHours =
					teamCurrentMap.get(team.id) ?? new Array(24).fill(0);
				const averageHours =
					teamAverageMap.get(team.id) ?? new Array(24).fill(0);

				let minHour = 0;
				let maxHour = 0;
				let minVal = Number.POSITIVE_INFINITY;
				let maxVal = Number.NEGATIVE_INFINITY;
				let total = 0;

				for (let h = 0; h < 24; h++) {
					const val = averageHours[h] ?? 0;
					total += val;
					if (val > 0 && val < minVal) {
						minVal = val;
						minHour = h;
					}
					if (val > maxVal) {
						maxVal = val;
						maxHour = h;
					}
				}

				return {
					teamId: team.id,
					name: team.name,
					score: team.score,
					attacks: team.attacks,
					membersCount: team.membersCount,
					lives: team.lives,
					wins: team.wins,
					losses: team.losses,
					position: team.position,
					eliminated: team.eliminated,
					eliminatedTimestamp: team.eliminatedTimestamp?.toISOString() ?? null,
					isMock: team.isMock,
					hourlyDistribution: averageHours,
					currentHourly: currentHours,
					averageHourly: averageHours,
					leastActiveHour: minVal === Number.POSITIVE_INFINITY ? 0 : minHour,
					mostActiveHour: maxVal === Number.NEGATIVE_INFINITY ? 0 : maxHour,
					totalActivity: total,
					lastSyncedAt: team.lastSyncedAt?.toISOString() ?? null,
				};
			});

			const keyPool = await getElimsKeyPool();
			const isMock = teams.some((t) => t.isMock);

			return {
				teams: teamReports,
				benchmarkHourly,
				liveTimeline,
				isMock,
				keyCount: keyPool.length,
				lastSyncedAt: teams[0]?.lastSyncedAt?.toISOString() ?? null,
			};
		},
		{
			detail: {
				summary: "Get Elimination Hourly Activity",
				description:
					"Returns hourly distribution of activity per team vs other teams across 0-24h TCT.",
			},
		},
	)

	// ─── GET /api/v1/elims/attack-matrix ─────────────────────────────────────
	.get(
		"/attack-matrix",
		async ({ user, query, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const timeframe = query.timeframe ?? "all";
			return await getElimsAttackMatrixSnapshot(timeframe);
		},
		{
			query: t.Object({
				timeframe: t.Optional(
					t.Union([
						t.Literal("all"),
						t.Literal("24h"),
						t.Literal("12h"),
						t.Literal("1h"),
					]),
				),
			}),
			detail: {
				summary: "Get Elimination Attack Matrix & Breakdown",
				description:
					"Returns the 12x12 inter-team attack matrix and per-team incoming/outgoing percentage breakdowns.",
			},
		},
	)

	// ─── POST /api/v1/elims/teams/sync ────────────────────────────────────────
	.post(
		"/teams/sync",
		async ({ user, set }) => {
			const isAdmin = await verifyElimsAdmin(user);
			if (!isAdmin) {
				set.status = 403;
				return { error: "Forbidden: Elims administrator access required." };
			}

			const res = await requestSchedulerAction<{
				success?: boolean;
				error?: string;
			}>("elims_sync_teams_request", {}, 15000);

			if (res?.error) {
				set.status = 500;
				return { error: res.error };
			}

			return { success: true, message: "Sync command executed." };
		},
		{
			detail: {
				summary: "Trigger Elimination Teams Sync",
				description:
					"Triggers the Scheduler worker to immediately run a collection cycle.",
			},
		},
	)

	// ─── GET /api/v1/elims/guild-roles ────────────────────────────────────────
	.get(
		"/guild-roles",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			const configData = existing?.data as unknown as
				| ElimsConfigData
				| undefined;
			const guildId = configData?.guildId;

			if (!guildId) {
				return { roles: [] };
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
				return { roles: [] };
			}

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
			detail: {
				summary: "Get Configured Guild Roles",
				description: "Returns roles for the currently active Elims guild.",
			},
		},
	)

	// ─── GET /api/v1/elims/team-stats ─────────────────────────────────────────
	.get(
		"/team-stats",
		async ({ query, user, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			const configData = existing?.data as unknown as
				| ElimsConfigData
				| undefined;
			const guildId = configData?.guildId;

			if (!guildId) {
				return {
					members: [],
					summary: {
						totalMembers: 0,
						totalBs: 0,
						avgBs: 0,
						sources: {
							premium: 0,
							spies: 0,
							bss: 0,
							none: 0,
							unlinked: 0,
						},
					},
				};
			}

			// Query stored Discord member stats for this guild
			const memberStatsRows = await db
				.select()
				.from(elimsMemberStats)
				.where(eq(elimsMemberStats.guildId, guildId))
				.orderBy(desc(elimsMemberStats.bsEstimate));

			// Query tournament player records for Nine Lives (team 88)
			const teamPlayers = await db
				.select({
					id: elimsTeamPlayers.id,
					score: elimsTeamPlayers.score,
					attacks: elimsTeamPlayers.attacks,
				})
				.from(elimsTeamPlayers)
				.where(eq(elimsTeamPlayers.teamId, 88));

			const playerStatsMap = new Map<
				number,
				{ score: number; attacks: number }
			>();
			for (const p of teamPlayers) {
				playerStatsMap.set(p.id, {
					score: p.score ?? 0,
					attacks: p.attacks ?? 0,
				});
			}

			// Map members strictly from fetched Discord members, attaching individual score & attacks with 0 fallback
			const membersWithElims = memberStatsRows.map((m) => {
				const p = m.tornId ? playerStatsMap.get(m.tornId) : null;
				return {
					...m,
					score: p?.score ?? 0,
					attacks: p?.attacks ?? 0,
					lastFetchedAt: (m.lastFetchedAt ?? new Date()).toISOString(),
				};
			});

			// Apply search filter
			let filtered = membersWithElims;
			if (query.search?.trim()) {
				const s = query.search.trim().toLowerCase();
				filtered = filtered.filter((r) => {
					const nameMatch = r.tornName?.toLowerCase().includes(s);
					const nickMatch = r.discordNickname?.toLowerCase().includes(s);
					const idMatch =
						r.tornId?.toString().includes(s) || r.discordId?.includes(s);
					return Boolean(nameMatch || nickMatch || idMatch);
				});
			}

			// Apply role filter
			const targetRole = query.roleId;
			if (targetRole && targetRole !== "all") {
				filtered = filtered.filter(
					(r) => Array.isArray(r.roles) && r.roles.includes(targetRole),
				);
			}

			// Apply source filter
			if (query.source && query.source !== "all") {
				filtered = filtered.filter((r) => r.source === query.source);
			}

			let totalBs = 0;
			let bsCount = 0;
			const sources = {
				premium: 0,
				spies: 0,
				bss: 0,
				none: 0,
				unlinked: 0,
			};

			for (const r of filtered) {
				if (typeof r.bsEstimate === "number" && r.bsEstimate > 0) {
					totalBs += r.bsEstimate;
					bsCount++;
				}
				const src = (r.source ?? "none") as keyof typeof sources;
				if (src in sources) {
					sources[src]++;
				} else {
					sources.none++;
				}
			}

			const avgBs = bsCount > 0 ? Math.round(totalBs / bsCount) : 0;

			return {
				members: filtered,
				summary: {
					totalMembers: filtered.length,
					totalBs,
					avgBs,
					estimatedMembers: bsCount,
					sources,
				},
			};
		},
		{
			query: t.Object({
				search: t.Optional(t.String()),
				roleId: t.Optional(t.String()),
				source: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Team Member Stats Breakdown",
				description:
					"Returns stored member stats with BS estimates, spy details, and stat distributions.",
			},
		},
	)

	// ─── POST /api/v1/elims/team-stats/fetch ───────────────────────────────────
	.post(
		"/team-stats/fetch",
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

			const configData = existing?.data as unknown as
				| ElimsConfigData
				| undefined;
			const guildId = configData?.guildId;

			if (!guildId) {
				set.status = 400;
				return { error: "Elims guild is not configured." };
			}

			const res = await requestSchedulerAction<{
				total?: number;
				newProcessed?: number;
				resolved?: number;
				ffScouterHits?: number;
				error?: string;
				message?: string;
			}>(
				"elims_fetch_member_stats_request",
				{
					guildId,
					roleId: body?.roleId,
					forceRefresh: body?.forceRefresh,
				},
				60000,
			);

			if (res?.error) {
				set.status = 500;
				return { error: res.error };
			}

			return {
				success: true,
				total: res?.total ?? 0,
				newProcessed: res?.newProcessed ?? 0,
				resolved: res?.resolved ?? 0,
				ffScouterHits: res?.ffScouterHits ?? 0,
				message:
					res?.message ?? `Processed ${res?.newProcessed ?? 0} member(s).`,
			};
		},
		{
			body: t.Optional(
				t.Object({
					roleId: t.Optional(t.String()),
					forceRefresh: t.Optional(t.Boolean()),
				}),
			),
			detail: {
				summary: "Fetch Member Stats",
				description:
					"Triggers the Scheduler to fetch member stats for new members with role X.",
			},
		},
	)

	// ─── POST /api/v1/elims/team-stats/reset ───────────────────────────────────
	.post(
		"/team-stats/reset",
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

			const configData = existing?.data as unknown as
				| ElimsConfigData
				| undefined;
			const guildId = configData?.guildId;

			if (!guildId) {
				set.status = 400;
				return { error: "Elims guild is not configured." };
			}

			let deletedCount = 0;
			if (body?.roleId && body.roleId !== "all") {
				// Remove members without this role
				const deleted = await db
					.delete(elimsMemberStats)
					.where(
						and(
							eq(elimsMemberStats.guildId, guildId),
							sql`NOT (${elimsMemberStats.roles} @> ${JSON.stringify([body.roleId])}::jsonb)`,
						),
					)
					.returning({ id: elimsMemberStats.id });
				deletedCount = deleted.length;
			} else {
				// Reset all members in this guild
				const deleted = await db
					.delete(elimsMemberStats)
					.where(eq(elimsMemberStats.guildId, guildId))
					.returning({ id: elimsMemberStats.id });
				deletedCount = deleted.length;
			}

			return {
				success: true,
				deletedCount,
				message:
					body?.roleId && body.roleId !== "all"
						? `Pruned ${deletedCount} member(s) who do not have the selected role.`
						: `Reset ${deletedCount} member stats records.`,
			};
		},
		{
			body: t.Optional(
				t.Object({
					roleId: t.Optional(t.String()),
				}),
			),
			detail: {
				summary: "Reset Member Stats",
				description:
					"Resets stored member stats for this tournament guild or prunes members without the specified role.",
			},
		},
	)

	// ─── GET /api/v1/elims/team-stats/stat-roles ───────────────────────────────
	.get(
		"/team-stats/stat-roles",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "elims:stat_roles"));

			const data = existing?.data as
				| { mappings?: Record<string, string> }
				| undefined;
			return {
				mappings: data?.mappings ?? {},
			};
		},
		{
			detail: {
				summary: "Get Stat Distribution Role Mappings",
				description:
					"Returns role mappings for battle stat distribution brackets.",
			},
		},
	)

	// ─── POST /api/v1/elims/team-stats/assign-roles ────────────────────────────
	.post(
		"/team-stats/assign-roles",
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

			const configData = existing?.data as unknown as
				| ElimsConfigData
				| undefined;
			const guildId = configData?.guildId;

			if (!guildId) {
				set.status = 400;
				return { error: "Elims guild is not configured." };
			}

			const mappings = body.roleMappings;

			// Save to systemStates
			await db
				.insert(systemStates)
				.values({
					id: "elims:stat_roles",
					init: true,
					data: {
						mappings,
						updatedAt: new Date().toISOString(),
					},
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						data: {
							mappings,
							updatedAt: new Date().toISOString(),
						},
						updatedAt: new Date(),
					},
				});

			// Dispatch IPC to bot to auto-assign roles
			const dispatched = await assignElimsStatRolesViaIpc(guildId, mappings);

			return {
				success: true,
				dispatched,
				message: dispatched
					? "Bot has begun auto-assigning roles based on stat distribution."
					: "Mappings saved. Bot IPC could not be reached (verify bot is running).",
			};
		},
		{
			body: t.Object({
				roleMappings: t.Record(t.String(), t.String()),
			}),
			detail: {
				summary: "Save and Assign Roles Based on Stat Distribution",
				description:
					"Saves stat distribution role mappings and instructs Discord bot to auto-assign roles.",
			},
		},
	)

	// ─── GET /api/v1/elims/team-stats/config ───────────────────────────────────
	.get(
		"/team-stats/config",
		async ({ user, set }) => {
			if (!user) {
				set.status = 401;
				return { error: "Unauthorized" };
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			const configData = existing?.data as unknown as
				| ElimsConfigData
				| undefined;
			return {
				teamRoleId: configData?.teamRoleId ?? null,
				autoSyncTeamStats: configData?.autoSyncTeamStats ?? false,
			};
		},
		{
			detail: {
				summary: "Get Team Breakdown Automation Config",
				description:
					"Returns configured team role ID and auto-sync setting for background execution.",
			},
		},
	)

	// ─── PUT /api/v1/elims/team-stats/config ───────────────────────────────────
	.put(
		"/team-stats/config",
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

			const currentData = existing.data as unknown as ElimsConfigData;
			const updatedData: ElimsConfigData = {
				...currentData,
				teamRoleId:
					body.teamRoleId !== undefined
						? body.teamRoleId
						: currentData.teamRoleId,
				autoSyncTeamStats:
					body.autoSyncTeamStats !== undefined
						? body.autoSyncTeamStats
						: currentData.autoSyncTeamStats,
				updatedAt: new Date().toISOString(),
			};

			await db
				.update(systemStates)
				.set({
					data: updatedData as unknown as Record<string, unknown>,
					updatedAt: new Date(),
				})
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));

			return {
				success: true,
				teamRoleId: updatedData.teamRoleId,
				autoSyncTeamStats: updatedData.autoSyncTeamStats,
				message: "Team breakdown automated configuration updated.",
			};
		},
		{
			body: t.Object({
				teamRoleId: t.Optional(t.Nullable(t.String())),
				autoSyncTeamStats: t.Optional(t.Boolean()),
			}),
			detail: {
				summary: "Update Team Breakdown Automation Config",
				description:
					"Sets the team role ID and toggles automated background stat syncing.",
			},
		},
	);
