import type {
	OperationPathParams,
	OperationQueryParams,
	OperationResponse,
	PathOperation,
	paths,
} from "@sentinel/schemas";
import { and, apiKeys, db, eq } from "../../database";
import { TornApiClient } from "./client";
import { decryptApiKey } from "./crypto";
import { KeyHealthManager } from "./key-health-manager";
import type { ManagedApiKey } from "./types";
import { UserCooldownManager } from "./user-cooldown";
import { UserRateLimiter } from "./user-rate-limiter";

let systemKeyIndex = 0;

/**
 * Fetches all active API keys (both system and personal) to form the full request pool.
 */
export async function getSystemKeyPool(): Promise<ManagedApiKey[]> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";
	const keysInDb = await db.query.apiKeys.findMany({
		where: eq(apiKeys.isValid, true),
	});

	if (keysInDb.length > 0) {
		return keysInDb.map((k) => ({
			apiKey:
				k.apiKeyEncrypted.length > 16 && masterKey
					? decryptApiKey(k.apiKeyEncrypted, masterKey)
					: k.apiKeyEncrypted,
			userId: k.userId,
			keyType: k.keyType,
		}));
	}

	const envKey = process.env.TORN_API_KEY;
	if (envKey) {
		return [{ apiKey: envKey, userId: 0, keyType: "system" }];
	}

	throw new Error("No valid API keys available in database or environment.");
}

/**
 * Gets the next system API key in a fair, persistent round-robin order across system requests.
 */
async function getNextSystemKey(): Promise<ManagedApiKey> {
	const keys = await getSystemKeyPool();
	const key = keys[systemKeyIndex % keys.length];
	if (!key) {
		throw new Error("No API keys available in key pool.");
	}
	systemKeyIndex = (systemKeyIndex + 1) % keys.length;
	return key;
}

/**
 * Returns the personal API key record for the repository owner (keyType === "personal").
 */
export async function getPersonalKey(): Promise<ManagedApiKey | null> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";

	const personalKey = await db.query.apiKeys.findFirst({
		where: and(eq(apiKeys.keyType, "personal"), eq(apiKeys.isValid, true)),
	});

	if (personalKey) {
		return {
			apiKey:
				personalKey.apiKeyEncrypted.length > 16 && masterKey
					? decryptApiKey(personalKey.apiKeyEncrypted, masterKey)
					: personalKey.apiKeyEncrypted,
			userId: personalKey.userId,
			keyType: personalKey.keyType,
		};
	}

	return null;
}

/**
 * Configuration options for ManagedTornApiClient
 */
export type ManagedTornApiConfig = {
	maxRequestsPerWindow?: number;
	pepper?: string;
	encryptionKey?: string;
};

/**
 * Managed Torn API Client for Worker v2 & Sentinel V2 applications.
 * Integrates per-user rate-limiting, per-user cooldowns, key health tracking, and TornApiClient.
 */
export class ManagedTornApiClient {
	readonly rateLimiter: UserRateLimiter;
	readonly cooldownManager: UserCooldownManager;
	readonly keyHealthManager: KeyHealthManager;
	readonly client: TornApiClient;
	private encryptionKey: string;

	constructor(config: ManagedTornApiConfig = {}) {
		this.rateLimiter = new UserRateLimiter(config.maxRequestsPerWindow ?? 50);
		this.cooldownManager = new UserCooldownManager();
		const pepper = config.pepper ?? process.env.API_KEY_HASH_PEPPER ?? "";
		this.encryptionKey =
			config.encryptionKey ?? process.env.ENCRYPTION_KEY ?? "";

		this.keyHealthManager = new KeyHealthManager(pepper);

		this.client = new TornApiClient({
			onInvalidKey: async (apiKey, errorCode) => {
				await this.keyHealthManager.handleInvalidKey(apiKey, errorCode);
			},
		});
	}

