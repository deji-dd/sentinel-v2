import type { OilRigHistoryRecord } from "./oil-rig";
import {
	OIL_RIG_POLICY,
	type OilRigAdPolicy,
	type OilRigInventoryState,
} from "./oil-rig-policy";

/**
 * Advertising advice, built on the wiki's rank model of company advertising.
 *
 * THE MECHANIC. "Advertising has a maximum base effect of 40% on a company, and
 * will be reduced based on the number of competing companies, and their
 * advertising budgets. If there are 80 companies of the same type with an
 * advertising budget, the company with the highest budget will receive the 40%
 * bonus, with the second highest receiving a 39.5% bonus, the third highest
 * receiving a 39% bonus, etc."
 *
 * TWO CONSEQUENCES THAT CHANGE THE ADVICE COMPLETELY:
 *
 * 1. The bonus is awarded by RANK, not by the size of the budget. A budget
 *    increase buys nothing at all unless it overtakes another company, and then
 *    it buys one whole step: 40% / (number of advertisers) of revenue. With the
 *    wiki's 80-company example that step is 0.5%, which for a rig earning $50M a
 *    day is $250k/day. So a probe is only worth funding up to what one rank step
 *    is worth - spending more than that to gain a single rank loses money.
 *
 * 2. Competitors' budgets are not observable, so our rank is not observable
 *    either. The engine therefore never asserts a rank. It measures OUR OWN
 *    response to OUR OWN past budget changes and advises accordingly: probe in
 *    steps, measure whether the step bought traffic, and hold rather than
 *    compound spend on an unmeasured effect.
 *
 * The old engine scaled the ad budget to a share of revenue (10% of daily income)
 * and, because revenue rises when advertising works, complying raised the target
 * and produced another "increase" demand - a ratchet with no basis in the game's
 * actual mechanic. Nothing here is derived from the current budget, so it cannot
 * ratchet.
 */

export type AdResponseVerdict =
	| "insufficient_data"
	| "probe_pending"
	| "unmeasured_effect"
	| "negative"
	| "positive";

export interface AdRankModel {
	/** Assumed number of same-type companies carrying an ad budget. */
	fieldSize: number;
	/** Wiki maximum base effect, in percentage points of revenue. */
	maxBonusPct: number;
	/** Percentage points of bonus lost per rank. */
	stepPct: number;
	/** Revenue per day that one rank step is worth at the reference revenue. */
	revenuePerRankStepPerDay: number;
	/** The whole 40% band is worth at most this much per day. */
	maxJustifiedSpendPerDay: number;
	/** Operational spend cap actually applied to recommendations. */
	operationalCapPerDay: number;
	rationale: string;
}

/**
 * Bonus percentage points awarded to the company holding a given rank.
 *
 * Rank 1 receives the full `maxBonusPct`; each subsequent rank loses one step of
 * `maxBonusPct / fieldSize`, with ranks past the advertiser field receiving
 * nothing. This is the wiki curve, expressed so it can be unit-tested and so the
 * engine's assumptions are visible rather than buried.
 */
export function adBonusPctForRank(
	rank: number,
	fieldSize: number,
	maxBonusPct = OIL_RIG_POLICY.advertising.maxBonusPct,
): number {
	if (fieldSize <= 0 || rank > fieldSize) return 0;
	if (rank < 1) return maxBonusPct;
	const step = maxBonusPct / fieldSize;
	return Number(Math.max(0, maxBonusPct - step * (rank - 1)).toFixed(4));
}

/** Inverse of `adBonusPctForRank`: the rank a given bonus corresponds to. */
export function rankForAdBonusPct(
	pct: number,
	fieldSize: number,
	maxBonusPct = OIL_RIG_POLICY.advertising.maxBonusPct,
): number {
	if (pct >= maxBonusPct) return 1;
	if (pct <= 0 || fieldSize <= 0) return fieldSize + 1;
	const step = maxBonusPct / fieldSize;
	return Math.min(fieldSize, Math.round(1 + (maxBonusPct - pct) / step));
}

