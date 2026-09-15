import { db, eq, subversiveTargetFinderUsers } from "@sentinel/database";
import {
	decryptApiKey,
	getActiveSystemKeyPool,
	KeyHealthManager,
	type ManagedApiKey,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

const logger = new Logger("SubversiveKeyPool");

export const subversiveKeyHealthManager = new KeyHealthManager(
	process.env.ENCRYPTION_KEY ?? "subversive-key-pepper",
);

export function markSubversiveKeyDisabled(
	apiKey: string,
	_errorCode = 13,
): number {
	return subversiveKeyHealthManager.markTemporarilyDisabled(apiKey);
}

export function recordSubversiveKeySuccess(apiKey: string): void {
	subversiveKeyHealthManager.recordSuccessfulUse(apiKey);
}

let roundRobinIndex = 0;

/**
 * Retrieves all active API keys strictly enrolled through the Subversive Target Finder userscript.
 */
export async function getSubversiveUserKeys(): Promise<ManagedApiKey[]> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";
	if (!masterKey) {
		logger.error("ENCRYPTION_KEY is not set in environment.");
		return [];
	}

	try {
		const activeUsers = await db
			.select({
				tornId: subversiveTargetFinderUsers.tornId,
				apiKeyEncrypted: subversiveTargetFinderUsers.apiKeyEncrypted,
			})
			.from(subversiveTargetFinderUsers)
			.where(eq(subversiveTargetFinderUsers.isActive, true));

		if (activeUsers.length === 0) {
			return [];
		}

		const keys: ManagedApiKey[] = [];
		for (const u of activeUsers) {
			try {
				const plainKey =
					u.apiKeyEncrypted.length > 16
						? decryptApiKey(u.apiKeyEncrypted, masterKey)
						: u.apiKeyEncrypted;

				if (plainKey && plainKey.length === 16) {
					keys.push({
						apiKey: plainKey,
						userId: u.tornId,
						keyType: "custom",
					});
				}
			} catch (err) {
				logger.warn(
					`Failed to decrypt API key for user ${u.tornId}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return keys;
	} catch (error) {
		logger.error("Failed to fetch Subversive Target Finder keys:", error);
		return [];
	}
}

/**
 * Checks whether at least one active user or system key is available.
 */
export async function hasActiveSubversiveKeys(): Promise<boolean> {
	const userKeys = await getSubversiveUserKeys();
	const activeUsers = userKeys.filter(
		(k) => !subversiveKeyHealthManager.isKeyTemporarilyDisabled(k.apiKey),
	);
	if (activeUsers.length > 0) return true;
	try {
		const systemKeys = await getActiveSystemKeyPool();
		const activeSystem = systemKeys.filter(
			(k) => !subversiveKeyHealthManager.isKeyTemporarilyDisabled(k.apiKey),
		);
		return activeSystem.length > 0;
	} catch {
		return false;
	}
}

/**
 * Returns the next available key in round-robin sequence.
 * If <= 1 user key is enrolled, falls back to load balance with system keys
 * to keep individual request frequencies safely below rate limits.
 */
export async function getNextSubversiveUserKey(): Promise<ManagedApiKey | null> {
	const userKeys = await getSubversiveUserKeys();
	let pool = userKeys.filter(
		(k) => !subversiveKeyHealthManager.isKeyTemporarilyDisabled(k.apiKey),
	);

	// If only 1 user key (or none) is available, load balance with system keys
	if (pool.length <= 1) {
		try {
			const systemKeys = await getActiveSystemKeyPool();
			const activeSystemKeys = systemKeys.filter(
				(k) => !subversiveKeyHealthManager.isKeyTemporarilyDisabled(k.apiKey),
			);
			if (activeSystemKeys.length > 0) {
				pool = [...pool, ...activeSystemKeys];
			}
		} catch (err) {
			logger.warn(
				`Failed to load balance with system keys: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	if (pool.length === 0) return null;

	const key = pool[roundRobinIndex % pool.length] ?? null;
	roundRobinIndex = (roundRobinIndex + 1) % pool.length;
	return key;
}
