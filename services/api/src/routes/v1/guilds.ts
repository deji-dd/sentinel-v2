import {
	and,
	db,
	eq,
	factionRoleMappings,
	factions,
	guildApiKeys,
	guildConfigs,
	inArray,
	like,
	reactionRoleMappings,
	reactionRoleMessages,
	territoryBlueprints,
	userSessions,
	users,
} from "@sentinel/database";
import { encryptApiKey, hashApiKey, TornApiClient } from "@sentinel/torn-api";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";

const DISCORD_API = "https://discord.com/api/v10";

interface DiscordGuild {
	id: string;
	name: string;
	icon: string | null;
	owner: boolean;
	permissions: string;
	features: string[];
}

interface DiscordChannel {
	id: string;
	name: string;
	type: number;
}

interface DiscordRole {
	id: string;
	name: string;
	color: number;
}

async function fetchDiscordApi<T>(
	endpoint: string,
	authorization: string,
): Promise<T | null> {
	try {
		const res = await fetch(`${DISCORD_API}${endpoint}`, {
			headers: { Authorization: authorization },
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

/**
 * Guild management routes for the bot dashboard.
 * Fetches live data from Discord API using bot token + user access token,
 * and manages guild configuration & API key state in SQLite.
 */
export const guildRoutes = new Elysia({ prefix: "/guilds" })
	// GET /api/v1/guilds — mutual guilds between user and bot
	.get(
		"/",
		async ({ request }) => {
			const cookieHeader = request.headers.get("cookie") ?? "";
			const discordMetaMatch = cookieHeader.match(/discord_meta=([^;]+)/);
			let userAccessToken: string | null = null;

			if (discordMetaMatch?.[1]) {
				try {
					const meta = JSON.parse(
						decodeURIComponent(discordMetaMatch[1]),
					) as Record<string, unknown>;
					userAccessToken =
						typeof meta.accessToken === "string" ? meta.accessToken : null;
				} catch {
					userAccessToken = null;
				}
			}

			if (!userAccessToken) {
				return {
					guilds: [],
					error: "No Discord access token found. Please log in with Discord.",
				};
			}

			const botToken = env.DISCORD_TOKEN;

			const [userGuilds, botGuilds] = await Promise.all([
				fetchDiscordApi<DiscordGuild[]>(
					"/users/@me/guilds",
					`Bearer ${userAccessToken}`,
				),
				fetchDiscordApi<DiscordGuild[]>("/users/@me/guilds", `Bot ${botToken}`),
			]);

			if (!userGuilds || !botGuilds) {
				return { guilds: [], error: "Failed to fetch guilds from Discord." };
			}

			const botGuildIds = new Set(botGuilds.map((g) => g.id));
			const mutual = userGuilds.filter((g) => botGuildIds.has(g.id));

			return { guilds: mutual };
		},
		{
			detail: {
				summary: "Mutual Guilds",
				description:
					"Returns guilds shared between the logged-in user and the bot.",
			},
		},
	)
	// GET /api/v1/guilds/:guildId/config — get guild configuration & API keys
	.get(
		"/:guildId/config",
		async ({ params }) => {
			const config = db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, params.guildId))
				.get();

			const keys = db
				.select({
					id: guildApiKeys.id,
					providedBy: guildApiKeys.providedBy,
					isValid: guildApiKeys.isValid,
					createdAt: guildApiKeys.createdAt,
				})
				.from(guildApiKeys)
				.where(eq(guildApiKeys.guildId, params.guildId))
				.all();

			const mappings = db
				.select()
				.from(factionRoleMappings)
				.where(eq(factionRoleMappings.guildId, params.guildId))
				.all();

			const factionIds = Array.from(new Set(mappings.map((m) => m.factionId)));
			const factionRows =
				factionIds.length > 0
					? db
							.select({
								id: factions.id,
								tag: factions.tag,
								tagImage: factions.tagImage,
							})
							.from(factions)
							.where(inArray(factions.id, factionIds))
							.all()
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
				apiKeys: keys,
				factionRoleMappings: enrichedMappings,
			};
		},
		{
			params: t.Object({ guildId: t.String() }),
			detail: {
				summary: "Get Guild Config",
				description:
					"Returns guild configuration, registered API keys, and faction mappings.",
			},
		},
	)
	// PUT /api/v1/guilds/:guildId/config — update guild configuration
	.put(
		"/:guildId/config",
		async ({ params, body, set, cookie }) => {
			const existing = db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, params.guildId))
				.get();

			if (!existing) {
				set.status = 403;
				return {
					error:
						"Guild is not initialized. Initialization can only be performed by a Sentinel administrator.",
				};
			}

			if (body.enabledModules !== undefined) {
				const sessionToken = cookie.session?.value;
				let isAdmin = false;

				if (typeof sessionToken === "string" && sessionToken) {
					const res = db
						.select({ role: users.role, discordId: users.discordId })
						.from(userSessions)
						.innerJoin(users, eq(userSessions.userId, users.id))
						.where(eq(userSessions.id, sessionToken))
						.get();

					isAdmin =
						res?.role === "admin" ||
						res?.role === "owner" ||
						(Boolean(env.DISCORD_USER_ID) &&
							res?.discordId === env.DISCORD_USER_ID);
				}

				if (!isAdmin) {
					set.status = 403;
					return {
						error:
							"Enabling or disabling modules can only be performed by a Sentinel administrator.",
					};
				}
			}

			db.update(guildConfigs)
				.set({
					...(body.logChannelId !== undefined
						? { logChannelId: body.logChannelId }
						: {}),
					...(body.adminRoleIds !== undefined
						? { adminRoleIds: body.adminRoleIds }
						: {}),
					...(body.enabledModules !== undefined
						? { enabledModules: body.enabledModules }
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
				.where(eq(guildConfigs.guildId, params.guildId))
				.run();

			return { success: true };
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				logChannelId: t.Optional(t.Nullable(t.String())),
				adminRoleIds: t.Optional(t.Array(t.String())),
				enabledModules: t.Optional(t.Array(t.String())),
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

			const existingConfig = db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, params.guildId))
				.get();

			if (!existingConfig) {
				set.status = 403;
				return {
					error:
						"Guild is not initialized. Initialization can only be performed by a Sentinel administrator.",
				};
			}

			const newId = crypto.randomUUID();
			db.insert(factionRoleMappings)
				.values({
					id: newId,
					guildId: params.guildId,
					factionId: body.factionId,
					factionName: body.factionName ?? null,
					memberRoleIds: body.memberRoleIds ?? [],
					leaderRoleIds: body.leaderRoleIds ?? [],
					enabled: true,
				})
				.run();

			const created = db
				.select()
				.from(factionRoleMappings)
				.where(eq(factionRoleMappings.id, newId))
				.get();

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
			db.update(factionRoleMappings)
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
				.where(eq(factionRoleMappings.id, params.mappingId))
				.run();

			const updated = db
				.select()
				.from(factionRoleMappings)
				.where(eq(factionRoleMappings.id, params.mappingId))
				.get();

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
			db.delete(factionRoleMappings)
				.where(eq(factionRoleMappings.id, params.mappingId))
				.run();

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
			const existing = db
				.select({
					id: factions.id,
					name: factions.name,
					tag: factions.tag,
					tagImage: factions.tagImage,
					updatedAt: factions.updatedAt,
				})
				.from(factions)
				.where(eq(factions.id, factionIdNum))
				.get();

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

			// 2. Fetch from Torn API using any valid guild API key
			try {
				const anyKey = db
					.select({ apiKeyEncrypted: guildApiKeys.apiKeyEncrypted })
					.from(guildApiKeys)
					.where(eq(guildApiKeys.isValid, true))
					.get();

				if (!anyKey) {
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
					return {
						error: "Faction not found locally and no API key available.",
					};
				}

				const { decryptApiKey } = await import("@sentinel/torn-api");
				const rawKey = decryptApiKey(
					anyKey.apiKeyEncrypted,
					process.env.ENCRYPTION_KEY ?? "",
				);

				const client = new TornApiClient();
				const res = await client.getRaw<{
					name?: string;
					tag?: string;
					tag_image?: string;
				}>(`faction/${factionIdNum}`, {
					apiKey: rawKey,
					queryParams: { selections: "basic" },
				});

				const basic = res;
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
					db.update(factions)
						.set({
							name,
							tag,
							tagImage,
							updatedAt: new Date(),
						})
						.where(eq(factions.id, factionIdNum))
						.run();
				} else {
					db.insert(factions)
						.values({
							id: factionIdNum,
							name,
							tag,
							tagImage,
						})
						.run();
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
	// POST /api/v1/guilds/:guildId/api-keys — register a new Torn API key for the guild
	.post(
		"/:guildId/api-keys",
		async ({ params, body, set }) => {
			const trimmedKey = body.apiKey.trim();
			if (trimmedKey.length !== 16) {
				set.status = 400;
				return {
					error:
						"Invalid Torn API key format. Key must be a 16-character string.",
				};
			}

			const keyHash = hashApiKey(
				trimmedKey,
				process.env.API_KEY_HASH_PEPPER ?? "",
			);

			// Check duplicate key within this guild
			const existingKey = db
				.select()
				.from(guildApiKeys)
				.where(
					and(
						eq(guildApiKeys.guildId, params.guildId),
						eq(guildApiKeys.apiKeyHash, keyHash),
					),
				)
				.get();

			if (existingKey) {
				set.status = 400;
				return { error: "This API key has already been added to this server." };
			}

			// Verify key against Torn API first
			let tornUserId: number | null = null;
			try {
				const client = new TornApiClient();
				const profile = await client.getRaw<{ player_id?: number }>("user/", {
					apiKey: trimmedKey,
					queryParams: { selections: "profile" },
				});
				tornUserId = profile?.player_id ?? null;
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

			const keyEncrypted = encryptApiKey(
				trimmedKey,
				process.env.ENCRYPTION_KEY ?? "",
			);

			db.insert(guildApiKeys)
				.values({
					guildId: params.guildId,
					userId: tornUserId,
					apiKeyEncrypted: keyEncrypted,
					apiKeyHash: keyHash,
					providedBy: body.providedBy ?? "Dashboard Admin",
					isValid: true,
				})
				.run();

			return { success: true };
		},
		{
			params: t.Object({ guildId: t.String() }),
			body: t.Object({
				apiKey: t.String(),
				providedBy: t.Optional(t.String()),
			}),
			detail: {
				summary: "Register Guild API Key",
				description:
					"Verifies with Torn API, encrypts, and stores a new Torn API key for the guild.",
			},
		},
	)
	// DELETE /api/v1/guilds/:guildId/api-keys/:keyId — remove a registered API key
	.delete(
		"/:guildId/api-keys/:keyId",
		async ({ params }) => {
			db.delete(guildApiKeys)
				.where(
					and(
						eq(guildApiKeys.id, params.keyId),
						eq(guildApiKeys.guildId, params.guildId),
					),
				)
				.run();

			return { success: true };
		},
		{
			params: t.Object({
				guildId: t.String(),
				keyId: t.String(),
			}),
			detail: {
				summary: "Delete Guild API Key",
				description: "Deletes a registered API key for a guild.",
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
				const blueprints = db
					.select({
						id: territoryBlueprints.id,
						sector: territoryBlueprints.sector,
						size: territoryBlueprints.size,
						density: territoryBlueprints.density,
						slots: territoryBlueprints.slots,
					})
					.from(territoryBlueprints)
					.where(like(territoryBlueprints.id, `%${search.toUpperCase()}%`))
					.limit(maxLimit)
					.all();

				return { territories: blueprints };
			}

			const blueprints = db
				.select({
					id: territoryBlueprints.id,
					sector: territoryBlueprints.sector,
					size: territoryBlueprints.size,
					density: territoryBlueprints.density,
					slots: territoryBlueprints.slots,
				})
				.from(territoryBlueprints)
				.limit(maxLimit)
				.all();

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
			const messages = db
				.select()
				.from(reactionRoleMessages)
				.where(eq(reactionRoleMessages.guildId, params.guildId))
				.all();

			const messageIds = messages.map((m) => m.id);
			const mappings =
				messageIds.length > 0
					? db
							.select()
							.from(reactionRoleMappings)
							.where(inArray(reactionRoleMappings.messageId, messageIds))
							.all()
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
			db.insert(reactionRoleMessages)
				.values({
					id: messageId,
					guildId: params.guildId,
					title: body.title.trim(),
					channelId: body.channelId,
					requiredRoleId: body.requiredRoleId ?? null,
				})
				.run();

			for (const m of body.mappings) {
				db.insert(reactionRoleMappings)
					.values({
						id: crypto.randomUUID(),
						messageId: messageId,
						emoji: m.emoji.trim(),
						roleId: m.roleId.trim(),
						description: m.description?.trim() ?? null,
					})
					.run();
			}

			const createdMessage = db
				.select()
				.from(reactionRoleMessages)
				.where(eq(reactionRoleMessages.id, messageId))
				.get();

			const createdMappings = db
				.select()
				.from(reactionRoleMappings)
				.where(eq(reactionRoleMappings.messageId, messageId))
				.all();

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
			const existing = db
				.select()
				.from(reactionRoleMessages)
				.where(
					and(
						eq(reactionRoleMessages.id, params.messageId),
						eq(reactionRoleMessages.guildId, params.guildId),
					),
				)
				.get();

			if (!existing) {
				set.status = 404;
				return { error: "Reaction role message not found." };
			}

			db.update(reactionRoleMessages)
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
				.where(eq(reactionRoleMessages.id, params.messageId))
				.run();

			if (body.mappings !== undefined) {
				db.delete(reactionRoleMappings)
					.where(eq(reactionRoleMappings.messageId, params.messageId))
					.run();

				for (const m of body.mappings) {
					db.insert(reactionRoleMappings)
						.values({
							id: crypto.randomUUID(),
							messageId: params.messageId,
							emoji: m.emoji.trim(),
							roleId: m.roleId.trim(),
							description: m.description?.trim() ?? null,
						})
						.run();
				}
			}

			const updatedMessage = db
				.select()
				.from(reactionRoleMessages)
				.where(eq(reactionRoleMessages.id, params.messageId))
				.get();

			const updatedMappings = db
				.select()
				.from(reactionRoleMappings)
				.where(eq(reactionRoleMappings.messageId, params.messageId))
				.all();

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
			const existing = db
				.select()
				.from(reactionRoleMessages)
				.where(
					and(
						eq(reactionRoleMessages.id, params.messageId),
						eq(reactionRoleMessages.guildId, params.guildId),
					),
				)
				.get();

			if (!existing) {
				set.status = 404;
				return { error: "Reaction role message not found." };
			}

			db.delete(reactionRoleMappings)
				.where(eq(reactionRoleMappings.messageId, params.messageId))
				.run();

			db.delete(reactionRoleMessages)
				.where(eq(reactionRoleMessages.id, params.messageId))
				.run();

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