/**
 * The economic frame for advertising: what one rank step is worth per day, and
 * the hard ceiling beyond which no amount of advertising can pay for itself.
 */
export function buildAdRankModel(input: {
	/** Stable revenue baseline; must NOT be a value the ad budget itself moves. */
	referenceDailyRevenue: number;
	/**
	 * Measured number of same-type companies in the industry, when the competitor
	 * benchmark has been run. Only the companies CARRYING an ad budget compete for
	 * rank, and that count is not visible, so the total is used: it is an upper
	 * bound on the advertiser count, which makes the implied step (40% / N) a LOWER
	 * bound on what a rank is worth. Erring small under-funds a probe, and
	 * over-spending on advertising is the riskier mistake.
	 */
	fieldSize?: number;
	policy?: OilRigAdPolicy;
}): AdRankModel {
	const policy = input.policy ?? OIL_RIG_POLICY.advertising;
	const revenue = Math.max(0, input.referenceDailyRevenue);
	const measuredSize =
		input.fieldSize !== undefined && input.fieldSize > 0
			? input.fieldSize
			: undefined;
	const fieldSize: number = measuredSize ?? policy.assumedFieldSize;
	const measured = measuredSize !== undefined;
	const stepPct = policy.maxBonusPct / fieldSize;
	const revenuePerRankStepPerDay = Math.round((stepPct / 100) * revenue);
	const maxJustifiedSpendPerDay = Math.round(
		(policy.maxBonusPct / 100) * revenue,
	);
	const operationalCapPerDay = Math.round(
		Math.min(
			maxJustifiedSpendPerDay,
			policy.maxShareOfReferenceRevenue * revenue,
		),
	);

	return {
		fieldSize,
		maxBonusPct: policy.maxBonusPct,
		stepPct: Number(stepPct.toFixed(4)),
		revenuePerRankStepPerDay,
		maxJustifiedSpendPerDay,
		operationalCapPerDay,
		rationale: `Advertising pays by rank, not by amount: the wiki caps the base effect at ${policy.maxBonusPct}% and awards it in steps of ${policy.maxBonusPct}% ÷ ${fieldSize} = ${stepPct.toFixed(2)}% of revenue per rank, worth about $${revenuePerRankStepPerDay.toLocaleString()}/day at this rig's revenue. A budget increase only pays if it overtakes another advertiser. ${
			measured
				? `The field of ${fieldSize} companies is the measured industry listing; the number actually advertising is smaller, so this step is a lower bound.`
				: `The field of ${fieldSize} companies is an assumption, not a measurement: run the competitor benchmark to replace it with the real listing.`
		}`,
	};
}

export interface AdProbeObservation {
	isoDate: string;
	timestamp: number;
	fromAdBudget: number;
	toAdBudget: number;
	delta: number;
	/** Records available after the change to judge its effect. */
	recordsAfter: number;
	customersBefore?: number;
	customersAfter?: number;
	revenueBefore?: number;
	revenueAfter?: number;
	/** Traffic change as a share of the pre-probe level. */
	customersChangePct?: number;
	/** Measured extra revenue per extra ad dollar, per day. */
	marginalRevenuePerAdDollar?: number;
	verdict: AdResponseVerdict;
	summary: string;
}

export interface AdResponseEstimate {
	/** Most recent budget change observed in the recorded history. */
	latest?: AdProbeObservation;
	/** Every change event found, most recent first. */
	observations: AdProbeObservation[];
	/** Which traffic signal the measurement used. */
	signal: "daily_customers" | "barrels_sold" | "revenue_only";
	/** True when the live setting differs from the last recorded tick. */
	pendingSettingChange: boolean;
	summary: string;
}

export interface AdResponseOptions {
	policy?: OilRigAdPolicy;
	/** Live setting, so an un-recorded change is not treated as no change. */
	currentAdBudget?: number;
	/** Records averaged either side of a change. */
	window?: number;
}

