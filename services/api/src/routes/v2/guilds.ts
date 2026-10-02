import {
	and,
	authorizeGuild,
	count,
	createMercContract,
	db,
	deauthorizeGuild,
	deleteMercContract,
	desc,
	eq,
	factionRoleMappings,
	factions,
	getMercChannelConfig,
	getMercContractSummary,
	getMercContracts,
	getServerTypeMappings,
	guildApiKeys,
	guildConfigs,
	guildMonitoredFactions,
	ilike,
	inArray,
	like,
	or,
	reactionRoleMappings,
	reactionRoleMessages,
	reconcileTargetGuildsAndModules,
	type ServerType,
	systemStates,
	territoryBlueprints,
	updateMercChannelConfig,
	updateMercContract,
	verificationLogs,
	verifiedUsers,
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
	deauthorizeGuildViaIpc,
	notifyBotAction,
	syncAuthorizedGuildsViaIpc,
	syncFactionMapViaIpc,
	syncFactionMonitoringViaIpc,
	syncGuildCommandsViaIpc,
	syncReactionRolesViaIpc,
} from "../../lib/bot-ipc";
import { getBotGuilds } from "../../lib/discord-auth";
import {
	getNextSubversiveUserKey,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
} from "../../lib/subversive-key-pool";
import { authPlugin } from "../../middleware/auth";

interface DiscordGuild {
	id: string;
	name: string;
	icon: string | null;
	owner: boolean;
	permissions: string;
	botInGuild?: boolean;
	manageable?: boolean;
	authorized?: boolean;
	userInGuild?: boolean;
	serverType?: ServerType | null;
}

interface DiscordGuildMember {
	roles: string[];
	permissions?: string;
	user?: {
		id: string;
		username: string;
	};
}

interface DiscordChannel {
	id: string;
	name: string;
	type: number;
	position: number;
	parent_id: string | null;
}

interface DiscordRole {
	id: string;
	name: string;
	color: number;
	position: number;
	permissions: string;
	managed: boolean;
}

const MANAGE_GUILD = 0x20;
const ADMINISTRATOR = 0x8;

