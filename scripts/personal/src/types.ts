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
	activeTab: "crimes" | "stocks" | "battlestats" | "wealth" | "settings";
	timeframe: "7d" | "30d" | "90d" | "all";
	chartMetric: "financials" | "activity";
	position: { x: number; y: number };
	showBadges: boolean;
}