const mean = (values: number[]): number =>
	values.length === 0
		? 0
		: values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Measures what this rig's own past advertising changes actually bought.
 *
 * A snapshot recorded at time T reports the day that ended at T together with the
 * budget live at T, so a change first shows up in the records AFTER the record
 * that carries it. The comparison therefore averages the records before the
 * change against the records after it, and refuses to judge a probe until
 * `minRecordsAfterProbe` records exist - which is also what stops the engine
 * demanding a second increase before the first one has been measured.
 */
export function estimateAdResponse(
	history: OilRigHistoryRecord[],
	options?: AdResponseOptions,
): AdResponseEstimate {
	const policy = options?.policy ?? OIL_RIG_POLICY.advertising;
	const window = Math.max(1, options?.window ?? policy.minRecordsAfterProbe);

	const hasCustomers = history.some((h) => (h.dailyCustomers ?? 0) > 0);
	const signal: AdResponseEstimate["signal"] = hasCustomers
		? "daily_customers"
		: history.some((h) => (h.stock?.soldAmount ?? 0) > 0)
			? "barrels_sold"
			: "revenue_only";

	const traffic = (h: OilRigHistoryRecord): number => {
		if (signal === "daily_customers") return h.dailyCustomers ?? 0;
		if (signal === "barrels_sold") return h.stock?.soldAmount ?? 0;
		return h.dailyIncome;
	};

	const observations: AdProbeObservation[] = [];

	for (let i = 1; i < history.length; i++) {
		const current = history[i];
		const previous = history[i - 1];
		if (!current || !previous) continue;

		const fromAdBudget = previous.adBudget ?? 0;
		const toAdBudget = current.adBudget ?? 0;
		if (fromAdBudget === toAdBudget) continue;

		const before = history.slice(Math.max(0, i - window), i);
		const after = history.slice(i + 1, i + 1 + window);
		const delta = toAdBudget - fromAdBudget;

		const base: AdProbeObservation = {
			isoDate: current.isoDate,
			timestamp: current.timestamp,
			fromAdBudget,
			toAdBudget,
			delta,
			recordsAfter: after.length,
			verdict: "probe_pending",
			summary: "",
		};

		if (after.length < policy.minRecordsAfterProbe) {
			observations.push({
				...base,
				verdict: "probe_pending",
				summary: `Ad budget moved from $${fromAdBudget.toLocaleString()} to $${toAdBudget.toLocaleString()} on ${current.isoDate} and only ${after.length} recorded day${after.length === 1 ? "" : "s"} have followed it; ${policy.minRecordsAfterProbe} are needed before its effect can be measured.`,
			});
			continue;
		}

		const customersBefore = mean(before.map(traffic));
		const customersAfter = mean(after.map(traffic));
		const revenueBefore = mean(before.map((h) => h.dailyIncome));
		const revenueAfter = mean(after.map((h) => h.dailyIncome));
		const revenuePerCustomer =
			customersAfter > 0 ? revenueAfter / customersAfter : 0;

		const customersChangePct =
			customersBefore > 0
				? Number(
						(
							((customersAfter - customersBefore) / customersBefore) *
							100
						).toFixed(1),
					)
				: 0;

		const marginal =
			delta !== 0
				? ((customersAfter - customersBefore) * revenuePerCustomer) / delta
				: undefined;

		const label = signal === "daily_customers" ? "customers" : "barrels sold";

		// A change smaller than the noise threshold is not a measurement of
		// anything, and must never be reported as a successful or a failed probe.
		const isNoise =
			Math.abs(customersChangePct) < policy.noiseRelativeThreshold * 100;

		let verdict: AdResponseVerdict;
		let summary: string;

		if (isNoise) {
			verdict = "unmeasured_effect";
			summary = `Moving the ad budget by $${Math.abs(delta).toLocaleString()}/day on ${current.isoDate} produced no measurable traffic change: ${label} moved ${customersChangePct >= 0 ? "+" : ""}${customersChangePct}% across the following ${after.length} recorded days. At this field's step size a budget increase only pays when it overtakes another advertiser, so this change bought no rank.`;
		} else if (
			marginal !== undefined &&
			marginal >= policy.minMarginalReturnRatio
		) {
			verdict = "positive";
			summary = `The ad change on ${current.isoDate} paid for itself: $${Math.abs(delta).toLocaleString()}/day of extra budget moved ${label} ${customersChangePct >= 0 ? "+" : ""}${customersChangePct}%, about $${Math.round(marginal).toLocaleString()} of revenue per additional dollar spent.`;
		} else {
			verdict = "negative";
			summary = `The ad change on ${current.isoDate} did not pay for itself: $${Math.abs(delta).toLocaleString()}/day of extra budget moved ${label} ${customersChangePct >= 0 ? "+" : ""}${customersChangePct}%, returning about $${Math.round(marginal ?? 0).toLocaleString()} of revenue per additional dollar spent.`;
		}

		observations.push({
			...base,
			customersBefore: Math.round(customersBefore),
			customersAfter: Math.round(customersAfter),
			revenueBefore: Math.round(revenueBefore),
			revenueAfter: Math.round(revenueAfter),
			customersChangePct,
			marginalRevenuePerAdDollar:
				marginal !== undefined ? Number(marginal.toFixed(3)) : undefined,
			verdict,
			summary,
		});
	}

	const latest = observations[observations.length - 1];
	const lastRecordedAdBudget =
		history.length > 0 ? (history[history.length - 1]?.adBudget ?? 0) : 0;
	// Only a RECORDED tick can disagree with the live setting. With no history at
	// all there is nothing to compare against, and treating a non-zero budget as an
	// un-recorded change made the engine hold forever on a fresh rig.
	const pendingSettingChange =
		options?.currentAdBudget !== undefined &&
		history.length > 0 &&
		Math.abs(options.currentAdBudget - lastRecordedAdBudget) > policy.tolerance;

	let summary: string;
	if (observations.length === 0) {
		summary = pendingSettingChange
			? "The live ad budget differs from the last recorded day, so a change is in flight and has not been measured yet."
			: "No recorded ad budget change yet, so this rig's advertising response is unmeasured. Only a ranked comparison against other advertisers - which is not publicly visible - could establish it, so the engine probes and measures instead.";
	} else if (latest) {
		summary = latest.summary;
		if (pendingSettingChange) {
			summary += ` The live setting has since changed again and is not yet recorded.`;
		}
	} else {
		summary = "No recorded ad budget change yet.";
	}

	return {
		latest,
		observations: observations.reverse(),
		signal,
		pendingSettingChange,
		summary,
	};
}

