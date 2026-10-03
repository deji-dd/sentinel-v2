import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { db } from "../../index";
import {
	guildConfigs,
	guildMonitoredFactions,
	verifiedUsers,
} from "../schema/discord";
import {
	mercChannelConfigs,
	mercContractHits,
	mercContracts,
	mercContractTokens,
} from "../schema/merc";
import { systemStates } from "../schema/system";

export type ServerType = "alliance" | "faction" | "elims" | "owner" | "merc";

export interface ServerTypeMapping {
	alliance: string | null;
	faction: string | null;
	elims: string | null;
	owner: string | null;
	merc: string | null;
}

/**
 * Safely extracts environment variables with live re-read of .env.development in development mode
 * so changes reflect immediately without requiring a full dev server restart.
 */
export function getEnvVar(key: string, alias?: string): string | null {
	if (process.env.NODE_ENV !== "production") {
		const candidateFiles = [
			resolve(process.cwd(), ".env.development"),
			resolve(process.cwd(), "../../.env.development"),
			resolve(process.cwd(), ".env"),
			resolve(process.cwd(), "../../.env"),
		];

		for (const file of candidateFiles) {
			try {
				if (existsSync(file)) {
					const content = readFileSync(file, "utf-8");
					const regexKey = new RegExp(`^${key}=["']?([^"'\r\n]+)["']?`, "m");
					const matchKey = content.match(regexKey);
					if (matchKey?.[1]) return matchKey[1].trim();

					if (alias) {
						const regexAlias = new RegExp(
							`^${alias}=["']?([^"'\r\n]+)["']?`,
							"m",
						);
						const matchAlias = content.match(regexAlias);
						if (matchAlias?.[1]) return matchAlias[1].trim();
					}
				}
			} catch {
				// ignore file read error
			}
		}
	}

	return process.env[key] || (alias ? process.env[alias] : null) || null;
}

export const DEFAULT_SERVER_TYPES: ServerTypeMapping = {
	alliance: getEnvVar("ALLIANCE_GUILD_ID", "DISCORD_ALLIANCE_GUILD_ID"),
	faction: getEnvVar("FACTION_GUILD_ID", "DISCORD_FACTION_GUILD_ID"),
	elims: getEnvVar("ELIMS_GUILD_ID", "DISCORD_ELIMS_GUILD_ID"),
	owner: getEnvVar("OWNER_GUILD_ID", "DISCORD_OWNER_GUILD_ID"),
	merc:
		getEnvVar("MERC_GUILD_ID", "DISCORD_MERC_GUILD_ID") ||
		getEnvVar("MERCENARY_GUILD_ID", "DISCORD_MERCENARY_GUILD_ID"),
};

let authorizedGuildsCache = new Set<string>();
let elimsGuildIdCache: string | null = null;
let mercGuildIdCache: string | null = null;
let cacheInitialized = false;

/**
 * Retrieves the mapping of the designated server types: alliance, faction, elims, owner, merc.
 * Dynamically resolves from environment variables so that configuration changes are immediately live.
 */
export async function getServerTypeMappings(): Promise<ServerTypeMapping> {
	return {
		alliance: getEnvVar("ALLIANCE_GUILD_ID", "DISCORD_ALLIANCE_GUILD_ID"),
		faction: getEnvVar("FACTION_GUILD_ID", "DISCORD_FACTION_GUILD_ID"),
		elims: getEnvVar("ELIMS_GUILD_ID", "DISCORD_ELIMS_GUILD_ID"),
		owner: getEnvVar("OWNER_GUILD_ID", "DISCORD_OWNER_GUILD_ID"),
		merc:
			getEnvVar("MERC_GUILD_ID", "DISCORD_MERC_GUILD_ID") ||
			getEnvVar("MERCENARY_GUILD_ID", "DISCORD_MERCENARY_GUILD_ID"),
	};
}

/**
 * Sets or resets (null) a server type mapping.
 */
export async function setServerType(
	type: ServerType,
	guildId: string | null,
): Promise<ServerTypeMapping> {
	const current = await getServerTypeMappings();
	const updated: ServerTypeMapping = {
		...current,
		[type]: guildId,
	};

	await db
		.insert(systemStates)
		.values({
			id: "system:server_types",
			init: true,
			data: updated,
		})
		.onConflictDoUpdate({
			target: systemStates.id,
			set: { data: updated, updatedAt: new Date() },
		});

	if (guildId) {
		await authorizeGuild(guildId);
	}

	if (type === "elims") {
		elimsGuildIdCache = guildId;
		if (guildId) {
			await db
				.insert(systemStates)
				.values({
					id: "elims:guild_config",
					init: true,
					data: { guildId },
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: { data: { guildId }, updatedAt: new Date() },
				});
		}
	}

	return updated;
}

/**
 * Retrieves the currently configured Elims tournament Discord guild ID.
 */
export async function getElimsGuildId(): Promise<string | null> {
	try {
		const [row] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, "elims:guild_config"));

		const data = row?.data as { guildId?: string } | undefined;
		elimsGuildIdCache = data?.guildId ?? null;
		return elimsGuildIdCache;
	} catch {
		return null;
	}
}

/**
 * Synchronous check whether a guild is the active Elims tournament server.
 */
export function isElimsGuild(guildId: string | null | undefined): boolean {
	if (!guildId) return false;
	return elimsGuildIdCache === guildId;
}

/**
 * Asynchronous check whether a guild is the active Elims tournament server.
 */
export async function isElimsGuildAsync(
	guildId: string | null | undefined,
): Promise<boolean> {
	if (!guildId) return false;
	if (elimsGuildIdCache === guildId) return true;
	const current = await getElimsGuildId();
	return current === guildId;
}

let subversiveGuildIdCache: string | null = null;

/**
 * Retrieves the currently configured Subversive Alliance Discord guild ID.
 */
export async function getSubversiveGuildId(): Promise<string | null> {
	try {
		const [row] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, "subversive:guild_config"));

		const data = row?.data as { guildId?: string } | undefined;
		if (data?.guildId) {
			subversiveGuildIdCache = data.guildId;
			return subversiveGuildIdCache;
		}

		const serverTypes = await getServerTypeMappings();
		subversiveGuildIdCache =
			serverTypes.faction ?? DEFAULT_SERVER_TYPES.faction;
		return subversiveGuildIdCache;
	} catch {
		return DEFAULT_SERVER_TYPES.faction;
	}
}