	/**
	 * High-level managed GET request for OpenAPI v2 paths.
	 * Automatically selects the next key from the central system pool if apiKey is omitted.
	 * Enforces per-user rate limiting, cooldown checking, and key health tracking.
	 */
	async get<P extends keyof paths>(
		path: P,
		options?: {
			userId?: number | string;
			apiKey?: string;
			pathParams?: OperationPathParams<PathOperation<P>>;
			queryParams?: OperationQueryParams<PathOperation<P>>;
		},
	): Promise<OperationResponse<PathOperation<P>>> {
		let apiKey = options?.apiKey;
		let userId = options?.userId;

		if (!apiKey || userId === undefined) {
			const systemKey = await getNextSystemKey();
			apiKey = systemKey.apiKey;
			userId = systemKey.userId;
		}

		await this.cooldownManager.waitIfInCooldown(userId);
		await this.rateLimiter.waitIfNeeded(userId);

		const decryptedKey =
			apiKey.length > 16 ? decryptApiKey(apiKey, this.encryptionKey) : apiKey;

		const result = await this.client.get(path, {
			apiKey: decryptedKey,
			pathParams: options?.pathParams,
			queryParams: options?.queryParams,
		});

		await this.keyHealthManager.recordSuccessfulUse(decryptedKey);
		return result;
	}

	/**
	 * Raw GET request for custom non-OpenAPI endpoints (or legacy v1 Torn endpoints).
	 * Automatically selects the next key from the central system pool if apiKey is omitted.
	 */
	async getRaw<T = unknown>(
		endpoint: string,
		options?: {
			userId?: number | string;
			apiKey?: string;
			queryParams?: Record<string, string | number | boolean | undefined>;
		},
	): Promise<T> {
		let apiKey = options?.apiKey;
		let userId = options?.userId;

		if (!apiKey || userId === undefined) {
			const systemKey = await getNextSystemKey();
			apiKey = systemKey.apiKey;
			userId = systemKey.userId;
		}

		await this.cooldownManager.waitIfInCooldown(userId);
		await this.rateLimiter.waitIfNeeded(userId);

		const decryptedKey =
			apiKey.length > 16 ? decryptApiKey(apiKey, this.encryptionKey) : apiKey;

		const result = await this.client.getRaw<T>(endpoint, {
			apiKey: decryptedKey,
			queryParams: options?.queryParams,
		});

		await this.keyHealthManager.recordSuccessfulUse(decryptedKey);
		return result;
	}

	/**
	 * Executes a GET request strictly using the personal key of the system owner.
	 * Falls back to central system key pool if no personal key is currently registered.
	 */
	async getPersonal<P extends keyof paths>(
		path: P,
		options?: {
			pathParams?: OperationPathParams<PathOperation<P>>;
			queryParams?: OperationQueryParams<PathOperation<P>>;
		},
	): Promise<OperationResponse<PathOperation<P>>> {
		const personalKey = (await getPersonalKey()) ?? (await getNextSystemKey());
		return this.get(path, {
			apiKey: personalKey.apiKey,
			userId: personalKey.userId,
			pathParams: options?.pathParams,
			queryParams: options?.queryParams,
		});
	}

	/**
	 * Distributes batch requests in parallel across available API keys using fair round-robin.
	 * Passes each request through per-user rate limiting.
	 */
	async executeBatch<P extends keyof paths, Item>(
		path: P,
		items: Item[],
		buildParams?: (item: Item) => {
			pathParams?: OperationPathParams<PathOperation<P>>;
			queryParams?: OperationQueryParams<PathOperation<P>>;
		},
		keys?: ManagedApiKey[],
	): Promise<OperationResponse<PathOperation<P>>[]> {
		const keyPool = keys && keys.length > 0 ? keys : await getSystemKeyPool();
		if (keyPool.length === 0) {
			throw new Error("No API keys provided for batch execution.");
		}

		return Promise.all(
			items.map((item) => {
				const keyEntry = keyPool[systemKeyIndex % keyPool.length];
				if (!keyEntry) {
					throw new Error("No API keys provided for batch execution.");
				}
				systemKeyIndex = (systemKeyIndex + 1) % keyPool.length;
				const params = buildParams ? buildParams(item) : {};
				return this.get(path, {
					apiKey: keyEntry.apiKey,
					userId: keyEntry.userId,
					pathParams: params.pathParams,
					queryParams: params.queryParams,
				});
			}),
		);
	}
}

export const tornApi = new ManagedTornApiClient();
