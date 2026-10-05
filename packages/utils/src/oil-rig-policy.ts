/**
 * Every tunable constant the Oil Rig advice engines depend on.
 *
 * This module is deliberately dependency-free so the policy can be read, tested
 * and changed without touching engine logic, and so the briefing, the dashboard
 * and the userscript all quote the same numbers.
 *
 * TWO CLASSES OF CONSTANT LIVE HERE, and the distinction matters for accuracy:
 *
 * 1. MEASURED-derived policy - thresholds and deadbands that shape *how* the
 *    engines read this rig's own recorded data (hysteresis, smoothing, tolerance).
 *    These are engineering choices and are safe to tune.
 *
 * 2. DIRECTOR ASSUMPTIONS - figures that are not observable from the Torn API at
 *    all. The advertising rank curve is the important one: the wiki states the
 *    maximum base effect is 40% and that it is awarded by RANK among the
 *    companies of the same type carrying an ad budget, so the per-rank step is
 *    40% / (number of advertisers). That field size is not visible to us, so it is
 *    an assumption recorded here rather than a fact asserted in the briefing.
 *    Nothing derived from an assumption is ever presented as a measurement.
 */

export type OilRigInventoryState = "deficit" | "equilibrium" | "surplus";

/** Hysteretic inventory thresholds. Enter and exit values always differ. */
export interface OilRigInventoryPolicy {
	/** Fill percentage below which the warehouse enters the deficit state. */
	deficitEnterPct: number;
	/** Fill percentage above which a deficit state is released. */
	deficitExitPct: number;
	/** Fill percentage above which the warehouse enters the surplus state. */
	surplusEnterPct: number;
	/** Fill percentage below which a surplus state is released. */
	surplusExitPct: number;
	/** Fill percentage at or above which output may be discarded. */
	criticalEnterPct: number;
	/** Fill percentage below which the critical flag is released. */
	criticalExitPct: number;
	/** Stock below this many days of sales counts as effectively exhausted. */
	minDaysOfStock: number;
	/** Healthy buffer the advice steers toward, for rationale text only. */
	bufferLowPct: number;
	bufferHighPct: number;
}

export interface OilRigPricePolicy {
	/** Lowest barrel price the engine will ever recommend. */
	floor: number;
	/** Highest barrel price the engine will ever recommend. */
	ceiling: number;
	/** Current price within this of target counts as already on target. */
	tolerance: number;
	/** Smallest change worth issuing; anything smaller is reported as "hold". */
	deadband: number;
	/** Largest single price move one brief may recommend. */
	maxStepPerAdvice: number;
	/** Minimum usable observations before a demand curve may be fitted. */
	minSamplesForFit: number;
	/** Minimum R² before a fitted optimum is trusted enough to act on. */
	minR2ForFit: number;
	/** Below this fill, sales are supply-limited rather than demand-limited. */
	minFillPctForDemandObservation: number;
	/** Price held while the warehouse is in deficit, to slow sell-through. */
	deficitHoldPrice: number;
}

export interface OilRigAdPolicy {
	/** Wiki: "Advertising has a maximum base effect of 40% on a company." */
	maxBonusPct: number;
	/**
	 * Wiki example: with 80 same-type companies carrying an ad budget the top
	 * spender receives 40%, the second 39.5%, the third 39%, and so on - a 0.5%
	 * step, i.e. maxBonusPct / 80. The true field size is not observable from the
	 * API, so it is an assumption. Changing it changes only how large a probe the
	 * engine is willing to fund, never a claimed measurement.
	 */
	assumedFieldSize: number;
	/** Current budget within this of target counts as already on target. */
	tolerance: number;
	/** Recommended budgets are rounded to this granularity. */
	rounding: number;
	/** Hard operational cap on spend as a share of reference daily revenue. */
	maxShareOfReferenceRevenue: number;
	/** Minimum recorded days between two upward probes. */
	probeHoldDays: number;
	/** Records required after a budget change before its effect is judged. */
	minRecordsAfterProbe: number;
	/** A customer change smaller than this share of the pre-probe level is noise. */
	noiseRelativeThreshold: number;
	/** Measured marginal revenue per ad dollar must exceed this to justify raising. */
	minMarginalReturnRatio: number;
}

export interface OilRigCapacityPolicy {
	/** Every extraction-side role keeps at least this many seats. */
	minExtractionRoleCount: number;
	/** Seats moved from extraction into sell-through in one rebalance. */
	maxShift: number;
	/** Most seats taken from any single role, so a rebalance stays measured. */
	maxShiftPerRole: number;
	/** Open seats proposed for hiring into sell-through. */
	maxHiresPerPlan: number;
	/**
	 * Consecutive recorded days of net stock fill before the rig may ENTER the
	 * extraction-bound regime. Entering on a single day's reading is what let the
	 * advice flip back and forth.
	 */
	enterConsecutiveFillDays: number;
	/**
	 * Consecutive recorded days of net drain before the rig may LEAVE the regime.
	 * Because adding sell-through capacity is itself what removes the "extraction
	 * outruns sales" condition, the exit rule must be strictly harder to satisfy
	 * than the entry rule or the advice oscillates forever.
	 */
	exitConsecutiveDrainDays: number;
	/** The warehouse must also be at or below this fill before the regime exits. */
	exitMaxFillPct: number;
	/**
	 * Fill percentage above which extraction outrunning sales is a PROBLEM.
	 *
	 * Below the healthy buffer, extraction outrunning sales is desirable: the rig
	 * is short of stock and wants it to accumulate. Entering the regime on net fill
	 * alone let the advice demand sell-through capacity on a rig whose warehouse was
	 * at 29% and falling, which is exactly backwards. Entry therefore requires
	 * storage pressure as well as the fill trend.
	 */
	enterMinFillPct: number;
	/**
	 * Minimum measured discarded barrels/day required to justify reshuffling the
	 * roster. Below this the brief reports the constraint and holds.
	 */
	minMeasuredDiscardBarrels: number;
	/** Days of measured production averaged by the smoothing estimator. */
	smoothedProductionDays: number;
	/** Measured samples required before a production estimate is high confidence. */
	confidentProductionSamples: number;
}

