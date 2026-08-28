import type {
	OperationPathParams,
	OperationQueryParams,
	OperationResponse,
	PathOperation,
	paths,
} from "@sentinel/schemas";
import { and, apiKeys, db, eq } from "../../database";
import { Logger } from "../../utils";
import { TornApiClient } from "./client";
import { decryptApiKey } from "./crypto";
import { KeyHealthManager } from "./key-health-manager";
import { type ManagedApiKey, TornError } from "./types";
import { UserCooldownManager } from "./user-cooldown";
import { UserRateLimiter } from "./user-rate-limiter";

const logger = new Logger("TornApiManager");
let systemKeyIndex = 0;

/**
 * Fetches all active system API keys in the database (keyType = 'system').
 * Isolates personal keys so they are never consumed by general background tasks.
 */
export async function getSystemKeyPool(): Promise<ManagedApiKey[]> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";
	const keysInDb = await db.query.apiKeys.findMany({
		where: and(eq(apiKeys.isValid, true), eq(apiKeys.keyType, "system")),
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

	throw new Error("No valid system API keys available in database.");
}

/**
 * Fetches active system keys that are not currently in temporary disable cooldown.
 * If all keys are in cooldown, falls back to the full system key pool.
 */
export async function getActiveSystemKeyPool(): Promise<ManagedApiKey[]> {
	const pool = await getSystemKeyPool();
	const active = pool.filter(
		(k) => !tornApi.keyHealthManager.isKeyTemporarilyDisabled(k.apiKey),
	);
	return active.length > 0 ? active : pool;
}

/**
 * Gets the next system API key in a fair, persistent round-robin order across system requests.
 */
export async function getNextSystemKey(): Promise<ManagedApiKey> {
	const keys = await getSystemKeyPool();
	const key = keys[systemKeyIndex % keys.length];
	if (!key) {
		throw new Error("No API keys available in key pool.");
	}
	systemKeyIndex = (systemKeyIndex + 1) % keys.length;
	return key;
}

/**
 * Returns the personal API key record for the repository owner.
 * Checks the database first for an active key marked as 'personal',
 * and falls back to process.env.TORN_API_KEY.
 */
export async function getPersonalKey(): Promise<ManagedApiKey | null> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";

	// 1. Check database for registered personal key
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

	// 2. Fall back to environment variable
	const envKey = process.env.TORN_API_KEY;
	if (envKey) {
		return { apiKey: envKey, userId: 0, keyType: "personal" };
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
	tempCooldownMs?: number;
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

		this.keyHealthManager = new KeyHealthManager(pepper, config.tempCooldownMs);

		this.client = new TornApiClient({
			onInvalidKey: async (apiKey, errorCode) => {
				await this.keyHealthManager.handleInvalidKey(apiKey, errorCode);
			},
		});
	}

	/**
	 * Selects the next available system key, filtering out keys currently in temporary disable cooldown.
	 * If all system keys are temporarily disabled, falls back to available keys with a warning.
	 */
	async getNextSystemKey(excludeKeys?: Set<string>): Promise<ManagedApiKey> {
		const pool = await getSystemKeyPool();
		let candidates = pool.filter(
			(k) =>
				!this.keyHealthManager.isKeyTemporarilyDisabled(k.apiKey) &&
				!excludeKeys?.has(k.apiKey),
		);

		if (candidates.length === 0) {
			candidates = pool.filter((k) => !excludeKeys?.has(k.apiKey));
		}

		if (candidates.length === 0) {
			candidates = pool;
		}

		const key = candidates[systemKeyIndex % candidates.length];
		if (!key) {
			throw new Error("No API keys available in key pool.");
		}
		systemKeyIndex = (systemKeyIndex + 1) % candidates.length;
		return key;
	}

	/**
	 * High-level managed GET request for OpenAPI v2 paths.
	 * Automatically selects the next key from the central system pool if apiKey is omitted.
	 * Enforces per-user rate limiting, cooldown checking, and key health tracking.
	 * Automatically fails over to another system key if a key error (e.g. code 13, 2, 10, 18) occurs.
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
		const isSpecificKey = options?.apiKey !== undefined;

		if (isSpecificKey) {
			const apiKey = options.apiKey as string;
			const userId = options.userId ?? 0;

			await this.cooldownManager.waitIfInCooldown(userId);
			await this.rateLimiter.waitIfNeeded(userId);

			const decryptedKey =
				apiKey.length > 16 ? decryptApiKey(apiKey, this.encryptionKey) : apiKey;

			const result = await this.client.get(path, {
				apiKey: decryptedKey,
				pathParams: options.pathParams,
				queryParams: {
					comment: "Sentinel",
					...options.queryParams,
				} as unknown as OperationQueryParams<PathOperation<P>>,
			});

			await this.keyHealthManager.recordSuccessfulUse(decryptedKey);
			return result;
		}

		const pool = await getSystemKeyPool();
		const maxAttempts = Math.min(pool.length, 3);
		const triedKeys = new Set<string>();
		let lastError: unknown = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const systemKey = await this.getNextSystemKey(triedKeys);
			const apiKey = systemKey.apiKey;
			const userId = systemKey.userId;
			triedKeys.add(apiKey);

			await this.cooldownManager.waitIfInCooldown(userId);
			await this.rateLimiter.waitIfNeeded(userId);

			const decryptedKey =
				apiKey.length > 16 ? decryptApiKey(apiKey, this.encryptionKey) : apiKey;

			try {
				const result = await this.client.get(path, {
					apiKey: decryptedKey,
					pathParams: options?.pathParams,
					queryParams: {
						comment: "Sentinel",
						...options?.queryParams,
					} as unknown as OperationQueryParams<PathOperation<P>>,
				});

				await this.keyHealthManager.recordSuccessfulUse(decryptedKey);
				return result;
			} catch (error) {
				lastError = error;
				const isKeyError =
					error instanceof TornError &&
					(error.code === 2 ||
						error.code === 10 ||
						error.code === 13 ||
						error.code === 18);

				if (!isKeyError || attempt === maxAttempts) {
					throw error;
				}

				logger.warn(
					`System key ending in '...${decryptedKey.slice(-4)}' failed with error code ${error.code}. Failing over to next system key (attempt ${attempt}/${maxAttempts}).`,
				);
			}
		}

		throw lastError;
	}

	/**
	 * Raw GET request for custom non-OpenAPI endpoints (or legacy v1 Torn endpoints).
	 * Automatically selects the next key from the central system pool if apiKey is omitted.
	 * Automatically fails over to another system key if a key error (e.g. code 13, 2, 10, 18) occurs.
	 */
	async getRaw<T = unknown>(
		endpoint: string,
		options?: {
			userId?: number | string;
			apiKey?: string;
			queryParams?: Record<string, string | number | boolean | undefined>;
		},
	): Promise<T> {
		const isSpecificKey = options?.apiKey !== undefined;

		if (isSpecificKey) {
			const apiKey = options.apiKey as string;
			const userId = options.userId ?? 0;

			await this.cooldownManager.waitIfInCooldown(userId);
			await this.rateLimiter.waitIfNeeded(userId);

			const decryptedKey =
				apiKey.length > 16 ? decryptApiKey(apiKey, this.encryptionKey) : apiKey;

			const result = await this.client.getRaw<T>(endpoint, {
				apiKey: decryptedKey,
				queryParams: {
					comment: "Sentinel",
					...options.queryParams,
				},
			});

			await this.keyHealthManager.recordSuccessfulUse(decryptedKey);
			return result;
		}

		const pool = await getSystemKeyPool();
		const maxAttempts = Math.min(pool.length, 3);
		const triedKeys = new Set<string>();
		let lastError: unknown = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const systemKey = await this.getNextSystemKey(triedKeys);
			const apiKey = systemKey.apiKey;
			const userId = systemKey.userId;
			triedKeys.add(apiKey);

			await this.cooldownManager.waitIfInCooldown(userId);
			await this.rateLimiter.waitIfNeeded(userId);

			const decryptedKey =
				apiKey.length > 16 ? decryptApiKey(apiKey, this.encryptionKey) : apiKey;

			try {
				const result = await this.client.getRaw<T>(endpoint, {
					apiKey: decryptedKey,
					queryParams: {
						comment: "Sentinel",
						...options?.queryParams,
					},
				});

				await this.keyHealthManager.recordSuccessfulUse(decryptedKey);
				return result;
			} catch (error) {
				lastError = error;
				const isKeyError =
					error instanceof TornError &&
					(error.code === 2 ||
						error.code === 10 ||
						error.code === 13 ||
						error.code === 18);

				if (!isKeyError || attempt === maxAttempts) {
					throw error;
				}

				logger.warn(
					`System key ending in '...${decryptedKey.slice(-4)}' failed with error code ${error.code}. Failing over to next system key (attempt ${attempt}/${maxAttempts}).`,
				);
			}
		}

		throw lastError;
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
	 * Executes a raw GET request strictly using the personal key of the system owner.
	 * Falls back to central system key pool if no personal key is currently registered.
	 */
	async getPersonalRaw<T = unknown>(
		endpoint: string,
		options?: {
			queryParams?: Record<string, string | number | boolean | undefined>;
		},
	): Promise<T> {
		const personalKey = (await getPersonalKey()) ?? (await getNextSystemKey());
		return this.getRaw<T>(endpoint, {
			apiKey: personalKey.apiKey,
			userId: personalKey.userId,
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
		let keyPool = keys && keys.length > 0 ? keys : await getSystemKeyPool();
		if (keyPool.length === 0) {
			throw new Error("No API keys provided for batch execution.");
		}

		// Filter out temporarily disabled keys if active keys remain
		const activeKeys = keyPool.filter(
			(k) => !this.keyHealthManager.isKeyTemporarilyDisabled(k.apiKey),
		);
		if (activeKeys.length > 0) {
			keyPool = activeKeys;
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
