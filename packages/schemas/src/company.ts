/**
 * Shared contract for the Oil Rig / company intelligence API (v2).
 *
 * This is the single source of truth for the company payload. It is produced by
 * `@sentinel/utils`'s `analyzeOilRig` (and assembled into directives by
 * `buildCompanyDirectives`), delivered to Discord by the director briefing, and
 * rendered by the Blasted's Script userscript in the browser.
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

export type CompanyAdAction = "freeze" | "maintain" | "increase" | "decrease";

export type CompanyCapacityActionKind = "rebalance" | "hire" | "storage";

export type CompanySellThroughVerdict =
	| "insufficient_data"
	| "unresponsive"
	| "partially_responsive"
	| "responsive";

/** How much weight a figure deserves, in plain terms. */
export type CompanyConfidence = "none" | "low" | "medium" | "high";

/**
 * What a price recommendation rests on. Anything other than "demand_fit" is not a
 * measurement and the surfaces say so.
 */
export type CompanyPriceBasis =
	| "demand_fit"
	| "inventory_buffer"
	| "measured_unresponsive"
	| "policy_band";

/** Whether the barrel price has been shown to move volume on this rig. */
export type CompanyPriceLeverVerdict = "works" | "does_not_work" | "unknown";

export type CompanyCapacityRegimeName = "balanced" | "extraction_bound";

/** Whether the capacity plan is asking for anything, and if not, why not. */
export type CompanyCapacityPlanState =
	| "balanced"
	| "action_required"
	| "holding";

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
	/** How much the production figure above deserves to be trusted. */
	dailyProducedConfidence?: CompanyConfidence;
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
 * The hysteretic capacity regime.
 *
 * The condition "extraction outruns sales" is removed by the remedy for it, so a
 * single threshold on that condition made the advice cycle between adding and
 * removing sell-through capacity. Entry and exit use different rules, and this
 * records which side of them the rig is on so the next brief can be hysteretic.
 */
export interface CompanyCapacityRegime {
	regime: CompanyCapacityRegimeName;
	/** True when the regime was carried over rather than freshly entered. */
	held: boolean;
	/**
	 * What actually changed since the previous brief. `held` cannot express this,
	 * because a first brief has nothing to hold or release.
	 */
	transition: "entered" | "released" | "held" | "none";
	/** Consecutive recorded days supporting the current reading. */
	dwellDays: number;
	fillingDays: number;
	drainingDays: number;
	/** When the current regime began. */
	sinceIso: string;
	/** Full explanation, for the dashboard. */
	reason: string;
	/** One-clause form for the briefing, which is read on a phone. */
	shortReason: string;
}

/**
 * The roster re-arrangement plan. Present whenever extraction outruns
 * sell-through, i.e. whenever the roster - not price or advertising - is the
 * thing standing between the rig and its output.
 */
export interface CompanyCapacityRebalance {
	extractionBound: boolean;
	/** Whether anything is still being asked for. */
	state: CompanyCapacityPlanState;
	/** False when the plan could not compare against the actual roster. */
	countsKnown: boolean;
	/**
	 * Barrels per day being LOST right now. Zero while the rig is draining:
	 * production above the sales rate is only discarded once storage is at its cap.
	 */
	discardedBarrelsPerDay: number;
	/**
	 * Median surplus measured on days storage still had room. Context for what the
	 * cap costs when it binds, never a claim about the present.
	 */
	discardedHistoricPerDay: number;
	/** True while the warehouse is at its cap and extraction outruns sales. */
	currentlyDiscarding: boolean;
	discardedPeakPerDay: number;
	/** Days of pre-cap history the discarded figure is based on. */
	discardedSamples: number;
	/** Value of discarded barrels at the current price (upper bound). */
	discardedValuePerDay: number;
	/** Lower bound measured from days that were already at critical fill. */
	discardedCappedLowerBound: number;
	/** True when there is not enough measured history to size the loss. */
	discardedEvidenceThin: boolean;
	/** Sell-through seats to fill from open capacity. */
	hires: number;
	quotaShifts: CompanyQuotaShift[];
	/** Seats still to move per role. Positive means under target. */
	seatDeltas: Record<string, number>;
	actions: CompanyCapacityAction[];
	summary: string;
	/** The exact condition under which the rebalance should be undone. */
	revertCondition: string;
	/** The same condition without the imperative, for inline rendering. */
	holdCondition: string;
	regime: CompanyCapacityRegime;
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

/** How a day's extraction figure was established. */
export interface CompanyProductionEstimate {
	dailyProduced?: number;
	/** Measured days the estimate rests on. */
	samples: number;
	confidence: CompanyConfidence;
	/** True when the most recent records were taken at full storage. */
	capped: boolean;
	summary: string;
}

/** The fitted barrel demand curve, so a reader sees the evidence behind a price. */
export interface CompanyDemandFit {
	usable: boolean;
	samples: number;
	r2: number;
	/** Price the fitted curve says maximises revenue, clamped to the band. */
	revenueMaxPrice: number;
	reason: string;
}

/** Inventory verdict plus the structural constraint, when there is one. */
export interface CompanyStockVerdict {
	state: CompanyInventoryState;
	/** True when this state was carried over rather than freshly entered. */
	stateHeld: boolean;
	stateDescription: string;
	fillPct: number;
	daysOfSales: number;
	isFillingUp: boolean;
	warehouseCritical: boolean;
	netDrainPerDay?: number;
	netFillPerDay?: number;
	/** Set when no price or ad setting can clear the surplus. */
	structuralAdvice?: string;
	production: CompanyProductionEstimate;
	priceLever: CompanyPriceLeverVerdict;
	demand: CompanyDemandFit;
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
		/** Why this recommendation was reached. */
		basis: string;
		/** Revenue per day one advertising rank step is worth. */
		rankStepValuePerDay: number;
		/** Ceiling no recommendation may exceed. */
		operationalCapPerDay: number;
	};
	pricing: {
		action: CompanyPriceAction;
		exact: number;
		formatted: string;
		/** True only while the live setting differs from the target. */
		isChanged: boolean;
		basis: CompanyPriceBasis;
		confidence: CompanyConfidence;
	};
	rehabTiers: {
		tier1: CompanyRehabTier[];
		tier2: CompanyRehabTier[];
		tier3: CompanyRehabTier[];
	};
	/** False whenever any directive, including the capacity rebalance, is open. */
	allOptimal: boolean;
}

/** Which data basis each decision input was taken from, and why. */
export interface CompanyAnalysisProvenance {
	dataBasis: "live" | "recorded";
	tickIsoDate?: string;
	tickAgeMinutes?: number;
	basisByField: Record<string, string>;
}

/**
 * Everything a reader needs in order to judge the advice: when it was taken, on
 * what basis, and what about the data would make it less trustworthy.
 *
 * This is what makes "why does the brief say something different this time?"
 * answerable without reading the code.
 */
export interface CompanyAnalysisMeta {
	asOfIso: string;
	provenance: CompanyAnalysisProvenance;
	/** Conditions that should lower a reader's confidence in the advice. */
	warnings: string[];
	/** The exact figures the advice was computed from. */
	decision: Record<string, number | string | undefined>;
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
	analysis: CompanyAnalysisMeta | null;
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
	/** True when barrels moved but production could not be measured. */
	producedEstimated?: boolean;
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
	/** True when the production figure above could not be measured. */
	producedEstimated: boolean;
	stock: number;
	fillPct: number;
	barrelPrice: number;
}

export interface CompanyHistoryResponse {
	success: boolean;
	timeline: CompanyHistoryEntry[];
}