async function fetchDiscordApi<T>(
	endpoint: string,
	authHeader: string,
): Promise<T | null> {
	try {
		const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
			headers: { Authorization: authHeader },
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

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
	memberCache.set(cacheKey, { member, expiresAt: Date.now() + 30_000 });
}

export async function verifyGuildAdmin(
	user: { role?: string; discordId?: string | null } | null | undefined,
	guildId: string,
): Promise<boolean> {
	if (!user) return false;
	if (
		user.role === "owner" ||
		user.role === "admin" ||
		(Boolean(env.DISCORD_USER_ID) && user.discordId === env.DISCORD_USER_ID)
	) {
		return true;
	}

	if (!user.discordId) return false;

	const botToken = env.DISCORD_TOKEN;
	if (!botToken) return env.NODE_ENV === "development";

	const cacheKey = `${guildId}:${user.discordId}`;
	let member = getCachedMember(cacheKey);
	if (member === undefined) {
		member = await fetchDiscordApi<DiscordGuildMember>(
			`/guilds/${guildId}/members/${user.discordId}`,
			`Bot ${botToken}`,
		);
		setCachedMember(cacheKey, member);
	}
	if (!member) return false;

	if (member.permissions) {
		try {
			const perms = BigInt(member.permissions);
			if (
				(perms & BigInt(ADMINISTRATOR)) !== 0n ||
				(perms & BigInt(MANAGE_GUILD)) !== 0n
			) {
				return true;
			}
		} catch {
			// ignore
		}
	}

	const [config] = await db
		.select({ adminRoleIds: guildConfigs.adminRoleIds })
		.from(guildConfigs)
		.where(eq(guildConfigs.guildId, guildId));

	const targetRoleSet = new Set(config?.adminRoleIds ?? []);
	const userRoles = member.roles ?? [];
	return userRoles.some((r) => targetRoleSet.has(r));
}

export const guildRoutes = new Elysia({ prefix: "/guilds" })
	.use(authPlugin)
	// GET /v2/guilds — list guilds manageable by the current user
	.get(
		"/",
		async ({ cookie, user }) => {
			const discordMetaCookie = cookie.discord_meta?.value;
			let userAccessToken: string | null = null;

			if (discordMetaCookie) {
				try {
					if (typeof discordMetaCookie === "string") {
						const parsed = JSON.parse(discordMetaCookie) as {
							accessToken?: string;
						};
						userAccessToken = parsed.accessToken ?? null;
					} else if (
						typeof discordMetaCookie === "object" &&
						discordMetaCookie !== null
					) {
						const parsed = discordMetaCookie as { accessToken?: string };
						userAccessToken = parsed.accessToken ?? null;
					}
				} catch {
					// Fallback to null
				}
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) {
				return {
					guilds: [],
					serverTypes: await getServerTypeMappings(),
					botClientId: env.DISCORD_CLIENT_ID,
				};
			}

			const [userGuilds, botGuilds] = await Promise.all([
				userAccessToken
					? fetchDiscordApi<DiscordGuild[]>(
							"/users/@me/guilds",
							`Bearer ${userAccessToken}`,
						)
					: Promise.resolve(null),
				getBotGuilds(botToken),
			]);

			// Synchronize guild configs with live environment variables
			await reconcileTargetGuildsAndModules();

			const authorizedRows = await db
				.select({ guildId: guildConfigs.guildId })
				.from(guildConfigs)
				.where(eq(guildConfigs.authorized, true));
			const authorizedSet = new Set(authorizedRows.map((r) => r.guildId));

			const safeBotGuilds: DiscordGuild[] = botGuilds ? [...botGuilds] : [];
			const botGuildIds = new Set(safeBotGuilds.map((g) => g.id));

			const serverTypes = await getServerTypeMappings();

			// Direct lookup for authorized guilds not returned in /users/@me/guilds
			// (handles Discord REST API edge caching, pagination, and propagation delay)
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

			// Ensure all configured server types are also loaded
			for (const stId of Object.values(serverTypes)) {
				if (stId && !botGuildIds.has(stId)) {
					const directGuild = await fetchDiscordApi<DiscordGuild>(
						`/guilds/${stId}`,
						`Bot ${botToken}`,
					);
					if (directGuild) {
						safeBotGuilds.push(directGuild);
						botGuildIds.add(directGuild.id);
					}
				}
			}

			const botGuildMap = new Map(
				safeBotGuilds.map((g) => [g.id, { ...g, botInGuild: true }]),
			);

			const typeByGuildId = new Map<string, ServerType>();
			if (serverTypes.alliance)
				typeByGuildId.set(serverTypes.alliance, "alliance");
			if (serverTypes.faction)
				typeByGuildId.set(serverTypes.faction, "faction");
			if (serverTypes.elims) typeByGuildId.set(serverTypes.elims, "elims");
			if (serverTypes.owner) typeByGuildId.set(serverTypes.owner, "owner");
			if (serverTypes.merc) typeByGuildId.set(serverTypes.merc, "merc");

			// Identify user's manageable guilds where bot is NOT installed yet (for Authorize modal only)
			const uninstalledGuilds: DiscordGuild[] = [];
			if (userGuilds) {
				for (const ug of userGuilds) {
					if (!botGuildIds.has(ug.id)) {
						const perms = BigInt(ug.permissions);
						const hasAdmin = (perms & BigInt(ADMINISTRATOR)) !== 0n;
						const hasManageGuild = (perms & BigInt(MANAGE_GUILD)) !== 0n;
						if (ug.owner || hasAdmin || hasManageGuild) {
							uninstalledGuilds.push({
								...ug,
								botInGuild: false,
								manageable: true,
								authorized: authorizedSet.has(ug.id),
								userInGuild: true,
								serverType: typeByGuildId.get(ug.id) ?? null,
							});
						}
					}
				}
			}

			const isSentinelOwner = user?.role === "owner" || user?.role === "admin";

			if (isSentinelOwner) {
				const userGuildMap = new Map((userGuilds ?? []).map((g) => [g.id, g]));

				const result: Array<
					DiscordGuild & {
						botInGuild: boolean;
						manageable: boolean;
						authorized: boolean;
						userInGuild: boolean;
						serverType: ServerType | null;
					}
				> = safeBotGuilds.map((g) => ({
					...g,
					botInGuild: true,
					manageable: true,
					authorized: authorizedSet.has(g.id),
					userInGuild: userGuildMap.has(g.id),
					serverType: typeByGuildId.get(g.id) ?? null,
				}));

				// Ensure authorized guilds and server types appear with accurate botInGuild status
				const existingResultIds = new Set(result.map((r) => r.id));
				for (const row of authorizedRows) {
					if (!existingResultIds.has(row.guildId)) {
						const ug = userGuildMap.get(row.guildId);
						result.push({
							id: row.guildId,
							name: ug?.name ?? `Authorized Server (${row.guildId})`,
							icon: ug?.icon ?? null,
							owner: ug?.owner ?? false,
							permissions: ug?.permissions ?? "0",
							botInGuild: false,
							manageable: true,
							authorized: true,
							userInGuild: Boolean(ug),
							serverType: typeByGuildId.get(row.guildId) ?? null,
						});
						existingResultIds.add(row.guildId);
					}
				}

				for (const stId of Object.values(serverTypes)) {
					if (stId && !existingResultIds.has(stId)) {
						const ug = userGuildMap.get(stId);
						result.push({
							id: stId,
							name: ug?.name ?? `Server (${stId})`,
							icon: ug?.icon ?? null,
							owner: ug?.owner ?? false,
							permissions: ug?.permissions ?? "0",
							botInGuild: false,
							manageable: true,
							authorized: true,
							userInGuild: Boolean(ug),
							serverType: typeByGuildId.get(stId) ?? null,
						});
						existingResultIds.add(stId);
					}
				}

				return {
					guilds: result,
					serverTypes,
					botClientId: env.DISCORD_CLIENT_ID,
				};
			}

			const userGuildMap = new Map((userGuilds ?? []).map((g) => [g.id, g]));

			const candidateGuildIds = new Set<string>();
			for (const g of userGuilds ?? []) {
				candidateGuildIds.add(g.id);
			}
			for (const stId of Object.values(serverTypes)) {
				if (stId) candidateGuildIds.add(stId);
			}

			const nonOwnerGuilds: Array<
				DiscordGuild & {
					botInGuild: boolean;
					manageable: boolean;
					authorized: boolean;
					userInGuild: boolean;
					serverType: ServerType | null;
				}
			> = [];

			for (const guildId of candidateGuildIds) {
				const botGuild = botGuildMap.get(guildId);
				const userGuild = userGuildMap.get(guildId);
				const isDesignatedServerType = typeByGuildId.has(guildId);

				// If bot is not in the server, include if it is a designated server type with botInGuild: false
				if (!botGuild) {
					if (isDesignatedServerType) {
						nonOwnerGuilds.push({
							id: guildId,
							name: userGuild?.name ?? `Server (${guildId})`,
							icon: userGuild?.icon ?? null,
							owner: userGuild?.owner ?? false,
							permissions: userGuild?.permissions ?? "0",
							botInGuild: false,
							manageable: false,
							authorized: authorizedSet.has(guildId),
							userInGuild: Boolean(userGuild),
							serverType: typeByGuildId.get(guildId) ?? null,
						});
					}
					continue;
				}

				let userInGuild = Boolean(userGuild);
				let canManage = false;

				if (userGuild) {
					const perms = BigInt(userGuild.permissions);
					const hasDiscordAdmin =
						userGuild.owner ||
						(perms & BigInt(ADMINISTRATOR)) !== 0n ||
						(perms & BigInt(MANAGE_GUILD)) !== 0n;

					if (hasDiscordAdmin) {
						canManage = true;
					}
				}

				// If not already determined manageable by Discord OAuth permissions,
				// check configured adminRoleIds via member lookup
				if (!canManage && user?.discordId && botGuild) {
					canManage = await verifyGuildAdmin(user, guildId);
					if (canManage) {
						userInGuild = true;
					}
				}

				// Also check if member in guild even if canManage is false (for designated server type cards)
				if (!userInGuild && user?.discordId && botGuild) {
					const cacheKey = `${guildId}:${user.discordId}`;
					let member = getCachedMember(cacheKey);
					if (member === undefined) {
						member = await fetchDiscordApi<DiscordGuildMember>(
							`/guilds/${guildId}/members/${user.discordId}`,
							`Bot ${botToken}`,
						);
						setCachedMember(cacheKey, member);
					}
					if (member) {
						userInGuild = true;
					}
				}

				// For general guilds (not one of the 4 designated server types):
				// only include if the user is in the guild AND has management permissions
				if (!isDesignatedServerType && (!userInGuild || !canManage)) {
					continue;
				}

				nonOwnerGuilds.push({
					id: botGuild.id,
					name: botGuild.name,
					icon: botGuild.icon,
					owner: botGuild.owner,
					permissions: botGuild.permissions,
					botInGuild: true,
					manageable: canManage,
					authorized: authorizedSet.has(guildId),
					userInGuild,
					serverType: typeByGuildId.get(guildId) ?? null,
				});
			}

			return {
				guilds: nonOwnerGuilds,
				serverTypes,
				botClientId: env.DISCORD_CLIENT_ID,
			};
		},
		{
			detail: {
				summary: "List Guilds",
				description:
					"Returns mutual guilds where the user has administrative permissions and Sentinel is installed.",
			},
		},
	)
	// GET /server-types — Get current configured 4 server types
	.get(
		"/server-types",
		async () => {
			const serverTypes = await getServerTypeMappings();
			return { serverTypes };
		},
		{
			detail: {
				summary: "Get Server Types",
				description:
					"Retrieves the 4 designated server type mappings: alliance, faction, elims, owner.",
			},
		},
	)
	// PUT /server-types — Server types are inferred from environment variables and cannot be modified via UI
	.put(
		"/server-types",
		async ({ set }) => {
			set.status = 400;
			return {
				success: false,
				error:
					"Server types are configured via environment variables and cannot be modified via UI.",
			};
		},
		{
			body: t.Object({
				type: t.Union([
					t.Literal("alliance"),
					t.Literal("faction"),
					t.Literal("elims"),
					t.Literal("owner"),
					t.Literal("merc"),
				]),
				guildId: t.Nullable(t.String()),
			}),
			detail: {
				summary: "Set Server Type (Disabled)",
				description:
					"Server types are inferred from environment variables and cannot be modified via UI.",
			},
		},
	)
	// POST /v2/guilds/authorize — Authorize a guild and generate an invite link (Admin/Owner only)
	.post(
		"/authorize",
		async ({ body, user, set }) => {
			if (user?.role !== "owner" && user?.role !== "admin") {
				set.status = 403;
				return { error: "Only Sentinel administrators can authorize servers." };
			}

			const { guildId } = body;
			if (!guildId || !/^\d{17,20}$/.test(guildId)) {
				set.status = 400;
				return { error: "Invalid Discord Guild ID." };
			}

			await authorizeGuild(guildId);
			void syncAuthorizedGuildsViaIpc(guildId);

			const clientId = env.DISCORD_CLIENT_ID;
			const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=8&scope=bot%20applications.commands&guild_id=${guildId}&disable_guild_select=true`;

			return {
				success: true,
				guildId,
				inviteUrl,
			};
		},
		{
			body: t.Object({
				guildId: t.String(),
			}),
			detail: {
				summary: "Authorize Guild",
				description:
					"Authorizes a Discord server and returns the bot invite URL.",
			},
		},
	)
	// POST /v2/guilds/deauthorize — Deauthorize a guild (Admin/Owner only)
	.post(
		"/deauthorize",
		async ({ body, user, set }) => {
			if (user?.role !== "owner" && user?.role !== "admin") {
				set.status = 403;
				return {
					error: "Only Sentinel administrators can deauthorize servers.",
				};
			}

			const { guildId } = body;
			if (!guildId || !/^\d{17,20}$/.test(guildId)) {
				set.status = 400;
				return { error: "Invalid Discord Guild ID." };
			}

			await deauthorizeGuild(guildId);
			void deauthorizeGuildViaIpc(guildId);

			return {
				success: true,
				guildId,
			};
		},
		{
			body: t.Object({
				guildId: t.String(),
			}),
			detail: {
				summary: "Deauthorize Guild",
				description: "Deauthorizes a Discord server from Sentinel.",
			},
		},
	)
	// GET /v2/guilds/:guildId/config — get guild configuration & faction mappings
	.get(
		"/:guildId/config",
		async ({ params, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					initialized: false,
					config: null,
					factionRoleMappings: [],
					error: "Forbidden: Administrator access to this server is required.",
				};
			}

			const [config] = await db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, params.guildId));

			const mappings = await db
				.select()
				.from(factionRoleMappings)
				.where(eq(factionRoleMappings.guildId, params.guildId));

			const factionIds = Array.from(new Set(mappings.map((m) => m.factionId)));
			const factionRows =
				factionIds.length > 0
					? await db
							.select({
								id: factions.id,
								tag: factions.tag,
								tagImage: factions.tagImage,
							})
							.from(factions)
							.where(inArray(factions.id, factionIds))
					: [];

			const factionMetaMap = new Map(factionRows.map((f) => [f.id, f]));

			const enrichedMappings = mappings.map((m) => {
				const meta = factionMetaMap.get(m.factionId);
				return {
					...m,
					factionTag: meta?.tag ?? null,
					tagImage: meta?.tagImage ?? null,
				};
			});

			return {
				initialized: Boolean(config),
				config: config ?? null,
				factionRoleMappings: enrichedMappings,
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "Get Guild Config",
				description: "Returns guild configuration and faction mappings.",
			},
		},
	)
	// PUT /v2/guilds/:guildId/config — update guild configuration
	.put(
		"/:guildId/config",
		async ({ params, body, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					error: "Forbidden: Administrator access to this server is required.",
				};
			}

			const [existing] = await db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, params.guildId));

			if (!existing) {
				set.status = 403;
				return {
					error:
						"Guild is not initialized. Initialization can only be performed by a Sentinel administrator.",
				};
			}

			const hasModuleUpdates =
				body.moduleVerification !== undefined ||
				body.moduleTerritory !== undefined ||
				body.moduleReactionRoles !== undefined ||
				body.moduleMonitoring !== undefined ||
				body.moduleGiveaways !== undefined;

			if (hasModuleUpdates && user?.role !== "owner") {
				set.status = 403;
				return {
					error:
						"Only the Sentinel bot owner can enable or disable server modules.",
				};
			}

			await db
				.update(guildConfigs)
				.set({
					...(body.moduleVerification !== undefined
						? { moduleVerification: body.moduleVerification }
						: {}),
					...(body.moduleTerritory !== undefined
						? { moduleTerritory: body.moduleTerritory }
						: {}),
					...(body.moduleReactionRoles !== undefined
						? { moduleReactionRoles: body.moduleReactionRoles }
						: {}),
					...(body.moduleMonitoring !== undefined
						? { moduleMonitoring: body.moduleMonitoring }
						: {}),
					...(body.moduleGiveaways !== undefined
						? { moduleGiveaways: body.moduleGiveaways }
						: {}),
					...(body.logChannelId !== undefined
						? { logChannelId: body.logChannelId }
						: {}),
					...(body.adminRoleIds !== undefined
						? { adminRoleIds: body.adminRoleIds }
						: {}),
					...(body.verifiedRoleIds !== undefined
						? { verifiedRoleIds: body.verifiedRoleIds }
						: {}),
					...(body.nicknameTemplate !== undefined
						? { nicknameTemplate: body.nicknameTemplate }
						: {}),
					...(body.verifyOnJoin !== undefined
						? { verifyOnJoin: body.verifyOnJoin }
						: {}),
					...(body.verifyCron !== undefined
						? { verifyCron: body.verifyCron }
						: {}),
					...(body.verifyCronInterval !== undefined
						? { verifyCronInterval: body.verifyCronInterval }
						: {}),
					...(body.protectedRoleIds !== undefined
						? { protectedRoleIds: body.protectedRoleIds }
						: {}),
					...(body.factionListChannelId !== undefined
						? { factionListChannelId: body.factionListChannelId }
						: {}),
					...(body.ttFullChannelId !== undefined
						? { ttFullChannelId: body.ttFullChannelId }
						: {}),
					...(body.ttFilteredChannelId !== undefined
						? { ttFilteredChannelId: body.ttFilteredChannelId }
						: {}),
					...(body.ttTerritoryIds !== undefined
						? { ttTerritoryIds: body.ttTerritoryIds }
						: {}),
					...(body.ttFactionIds !== undefined
						? { ttFactionIds: body.ttFactionIds }
						: {}),
					...(body.mercRoleId !== undefined
						? { mercRoleId: body.mercRoleId }
						: {}),
					...(body.mercManagerRoleId !== undefined
						? { mercManagerRoleId: body.mercManagerRoleId }
						: {}),
					...(body.mercDefaultHitPrice !== undefined
						? { mercDefaultHitPrice: body.mercDefaultHitPrice }
						: {}),
					...(body.mercDefaultStrickenHitPrice !== undefined
						? { mercDefaultStrickenHitPrice: body.mercDefaultStrickenHitPrice }
						: {}),
					updatedAt: new Date(),
				})
				.where(eq(guildConfigs.guildId, params.guildId));

			if (hasModuleUpdates) {
				void syncGuildCommandsViaIpc(params.guildId);
			}

			if (body.factionListChannelId !== undefined) {
				void syncFactionMapViaIpc(params.guildId);
			}

			return { success: true };
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				moduleVerification: t.Optional(t.Boolean()),
				moduleTerritory: t.Optional(t.Boolean()),
				moduleReactionRoles: t.Optional(t.Boolean()),
				moduleMonitoring: t.Optional(t.Boolean()),
				moduleGiveaways: t.Optional(t.Boolean()),
				logChannelId: t.Optional(t.Nullable(t.String())),
				adminRoleIds: t.Optional(t.Array(t.String())),
				verifiedRoleIds: t.Optional(t.Array(t.String())),
				nicknameTemplate: t.Optional(t.Nullable(t.String())),
				verifyOnJoin: t.Optional(t.Boolean()),
				verifyCron: t.Optional(t.Boolean()),
				verifyCronInterval: t.Optional(t.Number()),
				protectedRoleIds: t.Optional(t.Array(t.String())),
				factionListChannelId: t.Optional(t.Nullable(t.String())),
				ttFullChannelId: t.Optional(t.Nullable(t.String())),
				ttFilteredChannelId: t.Optional(t.Nullable(t.String())),
				ttTerritoryIds: t.Optional(t.Array(t.String())),
				ttFactionIds: t.Optional(t.Array(t.Number())),
				mercRoleId: t.Optional(t.Nullable(t.String())),
				mercManagerRoleId: t.Optional(t.Nullable(t.String())),
				mercDefaultHitPrice: t.Optional(t.Nullable(t.Number())),
				mercDefaultStrickenHitPrice: t.Optional(t.Nullable(t.Number())),
			}),
			detail: {
				summary: "Update Guild Config",
				description:
					"Updates general settings, verification settings, or module configuration for a guild.",
			},
		},
	)
	// PATCH /v2/guilds/:guildId/modules — update guild module enablements (Bot Owner only)
	.patch(
		"/:guildId/modules",
		async ({ params, body, user, set }) => {
			if (user?.role !== "owner") {
				set.status = 403;
				return {
					error:
						"Unauthorized. Only the Sentinel bot owner can configure server modules.",
				};
			}

			const [existing] = await db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, params.guildId));

			if (!existing) {
				set.status = 404;
				return { error: "Guild configuration not found." };
			}

			const updates: Partial<{
				moduleVerification: boolean;
				moduleTerritory: boolean;
				moduleReactionRoles: boolean;
				moduleMonitoring: boolean;
				moduleGiveaways: boolean;
			}> = {};

			if (body.moduleVerification !== undefined) {
				updates.moduleVerification = body.moduleVerification;
			}
			if (body.moduleTerritory !== undefined) {
				updates.moduleTerritory = body.moduleTerritory;
			}
			if (body.moduleReactionRoles !== undefined) {
				updates.moduleReactionRoles = body.moduleReactionRoles;
			}
			if (body.moduleMonitoring !== undefined) {
				updates.moduleMonitoring = body.moduleMonitoring;
			}
			if (body.moduleGiveaways !== undefined) {
				updates.moduleGiveaways = body.moduleGiveaways;
			}

			if (Object.keys(updates).length > 0) {
				await db
					.update(guildConfigs)
					.set({ ...updates, updatedAt: new Date() })
					.where(eq(guildConfigs.guildId, params.guildId));

				void syncGuildCommandsViaIpc(params.guildId);
			}

			return {
				success: true,
				modules: {
					verification:
						updates.moduleVerification ?? existing.moduleVerification,
					territory: updates.moduleTerritory ?? existing.moduleTerritory,
					reactionRoles:
						updates.moduleReactionRoles ?? existing.moduleReactionRoles,
					monitoring: updates.moduleMonitoring ?? existing.moduleMonitoring,
					giveaways: updates.moduleGiveaways ?? existing.moduleGiveaways,
				},
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				moduleVerification: t.Optional(t.Boolean()),
				moduleTerritory: t.Optional(t.Boolean()),
				moduleReactionRoles: t.Optional(t.Boolean()),
				moduleMonitoring: t.Optional(t.Boolean()),
				moduleGiveaways: t.Optional(t.Boolean()),
			}),
			detail: {
				summary: "Update Guild Modules",
				description:
					"Toggles modules on/off for a guild. Strictly restricted to the Sentinel bot owner.",
			},
		},
	)
	// GET /v2/guilds/:guildId/keys — list registered API keys for this guild
	.get(
		"/:guildId/keys",
		async ({ params, query, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					error: "Forbidden: Administrator access to this server is required.",
				};
			}

			const keys = await db
				.select({
					id: guildApiKeys.id,
					guildId: guildApiKeys.guildId,
					tornId: guildApiKeys.tornId,
					tornName: guildApiKeys.tornName,
					isValid: guildApiKeys.isValid,
					invalidCount: guildApiKeys.invalidCount,
					lastInvalidAt: guildApiKeys.lastInvalidAt,
					lastUsedAt: guildApiKeys.lastUsedAt,
					donatedByDiscordId: guildApiKeys.donatedByDiscordId,
					donatedByDiscordTag: guildApiKeys.donatedByDiscordTag,
					createdAt: guildApiKeys.createdAt,
				})
				.from(guildApiKeys)
				.where(eq(guildApiKeys.guildId, params.guildId))
				.orderBy(desc(guildApiKeys.createdAt));

			const serverTypes = await getServerTypeMappings();
			const requestedType = query?.type;
			const isMerc =
				requestedType === "merc" ||
				(Boolean(serverTypes.merc && params.guildId === serverTypes.merc) &&
					serverTypes.faction !== params.guildId &&
					requestedType !== "faction");

			let mercKeysState: Record<
				string,
				{
					keyId?: string;
					factionId?: number;
					factionName?: string;
					tornId?: number;
					tornName?: string;
				}
			> = {};

			if (isMerc) {
				const [stateRow] = await db
					.select()
					.from(systemStates)
					.where(eq(systemStates.id, `merc:master_keys:${params.guildId}`));
				if (stateRow?.data && typeof stateRow.data === "object") {
					mercKeysState = stateRow.data as typeof mercKeysState;
				}
			}

			const enrichedKeys = keys.map((k) => {
				if (!isMerc) return k;

				let factionId: number | null = null;
				let factionName: string | null = null;

				for (const info of Object.values(mercKeysState)) {
					if (info?.keyId === k.id) {
						factionId = info.factionId ?? null;
						factionName = info.factionName ?? null;
						break;
					}
				}

				if (!factionId && k.donatedByDiscordTag) {
					const match = k.donatedByDiscordTag.match(/\[Faction\s+(\d+)\]/);
					if (match?.[1]) {
						factionId = Number(match[1]);
						factionName =
							factionId === 2013
								? "Subversive  Alliance"
								: factionId === 27312
									? "SA Succession"
									: null;
					}
				}

				return {
					...k,
					factionId,
					factionName,
				};
			});

			return { keys: enrichedKeys, isMerc };
		},
		{
			params: t.Object({ guildId: t.String() }),
			query: t.Optional(t.Object({ type: t.Optional(t.String()) })),
			detail: {
				summary: "List Guild API Keys",
				description:
					"Returns all Torn API keys registered for the specified guild.",
			},
		},
	)
	// POST /v2/guilds/:guildId/keys — add an API key for this guild
	.post(
		"/:guildId/keys",
		async ({ params, body, query, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					error: "Forbidden: Administrator access to this server is required.",
				};
			}

			const trimmedKey = body.apiKey.trim();
			if (!isValidApiKey(trimmedKey)) {
				set.status = 400;
				return {
					error:
						"Invalid Torn API key format. Must be a 16-character alphanumeric string.",
				};
			}

			const serverTypes = await getServerTypeMappings();
			const requestedType = body.serverType || query?.type;
			const isMerc =
				requestedType === "merc" ||
				(Boolean(serverTypes.merc && params.guildId === serverTypes.merc) &&
					serverTypes.faction !== params.guildId &&
					requestedType !== "faction");

			const pepper = process.env.API_KEY_HASH_PEPPER ?? "";
			const keyHash = hashApiKey(trimmedKey, pepper);

			const [existingKey] = await db
				.select()
				.from(guildApiKeys)
				.where(
					and(
						eq(guildApiKeys.guildId, params.guildId),
						eq(guildApiKeys.apiKeyHash, keyHash),
					),
				);

			if (existingKey) {
				set.status = 400;
				return {
					error: "This API key has already been added to this server.",
				};
			}

			let tornUserId: number | null = null;
			let playerName = "Unknown";
			let playerFactionId: number | null = null;
			let playerFactionName = "Unknown Faction";

			try {
				const client = new TornApiClient();
				const profile = await client.getRaw<{
					player_id?: number;
					name?: string;
					faction?: { faction_id?: number; faction_name?: string };
				}>("user/", {
					apiKey: trimmedKey,
					queryParams: { selections: "profile" },
				});
				tornUserId = profile?.player_id ?? null;
				playerName = profile?.name ?? `Player ${tornUserId}`;
				playerFactionId = profile?.faction?.faction_id ?? null;
				playerFactionName = profile?.faction?.faction_name ?? "Unknown Faction";

				if (!tornUserId) {
					set.status = 400;
					return {
						error: "Failed to extract valid Torn Player ID from Torn API key.",
					};
				}

				if (isMerc) {
					const ALLOWED_MERC_FACTIONS = [2013, 27312];
					if (
						!playerFactionId ||
						!ALLOWED_MERC_FACTIONS.includes(playerFactionId)
					) {
						set.status = 400;
						return {
							error: `API key belongs to ${playerFactionName} [${playerFactionId ?? "None"}]. Mercenary guild keys must belong to family factions 2013 (Subversive Alliance) or 27312 (SA Succession).`,
						};
					}

					// Verify /faction/attacks endpoint
					try {
						await client.getRaw("faction/", {
							apiKey: trimmedKey,
							queryParams: { selections: "attacks" },
						});
					} catch (attackErr) {
						const attackMsg =
							attackErr instanceof Error
								? attackErr.message
								: "Key lacks faction attack log permissions.";
						set.status = 400;
						return {
							error: `Torn API Verification Failed for /faction/attacks: ${attackMsg}`,
						};
					}
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Torn API verification failed.";
				set.status = 400;
				return {
					error: `Torn API Verification Failed: ${errorMessage}`,
				};
			}

			if (isMerc && playerFactionId) {
				const stateKey = `merc:master_keys:${params.guildId}`;
				const [stateRow] = await db
					.select()
					.from(systemStates)
					.where(eq(systemStates.id, stateKey));
				const existingMap =
					(stateRow?.data as Record<string, { keyId?: string }>) ?? {};
				if (existingMap[String(playerFactionId)]) {
					set.status = 400;
					return {
						error: `A master API key for faction ${playerFactionId} (${playerFactionName}) is already registered. Only 1 master key per faction is permitted. Remove the existing key first to replace it.`,
					};
				}
			}

			const masterKey = process.env.ENCRYPTION_KEY ?? "";
			const keyEncrypted = encryptApiKey(trimmedKey, masterKey);

			const donatedTag =
				isMerc && playerFactionId
					? `[Faction ${playerFactionId}] ${user?.username ?? "Dashboard Admin"}`
					: (user?.username ?? "Dashboard Admin");

			const [inserted] = await db
				.insert(guildApiKeys)
				.values({
					guildId: params.guildId,
					tornId: tornUserId,
					tornName: playerName,
					apiKeyEncrypted: keyEncrypted,
					apiKeyHash: keyHash,
					isValid: true,
					invalidCount: 0,
					donatedByDiscordId: user?.discordId ?? null,
					donatedByDiscordTag: donatedTag,
				})
				.returning({
					id: guildApiKeys.id,
					tornId: guildApiKeys.tornId,
					tornName: guildApiKeys.tornName,
					isValid: guildApiKeys.isValid,
					donatedByDiscordId: guildApiKeys.donatedByDiscordId,
					donatedByDiscordTag: guildApiKeys.donatedByDiscordTag,
					createdAt: guildApiKeys.createdAt,
				});

			if (isMerc && playerFactionId && inserted) {
				const stateKey = `merc:master_keys:${params.guildId}`;
				const [stateRow] = await db
					.select()
					.from(systemStates)
					.where(eq(systemStates.id, stateKey));
				const currentMap = (stateRow?.data as Record<string, unknown>) ?? {};
				const updatedMap = {
					...currentMap,
					[String(playerFactionId)]: {
						keyId: inserted.id,
						factionId: playerFactionId,
						factionName: playerFactionName,
						tornId: tornUserId,
						tornName: playerName,
					},
				};
				await db
					.insert(systemStates)
					.values({
						id: stateKey,
						init: true,
						data: updatedMap,
					})
					.onConflictDoUpdate({
						target: systemStates.id,
						set: { data: updatedMap, updatedAt: new Date() },
					});
			}

			return {
				success: true,
				key: {
					...inserted,
					factionId: playerFactionId,
					factionName: playerFactionName,
				},
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				apiKey: t.String(),
				serverType: t.Optional(t.String()),
			}),
			query: t.Optional(t.Object({ type: t.Optional(t.String()) })),
			detail: {
				summary: "Register Guild API Key",
				description:
					"Validates and securely encrypts a Torn API key for the guild.",
			},
		},
	)
	// DELETE /v2/guilds/:guildId/keys/:keyId — remove an API key from this guild
	.delete(
		"/:guildId/keys/:keyId",
		async ({ params, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					error: "Forbidden: Administrator access to this server is required.",
				};
			}

			const [deleted] = await db
				.delete(guildApiKeys)
				.where(
					and(
						eq(guildApiKeys.id, params.keyId),
						eq(guildApiKeys.guildId, params.guildId),
					),
				)
				.returning({ id: guildApiKeys.id });

			if (!deleted) {
				set.status = 404;
				return { error: "API key not found." };
			}

			const serverTypes = await getServerTypeMappings();
			if (serverTypes.merc && params.guildId === serverTypes.merc) {
				const stateKey = `merc:master_keys:${params.guildId}`;
				const [stateRow] = await db
					.select()
					.from(systemStates)
					.where(eq(systemStates.id, stateKey));
				if (stateRow?.data && typeof stateRow.data === "object") {
					const map = {
						...(stateRow.data as Record<string, { keyId?: string }>),
					};
					for (const [fId, val] of Object.entries(map)) {
						if (val?.keyId === params.keyId) {
							delete map[fId];
						}
					}
					await db
						.update(systemStates)
						.set({ data: map, updatedAt: new Date() })
						.where(eq(systemStates.id, stateKey));
				}
			}

			return { success: true, id: deleted.id };
		},
		{
			params: t.Object({
				guildId: t.String(),
				keyId: t.String(),
			}),
			detail: {
				summary: "Delete Guild API Key",
				description: "Removes a Torn API key from the guild key vault.",
			},
		},
	)
	// POST /v2/guilds/:guildId/faction-mappings — create faction role mapping
	.post(
		"/:guildId/faction-mappings",
		async ({ params, body, set }) => {
			if (!body.factionId || body.factionId <= 0) {
				set.status = 400;
				return { error: "Invalid faction ID." };
			}

			const [existingConfig] = await db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, params.guildId));

			if (!existingConfig) {
				set.status = 403;
				return {
					error:
						"Guild is not initialized. Initialization can only be performed by a Sentinel administrator.",
				};
			}

			const newId = crypto.randomUUID();
			await db.insert(factionRoleMappings).values({
				id: newId,
				guildId: params.guildId,
				factionId: body.factionId,
				factionName: body.factionName ?? null,
				memberRoleIds: body.memberRoleIds ?? [],
				leaderRoleIds: body.leaderRoleIds ?? [],
				enabled: true,
			});

			const [created] = await db
				.select()
				.from(factionRoleMappings)
				.where(eq(factionRoleMappings.id, newId));

			return { success: true, mapping: created };
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				factionId: t.Number(),
				factionName: t.Optional(t.Nullable(t.String())),
				memberRoleIds: t.Optional(t.Array(t.String())),
				leaderRoleIds: t.Optional(t.Array(t.String())),
			}),
			detail: {
				summary: "Create Faction Role Mapping",
				description: "Adds a new faction role mapping for a guild.",
			},
		},
	)
	// PUT /v2/guilds/:guildId/faction-mappings/:mappingId — update mapping
	.put(
		"/:guildId/faction-mappings/:mappingId",
		async ({ params, body }) => {
			await db
				.update(factionRoleMappings)
				.set({
					...(body.factionId !== undefined
						? { factionId: body.factionId }
						: {}),
					...(body.factionName !== undefined
						? { factionName: body.factionName }
						: {}),
					memberRoleIds: body.memberRoleIds ?? [],
					leaderRoleIds: body.leaderRoleIds ?? [],
					updatedAt: new Date(),
				})
				.where(eq(factionRoleMappings.id, params.mappingId));

			const [updated] = await db
				.select()
				.from(factionRoleMappings)
				.where(eq(factionRoleMappings.id, params.mappingId));

			return { success: true, mapping: updated };
		},
		{
			params: t.Object({
				guildId: t.String(),
				mappingId: t.String(),
			}),
			body: t.Object({
				factionId: t.Optional(t.Number()),
				factionName: t.Optional(t.Nullable(t.String())),
				memberRoleIds: t.Array(t.String()),
				leaderRoleIds: t.Array(t.String()),
			}),
			detail: {
				summary: "Update Faction Role Mapping",
				description: "Updates role mappings for a faction in a guild.",
			},
		},
	)
	// DELETE /v2/guilds/:guildId/faction-mappings/:mappingId — delete mapping
	.delete(
		"/:guildId/faction-mappings/:mappingId",
		async ({ params }) => {
			await db
				.delete(factionRoleMappings)
				.where(eq(factionRoleMappings.id, params.mappingId));

			return { success: true };
		},
		{
			params: t.Object({
				guildId: t.String(),
				mappingId: t.String(),
			}),
			detail: {
				summary: "Delete Faction Role Mapping",
				description: "Deletes a faction role mapping for a guild.",
			},
		},
	)
	// GET /v2/guilds/:guildId/factions/:factionId — resolve faction details
	.get(
		"/:guildId/factions/:factionId",
		async ({ params, set }) => {
			const factionIdNum = Number.parseInt(params.factionId, 10);
			if (Number.isNaN(factionIdNum) || factionIdNum <= 0) {
				set.status = 400;
				return { error: "Invalid faction ID." };
			}

			// 1. Check local DB
			const [existing] = await db
				.select({
					id: factions.id,
					name: factions.name,
					tag: factions.tag,
					tagImage: factions.tagImage,
					updatedAt: factions.updatedAt,
				})
				.from(factions)
				.where(eq(factions.id, factionIdNum));

			const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
			const isStale =
				!existing ||
				Date.now() - new Date(existing.updatedAt).getTime() >
					TWENTY_FOUR_HOURS_MS;

			if (!isStale && existing) {
				return {
					faction: {
						id: existing.id,
						name: existing.name,
						tag: existing.tag,
						tagImage: existing.tagImage,
					},
				};
			}

			// 2. Fetch from Torn API using centralized key pool
			try {
				const { tornApi } = await import("@sentinel/torn-api");
				const basic = await tornApi.getRaw<{
					name?: string;
					tag?: string;
					tag_image?: string;
				}>(`faction/${factionIdNum}`, {
					queryParams: { selections: "basic" },
				});

				if (!basic?.name) {
					if (existing) {
						return {
							faction: {
								id: existing.id,
								name: existing.name,
								tag: existing.tag,
								tagImage: existing.tagImage,
							},
						};
					}
					set.status = 404;
					return { error: "Faction not found on Torn." };
				}

				const name = basic.name ?? `Faction ${factionIdNum}`;
				const tag = basic.tag ?? null;
				const tagImage = basic.tag_image ?? null;

				if (existing) {
					await db
						.update(factions)
						.set({
							name,
							tag,
							tagImage,
							updatedAt: new Date(),
						})
						.where(eq(factions.id, factionIdNum));
				} else {
					await db.insert(factions).values({
						id: factionIdNum,
						name,
						tag,
						tagImage,
					});
				}

				return {
					faction: {
						id: factionIdNum,
						name,
						tag,
						tagImage,
					},
				};
			} catch {
				if (existing) {
					return {
						faction: {
							id: existing.id,
							name: existing.name,
							tag: existing.tag,
							tagImage: existing.tagImage,
						},
					};
				}
				set.status = 404;
				return { error: "Faction not found and Torn API request failed." };
			}
		},
		{
			params: t.Object({
				guildId: t.String(),
				factionId: t.String(),
			}),
			detail: {
				summary: "Lookup Faction",
				description:
					"Resolves a faction ID to name and tag using database or Torn API.",
			},
		},
	)
	// GET /v2/guilds/:guildId/verification-logs — list verification execution history
	.get(
		"/:guildId/verification-logs",
		async ({ params, query }) => {
			const guildId = params.guildId;
			const page = Math.max(1, Number(query.page) || 1);
			const limit = Math.min(100, Math.max(1, Number(query.limit) || 15));
			const offset = (page - 1) * limit;

			const conditions = [eq(verificationLogs.guildId, guildId)];

			if (query.status && query.status !== "all") {
				conditions.push(eq(verificationLogs.status, query.status));
			}

			if (query.trigger && query.trigger !== "all") {
				conditions.push(eq(verificationLogs.triggeredBy, query.trigger));
			}

			if (query.search?.trim()) {
				const searchTerm = `%${query.search.trim()}%`;
				const searchCondition = or(
					ilike(verificationLogs.discordId, searchTerm),
					ilike(verificationLogs.oldNickname, searchTerm),
					ilike(verificationLogs.newNickname, searchTerm),
					ilike(verifiedUsers.tornName, searchTerm),
				);
				if (searchCondition) {
					conditions.push(searchCondition);
				}
			}

			const whereClause = and(...conditions);

			// Count total matching records
			const countResult = await db
				.select({ value: count() })
				.from(verificationLogs)
				.leftJoin(
					verifiedUsers,
					eq(verificationLogs.discordId, verifiedUsers.discordId),
				)
				.where(whereClause);

			const total = Number(countResult[0]?.value ?? 0);
			const totalPages = Math.ceil(total / limit) || 1;

			// Fetch paginated records joined with verifiedUsers
			const rows = await db
				.select({
					id: verificationLogs.id,
					guildId: verificationLogs.guildId,
					discordId: verificationLogs.discordId,
					status: verificationLogs.status,
					triggeredBy: verificationLogs.triggeredBy,
					rolesAdded: verificationLogs.rolesAdded,
					rolesRemoved: verificationLogs.rolesRemoved,
					oldNickname: verificationLogs.oldNickname,
					newNickname: verificationLogs.newNickname,
					error: verificationLogs.error,
					createdAt: verificationLogs.createdAt,
					tornId: verifiedUsers.tornId,
					tornName: verifiedUsers.tornName,
					factionTag: verifiedUsers.factionTag,
				})
				.from(verificationLogs)
				.leftJoin(
					verifiedUsers,
					eq(verificationLogs.discordId, verifiedUsers.discordId),
				)
				.where(whereClause)
				.orderBy(desc(verificationLogs.createdAt))
				.limit(limit)
				.offset(offset);

			return {
				logs: rows,
				pagination: {
					page,
					limit,
					total,
					totalPages,
				},
			};
		},
		{
			params: t.Object({
				guildId: t.String(),
			}),
			query: t.Object({
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
				status: t.Optional(t.String()),
				trigger: t.Optional(t.String()),
				search: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Verification Logs",
				description:
					"Returns paginated verification execution history for a guild with joined user identity context.",
			},
		},
	)
	// GET /v2/guilds/:guildId/channels — fetch channels from Discord API
	.get(
		"/:guildId/channels",
		async ({ params, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return { channels: [] };
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) return { channels: [] };

			const channels = await fetchDiscordApi<DiscordChannel[]>(
				`/guilds/${params.guildId}/channels`,
				`Bot ${botToken}`,
			);

			return { channels: channels ?? [] };
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "Guild Channels",
				description: "Returns text channels for a guild using the bot token.",
			},
		},
	)
	// GET /v2/guilds/:guildId/merc/channels — fetch mercenary channel settings & channel names
	.get(
		"/:guildId/merc/channels",
		async ({ params, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					config: {
						contractCreation: null,
						upcomingContracts: null,
						targets: null,
						mercLog: null,
						updatedAt: null,
						updatedBy: null,
					},
					channelNames: [],
					error: "Forbidden: Administrator access to this server is required.",
				};
			}

			const config = await getMercChannelConfig(params.guildId);

			const botToken = env.DISCORD_TOKEN;
			let channelNames: string[] = [];
			let categoryNames: string[] = [];
			let categories: Array<{ id: string; name: string }> = [];

			if (botToken) {
				const channels = await fetchDiscordApi<DiscordChannel[]>(
					`/guilds/${params.guildId}/channels`,
					`Bot ${botToken}`,
				);

				if (channels && Array.isArray(channels)) {
					const uniqueNames = new Set(
						channels
							.filter((c) => c.type === 0 || c.type === 5)
							.map((c) => c.name)
							.filter(Boolean),
					);
					channelNames = Array.from(uniqueNames).sort((a, b) =>
						a.localeCompare(b),
					);

					const categoryList = channels
						.filter((c) => c.type === 4 && Boolean(c.name))
						.map((c) => ({ id: c.id, name: c.name }));
					categories = categoryList.sort((a, b) =>
						a.name.localeCompare(b.name),
					);
					categoryNames = Array.from(new Set(categories.map((c) => c.name)));
				}
			}

			return {
				config,
				channelNames,
				categoryNames,
				categories,
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "Mercenary Channels Configuration",
				description:
					"Returns configured contract creation, upcoming contracts, targets, merc log, and categories alongside available guild channel names.",
			},
		},
	)
	// PUT /v2/guilds/:guildId/merc/channels — update mercenary channel settings
	.put(
		"/:guildId/merc/channels",
		async ({ params, body, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					error: "Forbidden: Administrator access to this server is required.",
				};
			}

			const updated = await updateMercChannelConfig(
				params.guildId,
				{
					contractCreation: body.contractCreation,
					upcomingContracts: body.upcomingContracts,
					targets: body.targets,
					mercLog: body.mercLog,
					clientCategory: body.clientCategory,
					archiveCategory: body.archiveCategory,
				},
				user?.username ?? "admin",
			);

			// Synchronize permanent contract creation embed in Discord
			void notifyBotAction("sync_merc_contract_creation", {
				guildId: params.guildId,
			});

			return {
				success: true,
				config: updated,
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				contractCreation: t.Optional(t.Nullable(t.String())),
				upcomingContracts: t.Optional(t.Nullable(t.String())),
				targets: t.Optional(t.Nullable(t.String())),
				mercLog: t.Optional(t.Nullable(t.String())),
				clientCategory: t.Optional(t.Nullable(t.String())),
				archiveCategory: t.Optional(t.Nullable(t.String())),
			}),
			detail: {
				summary: "Update Mercenary Channels Configuration",
				description:
					"Updates designated channel names for contract creation, upcoming contracts, targets, merc log, client category, and archive category.",
			},
		},
	)
	// GET /v2/guilds/:guildId/merc/contracts — list mercenary contracts
	.get(
		"/:guildId/merc/contracts",
		async ({ params, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					contracts: [],
					error: "Forbidden: Administrator access required.",
				};
			}

			const contracts = await getMercContracts(params.guildId);
			return { contracts };
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "List Mercenary Contracts",
				description:
					"Returns all past, upcoming, and active mercenary contracts for this guild.",
			},
		},
	)
	// POST /v2/guilds/:guildId/merc/contracts — create a new mercenary contract
	.post(
		"/:guildId/merc/contracts",
		async ({ params, body, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return { error: "Forbidden: Administrator access required." };
			}

			const contract = await createMercContract(
				params.guildId,
				{
					factionId: body.factionId,
					factionName: body.factionName,
					warStatusAtCreation: body.warStatusAtCreation,
					warId: body.warId ?? null,
					warStart: body.warStart ?? null,
					warEnd: body.warEnd ?? null,
					warTarget: body.warTarget ?? null,
					warOpponent: body.warOpponent ?? null,
					startTime: body.startTime,
					startImmediately: body.startImmediately ?? false,
					startMinutesBeforeWar: body.startMinutesBeforeWar ?? null,
					endTime: body.endTime ?? null,
					endOnWarEnd: body.endOnWarEnd ?? false,
					terms: {
						...body.terms,
					},
					hitPrice: body.hitPrice ?? 3_000_000,
					strickenHitPrice:
						body.strickenHitPrice ??
						(body.terms?.strickenHits ? 4_000_000 : null),
					changeTermsOnWarStart: body.changeTermsOnWarStart ?? false,
					warStartTerms: body.warStartTerms
						? {
								...body.warStartTerms,
							}
						: null,
					warStartHitPrice: body.warStartHitPrice ?? null,
					warStartStrickenHitPrice: body.warStartStrickenHitPrice ?? null,
				},
				user?.username ?? "admin",
			);

			// If Upcoming Contracts channel is configured, announce contract via bot IPC
			const channelConfig = await getMercChannelConfig(params.guildId);
			if (channelConfig.upcomingContracts) {
				const [gConfig] = await db
					.select({ mercRoleId: guildConfigs.mercRoleId })
					.from(guildConfigs)
					.where(eq(guildConfigs.guildId, params.guildId));

				void notifyBotAction("post_merc_contract_announcement", {
					guildId: params.guildId,
					channelName: channelConfig.upcomingContracts,
					contract,
					mercRoleId: gConfig?.mercRoleId ?? null,
				});
			}

			const baseUrl =
				process.env.DASHBOARD_URL ||
				(process.env.NODE_ENV === "production"
					? "https://dashboard.blasted-labs.tech"
					: "http://localhost:3000");

			const receiptUrl = `${baseUrl}/#/merc/receipt/${contract.id}`;

			return {
				success: true,
				contract,
				receiptUrl,
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				factionId: t.Number(),
				factionName: t.String(),
				warStatusAtCreation: t.Union([
					t.Literal("no_war"),
					t.Literal("upcoming"),
					t.Literal("active"),
				]),
				warId: t.Optional(t.Nullable(t.Number())),
				warStart: t.Optional(t.Nullable(t.Number())),
				warEnd: t.Optional(t.Nullable(t.Number())),
				warTarget: t.Optional(t.Nullable(t.Number())),
				warOpponent: t.Optional(
					t.Nullable(
						t.Object({
							id: t.Number(),
							name: t.String(),
						}),
					),
				),
				startTime: t.String(),
				startImmediately: t.Optional(t.Boolean()),
				startMinutesBeforeWar: t.Optional(t.Nullable(t.Number())),
				endTime: t.Optional(t.Nullable(t.String())),
				endOnWarEnd: t.Optional(t.Boolean()),
				terms: t.Object({
					statuses: t.Object({
						online: t.Boolean(),
						idle: t.Boolean(),
						offline: t.Boolean(),
					}),
					idleDurationMinutes: t.Nullable(t.Number()),
					strickenHits: t.Boolean(),
					levelRange: t.Tuple([t.Number(), t.Number()]),
				}),
				hitPrice: t.Optional(t.Number()),
				strickenHitPrice: t.Optional(t.Nullable(t.Number())),
				changeTermsOnWarStart: t.Optional(t.Boolean()),
				warStartTerms: t.Optional(
					t.Nullable(
						t.Object({
							statuses: t.Object({
								online: t.Boolean(),
								idle: t.Boolean(),
								offline: t.Boolean(),
							}),
							idleDurationMinutes: t.Nullable(t.Number()),
							strickenHits: t.Boolean(),
							levelRange: t.Tuple([t.Number(), t.Number()]),
						}),
					),
				),
				warStartHitPrice: t.Optional(t.Nullable(t.Number())),
				warStartStrickenHitPrice: t.Optional(t.Nullable(t.Number())),
			}),
			detail: {
				summary: "Create Mercenary Contract",
				description:
					"Creates a new mercenary contract with target filtering rules.",
			},
		},
	)
	// PUT /v2/guilds/:guildId/merc/contracts/:contractId — update contract
	.put(
		"/:guildId/merc/contracts/:contractId",
		async ({ params, body, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return { error: "Forbidden: Administrator access required." };
			}

			const isEnding =
				body.status === "completed" || body.status === "cancelled";
			const updated = await updateMercContract(
				params.guildId,
				params.contractId,
				{
					...body,
					...(isEnding ? { endTime: new Date().toISOString() } : {}),
				},
			);

			if (!updated) {
				set.status = 404;
				return { error: "Contract not found." };
			}

			// If contract was ended/completed and mercLog is configured, generate and post summary with CSVs
			if (isEnding) {
				const channelConfig = await getMercChannelConfig(params.guildId);
				if (channelConfig.mercLog && body.status === "completed") {
					const summary = await getMercContractSummary(params.contractId);
					void notifyBotAction("post_merc_contract_end_summary", {
						guildId: params.guildId,
						channelName: channelConfig.mercLog,
						contract: updated,
						summary,
					});
				}

				// Auto-delete respective announcement embed in upcoming contracts channel
				void notifyBotAction("delete_merc_upcoming_announcement", {
					guildId: params.guildId,
					contractId: params.contractId,
					factionId: updated.factionId,
					messageId: updated.upcomingMessageId ?? undefined,
				});
			}

			return { success: true, contract: updated };
		},
		{
			params: t.Object({
				guildId: t.String(),
				contractId: t.String(),
			}),
			body: t.Object({
				status: t.Optional(
					t.Union([
						t.Literal("active"),
						t.Literal("upcoming"),
						t.Literal("completed"),
						t.Literal("cancelled"),
					]),
				),
			}),
			detail: {
				summary: "Update Mercenary Contract",
				description:
					"Updates an existing mercenary contract's status or details.",
			},
		},
	)
	// DELETE /v2/guilds/:guildId/merc/contracts/:contractId — delete contract
	.delete(
		"/:guildId/merc/contracts/:contractId",
		async ({ params, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return { error: "Forbidden: Administrator access required." };
			}

			const existing = await getMercContracts(params.guildId);
			const targetContract = existing.find((c) => c.id === params.contractId);

			const ok = await deleteMercContract(params.guildId, params.contractId);
			if (!ok) {
				set.status = 404;
				return { error: "Contract not found." };
			}

			if (targetContract) {
				void notifyBotAction("delete_merc_upcoming_announcement", {
					guildId: params.guildId,
					contractId: params.contractId,
					factionId: targetContract.factionId,
					messageId: targetContract.upcomingMessageId ?? undefined,
				});
			}

			return { success: true };
		},
		{
			params: t.Object({
				guildId: t.String(),
				contractId: t.String(),
			}),
			detail: {
				summary: "Delete Mercenary Contract",
				description: "Deletes a mercenary contract by ID.",
			},
		},
	)
	// GET /v2/guilds/:guildId/merc/factions/validate — validate faction ID & detect war status
	.get(
		"/:guildId/merc/factions/validate",
		async ({ params, query, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return {
					valid: false,
					error: "Forbidden: Administrator access required.",
				};
			}

			const factionIdNum = Number.parseInt(query.factionId ?? "", 10);
			if (Number.isNaN(factionIdNum) || factionIdNum <= 0) {
				set.status = 400;
				return {
					valid: false,
					error: "Please provide a valid numeric Faction ID.",
				};
			}

			const keyObj = await getNextSubversiveUserKey();
			const apiKey = keyObj?.apiKey ?? process.env.TORN_API_KEY;

			if (!apiKey) {
				set.status = 503;
				return {
					valid: false,
					error:
						"No active Torn API key available in subversive pool or environment.",
				};
			}

			try {
				const tornUrl = new URL("https://api.torn.com/v2/faction");
				tornUrl.searchParams.set("id", String(factionIdNum));
				tornUrl.searchParams.set("selections", "basic,rankedwars");
				tornUrl.searchParams.set("key", apiKey);
				tornUrl.searchParams.set("comment", "SentinelMerc");

				const response = await fetch(tornUrl.toString(), {
					headers: {
						Authorization: `ApiKey ${apiKey}`,
					},
					signal: AbortSignal.timeout(10_000),
				});

				if (!response.ok) {
					return {
						valid: false,
						error: `Torn API request failed with status ${response.status}`,
					};
				}

				const data = (await response.json()) as Record<string, unknown>;

				if (data.error && typeof data.error === "object") {
					const err = data.error as { code?: number; error?: string };
					if (
						keyObj &&
						(err.code === 2 || err.code === 13 || err.code === 10)
					) {
						markSubversiveKeyDisabled(keyObj.apiKey, err.code);
					}
					return {
						valid: false,
						error:
							err.error ?? "Failed to fetch faction information from Torn.",
					};
				}

				if (keyObj) {
					recordSubversiveKeySuccess(keyObj.apiKey);
				}

				const basic =
					(data.basic as Record<string, unknown> | undefined) ?? data;
				const factionName =
					typeof basic.name === "string" && basic.name
						? basic.name
						: `Faction ${factionIdNum}`;
				const tag = typeof basic.tag === "string" ? basic.tag : null;

				// Parse ranked wars
				interface ParsedWar {
					id: number;
					start: number;
					end: number | null;
					target: number;
					winner: number | null;
					factions: Array<{ id: number; name: string }>;
				}

				const parsedWars: ParsedWar[] = [];

				const rawRanked =
					data.rankedwars ??
					(data.wars as Record<string, unknown> | undefined)?.ranked ??
					data.warfareranked;

				if (Array.isArray(rawRanked)) {
					for (const item of rawRanked) {
						if (typeof item === "object" && item !== null) {
							const w = item as Record<string, unknown>;
							const id = Number(w.id ?? w.war_id ?? 0);
							const start = Number(w.start ?? 0);
							const end =
								w.end !== null && w.end !== undefined ? Number(w.end) : null;
							const target = Number(w.target ?? 0);
							const winner =
								w.winner !== null && w.winner !== undefined
									? Number(w.winner)
									: null;
							const facs = Array.isArray(w.factions)
								? (w.factions as Array<{ id: number; name: string }>)
								: [];
							parsedWars.push({
								id,
								start,
								end,
								target,
								winner,
								factions: facs,
							});
						}
					}
				} else if (typeof rawRanked === "object" && rawRanked !== null) {
					for (const [key, val] of Object.entries(rawRanked)) {
						if (typeof val === "object" && val !== null) {
							const v = val as Record<string, unknown>;
							const innerWar =
								(v.war as Record<string, unknown> | undefined) ?? v;
							const id = Number(innerWar.id ?? key);
							const start = Number(innerWar.start ?? 0);
							const end =
								innerWar.end !== null && innerWar.end !== undefined
									? Number(innerWar.end)
									: null;
							const target = Number(innerWar.target ?? 0);
							const winner =
								innerWar.winner !== null && innerWar.winner !== undefined
									? Number(innerWar.winner)
									: null;
							let facs: Array<{ id: number; name: string }> = [];
							if (Array.isArray(v.factions)) {
								facs = v.factions as Array<{ id: number; name: string }>;
							} else if (
								typeof v.factions === "object" &&
								v.factions !== null
							) {
								facs = Object.entries(v.factions).map(([fId, fObj]) => ({
									id: Number(fId),
									name:
										typeof (fObj as { name?: string }).name === "string"
											? (fObj as { name: string }).name
											: `Faction ${fId}`,
								}));
							}
							parsedWars.push({
								id,
								start,
								end,
								target,
								winner,
								factions: facs,
							});
						}
					}
				}

				const nowSec = Math.floor(Date.now() / 1000);

				// Active war: start <= nowSec and end is not reached and no winner
				const activeWar = parsedWars.find(
					(w) =>
						w.start <= nowSec &&
						(!w.end || w.end === 0 || w.end > nowSec) &&
						(!w.winner || w.winner === 0),
				);

				// Upcoming war: start > nowSec and no winner
				const upcomingWar = parsedWars
					.filter((w) => w.start > nowSec && (!w.winner || w.winner === 0))
					.sort((a, b) => a.start - b.start)[0];

				let warStatus: "no_war" | "upcoming" | "active" = "no_war";
				let selectedWar: ParsedWar | null = null;

				if (activeWar) {
					warStatus = "active";
					selectedWar = activeWar;
				} else if (upcomingWar) {
					warStatus = "upcoming";
					selectedWar = upcomingWar;
				}

				let opponent: { id: number; name: string } | null = null;
				if (selectedWar && selectedWar.factions.length > 0) {
					const opp = selectedWar.factions.find((f) => f.id !== factionIdNum);
					if (opp) {
						opponent = { id: opp.id, name: opp.name };
					}
				}

				return {
					valid: true,
					faction: {
						id: factionIdNum,
						name: factionName,
						tag,
					},
					warStatus,
					war: selectedWar
						? {
								id: selectedWar.id,
								start: selectedWar.start,
								end: selectedWar.end,
								target: selectedWar.target,
								opponent,
							}
						: null,
				};
			} catch (err) {
				return {
					valid: false,
					error:
						err instanceof Error
							? err.message
							: "Failed to validate faction ID.",
				};
			}
		},
		{
			params: t.Object({ guildId: t.String() }),
			query: t.Object({
				factionId: t.Optional(t.String()),
			}),
			detail: {
				summary: "Validate Faction for Mercenary Contract",
				description:
					"Validates faction ID via Torn API basic & rankedwars selections, detecting active or upcoming war status.",
			},
		},
	)
	// GET /v2/guilds/:guildId/roles — fetch roles from Discord API
	.get(
		"/:guildId/roles",
		async ({ params, user, set }) => {
			const canManage = await verifyGuildAdmin(user, params.guildId);
			if (!canManage) {
				set.status = 403;
				return { roles: [] };
			}

			const botToken = env.DISCORD_TOKEN;
			if (!botToken) return { roles: [] };

			const roles = await fetchDiscordApi<DiscordRole[]>(
				`/guilds/${params.guildId}/roles`,
				`Bot ${botToken}`,
			);

			const filtered = (roles ?? []).filter((r) => r.name !== "@everyone");

			return { roles: filtered };
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "Guild Roles",
				description: "Returns roles for a guild using the bot token.",
			},
		},
	)
	// GET /v2/guilds/:guildId/territories — async search territory blueprints from database
	.get(
		"/:guildId/territories",
		async ({ query }) => {
			const search = (query.q ?? "").trim();
			const limitNum = query.limit ? Number.parseInt(query.limit, 10) : 20;
			const maxLimit =
				Number.isNaN(limitNum) || limitNum < 1 ? 20 : Math.min(limitNum, 100);

			if (search) {
				const blueprints = await db
					.select({
						id: territoryBlueprints.id,
						sector: territoryBlueprints.sector,
						size: territoryBlueprints.size,
						density: territoryBlueprints.density,
						slots: territoryBlueprints.slots,
					})
					.from(territoryBlueprints)
					.where(like(territoryBlueprints.id, `%${search.toUpperCase()}%`))
					.limit(maxLimit);

				return { territories: blueprints };
			}

			const blueprints = await db
				.select({
					id: territoryBlueprints.id,
					sector: territoryBlueprints.sector,
					size: territoryBlueprints.size,
					density: territoryBlueprints.density,
					slots: territoryBlueprints.slots,
				})
				.from(territoryBlueprints)
				.limit(maxLimit);

			return { territories: blueprints };
		},
		{
			params: t.Object({ guildId: t.String() }),
			query: t.Object({
				q: t.Optional(t.String()),
				limit: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Territory Blueprints",
				description:
					"Asynchronously search territory blueprints from database.",
			},
		},
	)
	// GET /v2/guilds/:guildId/reaction-roles — get reaction role messages & mappings
	.get(
		"/:guildId/reaction-roles",
		async ({ params }) => {
			const messages = await db
				.select()
				.from(reactionRoleMessages)
				.where(eq(reactionRoleMessages.guildId, params.guildId));

			const messageIds = messages.map((m) => m.id);
			const mappings =
				messageIds.length > 0
					? await db
							.select()
							.from(reactionRoleMappings)
							.where(inArray(reactionRoleMappings.messageId, messageIds))
					: [];

			const mappingsByMessageId = new Map<string, typeof mappings>();
			for (const mapping of mappings) {
				const list = mappingsByMessageId.get(mapping.messageId) ?? [];
				list.push(mapping);
				mappingsByMessageId.set(mapping.messageId, list);
			}

			const result = messages.map((msg) => ({
				...msg,
				mappings: mappingsByMessageId.get(msg.id) ?? [],
			}));

			return { messages: result };
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "Get Reaction Role Messages",
				description:
					"Returns all reaction role menus and emoji bindings for a guild.",
			},
		},
	)
	// POST /v2/guilds/:guildId/reaction-roles — create reaction role message & mappings
	.post(
		"/:guildId/reaction-roles",
		async ({ params, body, set }) => {
			if (!body.title.trim()) {
				set.status = 400;
				return { error: "Message title cannot be empty." };
			}
			if (!body.channelId) {
				set.status = 400;
				return { error: "Target channel ID is required." };
			}

			const messageId = crypto.randomUUID();
			await db.insert(reactionRoleMessages).values({
				id: messageId,
				guildId: params.guildId,
				title: body.title.trim(),
				channelId: body.channelId,
				requiredRoleId: body.requiredRoleId ?? null,
			});

			for (const m of body.mappings) {
				await db.insert(reactionRoleMappings).values({
					id: crypto.randomUUID(),
					messageId: messageId,
					emoji: m.emoji.trim(),
					roleId: m.roleId.trim(),
					description: m.description?.trim() ?? null,
				});
			}

			const [createdMessage] = await db
				.select()
				.from(reactionRoleMessages)
				.where(eq(reactionRoleMessages.id, messageId));

			const createdMappings = await db
				.select()
				.from(reactionRoleMappings)
				.where(eq(reactionRoleMappings.messageId, messageId));

			void syncReactionRolesViaIpc(params.guildId);

			return {
				success: true,
				message: createdMessage
					? { ...createdMessage, mappings: createdMappings }
					: null,
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				title: t.String(),
				channelId: t.String(),
				requiredRoleId: t.Optional(t.Nullable(t.String())),
				mappings: t.Array(
					t.Object({
						emoji: t.String(),
						roleId: t.String(),
						description: t.Optional(t.Nullable(t.String())),
					}),
				),
			}),
			detail: {
				summary: "Create Reaction Role Message",
				description: "Creates a new reaction role menu with emoji bindings.",
			},
		},
	)
	// PUT /v2/guilds/:guildId/reaction-roles/:messageId — update reaction role message & mappings
	.put(
		"/:guildId/reaction-roles/:messageId",
		async ({ params, body, set }) => {
			const [existing] = await db
				.select()
				.from(reactionRoleMessages)
				.where(
					and(
						eq(reactionRoleMessages.id, params.messageId),
						eq(reactionRoleMessages.guildId, params.guildId),
					),
				);

			if (!existing) {
				set.status = 404;
				return { error: "Reaction role message not found." };
			}

			await db
				.update(reactionRoleMessages)
				.set({
					...(body.title !== undefined ? { title: body.title.trim() } : {}),
					...(body.channelId !== undefined
						? { channelId: body.channelId }
						: {}),
					...(body.requiredRoleId !== undefined
						? { requiredRoleId: body.requiredRoleId }
						: {}),
					updatedAt: new Date(),
				})
				.where(eq(reactionRoleMessages.id, params.messageId));

			if (body.mappings !== undefined) {
				await db
					.delete(reactionRoleMappings)
					.where(eq(reactionRoleMappings.messageId, params.messageId));

				for (const m of body.mappings) {
					await db.insert(reactionRoleMappings).values({
						id: crypto.randomUUID(),
						messageId: params.messageId,
						emoji: m.emoji.trim(),
						roleId: m.roleId.trim(),
						description: m.description?.trim() ?? null,
					});
				}
			}

			const [updatedMessage] = await db
				.select()
				.from(reactionRoleMessages)
				.where(eq(reactionRoleMessages.id, params.messageId));

			const updatedMappings = await db
				.select()
				.from(reactionRoleMappings)
				.where(eq(reactionRoleMappings.messageId, params.messageId));

			void syncReactionRolesViaIpc(params.guildId);

			return {
				success: true,
				message: updatedMessage
					? { ...updatedMessage, mappings: updatedMappings }
					: null,
			};
		},
		{
			params: t.Object({
				guildId: t.String(),
				messageId: t.String(),
			}),
			body: t.Object({
				title: t.Optional(t.String()),
				channelId: t.Optional(t.String()),
				requiredRoleId: t.Optional(t.Nullable(t.String())),
				mappings: t.Optional(
					t.Array(
						t.Object({
							emoji: t.String(),
							roleId: t.String(),
							description: t.Optional(t.Nullable(t.String())),
						}),
					),
				),
			}),
			detail: {
				summary: "Update Reaction Role Message",
				description: "Updates a reaction role menu and its emoji bindings.",
			},
		},
	)
	// DELETE /v2/guilds/:guildId/reaction-roles/:messageId — delete reaction role message & mappings
	.delete(
		"/:guildId/reaction-roles/:messageId",
		async ({ params, set }) => {
			const [existing] = await db
				.select()
				.from(reactionRoleMessages)
				.where(
					and(
						eq(reactionRoleMessages.id, params.messageId),
						eq(reactionRoleMessages.guildId, params.guildId),
					),
				);

			if (!existing) {
				set.status = 404;
				return { error: "Reaction role message not found." };
			}

			await db
				.delete(reactionRoleMappings)
				.where(eq(reactionRoleMappings.messageId, params.messageId));

			await db
				.delete(reactionRoleMessages)
				.where(eq(reactionRoleMessages.id, params.messageId));

			void syncReactionRolesViaIpc(params.guildId);

			return { success: true };
		},
		{
			params: t.Object({
				guildId: t.String(),
				messageId: t.String(),
			}),
			detail: {
				summary: "Delete Reaction Role Message",
				description:
					"Deletes a reaction role menu and its associated emoji bindings.",
			},
		},
	)
	// GET /v2/guilds/:guildId/monitoring — list monitored factions
	.get(
		"/:guildId/monitoring",
		async ({ params }) => {
			const monitored = await db
				.select()
				.from(guildMonitoredFactions)
				.where(eq(guildMonitoredFactions.guildId, params.guildId))
				.orderBy(desc(guildMonitoredFactions.createdAt));

			return { monitored };
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "List Monitored Factions",
				description:
					"Returns all factions monitored by this guild and their category configurations.",
			},
		},
	)
	// POST /v2/guilds/:guildId/monitoring — add a faction to monitor
	.post(
		"/:guildId/monitoring",
		async ({ params, body, set }) => {
			if (!body.factionId || body.factionId <= 0) {
				set.status = 400;
				return { error: "Invalid faction ID." };
			}

			// Check if already monitored in this guild
			const [alreadyMonitored] = await db
				.select()
				.from(guildMonitoredFactions)
				.where(
					and(
						eq(guildMonitoredFactions.guildId, params.guildId),
						eq(guildMonitoredFactions.factionId, body.factionId),
					),
				);

			if (alreadyMonitored) {
				set.status = 409;
				return {
					error: "This faction is already being monitored in this server.",
				};
			}

			// Validate and resolve faction name & tag
			let factionName: string | null = null;
			let factionTag: string | null = null;

			try {
				const { tornApi } = await import("@sentinel/torn-api");
				const basic = await tornApi.getRaw<{
					name?: string;
					tag?: string;
				}>(`faction/${body.factionId}`, {
					queryParams: { selections: "basic" },
				});

				if (basic?.name) {
					factionName = basic.name;
					factionTag = basic.tag ?? null;
				}
			} catch {
				// Fallback to local table if available
				const [existingFaction] = await db
					.select()
					.from(factions)
					.where(eq(factions.id, body.factionId));
				if (existingFaction) {
					factionName = existingFaction.name;
					factionTag = existingFaction.tag;
				}
			}

			const [created] = await db
				.insert(guildMonitoredFactions)
				.values({
					guildId: params.guildId,
					factionId: body.factionId,
					factionName: factionName ?? `Faction ${body.factionId}`,
					factionTag,
					revivesEnabled: body.revivesEnabled ?? true,
					revivesChannelId: body.revivesChannelId ?? null,
				})
				.returning();

			if (created?.revivesEnabled && created.revivesChannelId) {
				void syncFactionMonitoringViaIpc(params.guildId, created.id);
			}

			return { success: true, monitored: created };
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				factionId: t.Number(),
				revivesEnabled: t.Optional(t.Boolean()),
				revivesChannelId: t.Optional(t.Nullable(t.String())),
			}),
			detail: {
				summary: "Add Monitored Faction",
				description:
					"Registers a faction to be monitored for revives or other subcategories.",
			},
		},
	)
	// PATCH /v2/guilds/:guildId/monitoring/:monitorId — update subcategories/channels
	.patch(
		"/:guildId/monitoring/:monitorId",
		async ({ params, body, set }) => {
			const [existing] = await db
				.select()
				.from(guildMonitoredFactions)
				.where(
					and(
						eq(guildMonitoredFactions.id, params.monitorId),
						eq(guildMonitoredFactions.guildId, params.guildId),
					),
				);

			if (!existing) {
				set.status = 404;
				return { error: "Monitored faction configuration not found." };
			}

			const updates: Partial<{
				revivesEnabled: boolean;
				revivesChannelId: string | null;
				revivesMessageIds: string[];
				updatedAt: Date;
			}> = {
				updatedAt: new Date(),
			};

			if (body.revivesEnabled !== undefined) {
				updates.revivesEnabled = body.revivesEnabled;
			}
			if (body.revivesChannelId !== undefined) {
				updates.revivesChannelId = body.revivesChannelId;
				// If channel changed, reset message IDs so it creates a fresh embed in the new channel
				if (body.revivesChannelId !== existing.revivesChannelId) {
					updates.revivesMessageIds = [];
				}
			}

			const [updated] = await db
				.update(guildMonitoredFactions)
				.set(updates)
				.where(eq(guildMonitoredFactions.id, params.monitorId))
				.returning();

			if (updated?.revivesEnabled && updated.revivesChannelId) {
				void syncFactionMonitoringViaIpc(params.guildId, params.monitorId);
			}

			return { success: true, monitored: updated };
		},
		{
			params: t.Object({
				guildId: t.String(),
				monitorId: t.String(),
			}),
			body: t.Object({
				revivesEnabled: t.Optional(t.Boolean()),
				revivesChannelId: t.Optional(t.Nullable(t.String())),
			}),
			detail: {
				summary: "Update Monitored Faction",
				description:
					"Updates monitoring sub-categories or designated output channels.",
			},
		},
	)
	// DELETE /v2/guilds/:guildId/monitoring/:monitorId — delete monitored faction
	.delete(
		"/:guildId/monitoring/:monitorId",
		async ({ params, set }) => {
			const [existing] = await db
				.select()
				.from(guildMonitoredFactions)
				.where(
					and(
						eq(guildMonitoredFactions.id, params.monitorId),
						eq(guildMonitoredFactions.guildId, params.guildId),
					),
				);

			if (!existing) {
				set.status = 404;
				return { error: "Monitored faction not found." };
			}

			await db
				.delete(guildMonitoredFactions)
				.where(eq(guildMonitoredFactions.id, params.monitorId));

			return { success: true };
		},
		{
			params: t.Object({
				guildId: t.String(),
				monitorId: t.String(),
			}),
			detail: {
				summary: "Delete Monitored Faction",
				description: "Removes a faction from guild monitoring.",
			},
		},
	);