/**
 * Synchronous check whether a guild is the active Subversive Alliance server.
 */
export function isSubversiveGuild(guildId: string | null | undefined): boolean {
	if (!guildId) return false;
	return subversiveGuildIdCache === guildId;
}

/**
 * Asynchronous check whether a guild is the active Subversive Alliance server.
 */
export async function isSubversiveGuildAsync(
	guildId: string | null | undefined,
): Promise<boolean> {
	if (!guildId) return false;
	if (subversiveGuildIdCache === guildId) return true;
	const current = await getSubversiveGuildId();
	return current === guildId;
}

/**
 * Retrieves the currently configured Mercenary Guild Discord guild ID.
 */
export async function getMercGuildId(): Promise<string | null> {
	try {
		const [row] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, "merc:guild_config"));

		const data = row?.data as { guildId?: string } | undefined;
		if (data?.guildId) {
			mercGuildIdCache = data.guildId;
			return mercGuildIdCache;
		}

		const serverTypes = await getServerTypeMappings();
		mercGuildIdCache = serverTypes.merc ?? DEFAULT_SERVER_TYPES.merc;
		return mercGuildIdCache;
	} catch {
		return DEFAULT_SERVER_TYPES.merc;
	}
}

/**
 * Synchronous check whether a guild is the active Mercenary Guild server.
 */
export function isMercGuild(guildId: string | null | undefined): boolean {
	if (!guildId) return false;
	return mercGuildIdCache === guildId || DEFAULT_SERVER_TYPES.merc === guildId;
}

/**
 * Asynchronous check whether a guild is the active Mercenary Guild server.
 */
export async function isMercGuildAsync(
	guildId: string | null | undefined,
): Promise<boolean> {
	if (!guildId) return false;
	if (mercGuildIdCache === guildId) return true;
	const current = await getMercGuildId();
	return current === guildId;
}

export interface MercChannelConfig {
	contractCreation: string | null;
	contractCreationMessageId?: string | null;
	upcomingContracts: string | null;
	targets: string | null;
	revivables?: string | null;
	revivablesMessageId?: string | null;
	mercLog: string | null;
	clientCategory: string | null;
	archiveCategory: string | null;
	updatedAt?: string | null;
	updatedBy?: string | null;
}

/**
 * Retrieves the mercenary channel configuration (contract creation, upcoming contracts, targets, revivables, merc log, categories) by channel name.
 */
export async function getMercChannelConfig(
	guildId: string,
): Promise<MercChannelConfig> {
	try {
		const [row] = await db
			.select()
			.from(mercChannelConfigs)
			.where(eq(mercChannelConfigs.guildId, guildId));

		if (row) {
			return {
				contractCreation: row.contractCreation ?? null,
				contractCreationMessageId: row.contractCreationMessageId ?? null,
				upcomingContracts: row.upcomingContracts ?? null,
				targets: row.targets ?? null,
				revivables: row.revivables ?? null,
				revivablesMessageId: row.revivablesMessageId ?? null,
				mercLog: row.mercLog ?? null,
				clientCategory: row.clientCategory ?? null,
				archiveCategory: row.archiveCategory ?? null,
				updatedAt: row.updatedAt?.toISOString() ?? null,
				updatedBy: row.updatedBy ?? null,
			};
		}

		// Fallback check to legacy systemStates for backward compatibility
		const [legacyRow] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, `merc:channel_config:${guildId}`));
		const data = legacyRow?.data as Partial<MercChannelConfig> | undefined;
		return {
			contractCreation: data?.contractCreation ?? null,
			contractCreationMessageId: data?.contractCreationMessageId ?? null,
			upcomingContracts: data?.upcomingContracts ?? null,
			targets: data?.targets ?? null,
			revivables: data?.revivables ?? null,
			revivablesMessageId: data?.revivablesMessageId ?? null,
			mercLog: data?.mercLog ?? null,
			clientCategory: data?.clientCategory ?? null,
			archiveCategory: data?.archiveCategory ?? null,
			updatedAt: data?.updatedAt ?? null,
			updatedBy: data?.updatedBy ?? null,
		};
	} catch {
		return {
			contractCreation: null,
			contractCreationMessageId: null,
			upcomingContracts: null,
			targets: null,
			revivables: null,
			revivablesMessageId: null,
			mercLog: null,
			clientCategory: null,
			archiveCategory: null,
			updatedAt: null,
			updatedBy: null,
		};
	}
}

/**
 * Updates the mercenary channel configuration using channel names (no channel IDs).
 */