export interface OilRigPolicy {
	inventory: OilRigInventoryPolicy;
	price: OilRigPricePolicy;
	advertising: OilRigAdPolicy;
	capacity: OilRigCapacityPolicy;
}

/**
 * Current policy. Every value here is either an engineering deadband or an
 * explicitly-labelled assumption; see the module comment.
 */
export const OIL_RIG_POLICY: OilRigPolicy = {
	inventory: {
		deficitEnterPct: 32,
		deficitExitPct: 38,
		surplusEnterPct: 78,
		surplusExitPct: 73,
		criticalEnterPct: 95,
		criticalExitPct: 90,
		minDaysOfStock: 1.5,
		bufferLowPct: 45,
		bufferHighPct: 70,
	},
	price: {
		floor: 180,
		ceiling: 186,
		tolerance: 1,
		deadband: 2,
		maxStepPerAdvice: 3,
		minSamplesForFit: 5,
		minR2ForFit: 0.35,
		minFillPctForDemandObservation: 10,
		deficitHoldPrice: 185,
	},
	advertising: {
		maxBonusPct: 40,
		assumedFieldSize: 80,
		tolerance: 50_000,
		rounding: 100_000,
		maxShareOfReferenceRevenue: 0.15,
		probeHoldDays: 3,
		minRecordsAfterProbe: 2,
		noiseRelativeThreshold: 0.02,
		minMarginalReturnRatio: 1,
	},
	capacity: {
		minExtractionRoleCount: 1,
		maxShift: 2,
		maxShiftPerRole: 1,
		maxHiresPerPlan: 2,
		enterConsecutiveFillDays: 2,
		exitConsecutiveDrainDays: 3,
		exitMaxFillPct: 60,
		// Matches the inventory policy's surplus threshold: this is the point at
		// which additional stock stops being useful.
		enterMinFillPct: 78,
		minMeasuredDiscardBarrels: 500,
		smoothedProductionDays: 3,
		confidentProductionSamples: 3,
	},
};

/**
 * Backwards-compatible view of the capacity policy.
 *
 * The capacity tuning used to live in `oil-rig.ts` as `OIL_RIG_CAPACITY_POLICY`;
 * it now lives in the central policy object so all four engines are tuned in one
 * place, but the name is kept so existing callers keep working.
 */
export const OIL_RIG_CAPACITY_POLICY = OIL_RIG_POLICY.capacity;

/**
 * Schmitt trigger for the inventory state.
 *
 * A single hard threshold made the whole recommendation chatter: at 79.9% fill
 * the brief said "hold", at 80.1% it demanded a price cut and an ad increase, so
 * a rig sitting on the boundary produced contradictory advice on consecutive
 * fetches. Entering and leaving on different thresholds removes that entirely.
 *
 * `previous` is the state recorded by the last brief. When it is absent (no
 * recorded brief yet) the enter thresholds are used directly.
 */
export function resolveInventoryState(params: {
	fillPct: number;
	daysOfSales: number;
	previous?: OilRigInventoryState;
	policy?: OilRigInventoryPolicy;
}): OilRigInventoryState {
	const policy = params.policy ?? OIL_RIG_POLICY.inventory;
	const { fillPct, daysOfSales, previous } = params;
	const criticallyShort = daysOfSales < policy.minDaysOfStock;

	// Stay in the state we are already in until its release threshold is met.
	if (
		previous === "deficit" &&
		(fillPct < policy.deficitExitPct || criticallyShort)
	) {
		return "deficit";
	}
	if (previous === "surplus" && fillPct > policy.surplusExitPct) {
		return "surplus";
	}

	if (fillPct < policy.deficitEnterPct || criticallyShort) return "deficit";
	if (fillPct > policy.surplusEnterPct) return "surplus";
	return "equilibrium";
}

/**
 * Schmitt trigger for the "storage is full enough that output may be discarded"
 * flag, for the same anti-chatter reason as `resolveInventoryState`.
 */
export function resolveWarehouseCritical(params: {
	fillPct: number;
	previous?: boolean;
	policy?: OilRigInventoryPolicy;
}): boolean {
	const policy = params.policy ?? OIL_RIG_POLICY.inventory;
	return params.previous
		? params.fillPct >= policy.criticalExitPct
		: params.fillPct >= policy.criticalEnterPct;
}
