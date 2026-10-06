import type {
	CompanyCapacityRebalance,
	CompanyDirectives,
	CompanySellThroughResponse,
	CompanyStockVerdict,
} from "../../schemas/src/company";
import {
	type CapacityRegime,
	type DiscardedBarrelsEstimate,
	type OilRigHistoryRecord,
	type OptimalRosterResult,
	planCapacityRebalance,
	type RosterBaseline,
	type SellThroughResponseAnalysis,
	type StockAnalysis,
} from "./oil-rig";

/**
 * Assembles the company directive set from the domain engines.
 *
 * This exists so the Discord director briefing and the v2 API dashboard are
 * literally the same analysis, not two implementations that drift. Every
 * consumer - Discord DM, dashboard, in-page userscript badges - reads the
 * directives this function produces.
 *
 * It is pure and it takes the engines' outputs as already-computed inputs. The
 * engines have to run in a particular order and the capacity plan depends on the
 * roster, so the ordering lives in `analyzeOilRig`; this function only assembles.
 * Pass in the engine outputs, get back the shared contract type.
 */
export interface CompanyDirectiveInputs {
	roster: OptimalRosterResult;
	stock: StockAnalysis;
	history: OilRigHistoryRecord[];
	/** Hysteretic capacity regime the roster was solved against. */
	regime: CapacityRegime;
	discarded: DiscardedBarrelsEstimate;
	sellThrough: SellThroughResponseAnalysis;
	currentAdBudget: number;
	barrelPrice: number;
	openSeats: number;
	/** Staff count the blueprint quotas are derived from. */
	staffCount: number;
	baseline?: RosterBaseline;
	asOfSeconds?: number;
}

