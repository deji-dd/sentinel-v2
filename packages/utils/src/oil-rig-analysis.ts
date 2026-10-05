import type { CompanyDirectives } from "../../schemas/src/company";
import { buildCompanyDirectives } from "./company-directives";
import {
	analyzeSellThroughResponse,
	analyzeStockAndPricing,
	assessCapacityRegime,
	type CapacityRegime,
	type DiscardedBarrelsEstimate,
	estimateDiscardedBarrels,
	type OilRigHistoryRecord,
	type OptimalRosterResult,
	type PriceLeverVerdict,
	type RosterBaseline,
	type SellThroughResponseAnalysis,
	type StockAnalysis,
	solveOptimalRoster,
} from "./oil-rig";
import {
	OIL_RIG_POLICY,
	type OilRigInventoryState,
	type OilRigPolicy,
} from "./oil-rig-policy";
import type { CompanySnapshot } from "./oil-rig-snapshot";

/**
 * The single analysis pipeline.
 *
 * WHY THIS EXISTS. The engines have to run in a specific order, and getting that
 * order wrong is what let the surfaces disagree:
 *
 *   sell-through response -> whether the price lever works
 *   stock analysis        -> inventory state, drain model, price and ad advice
 *   capacity regime       -> is extraction structurally bound (hysteretic)
 *   roster solve          -> target lineup, shaped by that regime
 *   capacity plan         -> only the seats still outstanding, against that roster
 *   directives            -> one assembled contract for every consumer
 *
 * The capacity plan compares targets against the roster, so the roster must be
 * solved with the SAME regime the plan uses. Computing the regime inside the
 * directives builder and a raw flag inside the solver - as the previous code did -
 * is precisely how the lineup and the rebalance advice ended up contradicting each
 * other. There is now one order, in one place, used by the briefing and the API.
 *
 * It is pure: no database, no network, no clock beyond the injected `asOfSeconds`.
 */

export interface OilRigAnalysisInput {
	snapshot: CompanySnapshot;
	history: OilRigHistoryRecord[];
	/** "live" when the snapshot came from the API, "recorded" from the last tick. */
	dataBasis: "live" | "recorded";
	/** Age of the recorded tick used for the rate figures, in minutes. */
	tickAgeMinutes?: number;
	asOfSeconds?: number;
	/** Inventory state recorded by the previous brief, for hysteresis. */
	previousState?: OilRigInventoryState;
	previousCritical?: boolean;
	/** Capacity regime recorded by the previous brief, for hysteresis. */
	previousRegime?: CapacityRegime;
	/** Measured top-rig roster baseline, when a fresh capture exists. */
	baseline?: RosterBaseline;
	policy?: OilRigPolicy;
}

export interface OilRigDecisionBasis {
	inStock: number;
	storageCap: number;
	fillPct: number;
	/** Whole-day barrels sold, from the recorded tick. */
	dailySold: number;
	dailyProduced?: number;
	currentPrice: number;
	currentAdBudget: number;
	/** Whole-day recorded revenue: the ad rank model's baseline. */
	recordedDailyRevenue: number;
	/**
	 * Revenue the game reports for the week, taken from the record itself. The
	 * briefing used to print "weekly revenue" as daily x 7, which is a fabricated
	 * figure: it assumes every day matches the last one.
	 */
	recordedWeeklyRevenue: number;
	recordedDailyWages: number;
	recordedAdBudget: number;
	recordedDailyProfit: number;
	openSeats: number;
	staffCount: number;
	/**
	 * Sales Executive headcount. Recorded so the next brief can attribute the
	 * outcome of a sell-through rebalance against what was actually done.
	 */
	salesHeadcount: number;
	asOfSeconds: number;
}

export interface OilRigProvenance {
	dataBasis: "live" | "recorded";
	tickIsoDate?: string;
	tickAgeMinutes?: number;
	/** Which basis each decision input was taken from, and why. */
	basisByField: Record<string, string>;
}

export interface OilRigAnalysis {
	stock: StockAnalysis;
	regime: CapacityRegime;
	roster: OptimalRosterResult;
	discarded: DiscardedBarrelsEstimate;
	sellThrough: SellThroughResponseAnalysis;
	directives: CompanyDirectives;
	decision: OilRigDecisionBasis;
	provenance: OilRigProvenance;
	/** Conditions a reader needs in order to distrust the advice appropriately. */
	warnings: string[];
}

