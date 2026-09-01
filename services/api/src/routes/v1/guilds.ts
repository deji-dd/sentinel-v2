import {
	and,
	db,
	eq,
	factionRoleMappings,
	factions,
	guildConfigs,
	inArray,
	like,
	reactionRoleMappings,
	reactionRoleMessages,
	territoryBlueprints,
} from "@sentinel/database";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
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

			const botGuildMap = new Map(
				(botGuilds ?? []).map((g) => [g.id, { ...g, botInGuild: true }]),
			);

			const isSentinelOwner = user?.role === "owner" || user?.role === "admin";

			if (isSentinelOwner) {
				const userGuildMap = new Map((userGuilds ?? []).map((g) => [g.id, g]));
				const result = (botGuilds ?? []).map((g) => ({
					...g,
					botInGuild: true,
					manageable: true,
					userInGuild: userGuildMap.has(g.id),
				}));
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
		async ({ params, body, set }) => {
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

			await db
				.update(guildConfigs)
				.set({
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

			return { success: true };
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
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
	);