export async function updateMercChannelConfig(
	guildId: string,
	config: Partial<MercChannelConfig>,
	updatedBy?: string,
): Promise<MercChannelConfig> {
	const current = await getMercChannelConfig(guildId);
	const cleanName = (val: string | null | undefined): string | null => {
		if (val === undefined) return undefined as unknown as string | null;
		if (val === null) return null;
		const trimmed = val.replace(/^#/, "").trim();
		return trimmed.length > 0 ? trimmed : null;
	};

	const contractCreation =
		config.contractCreation !== undefined
			? cleanName(config.contractCreation)
			: current.contractCreation;
	const contractCreationMessageId =
		config.contractCreationMessageId !== undefined
			? config.contractCreationMessageId
			: current.contractCreationMessageId;
	const upcomingContracts =
		config.upcomingContracts !== undefined
			? cleanName(config.upcomingContracts)
			: current.upcomingContracts;
	const targets =
		config.targets !== undefined ? cleanName(config.targets) : current.targets;
	const revivables =
		config.revivables !== undefined
			? cleanName(config.revivables)
			: current.revivables;
	const revivablesMessageId =
		config.revivablesMessageId !== undefined
			? config.revivablesMessageId
			: current.revivablesMessageId;
	const mercLog =
		config.mercLog !== undefined ? cleanName(config.mercLog) : current.mercLog;
	const clientCategory =
		config.clientCategory !== undefined
			? cleanName(config.clientCategory)
			: current.clientCategory;
	const archiveCategory =
		config.archiveCategory !== undefined
			? cleanName(config.archiveCategory)
			: current.archiveCategory;

	const now = new Date();

	await db
		.insert(mercChannelConfigs)
		.values({
			guildId,
			contractCreation,
			contractCreationMessageId,
			upcomingContracts,
			targets,
			revivables,
			revivablesMessageId,
			mercLog,
			clientCategory,
			archiveCategory,
			updatedBy: updatedBy ?? current.updatedBy ?? null,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: mercChannelConfigs.guildId,
			set: {
				contractCreation,
				contractCreationMessageId,
				upcomingContracts,
				targets,
				revivables,
				revivablesMessageId,
				mercLog,
				clientCategory,
				archiveCategory,
				updatedBy: updatedBy ?? current.updatedBy ?? null,
				updatedAt: now,
			},
		});

	return {
		contractCreation,
		contractCreationMessageId,
		upcomingContracts,
		targets,
		revivables,
		revivablesMessageId,
		mercLog,
		clientCategory,
		archiveCategory,
		updatedAt: now.toISOString(),
		updatedBy: updatedBy ?? current.updatedBy ?? null,
	};
}

/**
 * Updates the tracked message ID for the persistent revivables embed in Discord.
 */
export async function updateMercRevivablesMessageId(
	guildId: string,
	messageId: string | null,
): Promise<void> {
	await db
		.update(mercChannelConfigs)
		.set({
			revivablesMessageId: messageId,
			updatedAt: new Date(),
		})
		.where(eq(mercChannelConfigs.guildId, guildId));
}

/**
 * Fallback helper to retrieve target Discord guild IDs configured in environment variables (for legacy migration).
 */
function getLegacyEnvGuildIds(): string[] {
	const raw =
		getEnvVar("TARGET_GUILD_IDS") ||
		getEnvVar("DISCORD_GUILD_ID") ||
		getEnvVar("GUILD_ID") ||
		"";

	return raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => /^\d{17,20}$/.test(id));
}

/**
 * Retrieves all authorized target guild IDs from the database (including active Elims tournament guild).
 * Updates the in-memory cache for fast synchronous checks.
 */
export async function getTargetGuildIds(): Promise<string[]> {
	if (!cacheInitialized) {
		await reconcileTargetGuildsAndModules();
	}
	return Array.from(authorizedGuildsCache);
}

/**
 * Fast synchronous check against the in-memory authorized target guilds cache.
 */
export function isTargetGuild(guildId: string | null | undefined): boolean {
	if (!guildId) return false;
	if (authorizedGuildsCache.has(guildId)) return true;
	if (elimsGuildIdCache === guildId) return true;
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
	if (elimsGuildIdCache === guildId) return true;
	if (authorizedGuildsCache.has(guildId)) return true;

	// On cache miss, re-fetch from DB to guarantee fresh state across separate API and Bot processes
	const freshIds = await getTargetGuildIds();
	return freshIds.includes(guildId);
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
			moduleVerification: true,
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

export interface GuildCleanupResult {
	reconciledGuilds: string[];
	deauthorizedGuilds: string[];
	deactivatedModulesCount: number;
}

/**
 * Resolves the authoritative set of configured target guild IDs from environment variables and system state.
 */
export async function getAuthoritativeConfiguredGuildIds(): Promise<
	Set<string>
> {
	const set = new Set<string>();

	// 1. Designated Server Types from env
	const serverTypes = await getServerTypeMappings();
	for (const id of Object.values(serverTypes)) {
		if (id && /^\d{17,20}$/.test(id)) {
			set.add(id);
		}
	}

	// 2. Explicit TARGET_GUILD_IDS from env
	const legacyIds = getLegacyEnvGuildIds();
	for (const id of legacyIds) {
		set.add(id);
	}

	// 3. Dynamic Elims tournament guild (if active)
	const elimsId = await getElimsGuildId();
	if (elimsId && /^\d{17,20}$/.test(elimsId)) {
		set.add(elimsId);
	}

	return set;
}

/**
 * Reconciles all guild configurations against authoritative environment variables.
 * Automatically deauthorizes and disables active modules (verification cron, faction monitoring,
 * territory, reaction roles, giveaways) on orphaned/stale guilds that are no longer configured,
 * preventing scheduler and bot workers from executing ghost operations.
 */
export async function reconcileTargetGuildsAndModules(): Promise<GuildCleanupResult> {
	const authoritativeIds = await getAuthoritativeConfiguredGuildIds();

	// 1. Ensure all authoritative IDs exist in guild_configs and are marked authorized: true
	for (const guildId of authoritativeIds) {
		await db
			.insert(guildConfigs)
			.values({
				guildId,
				authorized: true,
				moduleVerification: true,
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
	}

	// 2. Scan all existing guildConfigs and deactivate any orphaned guilds
	const allConfigs = await db.query.guildConfigs.findMany();
	const deauthorized: string[] = [];
	let deactivatedCount = 0;

	for (const config of allConfigs) {
		if (!authoritativeIds.has(config.guildId)) {
			const hadActiveModules =
				config.authorized ||
				config.verifyCron ||
				config.moduleVerification ||
				config.moduleMonitoring ||
				config.moduleTerritory ||
				config.moduleReactionRoles ||
				config.moduleGiveaways;

			if (hadActiveModules) {
				await db
					.update(guildConfigs)
					.set({
						authorized: false,
						verifyCron: false,
						moduleVerification: false,
						moduleMonitoring: false,
						moduleTerritory: false,
						moduleReactionRoles: false,
						moduleGiveaways: false,
						updatedAt: new Date(),
					})
					.where(eq(guildConfigs.guildId, config.guildId));

				await db
					.update(guildMonitoredFactions)
					.set({
						revivesEnabled: false,
					})
					.where(eq(guildMonitoredFactions.guildId, config.guildId));

				deauthorized.push(config.guildId);
				deactivatedCount++;
			}
		}
	}

	// 3. Update the in-memory cache
	authorizedGuildsCache = new Set(authoritativeIds);
	cacheInitialized = true;

	return {
		reconciledGuilds: Array.from(authoritativeIds),
		deauthorizedGuilds: deauthorized,
		deactivatedModulesCount: deactivatedCount,
	};
}

/**
 * Ensures that default `guildConfigs` records exist for all target guilds and cleans up orphaned modules.
 */
export async function ensureTargetGuildConfigs(): Promise<GuildCleanupResult> {
	return reconcileTargetGuildsAndModules();
}

export interface GuildModuleStatus {
	verification: boolean;
	territory: boolean;
	reactionRoles: boolean;
	monitoring: boolean;
	giveaways: boolean;
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
			moduleGiveaways: true,
		},
	});

	return {
		verification: config?.moduleVerification ?? false,
		territory: config?.moduleTerritory ?? false,
		reactionRoles: config?.moduleReactionRoles ?? false,
		monitoring: config?.moduleMonitoring ?? false,
		giveaways: config?.moduleGiveaways ?? false,
	};
}

