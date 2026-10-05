/**
 * Torn API Error Response interface as returned by Torn API when a request fails
 */
export type TornApiErrorResponse = {
	error: {
		code: number;
		error: string;
	};
};

/**
 * Custom Error class for Torn API errors containing specific Torn API error code
 */
export class TornError extends Error {
	code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "TornError";
		this.code = code;
	}
}

/**
 * Human-readable mappings for standard Torn API error codes
 */
export const TORN_ERROR_CODES: Record<number, string> = {
	0: "Unknown error",
	1: "Key is empty",
	2: "Incorrect key",
	3: "Wrong type",
	4: "Wrong fields",
	5: "Too many requests",
	6: "Incorrect ID",
	7: "Incorrect ID/entity relation",
	8: "IP blocked",
	9: "API disabled",
	10: "Key owner in federal jail",
	11: "Key change cooldown",
	12: "Key read error",
	13: "Key temporarily disabled",
	14: "Daily read limit reached",
	15: "Log unavailable",
	16: "Access level too low",
	17: "Backend error",
	18: "API key paused",
	19: "Must migrate to Crimes v2",
	20: "Race not finished",
	21: "Incorrect category",
	22: "Only available in API v1",
	23: "Only available in API v2",
	24: "Closed temporarily",
	25: "Invalid stat requested",
	26: "Only category or stats allowed",
	27: "Must migrate to Organized Crimes v2",
	28: "Incorrect log ID",
	29: "Category selection unavailable for interaction logs",
};

/**
 * Pluggable rate limit tracker interface for callers requiring rate-limiting integration.
 *
 * Implementations may compute the count synchronously (`UserRateLimiter` does),
 * so the return type accepts either; `await`-ing a plain number is a no-op.
 */
export type RateLimitTracker = {
	waitIfNeeded(apiKey: string): Promise<void>;
	recordRequest(apiKey: string): Promise<void>;
	getRequestCount?(apiKey: string): number | Promise<number>;
};

/**
 * Configuration options for TornApiClient instance
 */
export type TornApiConfig = {
	rateLimitTracker?: RateLimitTracker;
	timeout?: number;
	onInvalidKey?: (apiKey: string, errorCode: number) => Promise<void>;
	/**
	 * Retry attempts for transient failures (network, timeout, rate limit).
	 * Defaults to 3. Set to 1 for opportunistic work that can be skipped and
	 * retried on a later cycle: retrying a rate-limited call sleeps
	 * `5000 * attempt` ms, which inside a sequential loop can consume a whole
	 * cycle budget and get the cycle killed.
	 */
	maxAttempts?: number;
};

/**
 * Decrypted API key entry used by the Key Pool Manager & Rate Limiters
 */
export type ManagedApiKey = {
	apiKey: string;
	userId: number;
	keyType: string;
};
