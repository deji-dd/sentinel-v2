export interface CrimeCategoryAnalytics {
	crimeId: number;
	crimeName: string;
	count: number;
	nerve: number;
	value: number;
	efficiency: number;
	percentage: number;
}

export interface DailyCrimeTimeline {
	date: string;
	count: number;
	nerve: number;
	value: number;
	efficiency: number;
}

export interface HourlyDistribution {
	hour: number;
	count: number;
	nerve: number;
}

export interface TopLootEvent {
	id: string;
	action: string;
	crimeId: number;
	crimeName: string;
	nerve: number;
	value: number;
	timestamp: string | number;
}

export interface CrimeLedgerState {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedCrimes: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totalInDb: number;
	totalNerveSpent: number;
	totalLootValue: number;
	distinctCrimesCount: number;
	totalPersonalLogsCrimes: number;
	dbOldestDate: string | null;
	dbNewestDate: string | null;
	topProfitCategory?: CrimeCategoryAnalytics | null;
	topEfficientCategory?: CrimeCategoryAnalytics | null;
	allTimeCategories?: CrimeCategoryAnalytics[];
}

export interface CrimeAnalyticsResponse {
	kpis: {
		totalCrimes: number;
		totalNerve: number;
		totalValue: number;
		overallEfficiency: number;
		avgNervePerCrime: number;
		avgValuePerCrime: number;
	};
	timeline: DailyCrimeTimeline[];
	categories: CrimeCategoryAnalytics[];
	hourlyDistribution?: HourlyDistribution[];
	topLootEvents?: TopLootEvent[];
}

export interface CrimeDefinition {
	id: number;
	name: string;
}

export interface ScriptSettings {
	apiUrl: string;
	apiKey: string;
	panelOpen: boolean;
	persistOpen: boolean;
	activeTab:
		| "crimes"
		| "stocks"
		| "battlestats"
		| "company"
		| "wealth"
		| "settings";
	timeframe: "7d" | "30d" | "90d" | "all";
	chartMetric: "financials" | "activity";
	position: { x: number; y: number };
	showBadges: boolean;
	ratioType: "baldr" | "hank";
	mainStat: "strength" | "defense" | "speed" | "dexterity";
}

export type StatType = "strength" | "defense" | "speed" | "dexterity";
export type RatioType = "baldr" | "hank";

export interface DailyBattlestatsTimeline {
	date: string;
	strength: number;
	defense: number;
	speed: number;
	dexterity: number;
	totalGained: number;
	trains: number;
	energyUsed: number;
	count: number;
}

export interface StatCategoryAnalytics {
	statType: string;
	count: number;
	gained: number;
	trains: number;
	energy: number;
	efficiency: number;
	percentage: number;
}

export interface StatSourceAnalytics {
	source: "gym" | "item" | "book" | "company";
	count: number;
	gained: number;
	trains: number;
	energy: number;
	percentage: number;
}

export interface BattlestatsAnalyticsResponse {
	summary: {
		totalGained: number;
		totalTrains: number;
		totalEnergyUsed: number;
		totalLogs: number;
		avgGainPerTrain: number;
		avgGainPerEnergy: number;
	};
	statBreakdown: StatCategoryAnalytics[];
	sourceBreakdown?: StatSourceAnalytics[];
	timeline: DailyBattlestatsTimeline[];
}

export interface BattlestatsLedgerState {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedLogs: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totals?: {
		totalInDb: number;
		totalStatGained: number;
		totalTrains: number;
		totalEnergyUsed: number;
		avgGainPerTrain: number;
		avgGainPerEnergy: number;
		matchingPersonalLogs: number;
		minTimestamp: number | null;
		maxTimestamp: number | null;
	};
	allTimeStats?: StatCategoryAnalytics[];
}

export interface ActiveGymData {
	id: string;
	name: string;
	cost: number;
	energy: number;
	strength: number;
	speed: number;
	defense: number;
	dexterity: number;
}

export interface EfficiencyDataPayload {
	stats: {
		strength: number;
		defense: number;
		speed: number;
		dexterity: number;
	};
	maxHappy: number;
	perks: {
		strength: number;
		defense: number;
		speed: number;
		dexterity: number;
	};
	activeGyms: {
		strength: ActiveGymData | null;
		defense: ActiveGymData | null;
		speed: ActiveGymData | null;
		dexterity: ActiveGymData | null;
	};
}

/**
 * Company / Oil Rig API payloads.
 *
 * These are re-exported from the shared contract in `packages/schemas` that the
 * API itself is typed against, so the dashboard, the in-page badges and the
 * Discord briefing cannot drift apart. This is a type-only import: nothing from
 * the schemas package (or its dependencies) reaches the userscript bundle.
 */
export type {
	CompanyCapacityAction,
	CompanyCapacityActionKind,
	CompanyCapacityRebalance,
	CompanyDirectives,
	CompanyEmployee,
	CompanyHistoryEntry,
	CompanyHistoryResponse,
	CompanyInventoryState,
	CompanyKPIs,
	CompanyProfile,
	CompanyQuotaShift,
	CompanyRehabTier,
	CompanyRoleTransfer,
	CompanySellThroughResponse,
	CompanySellThroughVerdict,
	CompanyStateResponse,
	CompanyStockVerdict,
	CompanyWeeklyLogsResponse,
	WeeklyLogEntry,
	WeeklyTotals,
} from "../../../packages/schemas/src/company";
