/**
 * Shared contract for the Oil Rig / company intelligence API (v2).
 *
 * This is the single source of truth for the company payload. It is produced by
 * `services/api` (and assembled by `@sentinel/utils`'s buildCompanyDirectives),
 * delivered to Discord by the director briefing, and rendered by the
 * Blasted's Script userscript in the browser.
 *
 * Purpose: the dashboard, the in-page badges and the Discord briefing must never
 * disagree about what the rig should do. Any new directive belongs here first,
 * so every consumer fails to compile until it handles it.
 *
 * This module is intentionally dependency-free and must stay that way: the
 * userscript imports it type-only and bundles for the browser.
 */

export type CompanyInventoryState = "deficit" | "equilibrium" | "surplus";

export type CompanyPriceAction = "increase" | "maintain" | "decrease";

export type CompanyAdAction = "freeze" | "maintain" | "increase";

export type CompanyCapacityActionKind = "rebalance" | "hire" | "storage";

export type CompanySellThroughVerdict =
	| "insufficient_data"
	| "unresponsive"
	| "partially_responsive"
	| "responsive";

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

export interface CompanyRoleTransfer {
	name: string;
	fromRole: string;
	toRole: string;
	statsStr: string;
	rationale?: string;
}

export interface CompanyRehabTier {
	name: string;
	penalty: number;
	role?: string;
}

/** One seat move that carries the capacity rebalance into the target lineup. */
export interface CompanyQuotaShift {
	role: string;
	from: number;
	to: number;
}

export interface CompanyCapacityAction {
	kind: CompanyCapacityActionKind;
	reason: string;
	/** Upper-bound revenue per day this unlocks, at the current barrel price. */
	estimatedGainPerDay: number;
	/** True when the change should be undone once stock normalises. */
	temporary: boolean;
}

/**
 * The roster re-arrangement plan. Present whenever extraction outruns
 * sell-through, i.e. whenever the roster - not price or advertising - is the
 * thing standing between the rig and its output.
 */
export interface CompanyCapacityRebalance {
	extractionBound: boolean;
	/** Barrels per day produced beyond what the rig can sell. */
	discardedBarrelsPerDay: number;
	discardedPeakPerDay: number;
	/** Days of pre-cap history the discarded figure is based on. */
	discardedSamples: number;
	/** Value of discarded barrels at the current price (upper bound). */
	discardedValuePerDay: number;
	/** Sell-through seats to fill from open capacity. */
	hires: number;
	quotaShifts: CompanyQuotaShift[];
	actions: CompanyCapacityAction[];
	summary: string;
}

/** How barrel sales have actually responded to recent price changes. */
export interface CompanySellThroughResponse {
	verdict: CompanySellThroughVerdict;
	summary: string;
	samples: number;
	priceChangePct: number;
	volumeChangePct: number;
	revenueChangePct: number;
}

/** Inventory verdict plus the structural constraint, when there is one. */
export interface CompanyStockVerdict {
	state: CompanyInventoryState;
	stateDescription: string;
	fillPct: number;
	daysOfSales: number;
	isFillingUp: boolean;
	warehouseCritical: boolean;
	netDrainPerDay?: number;
	netFillPerDay?: number;
	/** Set when no price or ad setting can clear the surplus. */
	structuralAdvice?: string;
}

export interface CompanyDirectives {
	roleTransfers: CompanyRoleTransfer[];
	capacityRebalance: CompanyCapacityRebalance;
	sellThrough: CompanySellThroughResponse;
	stock: CompanyStockVerdict;
	adSpend: {
		action: CompanyAdAction;
		amount: number;
		formatted: string;
		/** True only while the live setting differs from the target. */
		isChanged: boolean;
	};
	pricing: {
		action: CompanyPriceAction;
		exact: number;
		formatted: string;
		/** True only while the live setting differs from the target. */
		isChanged: boolean;
	};
	rehabTiers: {
		tier1: CompanyRehabTier[];
		tier2: CompanyRehabTier[];
		tier3: CompanyRehabTier[];
	};
	/** False whenever any directive, including the capacity rebalance, is open. */
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
	/** Set when the roster solver wants this employee in another role. */
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
