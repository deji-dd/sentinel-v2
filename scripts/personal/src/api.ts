import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./config";
import type {
	BattlestatsAnalyticsResponse,
	BattlestatsLedgerState,
	CrimeAnalyticsResponse,
	CrimeLedgerState,
	EfficiencyDataPayload,
	RatioType,
	StatType,
} from "./types";

declare function GM_getValue<T>(key: string, defaultValue?: T): T;
declare function GM_setValue<T>(key: string, value: T): void;
declare function GM_xmlhttpRequest(details: {
	method: "GET" | "POST" | "PUT" | "DELETE";
	url: string;
	headers?: Record<string, string>;
	data?: string;
	onload?: (response: { status: number; responseText: string }) => void;
	onerror?: (error: unknown) => void;
	ontimeout?: () => void;
}): void;

export class BlastedApiClient {
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

	public async request<T>(
		endpoint: string,
		options?: { method?: "GET" | "POST" | "PUT"; body?: unknown },
	): Promise<T> {
		const method = options?.method ?? "GET";
		const url = `${this.apiUrl}${endpoint}`;
		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-Client-App": "blasted-script",
		};

		if (this.apiKey) {
			headers["X-Api-Key"] = this.apiKey;
		}

		if (options?.body) {
			headers["Content-Type"] = "application/json";
		}

		// Prefer GM_xmlhttpRequest to avoid cross-origin restrictions in userscripts
		if (typeof GM_xmlhttpRequest !== "undefined") {
			return new Promise<T>((resolve, reject) => {
				GM_xmlhttpRequest({
					method,
					url,
					headers,
					data: options?.body ? JSON.stringify(options.body) : undefined,
					onload: (res) => {
						if (res.status === 401) {
							reject(
								new Error(
									"Unauthorized: Invalid API Key. Enter your key in Settings.",
								),
							);
							return;
						}
						if (res.status < 200 || res.status >= 300) {
							reject(
								new Error(`API Error (${res.status}): ${res.responseText}`),
							);
							return;
						}
						try {
							const json = JSON.parse(res.responseText) as T;
							resolve(json);
						} catch (e) {
							reject(new Error(`Failed to parse JSON response: ${e}`));
						}
					},
					onerror: (err) =>
						reject(new Error(`Network error requesting ${url}: ${err}`)),
					ontimeout: () => reject(new Error(`Request timed out for ${url}`)),
				});
			});
		}

		// Fallback to fetch if GM_xmlhttpRequest is not available
		const res = await fetch(url, {
			method,
			headers,
			body: options?.body ? JSON.stringify(options.body) : undefined,
		});

		if (res.status === 401) {
			throw new Error(
				"Unauthorized: Invalid API Key. Enter your key in Settings.",
			);
		}
		if (!res.ok) {
			throw new Error(`API Error (${res.status}): ${await res.text()}`);
		}
		return (await res.json()) as T;
	}

	public async getCrimeLedgerState(): Promise<CrimeLedgerState> {
		const data = await this.request<CrimeLedgerState>(
			"/api/v1/system/crime-ledger/state",
		);
		GM_setValue(STORAGE_KEYS.cachedState, JSON.stringify(data));
		return data;
	}

	public async getCrimeAnalytics(
		timeframe = "30d",
	): Promise<CrimeAnalyticsResponse> {
		const daysParam = timeframe === "all" ? "all" : timeframe.replace("d", "");
		const data = await this.request<CrimeAnalyticsResponse>(
			`/api/v1/system/crime-ledger/analytics?days=${daysParam}`,
		);
		GM_setValue(STORAGE_KEYS.cachedAnalytics, JSON.stringify(data));
		return data;
	}

	public async getBattlestatsState(): Promise<BattlestatsLedgerState> {
		const data = await this.request<BattlestatsLedgerState>(
			"/api/v1/system/battlestats-ledger/state",
		);
		GM_setValue(STORAGE_KEYS.cachedBattlestatsState, JSON.stringify(data));
		return data;
	}

	public async getBattlestatsAnalytics(
		timeframe = "30d",
	): Promise<BattlestatsAnalyticsResponse> {
		const daysParam = timeframe === "all" ? "all" : timeframe.replace("d", "");
		const data = await this.request<BattlestatsAnalyticsResponse>(
			`/api/v1/system/battlestats-ledger/analytics?days=${daysParam}`,
		);
		GM_setValue(STORAGE_KEYS.cachedBattlestatsAnalytics, JSON.stringify(data));
		return data;
	}

	public async getEfficiencyData(): Promise<EfficiencyDataPayload> {
		const data = await this.request<EfficiencyDataPayload>(
			"/api/v1/system/battlestats-ledger/efficiency-data",
		);
		GM_setValue(STORAGE_KEYS.cachedEfficiency, JSON.stringify(data));
		return data;
	}

	public async getBattlestatsPreferences(): Promise<{
		ratioType: RatioType;
		mainStat: StatType;
	}> {
		return this.request<{ ratioType: RatioType; mainStat: StatType }>(
			"/api/v1/system/battlestats-ledger/preferences",
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
		}>("/api/v1/system/battlestats-ledger/preferences", {
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
}

export const apiClient = new BlastedApiClient();
