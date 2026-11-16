import {
	formatMoney,
	type Money,
	moneyFromPriceShares,
	moneyToNumber,
	mulBps,
} from "./capital-money";

/**
 * Withdrawal liquidity planning.
 *
 * A redemption can be approved while the book is fully invested. The engine
 * must then raise cash by selling positions, and it should sell the names the
 * book is least likely to regret losing — not simply whatever is largest.
 *
 * The ranking is deliberately simple and uses only data the engine already
 * has. It is a *liquidity* decision, not an alpha signal: the strategy exits
 * (stop, trail, target, thesis) run first, and this pass only covers whatever
 * cash is still missing.
 */

export interface CapitalLiquidityCandidate {
	stockId: number;
	/** Shares still held. */
	shares: number;
	/** Current quote used for the sale. */
	price: number;
	/** Signal score (0–100); lower means weaker conviction. */
	score: number;
	/** Average cost per share, used to prefer smaller realised losses. */
	averageCost: number;
	targetPrice: number | null;
	daysHeld: number;
	/**
	 * Shares already committed to an open sell order. Those proceeds are
	 * counted towards the shortfall, but no second order is queued for the
	 * same stock.
	 */
	openOrderShares: number;
}

export interface CapitalLiquiditySale {
	stockId: number;
	shares: number;
	price: number;
	priority: number;
}

export interface CapitalLiquidityPlan {
	/** Gross withdrawal obligations still waiting to be paid. */
	requiredCash: Money;
	/** Signed book cash before any new sales. */
	availableCash: Money;
	/** Cash still needed before the obligation can be paid. */
	shortfall: Money;
	/** Net proceeds assumed from sell orders that are already open. */
	openOrderProceeds: Money;
	sales: CapitalLiquiditySale[];
	/** Shortfall left after the planned sales (0 when funded). */
	uncovered: Money;
}

/**
 * Higher means "sell this first".
 *
 * - A position already at its target is an exit the book wanted anyway, so it
 *   gets a large bonus.
 * - Weak conviction (`100 - score`) sells before strong conviction.
 * - Realised gains sell before realised losses, and among losers the smallest
 *   loss sells first. The ±50 cap keeps a single extreme position from
 *   dominating the ranking.
 */
export function liquiditySellPriority(
	candidate: Pick<
		CapitalLiquidityCandidate,
		"price" | "score" | "averageCost" | "targetPrice"
	>,
): number {
	const score = Number.isFinite(candidate.score)
		? Math.min(100, Math.max(0, candidate.score))
		: 0;
	const unrealizedPct =
		candidate.averageCost > 0
			? ((candidate.price - candidate.averageCost) / candidate.averageCost) *
				100
			: 0;
	const atTarget =
		candidate.targetPrice !== null &&
		candidate.targetPrice > 0 &&
		candidate.price >= candidate.targetPrice;

	return (
		(atTarget ? 200 : 0) +
		(100 - score) +
		Math.min(50, Math.max(-50, unrealizedPct))
	);
}

function netProceeds(price: number, shares: number, saleFeeBps: number): Money {
	const notional = moneyFromPriceShares(price.toFixed(6), shares);
	return notional - mulBps(notional, saleFeeBps);
}

/**
 * Works out which positions to sell to fund approved withdrawals.
 *
 * Existing open sell orders are assumed to fill and therefore reduce the
 * amount the new sales must raise. A partially filled order still blocks a
 * second order for that stock, so its remaining recommended shares are counted
 * once and the stock is not planned again.
 */
export function planWithdrawalLiquiditySales(input: {
	requiredCash: Money;
	availableCash: Money;
	saleFeeBps: number;
	candidates: CapitalLiquidityCandidate[];
}): CapitalLiquidityPlan {
	const shortfall =
		input.requiredCash > input.availableCash
			? input.requiredCash - input.availableCash
			: 0n;

	let openOrderProceeds = 0n;
	const sellable: CapitalLiquidityCandidate[] = [];
	for (const candidate of input.candidates) {
		if (candidate.shares <= 0) continue;
		if (candidate.openOrderShares > 0) {
			openOrderProceeds += netProceeds(
				candidate.price,
				Math.min(candidate.shares, candidate.openOrderShares),
				input.saleFeeBps,
			);
			continue;
		}
		sellable.push(candidate);
	}

	let remaining =
		shortfall > openOrderProceeds ? shortfall - openOrderProceeds : 0n;

	const sales: CapitalLiquiditySale[] = [];
	sellable.sort((a, b) => {
		const byPriority = liquiditySellPriority(b) - liquiditySellPriority(a);
		// Equal conviction: clear the older position first.
		return byPriority !== 0 ? byPriority : b.daysHeld - a.daysHeld;
	});

	for (const candidate of sellable) {
		if (remaining <= 0n) break;
		const perShare = netProceeds(candidate.price, 1, input.saleFeeBps);
		if (perShare <= 0n) continue;

		// Round up: selling one share too few leaves the withdrawal queued.
		let shares = Number((remaining + perShare - 1n) / perShare);
		if (shares > candidate.shares) shares = candidate.shares;
		if (shares <= 0) continue;

		const proceeds = netProceeds(candidate.price, shares, input.saleFeeBps);
		remaining = proceeds >= remaining ? 0n : remaining - proceeds;
		sales.push({
			stockId: candidate.stockId,
			shares,
			price: candidate.price,
			priority: liquiditySellPriority(candidate),
		});
	}

	return {
		requiredCash: input.requiredCash,
		availableCash: input.availableCash,
		shortfall,
		openOrderProceeds,
		sales,
		uncovered: remaining,
	};
}

/** Human-readable shortfall used in order rationale and alerts. */
export function describeLiquidityShortfall(plan: CapitalLiquidityPlan): string {
	return moneyToNumber(plan.shortfall) > 0 ? formatMoney(plan.shortfall) : "0";
}