export type AdRecommendationBasis =
	| "inventory_deficit"
	| "equilibrium"
	| "probe"
	| "probe_pending"
	| "measured_positive"
	| "measured_no_effect"
	| "measured_negative"
	| "above_ceiling";

export interface AdRecommendation {
	action: "freeze" | "maintain" | "increase" | "decrease";
	amount: number;
	formatted: string;
	rationale: string;
	changeNeeded: boolean;
	basis: AdRecommendationBasis;
	rankModel: AdRankModel;
	response: AdResponseEstimate;
}

export interface AdRecommendationInput {
	currentAdBudget: number;
	/** Recorded whole-day revenue: a baseline the ad budget did not set. */
	referenceDailyRevenue: number;
	state: OilRigInventoryState;
	/** True when the warehouse cannot drain, so demand is the binding constraint. */
	extractionBound: boolean;
	history: OilRigHistoryRecord[];
	policy?: OilRigAdPolicy;
	/** Measured industry field size, when the benchmark has been run. */
	fieldSize?: number;
	/** Live setting differs from the recorded tick; a change is already in flight. */
	pendingSettingChange?: boolean;
	/** Analysis time in epoch seconds; injected so the engine stays deterministic. */
	asOfSeconds?: number;
}

const roundTo = (value: number, granularity: number): number =>
	Math.max(0, Math.round(value / granularity) * granularity);

