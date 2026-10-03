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
	ratioType: "blasted_ratio_type",
	mainStat: "blasted_main_stat",
	battlestatsTimeframe: "blasted_battlestats_timeframe",
	cachedBattlestatsState: "blasted_cached_battlestats_state",
	cachedBattlestatsAnalytics: "blasted_cached_battlestats_analytics",
	cachedEfficiency: "blasted_cached_efficiency",
	battlestatsGoal: "blasted_battlestats_goal",
	cachedCompanyState: "blasted_cached_company_state",
	companyChartMode: "blasted_company_chart_mode",
	companyWeeklyOffset: "blasted_company_weekly_offset",
};

export const POLLING_CONFIG = {
	FAST_INTERVAL_MS: 30000,
	SLOW_INTERVAL_MS: 120000,
	DRAWER_INTERVAL_MS: 15000,
	HUD_ACTIVITY_TIMEOUT_MS: 60000,
	STORAGE_HUD_CYCLE: "sentinel_last_hud_cycle",
} as const;

export const DEFAULT_SETTINGS: ScriptSettings = {
	apiUrl: "https://api.blasted-labs.tech",
	apiKey: "",
	panelOpen: false,
	persistOpen: false,
	activeTab: "crimes",
	timeframe: "30d",
	chartMetric: "financials",
	position: { x: 20, y: 120 },
	showBadges: true,
	ratioType: "baldr",
	mainStat: "dexterity",
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

export function formatDecimal(val: number, decimals = 2): string {
	if (!Number.isFinite(val)) return "0";
	return val.toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
}

export function formatCompactNumber(val: number, decimals = 2): string {
	if (!Number.isFinite(val) || val === 0) return "0";
	const abs = Math.abs(val);
	const sign = val < 0 ? "-" : "";
	if (abs >= 1e9) {
		return `${sign}${(abs / 1e9).toFixed(decimals)}B`;
	}
	if (abs >= 1e6) {
		return `${sign}${(abs / 1e6).toFixed(decimals)}M`;
	}
	if (abs >= 1e3) {
		return `${sign}${(abs / 1e3).toFixed(1)}k`;
	}
	return `${sign}${Math.round(abs).toLocaleString()}`;
}

export function parseShorthandNumber(input: string): number | null {
	if (!input) return null;
	const clean = input.trim().replace(/,/g, "").toLowerCase();
	const match = clean.match(/^([0-9.]+)\s*([kmb])?$/);
	if (!match?.[1]) return null;
	const num = Number.parseFloat(match[1]);
	if (!Number.isFinite(num) || Number.isNaN(num)) return null;
	const suffix = match[2];
	if (suffix === "b") return Math.round(num * 1e9);
	if (suffix === "m") return Math.round(num * 1e6);
	if (suffix === "k") return Math.round(num * 1e3);
	return Math.round(num);
}

export const STAT_CONSTANTS = {
	strength: { a: 1600, b: 1700 },
	speed: { a: 1600, b: 2000 },
	dexterity: { a: 1800, b: 1500 },
	defense: { a: 2100, b: -600 },
} as const;

export const GYM_DEFINITIONS: Record<
	number,
	{
		name: string;
		energy: number;
		strength: number;
		speed: number;
		defense: number;
		dexterity: number;
	}
> = {
	1: {
		name: "Premier Fitness",
		energy: 5,
		strength: 0.5,
		speed: 0.5,
		defense: 0.5,
		dexterity: 0.5,
	},
	2: {
		name: "Average Joes",
		energy: 5,
		strength: 1.0,
		speed: 1.0,
		defense: 1.0,
		dexterity: 1.0,
	},
	3: {
		name: "Woody's Workout Club",
		energy: 5,
		strength: 1.5,
		speed: 1.5,
		defense: 1.5,
		dexterity: 1.5,
	},
	4: {
		name: "Beach Bods",
		energy: 5,
		strength: 2.0,
		speed: 2.0,
		defense: 2.0,
		dexterity: 2.0,
	},
	5: {
		name: "Silver Gym",
		energy: 5,
		strength: 2.5,
		speed: 2.5,
		defense: 2.5,
		dexterity: 2.5,
	},
	6: {
		name: "Pour Femme",
		energy: 5,
		strength: 3.0,
		speed: 3.0,
		defense: 3.0,
		dexterity: 3.0,
	},
	7: {
		name: "Davies Den",
		energy: 5,
		strength: 3.5,
		speed: 3.5,
		defense: 3.5,
		dexterity: 3.5,
	},
	8: {
		name: "Global Gym",
		energy: 5,
		strength: 4.0,
		speed: 4.0,
		defense: 4.0,
		dexterity: 4.0,
	},
	9: {
		name: "Knuckle Heads",
		energy: 10,
		strength: 4.5,
		speed: 4.5,
		defense: 4.5,
		dexterity: 4.5,
	},
	10: {
		name: "Pioneer Fitness",
		energy: 10,
		strength: 5.0,
		speed: 5.0,
		defense: 5.0,
		dexterity: 5.0,
	},
	11: {
		name: "Anabolic Anomalies",
		energy: 10,
		strength: 5.2,
		speed: 5.2,
		defense: 5.2,
		dexterity: 5.2,
	},
	12: {
		name: "Core",
		energy: 10,
		strength: 5.4,
		speed: 5.4,
		defense: 5.4,
		dexterity: 5.4,
	},
	13: {
		name: "Racing Fitness",
		energy: 10,
		strength: 5.6,
		speed: 5.6,
		defense: 5.6,
		dexterity: 5.6,
	},
	14: {
		name: "Complete Cardio",
		energy: 10,
		strength: 5.8,
		speed: 5.8,
		defense: 5.8,
		dexterity: 5.8,
	},
	15: {
		name: "Legs, Bums and Tums",
		energy: 10,
		strength: 6.0,
		speed: 6.0,
		defense: 6.0,
		dexterity: 6.0,
	},
	16: {
		name: "Deep Burn",
		energy: 10,
		strength: 6.2,
		speed: 6.2,
		defense: 6.2,
		dexterity: 6.2,
	},
	17: {
		name: "Apollo Gym",
		energy: 10,
		strength: 6.4,
		speed: 6.4,
		defense: 6.4,
		dexterity: 6.4,
	},
	18: {
		name: "Gun Shop",
		energy: 10,
		strength: 6.6,
		speed: 6.6,
		defense: 6.6,
		dexterity: 6.6,
	},
	19: {
		name: "Force Training",
		energy: 10,
		strength: 6.8,
		speed: 6.8,
		defense: 6.8,
		dexterity: 6.8,
	},
	20: {
		name: "Cha Cha's",
		energy: 10,
		strength: 7.0,
		speed: 7.0,
		defense: 7.0,
		dexterity: 7.0,
	},
	21: {
		name: "Atlas",
		energy: 10,
		strength: 7.1,
		speed: 7.1,
		defense: 7.1,
		dexterity: 7.1,
	},
	22: {
		name: "Last Round",
		energy: 10,
		strength: 7.2,
		speed: 7.2,
		defense: 7.2,
		dexterity: 7.2,
	},
	23: {
		name: "The Edge",
		energy: 10,
		strength: 7.3,
		speed: 7.3,
		defense: 7.3,
		dexterity: 7.3,
	},
	24: {
		name: "George's",
		energy: 10,
		strength: 7.5,
		speed: 7.5,
		defense: 7.5,
		dexterity: 7.5,
	},
	25: {
		name: "Balboas Gym",
		energy: 25,
		strength: 8.5,
		speed: 7.0,
		defense: 7.0,
		dexterity: 7.0,
	},
	26: {
		name: "Frontline Fitness",
		energy: 25,
		strength: 7.0,
		speed: 7.0,
		defense: 8.5,
		dexterity: 7.0,
	},
	27: {
		name: "Gym 3000",
		energy: 50,
		strength: 8.0,
		speed: 10.0,
		defense: 8.0,
		dexterity: 8.0,
	},
	28: {
		name: "Mr. Isoyamas",
		energy: 50,
		strength: 8.0,
		speed: 8.0,
		defense: 8.0,
		dexterity: 10.0,
	},
	29: {
		name: "Total Rebound",
		energy: 50,
		strength: 10.0,
		speed: 8.0,
		defense: 8.0,
		dexterity: 8.0,
	},
	30: {
		name: "Elites",
		energy: 50,
		strength: 8.0,
		speed: 8.0,
		defense: 10.0,
		dexterity: 8.0,
	},
	31: {
		name: "The Sports Science Lab",
		energy: 25,
		strength: 7.0,
		speed: 8.5,
		defense: 7.0,
		dexterity: 8.5,
	},
	32: {
		name: "Unknown",
		energy: 10,
		strength: 7.5,
		speed: 7.5,
		defense: 7.5,
		dexterity: 7.5,
	},
};

export function getTargetRatios(
	ratioType: "baldr" | "hank",
	mainStat: "strength" | "defense" | "speed" | "dexterity",
): Record<"strength" | "defense" | "speed" | "dexterity", number> {
	if (ratioType === "baldr") {
		// Baldr: 25/20/18/18 -> 30.86% main, 24.69% secondary, 22.22% other two
		const pairs: Record<
			"strength" | "defense" | "speed" | "dexterity",
			"strength" | "defense" | "speed" | "dexterity"
		> = {
			strength: "speed",
			speed: "strength",
			defense: "dexterity",
			dexterity: "defense",
		};
		const secondary = pairs[mainStat];
		const ratios: Record<
			"strength" | "defense" | "speed" | "dexterity",
			number
		> = {
			strength: 0.2222,
			defense: 0.2222,
			speed: 0.2222,
			dexterity: 0.2222,
		};
		ratios[mainStat] = 0.3086;
		ratios[secondary] = 0.2469;
		return ratios;
	}

	// Hank's: 34% main, 28% / 28% secondary, 10% dump
	const dumps: Record<
		"strength" | "defense" | "speed" | "dexterity",
		"strength" | "defense" | "speed" | "dexterity"
	> = {
		strength: "dexterity",
		defense: "dexterity",
		speed: "defense",
		dexterity: "strength",
	};
	const dump = dumps[mainStat];
	const ratios: Record<"strength" | "defense" | "speed" | "dexterity", number> =
		{
			strength: 0.28,
			defense: 0.28,
			speed: 0.28,
			dexterity: 0.28,
		};
	ratios[mainStat] = 0.34;
	ratios[dump] = 0.1;
	return ratios;
}

export function calculateGymGainBreakdown(
	statType: "strength" | "defense" | "speed" | "dexterity",
	currentStat: number,
	happy: number,
	gymDots: number,
	energyCost: number,
	perkMultiplier: number,
) {
	const S = Math.min(currentStat, 50_000_000);
	const H = happy;
	const { a, b } = STAT_CONSTANTS[statType];

	const lnHappy = Math.log(1 + H / 250);
	const roundedLn = Number(lnHappy.toFixed(4));
	const gymFactor = Number((1 + 0.07 * roundedLn).toFixed(4));

	const happyFactor = 8 * H ** 1.05;
	const statConstantFactor = (1 - (H / 99999) ** 2) * a + b;

	const G = gymDots / 10;
	const E = energyCost;

	const baseGain = S * gymFactor + happyFactor + statConstantFactor;
	const totalGain = baseGain * (1 / 200000) * G * E * perkMultiplier;
	const gainPerE = totalGain / (E || 1);

	return {
		totalGain,
		gainPerE,
		gymFactor,
		happyFactor,
		statConstantFactor,
		baseGain,
		perkMultiplier,
		G,
	};
}
