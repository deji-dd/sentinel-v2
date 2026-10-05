import type {
	CompanyCapacityRebalance,
	CompanyDirectives,
	CompanySellThroughResponse,
	CompanyStockVerdict,
} from "../../schemas/src/company";
import {
	analyzeSellThroughResponse,
	estimateDiscardedBarrels,
	type OilRigHistoryRecord,
	type OptimalRosterResult,
	planCapacityRebalance,
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
 * It is pure: pass in the engine outputs, get back the shared contract type.
 */
export function buildCompanyDirectives(inputs: {
	roster: OptimalRosterResult;
	stock: StockAnalysis;
	history: OilRigHistoryRecord[];
	currentAdBudget: number;
	barrelPrice: number;
	openSeats: number;
	/** Staff count the blueprint quotas are derived from. */
	staffCount: number;
}): CompanyDirectives {
	const sellThrough = analyzeSellThroughResponse(inputs.history);
	const discarded = estimateDiscardedBarrels(inputs.history);

	const plan = planCapacityRebalance({
		staffCount: inputs.staffCount,
		stock: inputs.stock,
		barrelPrice: inputs.barrelPrice,
		openSeats: inputs.openSeats,
		discardedBarrelsPerDay: discarded.medianSurplus,
	});

	const capacityRebalance: CompanyCapacityRebalance = {
		extractionBound: plan.extractionBound,
		discardedBarrelsPerDay: plan.discardedBarrelsPerDay,
		discardedPeakPerDay: discarded.peakSurplus,
		discardedSamples: discarded.samples,
		discardedValuePerDay: plan.discardedValuePerDay,
		hires: plan.hires,
		quotaShifts: plan.quotaShifts,
		actions: plan.actions,
		summary: plan.summary,
	};

	const sellThroughResponse: CompanySellThroughResponse = {
		verdict: sellThrough.verdict,
		summary: sellThrough.summary,
		samples: sellThrough.samples,
		priceChangePct: sellThrough.priceChangePct,
		volumeChangePct: sellThrough.volumeChangePct,
		revenueChangePct: sellThrough.revenueChangePct,
	};

	const stock: CompanyStockVerdict = {
		state: inputs.stock.state,
		stateDescription: inputs.stock.stateDescription,
		fillPct: inputs.stock.fillPct,
		daysOfSales: inputs.stock.daysOfSales,
		isFillingUp: inputs.stock.isFillingUp,
		warehouseCritical: inputs.stock.warehouseCritical,
		netDrainPerDay: inputs.stock.netDrainPerDay,
		netFillPerDay: inputs.stock.netFillPerDay,
		structuralAdvice: inputs.stock.structuralAdvice,
	};

	const hasPriceSuggestion = inputs.stock.recommendedPrice.changeNeeded;
	const hasAdSuggestion = inputs.stock.recommendedAdSpend.changeNeeded;
	const hasRoleTransfers = inputs.roster.activeTransfers.length > 0;
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
		},
		pricing: {
			action: inputs.stock.recommendedPrice.action,
			exact: inputs.stock.recommendedPrice.exact,
			formatted: inputs.stock.recommendedPrice.formatted,
			isChanged: hasPriceSuggestion,
		},
		rehabTiers: { tier1: t1, tier2: t2, tier3: t3 },
		// A capacity rebalance counts: a rig that cannot clear its output is not
		// in an optimal state, however well the price and ad settings are tuned.
		allOptimal:
			!hasRoleTransfers &&
			!hasPriceSuggestion &&
			!hasAdSuggestion &&
			t1.length + t2.length + t3.length === 0 &&
			!capacityRebalance.extractionBound,
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
