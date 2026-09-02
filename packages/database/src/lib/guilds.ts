import { eq } from "drizzle-orm";
import { db } from "../../index";
import { guildConfigs } from "../schema/discord";

let authorizedGuildsCache = new Set<string>();
let cacheInitialized = false;

/**
 * Fallback helper to retrieve target Discord guild IDs configured in environment variables (for legacy migration).
 */
function getLegacyEnvGuildIds(): string[] {
	const raw =
		process.env.TARGET_GUILD_IDS ||
		process.env.DISCORD_GUILD_ID ||
		process.env.GUILD_ID ||
		"";

	return raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => /^\d{17,20}$/.test(id));
}

/**
 * Retrieves all authorized target guild IDs from the database.
 * Updates the in-memory cache for fast synchronous checks.
 */
export async function getTargetGuildIds(): Promise<string[]> {
	// First ensure any legacy environment variable guilds are seeded into the database
	await seedLegacyEnvGuilds();

	const rows = await db
		.select({ guildId: guildConfigs.guildId })
		.from(guildConfigs)
		.where(eq(guildConfigs.authorized, true));

	const ids = rows.map((r) => r.guildId);
	authorizedGuildsCache = new Set(ids);
	cacheInitialized = true;
	return ids;
}

/**
 * Fast synchronous check against the in-memory authorized target guilds cache.
 */
export function isTargetGuild(guildId: string | null | undefined): boolean {
	if (!guildId) return false;
	if (authorizedGuildsCache.has(guildId)) return true;
	if (!cacheInitialized) {
		const legacyIds = getLegacyEnvGuildIds();
		if (legacyIds.length > 0) return legacyIds.includes(guildId);
	}
	return false;
}

/**
 * Asynchronous check directly querying the database (or cache).
 */
export async function isTargetGuildAsync(
	guildId: string | null | undefined,
): Promise<boolean> {
	if (!guildId) return false;
	if (!cacheInitialized) {
		await getTargetGuildIds();
	}
	return authorizedGuildsCache.has(guildId);
}

/**
 * Authorizes a guild in the database and adds it to the cache.
 */
export async function authorizeGuild(guildId: string): Promise<void> {
	if (!cacheInitialized) {
		await getTargetGuildIds();
	}

	await db
		.insert(guildConfigs)
		.values({
			guildId,
			authorized: true,
			adminRoleIds: [],
			verifiedRoleIds: [],
			protectedRoleIds: [],
			factionListMessageIds: [],
			ttTerritoryIds: [],
			ttFactionIds: [],
			nicknameTemplate: "[{tag}] {name} [{id}]",
			verifyOnJoin: false,
			verifyCron: false,
			verifyCronInterval: 24,
		})
		.onConflictDoUpdate({
			target: guildConfigs.guildId,
			set: { authorized: true, updatedAt: new Date() },
		});

	authorizedGuildsCache.add(guildId);
	cacheInitialized = true;
}

/**
 * Deauthorizes a guild in the database and removes it from the cache.
 */
export async function deauthorizeGuild(guildId: string): Promise<void> {
	if (!cacheInitialized) {
		await getTargetGuildIds();
	}

	await db
		.update(guildConfigs)
		.set({ authorized: false, updatedAt: new Date() })
		.where(eq(guildConfigs.guildId, guildId));

	authorizedGuildsCache.delete(guildId);
	cacheInitialized = true;
}

/**
 * Migrates/seeds any legacy TARGET_GUILD_IDS from environment variables if not already present.
 */
async function seedLegacyEnvGuilds(): Promise<void> {
	const legacyIds = getLegacyEnvGuildIds();
	if (legacyIds.length === 0) return;

	for (const guildId of legacyIds) {
		const existing = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, guildId),
		});

		if (!existing) {
			await db
				.insert(guildConfigs)
				.values({
					guildId,
					authorized: true,
					adminRoleIds: [],
					verifiedRoleIds: [],
					protectedRoleIds: [],
					factionListMessageIds: [],
					ttTerritoryIds: [],
					ttFactionIds: [],
					nicknameTemplate: "[{tag}] {name} [{id}]",
					verifyOnJoin: false,
					verifyCron: false,
					verifyCronInterval: 24,
				})
				.onConflictDoNothing();
		}
	}
}

/**
 * Ensures that default `guildConfigs` records exist for all target guilds.
 */
export async function ensureTargetGuildConfigs(): Promise<void> {
	await getTargetGuildIds();
}

export interface GuildModuleStatus {
	verification: boolean;
	territory: boolean;
	reactionRoles: boolean;
	monitoring: boolean;
}

/**
 * Returns the enabled status of all feature modules for a specific guild.
 */
export async function getGuildModules(
	guildId: string,
): Promise<GuildModuleStatus> {
	const config = await db.query.guildConfigs.findFirst({
		where: eq(guildConfigs.guildId, guildId),
		columns: {
			moduleVerification: true,
			moduleTerritory: true,
			moduleReactionRoles: true,
			moduleMonitoring: true,
		},
	});

	return {
		verification: config?.moduleVerification ?? true,
		territory: config?.moduleTerritory ?? true,
		reactionRoles: config?.moduleReactionRoles ?? true,
		monitoring: config?.moduleMonitoring ?? false,
	};
}