/**
 * Maps the measured price response onto a verdict the price engine can act on.
 *
 * This is the wiring that was missing: `analyzeSellThroughResponse` already
 * computed "price cuts are NOT working" and the briefing already printed that
 * sentence, while the price engine recommended another cut in the same message.
 */
export function priceLeverFromSellThrough(
	analysis: SellThroughResponseAnalysis,
): PriceLeverVerdict {
	if (analysis.verdict === "unresponsive") return "does_not_work";
	if (
		analysis.verdict === "responsive" ||
		analysis.verdict === "partially_responsive"
	) {
		return "works";
	}
	return "unknown";
}

export function analyzeOilRig(input: OilRigAnalysisInput): OilRigAnalysis {
	const policy = input.policy ?? OIL_RIG_POLICY;
	const asOfSeconds = input.asOfSeconds ?? Math.floor(Date.now() / 1000);
	const snapshot = input.snapshot;
	const history = input.history;
	const warnings: string[] = [];

	const tick = history.length > 0 ? history[history.length - 1] : undefined;
	const oilStock = snapshot.stock[0];
	const storageCap = snapshot.profile.upgrades.storage_capacity ?? 750_000;

	// ---- One basis per field -------------------------------------------------
	// STATE variables (stock on hand, price, ad setting, roster) come from the
	// live snapshot, because they are what the director's last action changed and
	// the brief has to reflect it.
	//
	// RATE variables (barrels sold per day, production per day, revenue per day)
	// come from the recorded whole-day tick. A mid-day live `sold_amount` is a
	// partial day, and comparing a partial-day sales figure against a whole-day
	// production figure is what let two briefs on the same data disagree purely
	// because they were asked at different hours.
	const inStock = oilStock?.in_stock ?? 0;
	const currentPrice = oilStock?.price ?? tick?.stock?.barrelPrice ?? 181;
	const currentAdBudget = Math.max(
		0,
		Number(snapshot.profile.advertisement_budget ?? 0),
	);
	const dailySold = tick?.stock?.soldAmount ?? oilStock?.sold_amount ?? 0;
	const recordedDailyRevenue =
		tick?.dailyIncome ?? snapshot.profile.income.daily;
	const recordedWeeklyRevenue =
		tick?.weeklyIncome ?? snapshot.profile.income.weekly;
	const recordedDailyWages =
		tick?.dailyWages ??
		snapshot.employees.reduce((sum, e) => sum + (e.wage ?? 0), 0);
	const recordedAdBudget = tick?.adBudget ?? currentAdBudget;
	const recordedDailyProfit =
		tick?.dailyProfit ??
		recordedDailyRevenue - recordedDailyWages - recordedAdBudget;

	if (!tick) {
		warnings.push(
			"No recorded tick yet: rate figures fall back to a partial live day, so this advice is provisional.",
		);
	} else if (
		input.tickAgeMinutes !== undefined &&
		input.tickAgeMinutes > 36 * 60
	) {
		warnings.push(
			`Rate figures come from a tick ${Math.round((input.tickAgeMinutes ?? 0) / 60)}h old; a change you make now will not show up in them until the next tick.`,
		);
	}

	// ---- Sell-through response: needed before the price decision -------------
	const sellThrough = analyzeSellThroughResponse(history);
	const priceLever = priceLeverFromSellThrough(sellThrough);

	// ---- Stock, price and advertising ---------------------------------------
	// The live ad setting is what the director controls; the recorded tick is what
	// any past probe will show up in. When they disagree a change is in flight, and
	// the ad engine must hold rather than ask for another increase.
	const pendingSettingChange =
		Math.abs(currentAdBudget - recordedAdBudget) > policy.advertising.tolerance;

	const stock = analyzeStockAndPricing({
		inStock,
		storageCap,
		dailySold,
		// Only a genuinely measured tick figure may act as the latest measurement.
		// Passing a display-only estimate here would bypass the measured-production
		// rule entirely and let a single row fake a bottleneck.
		dailyProduced:
			tick && tick.producedMeasured !== false ? tick.dailyProduced : undefined,
		currentPrice,
		adBudget: currentAdBudget,
		dailyIncome: snapshot.profile.income.daily,
		referenceDailyRevenue: recordedDailyRevenue,
		previousState: input.previousState,
		previousCritical: input.previousCritical,
		history,
		// The benchmark capture already knows how many rigs exist, so the ad model
		// uses the measured field rather than the built-in assumption.
		advertiserFieldSize: input.baseline?.fieldSize,
		pendingSettingChange,
		priceLever,
		asOfSeconds,
		policy,
	});

	// ---- Capacity regime, then the roster that regime implies ----------------
	const regime = assessCapacityRegime({
		history,
		fillPct: stock.fillPct,
		isFillingUp: stock.isFillingUp,
		warehouseCritical: stock.warehouseCritical,
		previousRegime: input.previousRegime?.regime,
		previousSince: input.previousRegime?.since,
		asOfSeconds,
		policy: policy.capacity,
	});

	const openSeats = Math.max(
		0,
		snapshot.profile.employees.capacity - snapshot.profile.employees.hired,
	);

	const roster = solveOptimalRoster(snapshot.employees, {
		bottleneck: { extractionBound: regime.regime === "extraction_bound" },
		baseline: input.baseline,
	});

	const discarded = estimateDiscardedBarrels(history);

	if (stock.production.confidence === "none") {
		warnings.push(
			"Extraction is unmeasured, so no drain or capacity conclusion is drawn from it.",
		);
	} else if (stock.production.confidence === "low") {
		warnings.push(
			`Extraction rests on ${stock.production.samples} measured day, too few to separate a real rate from one unusual day; the roster is not restructured on it.`,
		);
	}
	if (discarded.evidenceThin && regime.regime === "extraction_bound") {
		warnings.push(
			"The constraint is real but its cost is unknown: discarded volume cannot be measured while storage is capped.",
		);
	}
	if (!roster.blueprintSource.includes("benchmark")) {
		warnings.push(
			"Target lineup uses the built-in hand-written blueprint; no measured top-rig baseline yet (run the competitor benchmark).",
		);
	}
	if (stock.adRankModel.fieldSize === policy.advertising.assumedFieldSize) {
		warnings.push(
			`The advertising rank step assumes ${policy.advertising.assumedFieldSize} companies; the real field size is not yet measured, so a probe may be sized too small.`,
		);
	}
	if (stock.recommendedPrice.basis === "policy_band") {
		warnings.push(
			"Price advice is a policy-band default, not a measured optimum: too little recorded price variation to fit a demand curve.",
		);
	}

	const directives = buildCompanyDirectives({
		roster,
		stock,
		history,
		regime,
		discarded,
		sellThrough,
		currentAdBudget,
		barrelPrice: currentPrice,
		openSeats,
		staffCount: snapshot.employees.length,
		baseline: input.baseline,
		asOfSeconds,
	});

	return {
		stock,
		regime,
		roster,
		discarded,
		sellThrough,
		directives,
		decision: {
			inStock,
			storageCap,
			fillPct: stock.fillPct,
			dailySold,
			dailyProduced: stock.production.dailyProduced,
			currentPrice,
			currentAdBudget,
			recordedDailyRevenue,
			recordedWeeklyRevenue,
			recordedDailyWages,
			recordedAdBudget,
			recordedDailyProfit,
			openSeats,
			staffCount: snapshot.employees.length,
			salesHeadcount: roster.currentCounts["Sales Executive"] ?? 0,
			asOfSeconds,
		},
		provenance: {
			dataBasis: input.dataBasis,
			tickIsoDate: tick?.isoDate,
			tickAgeMinutes: input.tickAgeMinutes,
			basisByField: {
				inStock: "live snapshot (current state)",
				currentPrice: "live snapshot (current setting)",
				currentAdBudget: "live snapshot (current setting)",
				roster: "live snapshot (current placement)",
				dailySold: tick
					? `recorded tick ${tick.isoDate} (whole day)`
					: "live snapshot (partial day, no tick recorded)",
				dailyProduced: "recorded history (measured stock delta)",
				recordedDailyRevenue: tick
					? `recorded tick ${tick.isoDate} (whole day)`
					: "live snapshot",
				recordedDailyWages: tick
					? `recorded tick ${tick.isoDate} (whole day)`
					: "live snapshot",
				advertisingBaseline: tick
					? `recorded tick ${tick.isoDate} whole-day revenue`
					: "live snapshot revenue",
			},
		},
		warnings,
	};
}
