import { createHash } from "node:crypto";
import {
	db,
	eq,
	getMercGuildId,
	guildApiKeys,
	inArray,
	systemStates,
} from "@sentinel/database";
import { decryptApiKey } from "@sentinel/torn-api";
import {
	isSubversiveFamilyFaction,
	Logger,
	SUBVERSIVE_FAMILY_FACTION_IDS,
} from "@sentinel/utils";

const logger = new Logger("Scheduler", "FamilyMasterKeys");

/** Decrypted master key for one Subversive family faction. */
export interface FamilyMasterApiKey {
	/** Torn faction id the key belongs to (2013 / 27312). */
	factionId: number;
	/** Database row id of the underlying `guild_api_keys` record. */
	keyId: string;
	/** Torn user id that owns the key. */
	tornId: number;
	/** Decrypted 16-character Torn API key. */
	apiKey: string;
}

const CACHE_TTL_MS = 60_000;

let cachedKeys: FamilyMasterApiKey[] | null = null;
let cachedAt = 0;

/** Test seam: drops the in-memory key cache so the next read hits the database. */
export function clearFamilyMasterKeyCache(): void {
	cachedKeys = null;
	cachedAt = 0;
}

/**
 * Stable identifier for a master key, used to key per-faction progress state
 * (watermarks) without ever persisting the secret itself.
 *
 * The watermark is per faction rather than per (faction, direction) because the
 * feed reads both directions in a single unfiltered `/faction/attacks` call.
 */
export function familyMasterKeyStateId(factionId: number): string {
	return `faction_attacks:watermark:${factionId}`;
}

/** Stable identifier for a master key, used as a fallback when factionId is unknown. */
export function masterKeyFingerprint(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
}

async function loadFamilyMasterApiKeys(): Promise<FamilyMasterApiKey[]> {
	const guildId = await getMercGuildId();
	if (!guildId) {
		logger.warn(
			"No mercenary guild configured; no family master keys resolved.",
		);
		return [];
	}

	const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
	if (!encryptionKey) {
		logger.error(
			"ENCRYPTION_KEY is not set; cannot decrypt family master keys.",
		);
		return [];
	}

	const keys: FamilyMasterApiKey[] = [];

	try {
		const [stateRow] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, `merc:master_keys:${guildId}`));

		const map =
			stateRow?.data && typeof stateRow.data === "object"
				? (stateRow.data as Record<
						string,
						{ keyId?: string; factionId?: number }
					>)
				: {};

		const entries = Object.entries(map)
			.map(([factionKey, value]) => ({
				factionId: value?.factionId ?? Number(factionKey),
				keyId: value?.keyId,
			}))
			.filter(
				(entry): entry is { factionId: number; keyId: string } =>
					Number.isFinite(entry.factionId) &&
					isSubversiveFamilyFaction(entry.factionId) &&
					Boolean(entry.keyId),
			);

		if (entries.length === 0) {
			logger.warn(
				`No Subversive family master keys registered for merc guild ${guildId}.`,
			);
		}

		const rows = await db
			.select()
			.from(guildApiKeys)
			.where(
				inArray(
					guildApiKeys.id,
					entries.map((e) => e.keyId),
				),
			);

		for (const row of rows) {
			const entry = entries.find((e) => e.keyId === row.id);
			if (!entry || !row.apiKeyEncrypted) continue;
			try {
				keys.push({
					factionId: entry.factionId,
					keyId: row.id,
					tornId: row.tornId,
					apiKey: decryptApiKey(row.apiKeyEncrypted, encryptionKey),
				});
			} catch (err) {
				logger.warn(`Failed decrypting family master key ${row.id}:`, err);
			}
		}
	} catch (err) {
		logger.warn(`Failed reading family master keys for guild ${guildId}:`, err);
	}

	// Fall back to the environment key so a single-family deployment still works.
	if (keys.length === 0 && process.env.TORN_API_KEY) {
		logger.warn(
			"Falling back to TORN_API_KEY environment key for faction attack ingestion.",
		);
		keys.push({
			factionId: SUBVERSIVE_FAMILY_FACTION_IDS[0] as number,
			keyId: `env:${masterKeyFingerprint(process.env.TORN_API_KEY)}`,
			tornId: 0,
			apiKey: process.env.TORN_API_KEY,
		});
	}

	return keys;
}

/**
 * Resolves the Subversive family master API keys used for `/v2/faction/attacks`
 * ingestion. Shared by the attack feed, the merc hit validator and the retal
 * tracker so every consumer works from the same decrypted, faction-scoped set.
 *
 * Decrypted keys are cached briefly to avoid a database round-trip and an AES
 * decrypt on every 10s cycle.
 */
export async function getFamilyMasterApiKeys(
	options: { forceRefresh?: boolean } = {},
): Promise<FamilyMasterApiKey[]> {
	const now = Date.now();
	if (!options.forceRefresh && cachedKeys && now - cachedAt < CACHE_TTL_MS) {
		return cachedKeys;
	}

	const keys = await loadFamilyMasterApiKeys();
	cachedKeys = keys;
	cachedAt = now;
	return keys;
}

/**
 * Returns a faction id -> key map, which is the shape most consumers need.
 */
export async function getFamilyMasterApiKeyMap(
	options: { forceRefresh?: boolean } = {},
): Promise<Map<number, FamilyMasterApiKey>> {
	const keys = await getFamilyMasterApiKeys(options);
	return new Map(keys.map((key) => [key.factionId, key]));
}