/**
 * Rounds down to the granularity.
 *
 * The operational cap is a hard ceiling: rounding to nearest could push a
 * recommendation above it, which would let the engine advise spending more than
 * the whole advertising bonus band is worth.
 */
const roundDownTo = (value: number, granularity: number): number =>
	Math.max(0, Math.floor(value / granularity) * granularity);

/**
 * Recommends a single absolute ad budget.
 *
 * The target never references the current budget as a scaling factor, so
 * complying cannot move the target, and it is bounded by what one advertising
 * rank step is actually worth. The engine only asks for an increase when either
 * the previous increase was measured to pay for itself, or no probe has been run
 * inside the hold window - and it holds, visibly and with the reason attached,
 * when a probe bought nothing.
 */
export function recommendAdBudget(
	input: AdRecommendationInput,
): AdRecommendation {
	const policy = input.policy ?? OIL_RIG_POLICY.advertising;
	const asOfSeconds = input.asOfSeconds ?? Math.floor(Date.now() / 1000);
	const current = Math.max(0, input.currentAdBudget);
	const rankModel = buildAdRankModel({
		referenceDailyRevenue: input.referenceDailyRevenue,
		fieldSize: input.fieldSize,
		policy,
	});
	const response = estimateAdResponse(input.history, {
		policy,
		currentAdBudget: current,
	});

	const make = (
		partial: Omit<AdRecommendation, "rankModel" | "response">,
	): AdRecommendation => ({ ...partial, rankModel, response });

	const hold = (rationale: string, basis: AdRecommendationBasis) =>
		make({
			action: input.state === "deficit" ? "freeze" : "maintain",
			amount: current,
			formatted: `Maintain at $${current.toLocaleString()}/day.`,
			rationale,
			changeNeeded: false,
			basis,
		});

	// The warehouse cannot serve more customers, so buying traffic is pure waste.
	if (input.state === "deficit") {
		return hold(
			`Hold at $${current.toLocaleString()}/day. Advertising buys customers, and a warehouse below the safe buffer cannot serve the customers it already has, so extra traffic would only drain reserves faster.`,
			"inventory_deficit",
		);
	}

	// Above the ceiling no advertising decision can pay for itself, whatever the
	// rank curve says, so the only defensible advice is to come back down.
	if (
		current > rankModel.operationalCapPerDay &&
		rankModel.operationalCapPerDay > 0
	) {
		const target = roundDownTo(rankModel.operationalCapPerDay, policy.rounding);
		return make({
			action: "decrease",
			amount: target,
			formatted: `Reduce to $${target.toLocaleString()}/day.`,
			rationale: `Reduce to $${target.toLocaleString()}/day. The wiki caps advertising's base effect at ${policy.maxBonusPct}%, so at $${Math.round(input.referenceDailyRevenue).toLocaleString()}/day of revenue the entire bonus band is worth about $${rankModel.maxJustifiedSpendPerDay.toLocaleString()}/day; spend above $${target.toLocaleString()}/day cannot be recovered by any rank it could buy.`,
			changeNeeded: true,
			basis: "above_ceiling",
		});
	}

	if (input.state === "equilibrium" && !input.extractionBound) {
		return hold(
			`Maintain at $${current.toLocaleString()}/day. Inventory is inside the healthy buffer, so there is no surplus to clear and no reason to buy traffic that would push stock back toward the cap.`,
			"equilibrium",
		);
	}

	// A change is already in flight: either the live setting has moved ahead of the
	// recorded tick, or a recorded probe has not produced enough days to judge.
	if (input.pendingSettingChange === true || response.pendingSettingChange) {
		return hold(
			`Maintain at $${current.toLocaleString()}/day. A budget change is in flight and has not been recorded long enough to measure, so the engine is holding rather than compounding spend on an unmeasured effect. ${rankModel.rationale}`,
			"probe_pending",
		);
	}

	const latest = response.latest;

	if (latest && latest.verdict === "probe_pending") {
		return hold(
			`Maintain at $${current.toLocaleString()}/day. ${latest.summary}`,
			"probe_pending",
		);
	}

	if (latest && latest.verdict === "unmeasured_effect") {
		return hold(
			`Maintain at $${current.toLocaleString()}/day, and do not increase it. ${latest.summary}`,
			"measured_no_effect",
		);
	}

	if (latest && latest.verdict === "negative") {
		const target = roundTo(
			Math.max(0, current - Math.abs(latest.delta)),
			policy.rounding,
		);
		return make({
			action: "decrease",
			amount: target,
			formatted: `Reduce to $${target.toLocaleString()}/day.`,
			rationale: `Reduce to $${target.toLocaleString()}/day. ${latest.summary} Reverting the increase returns the budget to its last measured level.`,
			changeNeeded: Math.abs(target - current) >= policy.tolerance,
			basis: "measured_negative",
		});
	}

	// Measured to pay for itself: one more step is justified, bounded by what a
	// rank step is worth and by the operational ceiling.
	const stepValue = Math.max(
		policy.rounding,
		rankModel.revenuePerRankStepPerDay,
	);
	// Floored, because the cap is a hard ceiling and rounding to nearest could
	// step over it.
	const ceilingTarget = roundDownTo(
		rankModel.operationalCapPerDay,
		policy.rounding,
	);
	const headroom = ceilingTarget - current;
	if (latest && latest.verdict === "positive" && headroom >= policy.rounding) {
		const target = Math.min(
			roundTo(current + Math.min(stepValue, headroom), policy.rounding),
			ceilingTarget,
		);
		return make({
			action: "increase",
			amount: target,
			formatted: `Increase to $${target.toLocaleString()}/day.`,
			rationale: `Increase to $${target.toLocaleString()}/day. ${latest.summary} One further rank step is worth about $${rankModel.revenuePerRankStepPerDay.toLocaleString()}/day at this revenue, so a step no larger than that is funded; the ceiling for any further increase is $${rankModel.operationalCapPerDay.toLocaleString()}/day.`,
			changeNeeded: Math.abs(target - current) >= policy.tolerance,
			basis: "measured_positive",
		});
	}

	// No measurement exists yet, and the rig has a surplus it cannot clear: run a
	// single bounded probe. The hold window stops a second probe being demanded
	// before the first one has had time to show up in the records.
	const daysSinceChange =
		latest !== undefined
			? Math.floor((asOfSeconds - latest.timestamp) / 86_400)
			: Number.POSITIVE_INFINITY;

	if (!latest || daysSinceChange >= policy.probeHoldDays) {
		const target = Math.min(
			roundTo(
				current + Math.min(stepValue, Math.max(policy.rounding, headroom)),
				policy.rounding,
			),
			ceilingTarget,
		);
		if (target > current) {
			return make({
				action: "increase",
				amount: target,
				formatted: `Increase to $${target.toLocaleString()}/day.`,
				rationale: `Increase to $${target.toLocaleString()}/day as a single measured probe. ${rankModel.rationale} The step is capped at what one rank is worth so the test cannot cost more than the rank it might buy; if it produces no measurable traffic change the engine will hold rather than increase again.${
					latest ? ` The previous probe was recorded on ${latest.isoDate}.` : ""
				}`,
				changeNeeded: Math.abs(target - current) >= policy.tolerance,
				basis: "probe",
			});
		}
	}

	return hold(
		latest
			? `Maintain at $${current.toLocaleString()}/day. The last recorded budget change was ${daysSinceChange} day${daysSinceChange === 1 ? "" : "s"} ago and ${policy.probeHoldDays} days must pass before another probe, so the current setting is left alone to be measured.`
			: `Maintain at $${current.toLocaleString()}/day. Advertising's response is unmeasured and the rank curve cannot be observed from outside, so no change is justified yet.`,
		"probe_pending",
	);
}