/**
 * Checks whether the Giveaway module is enabled for a guild.
 * For Elims tournament guilds, it is ALWAYS enabled.
 * For normal guilds, it requires explicit admin activation (module_giveaways = true).
 */
export async function isGiveawaysModuleEnabled(
	guildId: string,
): Promise<boolean> {
	if (await isElimsGuildAsync(guildId)) return true;
	const modules = await getGuildModules(guildId);
	return modules.giveaways;
}

export interface MercContractHitTerms {
	statuses: {
		online: boolean;
		idle: boolean;
		offline: boolean;
	};
	idleDurationMinutes: number | null;
	strickenHits: boolean;
	levelRange: [number, number];
}

/**
 * A window during which a contract was paused. Hits landing inside a window are
 * excluded from payout. An open window (resumedAt === null) extends to the present.
 */
export interface MercContractPauseWindow {
	pausedAt: string;
	resumedAt: string | null;
}

export interface MercContract {
	id: string;
	guildId: string;
	factionId: number;
	factionName: string;
	warStatusAtCreation: "no_war" | "upcoming" | "active";
	warId?: number | null;
	warStart?: number | null;
	warEnd?: number | null;
	warTarget?: number | null;
	warOpponent?: {
		id: number;
		name: string;
	} | null;
	startTime: string;
	startImmediately?: boolean;
	startMinutesBeforeWar?: number | null;
	endTime: string | null;
	endOnWarEnd?: boolean;
	terms: MercContractHitTerms;
	hitPrice: number;
	strickenHitPrice?: number | null;
	autoStopPrice?: number | null;
	changeTermsOnWarStart?: boolean;
	warStartTerms?: MercContractHitTerms | null;
	warStartHitPrice?: number | null;
	warStartStrickenHitPrice?: number | null;
	excludedMembers?: number[];
	pausedWindows?: MercContractPauseWindow[];
	status: "active" | "upcoming" | "paused" | "completed" | "cancelled";
	clientChannelId?: string | null;
	clientDiscordId?: string | null;
	upcomingMessageId?: string | null;
	upcomingChannelId?: string | null;
	createdAt: string;
	updatedAt?: string | null;
	createdBy?: string | null;
}

/**
 * Retrieves all mercenary contracts for a specific guild.
 * Automatically computes live status based on start/end timestamps.
 */
export async function getMercContracts(
	guildId: string,
): Promise<MercContract[]> {
	try {
		const rows = await db
			.select()
			.from(mercContracts)
			.where(eq(mercContracts.guildId, guildId))
			.orderBy(desc(mercContracts.createdAt));

		return rows.map(mapRowToMercContract);
	} catch {
		return [];
	}
}

/**
 * Retrieves a single mercenary contract by its ID, optionally scoped to a guild.
 */
export async function getMercContractById(
	contractId: string,
	guildId?: string,
): Promise<MercContract | null> {
	try {
		const conditions = [eq(mercContracts.id, contractId)];
		if (guildId) {
			conditions.push(eq(mercContracts.guildId, guildId));
		}
		const [row] = await db
			.select()
			.from(mercContracts)
			.where(and(...conditions));

		if (!row) return null;
		return mapRowToMercContract(row);
	} catch {
		return null;
	}
}

/**
 * Maps a raw database row from `merc_contracts` to the structured `MercContract` domain object.
 */
export function mapRowToMercContract(
	row: typeof mercContracts.$inferSelect,
): MercContract {
	const now = Date.now();
	const startMs = row.startTime ? row.startTime.getTime() : now;
	const endMs = row.endTime ? row.endTime.getTime() : null;

	let status: MercContract["status"] =
		(row.status as MercContract["status"]) ?? "active";
	if (status !== "cancelled") {
		if (endMs && endMs <= now) {
			status = "completed";
		} else if (status !== "paused" && status !== "completed") {
			if (startMs > now) {
				status = "upcoming";
			} else {
				status = "active";
			}
		}
	}

	return {
		id: row.id,
		guildId: row.guildId,
		factionId: row.factionId,
		factionName: row.factionName,
		warStatusAtCreation: row.warStatusAtCreation as
			| "no_war"
			| "upcoming"
			| "active",
		warId: row.warId ?? null,
		warStart: row.warStart ? Math.floor(row.warStart.getTime() / 1000) : null,
		warEnd: row.warEnd ? Math.floor(row.warEnd.getTime() / 1000) : null,
		warTarget: row.warTarget ?? null,
		warOpponent:
			row.warOpponentId && row.warOpponentName
				? { id: row.warOpponentId, name: row.warOpponentName }
				: null,
		startTime: row.startTime.toISOString(),
		startImmediately: row.startImmediately,
		startMinutesBeforeWar: row.startMinutesBeforeWar ?? null,
		endTime: row.endTime ? row.endTime.toISOString() : null,
		endOnWarEnd: row.endOnWarEnd,
		terms: {
			statuses: {
				online: row.allowOnline,
				idle: row.allowIdle,
				offline: row.allowOffline,
			},
			idleDurationMinutes: row.allowIdle ? (row.maxIdleMinutes ?? 15) : null,
			strickenHits: row.allowStrickenHits,
			levelRange: [row.minLevel, row.maxLevel],
		},
		hitPrice: row.hitPrice ?? 0,
		strickenHitPrice: row.strickenHitPrice ?? null,
		autoStopPrice: row.autoStopPrice ?? null,
		changeTermsOnWarStart: row.changeTermsOnWarStart,
		warStartTerms: row.changeTermsOnWarStart
			? {
					statuses: {
						online: row.warStartAllowOnline ?? true,
						idle: row.warStartAllowIdle ?? false,
						offline: row.warStartAllowOffline ?? false,
					},
					idleDurationMinutes: row.warStartAllowIdle
						? (row.warStartMaxIdleMinutes ?? 15)
						: null,
					strickenHits: row.warStartAllowStrickenHits ?? false,
					levelRange: [row.warStartMinLevel ?? 1, row.warStartMaxLevel ?? 100],
				}
			: null,
		warStartHitPrice: row.warStartHitPrice ?? null,
		warStartStrickenHitPrice: row.warStartStrickenHitPrice ?? null,
		excludedMembers: Array.isArray(row.excludedMembers)
			? (row.excludedMembers as number[])
			: [],
		pausedWindows: Array.isArray(row.pausedWindows)
			? (row.pausedWindows as MercContractPauseWindow[])
			: [],
		status,
		clientChannelId: row.clientChannelId ?? null,
		clientDiscordId: row.clientDiscordId ?? null,
		upcomingMessageId: row.upcomingMessageId ?? null,
		upcomingChannelId: row.upcomingChannelId ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt?.toISOString() ?? null,
		createdBy: row.createdBy ?? null,
	};
}

