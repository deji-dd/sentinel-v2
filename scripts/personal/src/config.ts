import type { ScriptSettings } from "./types";

export const STORAGE_KEYS = {
	apiUrl: "blasted_api_url",
	apiKey: "blasted_api_key",
	panelOpen: "blasted_panel_open",
	persistOpen: "blasted_persist_open",
	activeTab: "blasted_active_tab",
	timeframe: "blasted_timeframe",
	chartMetric: "blasted_chart_metric",
	position: "blasted_launcher_position",
	showBadges: "blasted_show_badges",
	cachedAnalytics: "blasted_cached_analytics",
	cachedState: "blasted_cached_state",
};

export const DEFAULT_SETTINGS: ScriptSettings = {
	apiUrl: "https://sentinel.blasted-labs.tech",
	apiKey: "",
	panelOpen: false,
	persistOpen: false,
	activeTab: "crimes",
	timeframe: "30d",
	chartMetric: "financials",
	position: { x: 20, y: 120 },
	showBadges: true,
};

export const DEFAULT_CRIME_NAMES: Record<number, string> = {
	1: "Search For Cash",
	2: "Bootlegging",
	3: "Graffiti",
	4: "Shoplifting",
	5: "Pickpocketing",
	6: "Card Skimming",
	7: "Burglary",
	8: "Street Hustling",
	9: "Disposal",
	10: "Cracking",
	11: "Forgery",
	12: "Scamming",
	13: "Arson & Robbery",
};

export const CRIME_SLUG_MAP: Record<string, number> = {
	searchforcash: 1,
	"search-for-cash": 1,
	bootlegging: 2,
	graffiti: 3,
	shoplifting: 4,
	pickpocketing: 5,
	cardskimming: 6,
	"card-skimming": 6,
	burglary: 7,
	hustling: 8,
	"street-hustling": 8,
	disposal: 9,
	cracking: 10,
	forgery: 11,
	scamming: 12,
	arson: 13,
	"arson-robbery": 13,
};

export function formatMoney(val: number): string {
	if (!Number.isFinite(val) || val === 0) return "$0";
	const abs = Math.abs(val);
	const sign = val < 0 ? "-" : "";
	if (abs >= 1e9) {
		return `${sign}$${(abs / 1e9).toFixed(2)}B`;
	}
	if (abs >= 1e6) {
		return `${sign}$${(abs / 1e6).toFixed(2)}M`;
	}
	if (abs >= 1e3) {
		return `${sign}$${(abs / 1e3).toFixed(1)}k`;
	}
	return `${sign}$${Math.round(abs).toLocaleString()}`;
}

export function formatNumber(val: number): string {
	if (!Number.isFinite(val)) return "0";
	return Math.round(val).toLocaleString();
}
