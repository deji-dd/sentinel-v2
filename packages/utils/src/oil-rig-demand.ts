import type { OilRigHistoryRecord } from "./oil-rig";
import { OIL_RIG_POLICY, type OilRigPricePolicy } from "./oil-rig-policy";

/**
 * How barrel sales respond to the barrel price, fitted from this rig's own
 * recorded history.
 *
 * WHY THIS EXISTS. Price is not observable from any public source - we cannot
 * look up what a competitor charges or what the market will bear - so the only
 * honest way to price is to measure our own response and fit it. The previous
 * engine instead hardcoded a "$180-$185 target band" and a "$185 deficit target"
 * as director policy, which meant the price advice could not improve with
 * evidence and could contradict the sell-through analysis printed beside it.
 *
 * The model is a linear demand curve `sold = intercept + slope * price`, which is
 * the simplest form that identifies a revenue-maximising price. Its known limits
 * are stated in `reason` and `caveats` rather than hidden: it assumes the days
 * used were demand-limited (not supply-limited by an empty warehouse), it cannot
 * separate a price effect from a simultaneous popularity or advertising change,
 * and it needs real price variation to fit at all.
 */
export interface BarrelDemandFit {
	/** Records that passed the demand-observation filters. */
	samples: number;
	/** True only when a usable downward-sloping curve was fitted. */
	usable: boolean;
	/** `sold = intercept + slope * price`. */
	intercept: number;
	slope: number;
	/** Coefficient of determination of the fit. */
	r2: number;
	/** Price maximising `price * sold`, before clamping to the policy band. */
	unclampedRevenueMaxPrice: number;
	/** Same, clamped into the policy band: the actionable target. */
	revenueMaxPrice: number;
	/** Point price sensitivity at a given price (positive = normal demand). */
	sensitivityAt: (price: number) => number;
	/** Predicted daily barrels sold at a price. */
	predictedSoldAt: (price: number) => number;
	/** Plain-language statement of what the fit does and does not support. */
	reason: string;
	/** Everything a reader needs to distrust the fit appropriately. */
	caveats: string[];
}

export interface DemandFitOptions {
	policy?: OilRigPricePolicy;
	/** Minimum usable observations; defaults to the price policy. */
	minSamples?: number;
}

const EMPTY_FIT_REASON =
	"Not enough recorded price variation to measure how barrels sell at different prices yet.";

function unusable(params: {
	samples: number;
	reason: string;
	caveats: string[];
	policy: OilRigPricePolicy;
}): BarrelDemandFit {
	return {
		samples: params.samples,
		usable: false,
		intercept: 0,
		slope: 0,
		r2: 0,
		unclampedRevenueMaxPrice: 0,
		revenueMaxPrice: 0,
		sensitivityAt: () => 0,
		predictedSoldAt: () => 0,
		reason: params.reason,
		caveats: params.caveats,
	};
}

/**
 * Fits the barrel demand curve from recorded daily snapshots.
 *
 * Observations are filtered to days that could actually express demand:
 *  - a barrel price and a non-zero sold amount are required;
 *  - days where the warehouse was nearly empty are excluded, because on those
 *    days sales were capped by what extraction had delivered rather than by what
 *    customers wanted to buy. Including them would flatten the curve and make
 *    price look irrelevant - the exact opposite of the truth.
 */
export function fitBarrelDemand(
	history: OilRigHistoryRecord[],
	options?: DemandFitOptions,
): BarrelDemandFit {
	const policy = options?.policy ?? OIL_RIG_POLICY.price;
	const minSamples = options?.minSamples ?? policy.minSamplesForFit;

	const caveats = [
		"Fitted from this rig's own recorded days only; no external price data exists to validate it.",
		"A price move that coincided with a popularity, efficiency or advertising change is attributed to price.",
		"Linear demand is an approximation; the true response may flatten at the extremes of the band.",
	];

	const usable = history.filter((h) => {
		const price = h.stock?.barrelPrice ?? 0;
		const sold = h.stock?.soldAmount ?? 0;
		const fill = h.stock?.fillPct ?? 0;
		return (
			price > 0 && sold > 0 && fill >= policy.minFillPctForDemandObservation
		);
	});

	if (usable.length < minSamples) {
		return unusable({
			samples: usable.length,
			reason: `${EMPTY_FIT_REASON} ${usable.length} usable demand observation${usable.length === 1 ? "" : "s"} recorded, ${minSamples} required.`,
			caveats,
			policy,
		});
	}

	const xs = usable.map((h) => h.stock.barrelPrice);
	const ys = usable.map((h) => h.stock.soldAmount);
	const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
	const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;

	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		const dx = (xs[i] ?? 0) - meanX;
		const dy = (ys[i] ?? 0) - meanY;
		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}

	// With no spread in price there is nothing to identify a slope from.
	if (sxx <= 0 || syy <= 0) {
		return unusable({
			samples: usable.length,
			reason: `${EMPTY_FIT_REASON} The recorded days all used the same barrel price, so no price response can be separated from day-to-day variation.`,
			caveats,
			policy,
		});
	}

	const slope = sxy / sxx;
	const intercept = meanY - slope * meanX;

	// A non-negative slope cannot describe normal demand, so no optimum exists to
	// recommend. Reporting "unusable" is the honest outcome; inventing a target
	// from a noise fit is how the old engine produced advice it could not defend.
	if (slope >= 0) {
		return unusable({
			samples: usable.length,
			reason: `Recorded sales did not fall as the price rose (fitted slope ${slope.toFixed(2)} barrels per dollar), so no revenue-maximising price can be identified from ${usable.length} observation${usable.length === 1 ? "" : "s"}.`,
			caveats,
			policy,
		});
	}

	let ssRes = 0;
	for (let i = 0; i < xs.length; i++) {
		const predicted = intercept + slope * (xs[i] ?? 0);
		const residual = (ys[i] ?? 0) - predicted;
		ssRes += residual * residual;
	}
	const r2 = Math.max(0, Math.min(1, 1 - ssRes / syy));

	const unclamped = -intercept / (2 * slope);
	const clamped = Math.max(policy.floor, Math.min(policy.ceiling, unclamped));

	const confident = usable.length >= minSamples && r2 >= policy.minR2ForFit;
	const inBand = unclamped >= policy.floor && unclamped <= policy.ceiling;

	return {
		samples: usable.length,
		usable: true,
		intercept,
		slope,
		r2: Number(r2.toFixed(3)),
		unclampedRevenueMaxPrice: Math.round(unclamped),
		revenueMaxPrice: Math.round(clamped),
		sensitivityAt: (price: number) => {
			const q = intercept + slope * price;
			if (q <= 0) return 0;
			return Number(((-slope * price) / q).toFixed(3));
		},
		predictedSoldAt: (price: number) =>
			Math.max(0, Math.round(intercept + slope * price)),
		reason: `Fitted from ${usable.length} recorded day${usable.length === 1 ? "" : "s"} (R² ${r2.toFixed(2)}): demand falls about ${Math.abs(Math.round(slope)).toLocaleString()} bbl/day per $1 of barrel price, putting the revenue-maximising price at about $${Math.round(unclamped)}${inBand ? "" : ` (outside the $${policy.floor}–$${policy.ceiling} band, so the band edge at $${Math.round(clamped)} is used)`}.${
			confident
				? ""
				: " The fit is weak or thin, so this price is reported as a direction to test rather than a setting to adopt."
		}`,
		caveats,
	};
}
