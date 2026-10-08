import { DEFAULT_SETTINGS, POLLING_CONFIG, STORAGE_KEYS } from "./config";
import type {
	BattlestatsAnalyticsResponse,
	BattlestatsLedgerState,
	CompanyHistoryResponse,
	CompanyStateResponse,
	CompanyWeeklyLogsResponse,
	CrimeAnalyticsResponse,
	CrimeLedgerState,
	EfficiencyDataPayload,
	RatioType,
	StatType,
	StockPortfolioResponse,
	StocksLedgerState,
	WealthAnalyticsResponse,
	WealthStateResponse,
	WealthTransactionsResponse,
} from "./types";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;
declare function GM_xmlhttpRequest(details: {
	method: "GET" | "POST" | "PUT" | "DELETE";
	url: string;
	headers?: Record<string, string>;
	data?: string;
	timeout?: number;
	onload?: (response: { status: number; responseText: string }) => void;
	onerror?: (error: unknown) => void;
	ontimeout?: () => void;
}): { abort: () => void };

/**
 * A failed request, with the HTTP status kept separate from the body.
 *
 * Callers used to sniff `message.includes("api key")` over a string that embedded
 * the whole response body, so a 500 page that merely mentioned an API key was
 * presented as "your key is wrong" with a button offering to fix it.
 */
