import type {
	OperationPathParams,
	OperationQueryParams,
	OperationResponse,
	PathOperation,
	paths,
} from "@sentinel/schemas";
import {
	type RateLimitTracker,
	TORN_ERROR_CODES,
	type TornApiConfig,
	TornError,
} from "./types";

const TORN_API_BASE = "https://api.torn.com/v2";
const TORN_API_V1_BASE = "https://api.torn.com";
const REQUEST_TIMEOUT = 30000;

export class TornApiClient {
	private rateLimitTracker?: RateLimitTracker;
	private onInvalidKey?: (apiKey: string, errorCode: number) => Promise<void>;
	private timeout: number;
	private maxAttempts: number;

	constructor(config: TornApiConfig = {}) {
		this.rateLimitTracker = config.rateLimitTracker;
		this.onInvalidKey = config.onInvalidKey;
		this.timeout = config.timeout ?? REQUEST_TIMEOUT;
		this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
	}

	private replacePath(
		path: string,
		pathParams?: Record<string, string | number>,
	): string {
		if (!pathParams) return path;
		let result = path;
		for (const [key, value] of Object.entries(pathParams)) {
			result = result.replace(`{${key}}`, String(value));
		}
		return result;
	}

	async get<P extends keyof paths>(
		path: P,
		options: {
			apiKey: string;
			pathParams?: OperationPathParams<PathOperation<P>>;
			queryParams?: OperationQueryParams<PathOperation<P>>;
			maxAttempts?: number;
			rateLimitKey?: string | number;
		},
	): Promise<OperationResponse<PathOperation<P>>>;

	async get<T extends Record<string, unknown> = Record<string, unknown>>(
		path: Exclude<string, keyof paths>,
		options: {
			apiKey: string;
			pathParams?: Record<string, string | number>;
			queryParams?: Record<string, unknown>;
			maxAttempts?: number;
			rateLimitKey?: string | number;
		},
	): Promise<T>;

	async get<
		P extends keyof paths = keyof paths,
		T extends Record<string, unknown> = Record<string, unknown>,
	>(
		path: P | string,
		options: {
			apiKey: string;
			pathParams?: Record<string, unknown>;
			queryParams?: Record<string, unknown>;
			/**
			 * Per-call retry override. Use 1 for opportunistic requests inside a
			 * sequential loop: a rate-limited retry sleeps `5000 * attempt` ms, so
			 * a couple of them can consume an entire cycle budget and get the
			 * cycle killed. Skipping and retrying on a later cycle is cheaper.
			 */
			maxAttempts?: number;
			/**
			 * Identifier this request is accounted against in the configured
			 * `rateLimitTracker`. Defaults to the API key itself.
			 *
			 * Callers should pass the owning Torn user id instead: it is stable
			 * across key rotation and, unlike the raw key, is safe to appear in the
			 * limiter's rate-limit warnings.
			 */
			rateLimitKey?: string | number;
		},
	): Promise<OperationResponse<PathOperation<P>> | T> {
		const { apiKey, pathParams, queryParams } = options;
		const maxAttempts = Math.max(1, options.maxAttempts ?? this.maxAttempts);
		const rateLimitKey = options.rateLimitKey ?? apiKey;

		if (this.rateLimitTracker) {
			await this.rateLimitTracker.waitIfNeeded(String(rateLimitKey));
		}

		const targetPath = this.replacePath(
			String(path),
			pathParams as Record<string, string | number>,
		);
		const url = new URL(
			`${TORN_API_BASE}${targetPath.startsWith("/") ? "" : "/"}${targetPath}`,
		);

		url.searchParams.append("key", apiKey);
		url.searchParams.append("comment", "Sentinel");
		url.searchParams.append("timestamp", String(Math.floor(Date.now() / 1000)));

		if (queryParams) {
			for (const [key, value] of Object.entries(queryParams)) {
				if (value !== undefined && value !== null && value !== "") {
					url.searchParams.set(
						key,
						Array.isArray(value) ? value.join(",") : String(value),
					);
				}
			}
		}

		let lastError: unknown = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const response = await fetch(url.toString(), {
					signal: AbortSignal.timeout(this.timeout),
					headers: { Accept: "application/json" },
				});

				const data: unknown = await response.json();

				if (data && typeof data === "object" && "error" in data) {
					const error = (data as { error: { code: number; error: string } })
						.error;
					const errorMessage =
						TORN_ERROR_CODES[error.code] ||
						error.error ||
						`Error code ${error.code}`;

					if (this.onInvalidKey) {
						await this.onInvalidKey(apiKey, error.code);
					}

					throw new TornError(error.code, errorMessage);
				}

				if (!response.ok) {
					throw new Error(`Torn API returned status ${response.status}`);
				}

				if (this.rateLimitTracker) {
					await this.rateLimitTracker.recordRequest(String(rateLimitKey));
				}

				return data as OperationResponse<PathOperation<P>> | T;
			} catch (error) {
				lastError = error;
				const err = error instanceof Error ? error : null;
				const isRateLimit =
					(error instanceof TornError && error.code === 5) ||
					Boolean(err?.message.toLowerCase().includes("rate limit"));

				const isNetworkOrTimeout =
					error instanceof TypeError ||
					err?.name === "TimeoutError" ||
					err?.name === "AbortError" ||
					Boolean(err?.message.includes("status")) ||
					isRateLimit;

				if (!isNetworkOrTimeout || attempt === maxAttempts) {
					throw error;
				}

				// Jittered so concurrent workers failing on the same key/rate-limit
				// window do not retry in lockstep and re-collide.
				const baseDelay = isRateLimit ? 5000 * attempt : 200 * attempt;
				const delay = baseDelay + Math.floor(Math.random() * 250);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}

		throw lastError;
	}

	async getRaw<T = unknown>(
		path: string,
		options: {
			apiKey: string;
			queryParams?: Record<string, unknown>;
			/** See `TornApiClient.get` — defaults to the API key itself. */
			rateLimitKey?: string | number;
		},
	): Promise<T> {
		const { apiKey, queryParams } = options;
		const rateLimitKey = options.rateLimitKey ?? apiKey;

		if (this.rateLimitTracker) {
			await this.rateLimitTracker.waitIfNeeded(String(rateLimitKey));
		}

		const cleanPath = path.startsWith("/") ? path : `/${path}`;
		const url = new URL(`${TORN_API_V1_BASE}${cleanPath}`);
		url.searchParams.append("key", apiKey);
		url.searchParams.append("comment", "Sentinel");

		if (queryParams) {
			for (const [key, value] of Object.entries(queryParams)) {
				if (value !== undefined && value !== null && value !== "") {
					url.searchParams.set(
						key,
						Array.isArray(value) ? value.join(",") : String(value),
					);
				}
			}
		}

		const response = await fetch(url.toString(), {
			signal: AbortSignal.timeout(this.timeout),
			headers: { Accept: "application/json" },
		});

		const data: unknown = await response.json();

		if (data && typeof data === "object" && "error" in data) {
			const error = (data as { error: { code: number; error: string } }).error;
			const errorMessage =
				TORN_ERROR_CODES[error.code] ||
				error.error ||
				`Error code ${error.code}`;

			if (this.onInvalidKey) {
				await this.onInvalidKey(apiKey, error.code);
			}

			throw new TornError(error.code, errorMessage);
		}

		if (!response.ok) {
			throw new Error(`Torn API v1 returned status ${response.status}`);
		}

		if (this.rateLimitTracker) {
			await this.rateLimitTracker.recordRequest(String(rateLimitKey));
		}

		return data as T;
	}
}
