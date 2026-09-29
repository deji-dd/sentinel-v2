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

export interface CompanyProfile {
	name: string;
	rating: number;
	funds: number;
	efficiency: number;
	environment: number;
	popularity: number;
	employees: { hired: number; capacity: number };
	storageCapacity: number;
}

export interface CompanyKPIs {
	wtdProfit: number;
	wtdRevenue: number;
	wtdExpenses: number;
	dailyIncome: number;
	dailyWages: number;
	dailyAdBudget: number;
	dailyExpenses: number;
	dailyProfit: number;
	inStock: number;
	storageCapacity: number;
	fillPct: number;
	barrelPrice: number;
	dailySold: number;
	dailyProduced?: number;
}

export interface CompanyDirectives {
	roleTransfers: Array<{
		name: string;
		fromRole: string;
		toRole: string;
		statsStr: string;
	}>;
	adSpend: {
		action: string;
		amount: number;
		formatted: string;
		isChanged: boolean;
	};
	pricing: {
		action: string;
		exact: number;
		formatted: string;
		isChanged: boolean;
	};
	rehabTiers: {
		tier1: Array<{ name: string; penalty: number }>;
		tier2: Array<{ name: string; penalty: number }>;
		tier3: Array<{ name: string; penalty: number }>;
	};
	allOptimal: boolean;
}

export interface CompanyEmployee {
	id: number;
	name: string;
	positionName: string;
	wage: number;
	addiction: number;
	stats: {
		manualLabor: number;
		intelligence: number;
		endurance: number;
	};
	targetRole?: string;
	isOptimal: boolean;
	rehabTier?: 1 | 2 | 3;
}

export interface CompanyStateResponse {
	success: boolean;
	profile: CompanyProfile | null;
	kpis: CompanyKPIs | null;
	directives: CompanyDirectives | null;
	employees: CompanyEmployee[];
	message?: string;
}

export interface WeeklyLogEntry {
	dayOfWeek: string;
	isoDate: string;
	revenue: number;
	wages: number;
	adBudget: number;
	expenses: number;
	profit: number;
	soldBarrels: number;
	producedBarrels?: number;
	barrelPrice: number;
}

export interface WeeklyTotals {
	totalRevenue: number;
	totalWages: number;
	totalAd: number;
	totalExpenses: number;
	totalProfit: number;
	totalSold: number;
	totalProduced: number;
	avgPrice: number;
}

export interface CompanyWeeklyLogsResponse {
	success: boolean;
	offset: number;
	hasPrev: boolean;
	hasNext: boolean;
	mondayIso: string;
	sundayIso: string;
	weekLabel: string;
	entries: WeeklyLogEntry[];
	totals: WeeklyTotals;
}

export interface CompanyHistoryEntry {
	isoDate: string;
	timestamp: number;
	income: number;
	wages: number;
	adBudget: number;
	expenses: number;
	profit: number;
	sold: number;
	produced: number;
	stock: number;
	fillPct: number;
	barrelPrice: number;
}

export interface CompanyHistoryResponse {
	success: boolean;
	timeline: CompanyHistoryEntry[];
}