export class ApiError extends Error {
	public readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}

	public get isUnauthorized(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

export class BlastedApiClient {
	/**
	 * Identical GETs in flight at the same moment share one request.
	 *
	 * The drawer, the in-page observers and the manual refresh all ask for the
	 * same endpoints on overlapping cadences; without this each opens its own
	 * request, and the slowest reply is the one that paints.
	 */
	private inFlight = new Map<string, Promise<unknown>>();

	/** Hosts the personal API key may be sent to. */
	private static readonly ALLOWED_HOSTS = new Set([
		"api.blasted-labs.tech",
		"sentinel.blasted-labs.tech",
		"localhost",
		"127.0.0.1",
	]);

	private get apiUrl(): string {
		const url = GM_getValue<string>(
			STORAGE_KEYS.apiUrl,
			DEFAULT_SETTINGS.apiUrl,
		);
		return url ? url.replace(/\/+$/, "") : DEFAULT_SETTINGS.apiUrl;
	}

	private get apiKey(): string {
		return GM_getValue<string>(STORAGE_KEYS.apiKey, "");
	}

	/**
	 * Whether the configured base URL is one this script will send the key to.
	 *
	 * Without this check, anything able to write `blasted_api_url` in storage
	 * redirects the player's key to a host of its choosing — the key-disclosure
	 * obligation the scripting rules put on API tools.
	 */
	private isTrustedHost(url: string): boolean {
		try {
			return BlastedApiClient.ALLOWED_HOSTS.has(new URL(url).hostname);
		} catch {
			return false;
		}
	}

	public async request<T>(
		endpoint: string,
		options?: { method?: "GET" | "POST" | "PUT"; body?: unknown },
	): Promise<T> {
		const method = options?.method ?? "GET";
		const url = `${this.apiUrl}${endpoint}`;

		// Only reads are coalesced: a repeated POST is a deliberate second action.
		const coalesceKey = method === "GET" ? `${method} ${url}` : null;
		if (coalesceKey) {
			const existing = this.inFlight.get(coalesceKey) as Promise<T> | undefined;
			if (existing) return existing;
		}

		const run = this.performRequest<T>(url, method, options?.body);
		if (coalesceKey) {
			this.inFlight.set(coalesceKey, run);
			void run
				.catch(() => {})
				.finally(() => {
					this.inFlight.delete(coalesceKey);
				});
		}
		return run;
	}

	private async performRequest<T>(
		url: string,
		method: "GET" | "POST" | "PUT",
		body: unknown,
	): Promise<T> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-Client-App": "blasted-script",
		};

		// The key is attached only for hosts this script is allowed to talk to.
		if (this.apiKey && this.isTrustedHost(this.apiUrl)) {
			headers["X-Api-Key"] = this.apiKey;
		}

		if (body) {
			headers["Content-Type"] = "application/json";
		}

		// Prefer GM_xmlhttpRequest to avoid cross-origin restrictions in userscripts
		if (typeof GM_xmlhttpRequest !== "undefined") {
			return new Promise<T>((resolve, reject) => {
				GM_xmlhttpRequest({
					method,
					url,
					headers,
					data: body ? JSON.stringify(body) : undefined,
					// Without an explicit timeout a hung request never settles, and the
					// poller stacks another on top of it every cycle.
					timeout: POLLING_CONFIG.REQUEST_TIMEOUT_MS,
					onload: (res) => {
						if (res.status === 401) {
							reject(
								new ApiError(
									401,
									"Unauthorized: invalid API key. Enter your key in Settings.",
								),
							);
							return;
						}
						if (res.status < 200 || res.status >= 300) {
							reject(
								new ApiError(res.status, `Request failed (${res.status}).`),
							);
							return;
						}
						try {
							resolve(JSON.parse(res.responseText) as T);
						} catch {
							reject(new ApiError(res.status, "Response was not valid JSON."));
						}
					},
					onerror: () => reject(new ApiError(0, "Network error.")),
					ontimeout: () =>
						reject(
							new ApiError(
								0,
								`Request timed out after ${POLLING_CONFIG.REQUEST_TIMEOUT_MS / 1000}s.`,
							),
						),
				});
			});
		}

		// Fallback to fetch if GM_xmlhttpRequest is not available
		const res = await fetch(url, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
		});

		if (res.status === 401) {
			throw new ApiError(
				401,
				"Unauthorized: invalid API key. Enter your key in Settings.",
			);
		}
		if (!res.ok) {
			throw new ApiError(res.status, `Request failed (${res.status}).`);
		}
		return (await res.json()) as T;
	}

	/**
	 * The portfolio as the API computes it.
	 *
	 * No resource rates are sent: points are priced server-side from the points
	 * market, and energy, nerve and happiness have no market price to send.
	 */
	public async getStockPortfolio(): Promise<StockPortfolioResponse> {
		const data = await this.request<StockPortfolioResponse>(
			"/v2/system/stocks-ledger/portfolio",
		);
		GM_setValue(STORAGE_KEYS.cachedStockPortfolio, JSON.stringify(data));
		return data;
	}

	/** Reads the live position and prices from Torn, then re-computes. */
	public async syncStockPortfolio(): Promise<StockPortfolioResponse> {
		const data = await this.request<StockPortfolioResponse>(
			"/v2/system/stocks-ledger/sync",
			{ method: "POST" },
		);
		if (data.success) {
			GM_setValue(STORAGE_KEYS.cachedStockPortfolio, JSON.stringify(data));
		}
		return data;
	}

	public async getStocksLedgerState(): Promise<StocksLedgerState> {
		return this.request<StocksLedgerState>("/v2/system/stocks-ledger/state");
	}

	public getCachedStockPortfolio(): StockPortfolioResponse | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedStockPortfolio, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as StockPortfolioResponse;
		} catch {
			return null;
		}
	}

	public async getCrimeLedgerState(): Promise<CrimeLedgerState> {
		const data = await this.request<CrimeLedgerState>(
			"/v2/system/crime-ledger/state",
		);
		GM_setValue(STORAGE_KEYS.cachedState, JSON.stringify(data));
		return data;
	}

	public async getCrimeAnalytics(
		timeframe = "30d",
	): Promise<CrimeAnalyticsResponse> {
		const daysParam = timeframe === "all" ? "all" : timeframe.replace("d", "");
		const data = await this.request<CrimeAnalyticsResponse>(
			`/v2/system/crime-ledger/analytics?days=${daysParam}`,
		);
		GM_setValue(STORAGE_KEYS.cachedAnalytics, JSON.stringify(data));
		return data;
	}

	public async getBattlestatsState(): Promise<BattlestatsLedgerState> {
		const data = await this.request<BattlestatsLedgerState>(
			"/v2/system/battlestats-ledger/state",
		);
		GM_setValue(STORAGE_KEYS.cachedBattlestatsState, JSON.stringify(data));
		return data;
	}

	public async getBattlestatsAnalytics(
		timeframe = "30d",
	): Promise<BattlestatsAnalyticsResponse> {
		const daysParam = timeframe === "all" ? "all" : timeframe.replace("d", "");
		const data = await this.request<BattlestatsAnalyticsResponse>(
			`/v2/system/battlestats-ledger/analytics?days=${daysParam}`,
		);
		GM_setValue(STORAGE_KEYS.cachedBattlestatsAnalytics, JSON.stringify(data));
		return data;
	}

	public async getEfficiencyData(): Promise<EfficiencyDataPayload> {
		const data = await this.request<EfficiencyDataPayload>(
			"/v2/system/battlestats-ledger/efficiency-data",
		);
		GM_setValue(STORAGE_KEYS.cachedEfficiency, JSON.stringify(data));
		return data;
	}

	public async getBattlestatsPreferences(): Promise<{
		ratioType: RatioType;
		mainStat: StatType;
	}> {
		return this.request<{ ratioType: RatioType; mainStat: StatType }>(
			"/v2/system/battlestats-ledger/preferences",
		);
	}

	public async saveBattlestatsPreferences(prefs: {
		ratioType: RatioType;
		mainStat: StatType;
	}): Promise<{ success: boolean; ratioType: RatioType; mainStat: StatType }> {
		return this.request<{
			success: boolean;
			ratioType: RatioType;
			mainStat: StatType;
		}>("/v2/system/battlestats-ledger/preferences", {
			method: "PUT",
			body: prefs,
		});
	}

	public getCachedState(): CrimeLedgerState | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedState, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as CrimeLedgerState;
		} catch {
			return null;
		}
	}

	public getCachedAnalytics(): CrimeAnalyticsResponse | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedAnalytics, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as CrimeAnalyticsResponse;
		} catch {
			return null;
		}
	}

	public getCachedBattlestatsState(): BattlestatsLedgerState | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedBattlestatsState, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as BattlestatsLedgerState;
		} catch {
			return null;
		}
	}

	public getCachedBattlestatsAnalytics(): BattlestatsAnalyticsResponse | null {
		const raw = GM_getValue<string>(
			STORAGE_KEYS.cachedBattlestatsAnalytics,
			"",
		);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as BattlestatsAnalyticsResponse;
		} catch {
			return null;
		}
	}

	public getCachedEfficiency(): EfficiencyDataPayload | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedEfficiency, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as EfficiencyDataPayload;
		} catch {
			return null;
		}
	}

	public async getCompanyState(): Promise<CompanyStateResponse> {
		const data = await this.request<CompanyStateResponse>(
			"/v2/system/company/state",
		);
		GM_setValue(STORAGE_KEYS.cachedCompanyState, JSON.stringify(data));
		return data;
	}

	public async getCompanyWeeklyLogs(
		offset = 0,
	): Promise<CompanyWeeklyLogsResponse> {
		return this.request<CompanyWeeklyLogsResponse>(
			`/v2/system/company/weekly-logs?offset=${offset}`,
		);
	}

	public async getCompanyHistory(days = 30): Promise<CompanyHistoryResponse> {
		return this.request<CompanyHistoryResponse>(
			`/v2/system/company/history?days=${days}`,
		);
	}

	public getCachedCompanyState(): CompanyStateResponse | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedCompanyState, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as CompanyStateResponse;
		} catch {
			return null;
		}
	}
	// ─── Wealth ledger ─────────────────────────────────────────────────────────

	public async getWealthState(): Promise<WealthStateResponse> {
		const data = await this.request<WealthStateResponse>(
			"/v2/system/wealth-ledger/state",
		);
		GM_setValue(STORAGE_KEYS.cachedWealthState, JSON.stringify(data));
		return data;
	}

	public async getWealthAnalytics(
		timeframe = "30d",
	): Promise<WealthAnalyticsResponse> {
		const daysParam = timeframe === "all" ? "all" : timeframe.replace("d", "");
		const data = await this.request<WealthAnalyticsResponse>(
			`/v2/system/wealth-ledger/analytics?days=${daysParam}`,
		);
		GM_setValue(STORAGE_KEYS.cachedWealthAnalytics, JSON.stringify(data));
		return data;
	}

	public async getWealthTransactions(
		limit = 50,
		offset = 0,
	): Promise<WealthTransactionsResponse> {
		return this.request<WealthTransactionsResponse>(
			`/v2/system/wealth-ledger/transactions?limit=${limit}&offset=${offset}`,
		);
	}

	/** Asks the scheduler to reconcile, then returns the refreshed state. */
	public async refreshWealth(): Promise<WealthStateResponse> {
		const data = await this.request<WealthStateResponse>(
			"/v2/system/wealth-ledger/refresh",
			{ method: "POST" },
		);
		if (data.success) {
			GM_setValue(STORAGE_KEYS.cachedWealthState, JSON.stringify(data));
		}
		return data;
	}

	public getCachedWealthState(): WealthStateResponse | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedWealthState, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as WealthStateResponse;
		} catch {
			return null;
		}
	}

	public getCachedWealthAnalytics(): WealthAnalyticsResponse | null {
		const raw = GM_getValue<string>(STORAGE_KEYS.cachedWealthAnalytics, "");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as WealthAnalyticsResponse;
		} catch {
			return null;
		}
	}
}

export const apiClient = new BlastedApiClient();