export function buildCompanyDirectives(
	inputs: CompanyDirectiveInputs,
): CompanyDirectives {
	// The capacity plan is built here rather than in the analysis because it is the
	// one engine that needs BOTH the stock state and the solved roster: it reports
	// only the seats still outstanding, which is what makes the advice idempotent.
	const plan = planCapacityRebalance({
		staffCount: inputs.staffCount,
		stock: inputs.stock,
		barrelPrice: inputs.barrelPrice,
		openSeats: inputs.openSeats,
		discardedBarrelsPerDay: inputs.discarded.medianSurplus,
		currentCounts: inputs.roster.currentCounts,
		regime: inputs.regime,
		baseline: inputs.baseline,
		discardedEvidenceThin: inputs.discarded.evidenceThin,
		asOfSeconds: inputs.asOfSeconds,
	});

	const capacityRebalance: CompanyCapacityRebalance = {
		extractionBound: plan.extractionBound,
		state: plan.state,
		countsKnown: plan.countsKnown,
		discardedBarrelsPerDay: plan.discardedBarrelsPerDay,
		discardedHistoricPerDay: plan.discardedHistoricPerDay,
		currentlyDiscarding: plan.currentlyDiscarding,
		discardedPeakPerDay: inputs.discarded.peakSurplus,
		discardedSamples: inputs.discarded.samples,
		discardedValuePerDay: plan.discardedValuePerDay,
		discardedCappedLowerBound: inputs.discarded.cappedLowerBound,
		discardedEvidenceThin: inputs.discarded.evidenceThin,
		hires: plan.hires,
		quotaShifts: plan.quotaShifts,
		seatDeltas: plan.seatDeltas,
		actions: plan.actions,
		summary: plan.summary,
		revertCondition: plan.revertCondition,
		holdCondition: plan.holdCondition,
		regime: {
			regime: plan.regime.regime,
			held: plan.regime.held,
			transition: plan.regime.transition,
			dwellDays: plan.regime.dwellDays,
			fillingDays: plan.regime.fillingDays,
			drainingDays: plan.regime.drainingDays,
			sinceIso: new Date(plan.regime.since * 1000).toISOString(),
			reason: plan.regime.reason,
			shortReason: plan.regime.shortReason,
		},
	};

	const sellThroughResponse: CompanySellThroughResponse = {
		verdict: inputs.sellThrough.verdict,
		summary: inputs.sellThrough.summary,
		samples: inputs.sellThrough.samples,
		priceChangePct: inputs.sellThrough.priceChangePct,
		volumeChangePct: inputs.sellThrough.volumeChangePct,
		revenueChangePct: inputs.sellThrough.revenueChangePct,
	};

	const stock: CompanyStockVerdict = {
		state: inputs.stock.state,
		stateHeld: inputs.stock.stateHeld,
		stateDescription: inputs.stock.stateDescription,
		fillPct: inputs.stock.fillPct,
		daysOfSales: inputs.stock.daysOfSales,
		isFillingUp: inputs.stock.isFillingUp,
		warehouseCritical: inputs.stock.warehouseCritical,
		netDrainPerDay: inputs.stock.netDrainPerDay,
		netFillPerDay: inputs.stock.netFillPerDay,
		structuralAdvice: inputs.stock.structuralAdvice,
		production: {
			dailyProduced: inputs.stock.production.dailyProduced,
			samples: inputs.stock.production.samples,
			confidence: inputs.stock.production.confidence,
			capped: inputs.stock.production.capped,
			summary: inputs.stock.production.summary,
		},
		priceLever: inputs.stock.priceLever,
		demand: {
			usable: inputs.stock.demand.usable,
			samples: inputs.stock.demand.samples,
			r2: inputs.stock.demand.r2,
			revenueMaxPrice: inputs.stock.demand.revenueMaxPrice,
			reason: inputs.stock.demand.reason,
		},
	};

	const hasRoleTransfers = inputs.roster.activeTransfers.length > 0;
	const hasPriceSuggestion = inputs.stock.recommendedPrice.changeNeeded;
	const hasAdSuggestion = inputs.stock.recommendedAdSpend.changeNeeded;
	const t1 = inputs.roster.rehabTiers.tier1;
	const t2 = inputs.roster.rehabTiers.tier2;
	const t3 = inputs.roster.rehabTiers.tier3;

	return {
		roleTransfers: inputs.roster.activeTransfers.map((t) => ({
			name: t.name,
			fromRole: t.fromRole,
			toRole: t.toRole,
			statsStr: t.statsStr,
			rationale: t.rationale,
		})),
		capacityRebalance,
		sellThrough: sellThroughResponse,
		stock,
		adSpend: {
			action: inputs.stock.recommendedAdSpend.action,
			amount: inputs.stock.recommendedAdSpend.amount,
			formatted: inputs.stock.recommendedAdSpend.formatted,
			isChanged: hasAdSuggestion,
			basis: inputs.stock.recommendedAdSpend.basis,
			rankStepValuePerDay: inputs.stock.adRankModel.revenuePerRankStepPerDay,
			operationalCapPerDay: inputs.stock.adRankModel.operationalCapPerDay,
		},
		pricing: {
			action: inputs.stock.recommendedPrice.action,
			exact: inputs.stock.recommendedPrice.exact,
			formatted: inputs.stock.recommendedPrice.formatted,
			isChanged: hasPriceSuggestion,
			basis: inputs.stock.recommendedPrice.basis,
			confidence: inputs.stock.recommendedPrice.confidence,
		},
		rehabTiers: { tier1: t1, tier2: t2, tier3: t3 },
		// "Optimal" means nothing is being asked of the director. A rig that still
		// cannot clear its output is not optimal, but a rig whose roster already
		// carries the sell-through weight the bottleneck requires has nothing
		// outstanding - that state is reported as "holding" by the plan, not as a
		// repeated demand and not as an all-clear.
		allOptimal:
			!hasRoleTransfers &&
			!hasPriceSuggestion &&
			!hasAdSuggestion &&
			t1.length + t2.length + t3.length === 0 &&
			plan.state === "balanced",
	};
}

/** Convenience for callers that only need the employees' target roles. */
export function buildTargetRoleMap(
	directives: CompanyDirectives,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const transfer of directives.roleTransfers) {
		map.set(transfer.name, transfer.toRole);
	}
	return map;
}
