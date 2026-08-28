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

	constructor(config: TornApiConfig = {}) {
		this.rateLimitTracker = config.rateLimitTracker;
		this.onInvalidKey = config.onInvalidKey;
		this.timeout = config.timeout ?? REQUEST_TIMEOUT;
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
		},
	): Promise<OperationResponse<PathOperation<P>>>;

	async get<T extends Record<string, unknown> = Record<string, unknown>>(
		path: Exclude<string, keyof paths>,
		options: {
			apiKey: string;
			pathParams?: Record<string, string | number>;
			queryParams?: Record<string, unknown>;
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
		},
	): Promise<OperationResponse<PathOperation<P>> | T> {
		const { apiKey, pathParams, queryParams } = options;

		if (this.rateLimitTracker) {
			await this.rateLimitTracker.waitIfNeeded(apiKey);
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

		const maxAttempts = 3;
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
					await this.rateLimitTracker.recordRequest(apiKey);
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

				const delay = isRateLimit ? 5000 * attempt : 200 * attempt;
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
		},
	): Promise<T> {
		const { apiKey, queryParams } = options;

		if (this.rateLimitTracker) {
			await this.rateLimitTracker.waitIfNeeded(apiKey);
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
			await this.rateLimitTracker.recordRequest(apiKey);
		}

		return data as T;
	}
}