/**
 * Creates a new mercenary contract for a guild.
 */
export async function createMercContract(
	guildId: string,
	contractData: Omit<MercContract, "id" | "guildId" | "createdAt" | "status">,
	createdBy?: string,
): Promise<MercContract> {
	const now = new Date();
	const startMs = contractData.startTime
		? new Date(contractData.startTime).getTime()
		: now.getTime();
	const endMs = contractData.endTime
		? new Date(contractData.endTime).getTime()
		: null;

	let status: MercContract["status"] = "active";
	if (endMs && endMs <= now.getTime()) {
		status = "completed";
	} else if (startMs > now.getTime()) {
		status = "upcoming";
	}

	const [created] = await db
		.insert(mercContracts)
		.values({
			guildId,
			factionId: contractData.factionId,
			factionName: contractData.factionName,
			warStatusAtCreation: contractData.warStatusAtCreation,
			warId: contractData.warId ?? null,
			warStart: contractData.warStart
				? new Date(contractData.warStart * 1000)
				: null,
			warEnd: contractData.warEnd ? new Date(contractData.warEnd * 1000) : null,
			warTarget: contractData.warTarget ?? null,
			warOpponentId: contractData.warOpponent?.id ?? null,
			warOpponentName: contractData.warOpponent?.name ?? null,

			startTime: new Date(contractData.startTime),
			startImmediately: contractData.startImmediately ?? false,
			startMinutesBeforeWar: contractData.startMinutesBeforeWar ?? null,
			endTime: contractData.endTime ? new Date(contractData.endTime) : null,
			endOnWarEnd: contractData.endOnWarEnd ?? false,

			allowOnline: contractData.terms.statuses.online,
			allowIdle: contractData.terms.statuses.idle,
			allowOffline: contractData.terms.statuses.offline,
			maxIdleMinutes: contractData.terms.idleDurationMinutes ?? 15,
			allowStrickenHits: contractData.terms.strickenHits,
			minLevel: contractData.terms.levelRange[0],
			maxLevel: contractData.terms.levelRange[1],

			hitPrice: contractData.hitPrice ?? 0,
			strickenHitPrice: contractData.strickenHitPrice ?? null,
			autoStopPrice:
				contractData.autoStopPrice !== null &&
				contractData.autoStopPrice !== undefined
					? Math.max(0, Number(contractData.autoStopPrice))
					: null,

			changeTermsOnWarStart: contractData.changeTermsOnWarStart ?? false,
			warStartAllowOnline: contractData.warStartTerms?.statuses.online ?? null,
			warStartAllowIdle: contractData.warStartTerms?.statuses.idle ?? null,
			warStartAllowOffline:
				contractData.warStartTerms?.statuses.offline ?? null,
			warStartMaxIdleMinutes:
				contractData.warStartTerms?.idleDurationMinutes ?? null,
			warStartAllowStrickenHits:
				contractData.warStartTerms?.strickenHits ?? null,
			warStartMinLevel: contractData.warStartTerms?.levelRange[0] ?? null,
			warStartMaxLevel: contractData.warStartTerms?.levelRange[1] ?? null,
			warStartHitPrice: contractData.warStartHitPrice ?? null,
			warStartStrickenHitPrice: contractData.warStartStrickenHitPrice ?? null,
			excludedMembers: contractData.excludedMembers ?? [],

			status,
			clientChannelId: contractData.clientChannelId ?? null,
			clientDiscordId: contractData.clientDiscordId ?? null,
			createdBy: createdBy ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	if (!created) {
		throw new Error("Failed to insert mercenary contract.");
	}

	return {
		id: created.id,
		guildId: created.guildId,
		factionId: created.factionId,
		factionName: created.factionName,
		warStatusAtCreation: created.warStatusAtCreation as
			| "no_war"
			| "upcoming"
			| "active",
		warId: created.warId ?? null,
		warStart: created.warStart
			? Math.floor(created.warStart.getTime() / 1000)
			: null,
		warEnd: created.warEnd ? Math.floor(created.warEnd.getTime() / 1000) : null,
		warTarget: created.warTarget ?? null,
		warOpponent:
			created.warOpponentId && created.warOpponentName
				? { id: created.warOpponentId, name: created.warOpponentName }
				: null,
		startTime: created.startTime.toISOString(),
		startImmediately: created.startImmediately,
		startMinutesBeforeWar: created.startMinutesBeforeWar ?? null,
		endTime: created.endTime ? created.endTime.toISOString() : null,
		endOnWarEnd: created.endOnWarEnd,
		terms: {
			statuses: {
				online: created.allowOnline,
				idle: created.allowIdle,
				offline: created.allowOffline,
			},
			idleDurationMinutes: created.allowIdle ? created.maxIdleMinutes : null,
			strickenHits: created.allowStrickenHits,
			levelRange: [created.minLevel, created.maxLevel],
		},
		hitPrice: created.hitPrice ?? 0,
		strickenHitPrice: created.strickenHitPrice ?? null,
		changeTermsOnWarStart: created.changeTermsOnWarStart,
		warStartTerms: created.changeTermsOnWarStart
			? {
					statuses: {
						online: created.warStartAllowOnline ?? true,
						idle: created.warStartAllowIdle ?? false,
						offline: created.warStartAllowOffline ?? false,
					},
					idleDurationMinutes: created.warStartAllowIdle
						? (created.warStartMaxIdleMinutes ?? 15)
						: null,
					strickenHits: created.warStartAllowStrickenHits ?? false,
					levelRange: [
						created.warStartMinLevel ?? 1,
						created.warStartMaxLevel ?? 100,
					],
				}
			: null,
		warStartHitPrice: created.warStartHitPrice ?? null,
		warStartStrickenHitPrice: created.warStartStrickenHitPrice ?? null,
		excludedMembers: Array.isArray(created.excludedMembers)
			? (created.excludedMembers as number[])
			: [],
		status,
		clientChannelId: created.clientChannelId ?? null,
		clientDiscordId: created.clientDiscordId ?? null,
		upcomingMessageId: created.upcomingMessageId ?? null,
		upcomingChannelId: created.upcomingChannelId ?? null,
		createdAt: created.createdAt.toISOString(),
		updatedAt: created.updatedAt?.toISOString() ?? null,
		createdBy: created.createdBy ?? null,
	};
}

/**
 * Updates an existing mercenary contract.
 */
export async function updateMercContract(
	guildId: string,
	contractId: string,
	updates: Partial<MercContract>,
): Promise<MercContract | null> {
	const [existingRow] = await db
		.select()
		.from(mercContracts)
		.where(
			and(eq(mercContracts.guildId, guildId), eq(mercContracts.id, contractId)),
		)
		.limit(1);

	if (!existingRow) return null;

	// ── Pause window bookkeeping ────────────────────────────────────────────
	// Entering "paused" opens a window; leaving "paused" closes the open one.
	// Hits landing inside a window are excluded from payout by the validator.
	let nextPausedWindows: MercContractPauseWindow[] = Array.isArray(
		existingRow.pausedWindows,
	)
		? (existingRow.pausedWindows as MercContractPauseWindow[])
		: [];

	if (updates.status !== undefined && updates.status !== existingRow.status) {
		const nowIso = new Date().toISOString();

		if (updates.status === "paused") {
			const alreadyOpen = nextPausedWindows.some((w) => w.resumedAt === null);
			if (!alreadyOpen) {
				nextPausedWindows = [
					...nextPausedWindows,
					{ pausedAt: nowIso, resumedAt: null },
				];
			}
		} else if (existingRow.status === "paused") {
			nextPausedWindows = nextPausedWindows.map((w) =>
				w.resumedAt === null ? { ...w, resumedAt: nowIso } : w,
			);
		}
	}

	const pausedWindowsChanged =
		updates.status !== undefined && updates.status !== existingRow.status;

	// ── start time guard ────────────────────────────────────────────────────
	// When editing an already started contract, start time must not be editable.
	const isAlreadyStarted =
		existingRow.status === "active" ||
		existingRow.status === "paused" ||
		existingRow.status === "completed" ||
		existingRow.status === "cancelled" ||
		existingRow.startTime.getTime() <= Date.now();

	let resolvedStartTime: Date | undefined;
	if (!isAlreadyStarted) {
		if (updates.startImmediately === true) {
			resolvedStartTime = new Date();
		} else if (updates.startTime !== undefined) {
			resolvedStartTime = new Date(updates.startTime);
		}
	}

	const [updated] = await db
		.update(mercContracts)
		.set({
			...(updates.status !== undefined ? { status: updates.status } : {}),
			...(resolvedStartTime !== undefined
				? { startTime: resolvedStartTime }
				: {}),
			...(updates.pausedWindows !== undefined
				? { pausedWindows: updates.pausedWindows }
				: // Only persist when a status transition actually opened/closed a window.
					pausedWindowsChanged
					? { pausedWindows: nextPausedWindows }
					: {}),
			...(!isAlreadyStarted && updates.startImmediately !== undefined
				? { startImmediately: updates.startImmediately }
				: {}),
			...(!isAlreadyStarted && updates.startMinutesBeforeWar !== undefined
				? { startMinutesBeforeWar: updates.startMinutesBeforeWar }
				: {}),
			...(updates.endTime !== undefined
				? { endTime: updates.endTime ? new Date(updates.endTime) : null }
				: {}),
			...(updates.endOnWarEnd !== undefined
				? { endOnWarEnd: updates.endOnWarEnd }
				: {}),
			...(updates.terms !== undefined
				? {
						allowOnline: updates.terms.statuses.online,
						allowIdle: updates.terms.statuses.idle,
						allowOffline: updates.terms.statuses.offline,
						maxIdleMinutes: updates.terms.idleDurationMinutes ?? 15,
						allowStrickenHits: updates.terms.strickenHits,
						minLevel: updates.terms.levelRange[0],
						maxLevel: updates.terms.levelRange[1],
					}
				: {}),
			...(updates.hitPrice !== undefined ? { hitPrice: updates.hitPrice } : {}),
			...(updates.strickenHitPrice !== undefined
				? { strickenHitPrice: updates.strickenHitPrice }
				: {}),
			...(updates.autoStopPrice !== undefined
				? {
						autoStopPrice:
							updates.autoStopPrice !== null &&
							updates.autoStopPrice !== undefined
								? Math.max(0, Number(updates.autoStopPrice))
								: null,
					}
				: {}),
			...(updates.changeTermsOnWarStart !== undefined
				? { changeTermsOnWarStart: updates.changeTermsOnWarStart }
				: {}),
			...(updates.warStartTerms !== undefined
				? {
						warStartAllowOnline: updates.warStartTerms?.statuses.online ?? null,
						warStartAllowIdle: updates.warStartTerms?.statuses.idle ?? null,
						warStartAllowOffline:
							updates.warStartTerms?.statuses.offline ?? null,
						warStartMaxIdleMinutes:
							updates.warStartTerms?.idleDurationMinutes ?? null,
						warStartAllowStrickenHits:
							updates.warStartTerms?.strickenHits ?? null,
						warStartMinLevel: updates.warStartTerms?.levelRange[0] ?? null,
						warStartMaxLevel: updates.warStartTerms?.levelRange[1] ?? null,
					}
				: {}),
			...(updates.warStartHitPrice !== undefined
				? { warStartHitPrice: updates.warStartHitPrice }
				: {}),
			...(updates.warStartStrickenHitPrice !== undefined
				? { warStartStrickenHitPrice: updates.warStartStrickenHitPrice }
				: {}),
			...(updates.excludedMembers !== undefined
				? { excludedMembers: updates.excludedMembers }
				: {}),
			...(updates.upcomingMessageId !== undefined
				? { upcomingMessageId: updates.upcomingMessageId }
				: {}),
			...(updates.upcomingChannelId !== undefined
				? { upcomingChannelId: updates.upcomingChannelId }
				: {}),
			updatedAt: new Date(),
		})
		.where(
			and(eq(mercContracts.guildId, guildId), eq(mercContracts.id, contractId)),
		)
		.returning();

	if (!updated) return null;

	const all = await getMercContracts(guildId);
	return all.find((c) => c.id === contractId) ?? null;
}

/**
 * Deletes a mercenary contract.
 */
export async function deleteMercContract(
	guildId: string,
	contractId: string,
): Promise<boolean> {
	const deleted = await db
		.delete(mercContracts)
		.where(
			and(eq(mercContracts.guildId, guildId), eq(mercContracts.id, contractId)),
		)
		.returning({ id: mercContracts.id });

	return deleted.length > 0;
}

/**
 * Records a validated hit for a mercenary contract, preventing duplicates.
 */
export async function recordMercContractHit(data: {
	contractId: string;
	guildId: string;
	attackId: number;
	attackerId: number;
	attackerName: string;
	attackerFactionId?: number | null;
	attackerFactionName?: string | null;
	defenderId: number;
	defenderName: string;
	result: string;
	isStricken: boolean;
	payoutValue: number;
	timestamp: Date;
}): Promise<boolean> {
	try {
		const [inserted] = await db
			.insert(mercContractHits)
			.values({
				contractId: data.contractId,
				guildId: data.guildId,
				attackId: data.attackId,
				attackerId: data.attackerId,
				attackerName: data.attackerName,
				attackerFactionId: data.attackerFactionId ?? null,
				attackerFactionName: data.attackerFactionName ?? null,
				defenderId: data.defenderId,
				defenderName: data.defenderName,
				result: data.result,
				isStricken: data.isStricken,
				payoutValue: data.payoutValue,
				timestamp: data.timestamp,
			})
			.onConflictDoNothing()
			.returning({ id: mercContractHits.id });

		return Boolean(inserted);
	} catch (err) {
		console.error("Failed to record merc contract hit:", err);
		return false;
	}
}

/**
 * Checks if a specific Torn attack ID has already been processed and credited.
 */
export async function isAttackProcessed(
	attackId: number,
	contractId?: string,
): Promise<boolean> {
	const conditions = [eq(mercContractHits.attackId, attackId)];
	if (contractId) {
		conditions.push(eq(mercContractHits.contractId, contractId));
	}
	const [row] = await db
		.select({ id: mercContractHits.id })
		.from(mercContractHits)
		.where(and(...conditions));

	return Boolean(row);
}

/**
 * Retrieves all validated hits for a mercenary contract.
 */
export async function getMercContractHits(contractId: string) {
	return await db
		.select()
		.from(mercContractHits)
		.where(eq(mercContractHits.contractId, contractId))
		.orderBy(desc(mercContractHits.timestamp));
}

export interface MercPayoutSummary {
	attackerId: number;
	attackerName: string;
	attackerFactionId: number | null;
	attackerFactionName: string | null;
	totalHits: number;
	standardHits: number;
	strickenHits: number;
	totalPayout: number;
}

export interface FactionMercPayoutSummary {
	factionId: number | null;
	factionName: string;
	totalHits: number;
	totalPayout: number;
	mercs: MercPayoutSummary[];
}

export interface MercTargetSummary {
	defenderId: number;
	defenderName: string;
	totalHits: number;
	standardHitsReceived: number;
	strickenHitsReceived: number;
}

export interface MercContractSummaryReport {
	contractId: string;
	totalHits: number;
	totalPayout: number;
	mercPayouts: MercPayoutSummary[];
	factionPayouts: FactionMercPayoutSummary[];
	targetBreakdown: MercTargetSummary[];
}

/**
 * Computes end-of-contract aggregations for mercenary payouts and target breakdowns.
 */
export async function getMercContractSummary(
	contractId: string,
): Promise<MercContractSummaryReport> {
	const hits = await getMercContractHits(contractId);

	// Collect any attacker IDs that lack faction info to resolve via verifiedUsers
	const missingFactionAttackerIds = new Set<number>();
	for (const hit of hits) {
		if (!hit.attackerFactionId && !hit.attackerFactionName) {
			missingFactionAttackerIds.add(hit.attackerId);
		}
	}

	const fallbackFactionMap = new Map<
		number,
		{ factionId: number | null; factionName: string }
	>();
	if (missingFactionAttackerIds.size > 0) {
		try {
			const verifiedRows = await db
				.select({
					tornId: verifiedUsers.tornId,
					factionId: verifiedUsers.factionId,
					factionTag: verifiedUsers.factionTag,
				})
				.from(verifiedUsers)
				.where(
					inArray(verifiedUsers.tornId, Array.from(missingFactionAttackerIds)),
				);

			for (const v of verifiedRows) {
				if (v.factionId) {
					fallbackFactionMap.set(v.tornId, {
						factionId: v.factionId,
						factionName: v.factionTag || `Faction #${v.factionId}`,
					});
				}
			}
		} catch {
			// Gracefully ignore fallback lookup errors
		}
	}

	const mercMap = new Map<number, MercPayoutSummary>();
	const targetMap = new Map<number, MercTargetSummary>();
	let grandTotalPayout = 0;

	for (const hit of hits) {
		grandTotalPayout += hit.payoutValue;

		const fallback = fallbackFactionMap.get(hit.attackerId);
		const factionId = hit.attackerFactionId ?? fallback?.factionId ?? null;
		const factionName =
			hit.attackerFactionName ??
			fallback?.factionName ??
			(factionId ? `Faction #${factionId}` : "Independent");

		// Attacker (Mercenary)
		let merc = mercMap.get(hit.attackerId);
		if (!merc) {
			merc = {
				attackerId: hit.attackerId,
				attackerName: hit.attackerName,
				attackerFactionId: factionId,
				attackerFactionName: factionName,
				totalHits: 0,
				standardHits: 0,
				strickenHits: 0,
				totalPayout: 0,
			};
			mercMap.set(hit.attackerId, merc);
		} else if (
			!merc.attackerFactionId &&
			(factionId || factionName !== "Independent")
		) {
			merc.attackerFactionId = factionId;
			merc.attackerFactionName = factionName;
		}

		merc.totalHits += 1;
		if (hit.isStricken) {
			merc.strickenHits += 1;
		} else {
			merc.standardHits += 1;
		}
		merc.totalPayout += hit.payoutValue;

		// Defender (Target)
		let target = targetMap.get(hit.defenderId);
		if (!target) {
			target = {
				defenderId: hit.defenderId,
				defenderName: hit.defenderName,
				totalHits: 0,
				standardHitsReceived: 0,
				strickenHitsReceived: 0,
			};
			targetMap.set(hit.defenderId, target);
		}
		target.totalHits += 1;
		if (hit.isStricken) {
			target.strickenHitsReceived += 1;
		} else {
			target.standardHitsReceived += 1;
		}
	}

	const mercPayouts = Array.from(mercMap.values()).sort(
		(a, b) => b.totalPayout - a.totalPayout,
	);
	const targetBreakdown = Array.from(targetMap.values()).sort(
		(a, b) => b.totalHits - a.totalHits,
	);

	// Group mercs by faction
	const factionGroupMap = new Map<string, FactionMercPayoutSummary>();
	for (const merc of mercPayouts) {
		const key = merc.attackerFactionId
			? String(merc.attackerFactionId)
			: (merc.attackerFactionName ?? "Independent");
		let group = factionGroupMap.get(key);
		if (!group) {
			group = {
				factionId: merc.attackerFactionId ?? null,
				factionName: merc.attackerFactionName ?? "Independent",
				totalHits: 0,
				totalPayout: 0,
				mercs: [],
			};
			factionGroupMap.set(key, group);
		}
		group.totalHits += merc.totalHits;
		group.totalPayout += merc.totalPayout;
		group.mercs.push(merc);
	}

	// Sort mercs within each faction by payout descending
	for (const group of factionGroupMap.values()) {
		group.mercs.sort((a, b) => b.totalPayout - a.totalPayout);
	}

	const factionPayouts = Array.from(factionGroupMap.values()).sort(
		(a, b) => b.totalPayout - a.totalPayout,
	);

	return {
		contractId,
		totalHits: hits.length,
		totalPayout: grandTotalPayout,
		mercPayouts,
		factionPayouts,
		targetBreakdown,
	};
}

/**
 * Creates a single-use expiring contract creation session token.
 */
export async function createMercContractToken(data: {
	guildId: string;
	channelId?: string | null;
	discordUserId: string;
	discordUsername?: string | null;
	factionId: number;
	factionName?: string | null;
	ttlMinutes?: number;
}): Promise<string> {
	const ttl = data.ttlMinutes ?? 30;
	const expiresAt = new Date(Date.now() + ttl * 60 * 1000);
	const token = crypto.randomUUID();

	await db.insert(mercContractTokens).values({
		token,
		guildId: data.guildId,
		channelId: data.channelId ?? null,
		discordUserId: data.discordUserId,
		discordUsername: data.discordUsername ?? null,
		factionId: data.factionId,
		factionName: data.factionName ?? null,
		used: false,
		expiresAt,
	});

	return token;
}

/**
 * Retrieves an existing mercenary contract creation token.
 */
export async function getMercContractToken(
	token: string,
): Promise<typeof mercContractTokens.$inferSelect | null> {
	const [row] = await db
		.select()
		.from(mercContractTokens)
		.where(eq(mercContractTokens.token, token));

	return row ?? null;
}

/**
 * Marks a contract creation session token as used.
 */
export async function markMercContractTokenUsed(
	token: string,
): Promise<boolean> {
	const [updated] = await db
		.update(mercContractTokens)
		.set({ used: true })
		.where(eq(mercContractTokens.token, token))
		.returning({ token: mercContractTokens.token });

	return Boolean(updated);
}

/**
 * Retrieves expired, unused, and unarchived contract creation session tokens.
 */
export async function getExpiredUnusedMercContractTokens(): Promise<
	(typeof mercContractTokens.$inferSelect)[]
> {
	const now = new Date();
	return db
		.select()
		.from(mercContractTokens)
		.where(
			and(
				eq(mercContractTokens.used, false),
				eq(mercContractTokens.archived, false),
				lte(mercContractTokens.expiresAt, now),
			),
		);
}

/**
 * Checks if an active or upcoming mercenary contract exists for a client channel.
 */
export async function hasActiveMercContractForChannel(
	channelId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: mercContracts.id })
		.from(mercContracts)
		.where(
			and(
				eq(mercContracts.clientChannelId, channelId),
				inArray(mercContracts.status, ["active", "upcoming"]),
			),
		)
		.limit(1);

	return Boolean(row);
}

/**
 * Checks if a newer, unexpired and unused session token exists for a client channel.
 */
export async function hasActiveMercContractTokenForChannel(
	channelId: string,
): Promise<boolean> {
	const now = new Date();
	const [row] = await db
		.select({ token: mercContractTokens.token })
		.from(mercContractTokens)
		.where(
			and(
				eq(mercContractTokens.channelId, channelId),
				eq(mercContractTokens.used, false),
				gt(mercContractTokens.expiresAt, now),
			),
		)
		.limit(1);

	return Boolean(row);
}

/**
 * Marks contract creation session tokens as archived.
 */
export async function markMercContractTokensArchived(
	tokens: string[],
): Promise<number> {
	if (tokens.length === 0) return 0;
	const updated = await db
		.update(mercContractTokens)
		.set({ archived: true })
		.where(inArray(mercContractTokens.token, tokens))
		.returning({ token: mercContractTokens.token });

	return updated.length;
}
