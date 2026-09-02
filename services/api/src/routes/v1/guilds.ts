import {
	and,
	authorizeGuild,
	count,
	db,
	deauthorizeGuild,
	desc,
	eq,
	factionRoleMappings,
	factions,
	guildConfigs,
	guildMonitoredFactions,
	ilike,
	inArray,
	like,
	or,
	reactionRoleMappings,
	reactionRoleMessages,
	territoryBlueprints,
	verificationLogs,
	verifiedUsers,
} from "@sentinel/database";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import {
	syncFactionMonitoringViaIpc,
	syncGuildCommandsViaIpc,
} from "../../lib/bot-ipc";
import { authPlugin } from "../../middleware/auth";

interface DiscordGuild {
	id: string;
	name: string;
	icon: string | null;
	owner: boolean;
	permissions: string;
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

export const guildRoutes = new Elysia({ prefix: "/guilds" })
	.use(authPlugin)
	// GET /api/v1/guilds — list guilds manageable by the current user
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
				return { guilds: [] };
			}

			const [userGuilds, botGuilds] = await Promise.all([
				userAccessToken
					? fetchDiscordApi<DiscordGuild[]>(
							"/users/@me/guilds",
							`Bearer ${userAccessToken}`,
						)
					: Promise.resolve(null),
				fetchDiscordApi<DiscordGuild[]>("/users/@me/guilds", `Bot ${botToken}`),
			]);

			const authorizedRows = await db
				.select({ guildId: guildConfigs.guildId })
				.from(guildConfigs)
				.where(eq(guildConfigs.authorized, true));
			const authorizedSet = new Set(authorizedRows.map((r) => r.guildId));

			const botGuildMap = new Map(
				(botGuilds ?? []).map((g) => [g.id, { ...g, botInGuild: true }]),
			);

			const isSentinelOwner = user?.role === "owner" || user?.role === "admin";

			if (isSentinelOwner) {
				const userGuildMap = new Map((userGuilds ?? []).map((g) => [g.id, g]));
				const botGuildIds = new Set((botGuilds ?? []).map((g) => g.id));

				const result: Array<
					DiscordGuild & {
						botInGuild: boolean;
						manageable: boolean;
						authorized: boolean;
						userInGuild: boolean;
					}
				> = (botGuilds ?? []).map((g) => ({
					...g,
					botInGuild: true,
					manageable: true,
					authorized: authorizedSet.has(g.id),
					userInGuild: userGuildMap.has(g.id),
				}));

				// Also add user's manageable guilds where bot is not installed yet
				if (userGuilds) {
					for (const ug of userGuilds) {
						if (!botGuildIds.has(ug.id)) {
							const perms = BigInt(ug.permissions);
							const hasAdmin = (perms & BigInt(ADMINISTRATOR)) !== 0n;
							const hasManageGuild = (perms & BigInt(MANAGE_GUILD)) !== 0n;
							if (ug.owner || hasAdmin || hasManageGuild) {
								result.push({
									...ug,
									botInGuild: false,
									manageable: true,
									authorized: authorizedSet.has(ug.id),
									userInGuild: true,
								});
							}
						}
					}
				}

				return { guilds: result };
			}

			if (!userGuilds) {
				return { guilds: [] };
			}

			const manageable = userGuilds
				.filter((g) => {
					const perms = BigInt(g.permissions);
					const hasAdmin = (perms & BigInt(ADMINISTRATOR)) !== 0n;
					const hasManageGuild = (perms & BigInt(MANAGE_GUILD)) !== 0n;
					return g.owner || hasAdmin || hasManageGuild;
				})
				.map((g) => ({
					...g,
					botInGuild: botGuildMap.has(g.id),
					manageable: true,
					authorized: authorizedSet.has(g.id),
					userInGuild: true,
				}));

			return { guilds: manageable };
		},
		{
			detail: {
				summary: "List Guilds",
				description:
					"Returns mutual guilds where the user has administrative permissions and Sentinel is installed.",
			},
		},
	)
	// POST /api/v1/guilds/authorize — Authorize a guild and generate an invite link (Admin/Owner only)
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
	// POST /api/v1/guilds/deauthorize — Deauthorize a guild (Admin/Owner only)
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
	// GET /api/v1/guilds/:guildId/config — get guild configuration & faction mappings
	.get(
		"/:guildId/config",
		async ({ params }) => {
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
	// PUT /api/v1/guilds/:guildId/config — update guild configuration
	.put(
		"/:guildId/config",
		async ({ params, body, user, set }) => {
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
				body.moduleMonitoring !== undefined;

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
					updatedAt: new Date(),
				})
				.where(eq(guildConfigs.guildId, params.guildId));

			if (hasModuleUpdates) {
				void syncGuildCommandsViaIpc(params.guildId);
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
			}),
			detail: {
				summary: "Update Guild Config",
				description:
					"Updates general settings, verification settings, or module configuration for a guild.",
			},
		},
	)
	// PATCH /api/v1/guilds/:guildId/modules — update guild module enablements (Bot Owner only)
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
			}),
			detail: {
				summary: "Update Guild Modules",
				description:
					"Toggles modules on/off for a guild. Strictly restricted to the Sentinel bot owner.",
			},
		},
	)
	// POST /api/v1/guilds/:guildId/faction-mappings — create faction role mapping
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
	// PUT /api/v1/guilds/:guildId/faction-mappings/:mappingId — update mapping
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
	// DELETE /api/v1/guilds/:guildId/faction-mappings/:mappingId — delete mapping
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
	// GET /api/v1/guilds/:guildId/factions/:factionId — resolve faction details
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
	// GET /api/v1/guilds/:guildId/verification-logs — list verification execution history
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
	// GET /api/v1/guilds/:guildId/channels — fetch channels from Discord API
	.get(
		"/:guildId/channels",
		async ({ params }) => {
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
	// GET /api/v1/guilds/:guildId/roles — fetch roles from Discord API
	.get(
		"/:guildId/roles",
		async ({ params }) => {
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
	// GET /api/v1/guilds/:guildId/territories — async search territory blueprints from database
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
	// GET /api/v1/guilds/:guildId/reaction-roles — get reaction role messages & mappings
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
	// POST /api/v1/guilds/:guildId/reaction-roles — create reaction role message & mappings
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
	// PUT /api/v1/guilds/:guildId/reaction-roles/:messageId — update reaction role message & mappings
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
	// DELETE /api/v1/guilds/:guildId/reaction-roles/:messageId — delete reaction role message & mappings
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
	// GET /api/v1/guilds/:guildId/monitoring — list monitored factions
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
	// POST /api/v1/guilds/:guildId/monitoring — add a faction to monitor
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
	// PATCH /api/v1/guilds/:guildId/monitoring/:monitorId — update subcategories/channels
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
	// DELETE /api/v1/guilds/:guildId/monitoring/:monitorId — delete monitored faction
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
