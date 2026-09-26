import {
	and,
	apiKeys,
	db,
	eq,
	ne,
	subversiveApiKeys,
	tornUsers,
	users,
	verifiedUsers,
} from "@sentinel/database";
import { decryptApiKey, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

const logger = new Logger("ResolveDiscordTornUser");

export interface ResolvedTornUser {
	tornId: number;
	tornName: string;
}

interface TornUserApiResponse {
	profile?: {
		id?: number;
		name?: string;
	};
	player_id?: number;
	name?: string;
	faction?: {
		id?: number;
		tag?: string;
	};
	discord?: {
		discord_id?: string;
	};
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Finds an available Torn API key to perform Discord user verification.
 * Checks Subversive API keys, then system keys, then environment variables.
 */
async function getLookupApiKey(): Promise<string | undefined> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";

	try {
		const [subKey] = await db
			.select()
			.from(subversiveApiKeys)
			.where(eq(subversiveApiKeys.isValid, true))
			.limit(1);

		if (subKey?.apiKeyEncrypted) {
			return subKey.apiKeyEncrypted.length > 16 && masterKey
				? decryptApiKey(subKey.apiKeyEncrypted, masterKey)
				: subKey.apiKeyEncrypted;
		}
	} catch (err) {
		logger.warn("Failed querying subversiveApiKeys:", err);
	}

	try {
		const [sysKey] = await db
			.select()
			.from(apiKeys)
			.where(eq(apiKeys.isValid, true))
			.limit(1);

		if (sysKey?.apiKeyEncrypted) {
			return sysKey.apiKeyEncrypted.length > 16 && masterKey
				? decryptApiKey(sysKey.apiKeyEncrypted, masterKey)
				: sysKey.apiKeyEncrypted;
		}
	} catch (err) {
		logger.warn("Failed querying apiKeys:", err);
	}

	return process.env.TORN_API_KEY;
}

/**
 * Resolves a Discord user ID to their Torn player ID and name.
 * Uses tornUsers cache if checked within 7 days.
 * Otherwise, queries the Torn API (/user/?selections=discord,profile&id=discordId)
 * and stores/updates the result in tornUsers and verifiedUsers.
 */
export async function resolveDiscordTornUser(
	discordId: string,
	forceRefresh = false,
): Promise<ResolvedTornUser | null> {
	// 1. Check tornUsers registry
	let cachedTornUser: typeof tornUsers.$inferSelect | undefined;
	try {
		const [found] = await db
			.select()
			.from(tornUsers)
			.where(eq(tornUsers.discordId, discordId));
		cachedTornUser = found;
	} catch (err) {
		logger.warn(`Failed reading tornUsers for Discord ${discordId}:`, err);
	}

	const isFresh =
		cachedTornUser?.updatedAt &&
		Date.now() - new Date(cachedTornUser.updatedAt).getTime() < SEVEN_DAYS_MS;

	if (cachedTornUser && isFresh && !forceRefresh) {
		return {
			tornId: cachedTornUser.tornId,
			tornName: cachedTornUser.name,
		};
	}

	// 2. Fallback check verifiedUsers cache
	let cachedVerified: typeof verifiedUsers.$inferSelect | undefined;
	try {
		const [found] = await db
			.select()
			.from(verifiedUsers)
			.where(eq(verifiedUsers.discordId, discordId));
		cachedVerified = found;
	} catch (err) {
		logger.warn(`Failed reading verifiedUsers for Discord ${discordId}:`, err);
	}

	// 3. Fetch from Torn API
	try {
		const apiKey = await getLookupApiKey();
		const response = (await tornApi.get("/user", {
			apiKey,
			queryParams: {
				selections: ["discord", "profile"],
				id: discordId,
			},
		})) as TornUserApiResponse;

		const tornId = response?.profile?.id ?? response?.player_id;
		const tornName = response?.profile?.name ?? response?.name;

		if (tornId && tornName) {
			const now = new Date();
			// Update general tornUsers table
			try {
				await db
					.update(tornUsers)
					.set({ discordId: null })
					.where(
						and(
							eq(tornUsers.discordId, discordId),
							ne(tornUsers.tornId, tornId),
						),
					);

				await db
					.insert(tornUsers)
					.values({
						tornId,
						name: tornName,
						discordId,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: tornUsers.tornId,
						set: {
							name: tornName,
							discordId,
							updatedAt: now,
						},
					});
			} catch (dbErr) {
				logger.warn(`Failed updating tornUsers cache for ${discordId}:`, dbErr);
			}

			// Update legacy verifiedUsers table for backwards compatibility
			try {
				await db
					.insert(verifiedUsers)
					.values({
						discordId,
						tornId,
						tornName,
						factionId: response?.faction?.id ?? null,
						factionTag: response?.faction?.tag ?? null,
						lastCheckedAt: now,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: verifiedUsers.discordId,
						set: {
							tornId,
							tornName,
							factionId: response?.faction?.id ?? null,
							factionTag: response?.faction?.tag ?? null,
							lastCheckedAt: now,
							updatedAt: now,
						},
					});
			} catch (dbErr) {
				logger.warn(
					`Failed updating verifiedUsers cache for ${discordId}:`,
					dbErr,
				);
			}

			return { tornId, tornName };
		}
	} catch (apiErr) {
		logger.warn(
			`Torn API lookup failed for Discord ID ${discordId}:`,
			apiErr instanceof Error ? apiErr.message : String(apiErr),
		);
	}

	// 4. Fallback: If Torn API query failed but we had a cached record, return it
	if (cachedTornUser?.tornId && cachedTornUser?.name) {
		return {
			tornId: cachedTornUser.tornId,
			tornName: cachedTornUser.name,
		};
	}
	if (cachedVerified?.tornId && cachedVerified?.tornName) {
		return {
			tornId: cachedVerified.tornId,
			tornName: cachedVerified.tornName,
		};
	}

	// 5. Fallback: Check OAuth users table
	try {
		const [authUser] = await db
			.select({
				tornId: users.tornId,
				username: users.username,
			})
			.from(users)
			.where(eq(users.discordId, discordId));

		if (authUser?.tornId && authUser?.username) {
			return {
				tornId: authUser.tornId,
				tornName: authUser.username,
			};
		}
	} catch (dbErr) {
		logger.warn(`Failed checking users table for Discord ${discordId}:`, dbErr);
	}

	return null;
}

/**
 * Resolves a Torn user by either tornId or discordId.
 * Checks tornUsers first (O(1)), then Torn API if missing/stale.
 */
export async function resolveTornUser(
	query: { tornId?: number; discordId?: string },
	forceRefresh = false,
): Promise<ResolvedTornUser | null> {
	if (query.discordId) {
		return resolveDiscordTornUser(query.discordId, forceRefresh);
	}
	if (!query.tornId) return null;

	const tornId = query.tornId;

	// 1. Check tornUsers registry by tornId
	let cached: typeof tornUsers.$inferSelect | undefined;
	try {
		const [found] = await db
			.select()
			.from(tornUsers)
			.where(eq(tornUsers.tornId, tornId));
		cached = found;
	} catch (err) {
		logger.warn(`Failed reading tornUsers for Torn ID ${tornId}:`, err);
	}

	const isFresh =
		cached?.updatedAt &&
		Date.now() - new Date(cached.updatedAt).getTime() < SEVEN_DAYS_MS;

	if (cached && isFresh && !forceRefresh) {
		return {
			tornId: cached.tornId,
			tornName: cached.name,
		};
	}

	// 2. Fetch from Torn API
	try {
		const apiKey = await getLookupApiKey();
		const response = (await tornApi.get("/user", {
			apiKey,
			queryParams: {
				selections: ["discord", "profile"],
				id: tornId,
			},
		})) as TornUserApiResponse;

		const profileId = response?.profile?.id ?? response?.player_id ?? tornId;
		const tornName = response?.profile?.name ?? response?.name;
		const discordId = response?.discord?.discord_id || null;

		if (profileId && tornName) {
			const now = new Date();
			try {
				if (discordId) {
					await db
						.update(tornUsers)
						.set({ discordId: null })
						.where(
							and(
								eq(tornUsers.discordId, discordId),
								ne(tornUsers.tornId, profileId),
							),
						);
				}

				await db
					.insert(tornUsers)
					.values({
						tornId: profileId,
						name: tornName,
						discordId,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: tornUsers.tornId,
						set: {
							name: tornName,
							discordId,
							updatedAt: now,
						},
					});
			} catch (dbErr) {
				logger.warn(`Failed updating tornUsers cache for ${profileId}:`, dbErr);
			}

			return { tornId: profileId, tornName };
		}
	} catch (apiErr) {
		logger.warn(
			`Torn API lookup failed for Torn ID ${tornId}:`,
			apiErr instanceof Error ? apiErr.message : String(apiErr),
		);
	}

	if (cached?.tornId && cached?.name) {
		return {
			tornId: cached.tornId,
			tornName: cached.name,
		};
	}

	return null;
}
