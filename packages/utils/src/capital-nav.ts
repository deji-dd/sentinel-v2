/**
 * Fund NAV, unit issuance/redemption, payout and withdrawal arithmetic.
 *
 * All functions are pure and operate on scaled integers from
 * `capital-money.ts`. They do not read the database: the caller supplies the
 * current positions/prices, and the function returns the exact amounts that
 * should be written in one transaction.
 *
 * The model is deliberately simple and auditable:
 *
 * - A lot owns `units`. Its value is `units × NAV`.
 * - A deposit issues units at the NAV immediately before the cash lands.
 * - A profit payout distributes the NAV gain above the lot's high-water mark
 *   and redeems the units that cash represents, so one lot's payout cannot
 *   transfer value to or from another.
 * - A withdrawal is treated as a realization for fee purposes: the positive
 *   profit portion pays the performance fee, losses pay none, and an optional
 *   exit fee is applied explicitly.
 */

import {
	absMoney,
	clampMoney,
	divideRound,
	formatMoney,
	formatUnits,
	maxMoney,
	type Money,
	MONEY_SCALE,
	moneyToNumber,
	mulBps,
	navFromValueUnits,
	parseMoney,
	parseUnits,
	UNIT_SCALE,
	type Units,
	unitsForAmount,
	unitsForRedemption,
	valueOfUnits,
} from "./capital-money";
import { daysBetween } from "./capital-time";

export interface CapitalPricePosition {
	shares: number;
	/** Live price per share, as a decimal string. */
	price: string;
}

export interface CapitalNavInput {
	cash: string | number;
	units: string | number;
	positions: CapitalPricePosition[];
}

export interface CapitalNav {
	cash: Money;
	positionsValue: Money;
	totalValue: Money;
	units: Units;
	/** Money per unit. Defaults to $1.00 for an empty book. */
	navPerUnit: Money;
}

/** Marks the book to market and derives NAV per unit. */
export function computeNav(input: CapitalNavInput): CapitalNav {
	const cash = parseMoney(input.cash);
	const units = parseUnits(input.units);

	let positionsValue = 0n;
	for (const position of input.positions) {
		if (!Number.isFinite(position.shares) || position.shares <= 0) continue;
		positionsValue +=
			parseMoney(position.price) * BigInt(Math.trunc(position.shares));
	}

	const totalValue = cash + positionsValue;
	const navPerUnit = navFromValueUnits(totalValue, units);

	return { cash, positionsValue, totalValue, units, navPerUnit };
}

export interface DepositComputation {
	navPerUnit: Money;
	unitsIssued: Units;
	principal: Money;
	highWaterNav: Money;
}

/** Units issued by a deposit, priced at the NAV before the cash is added. */
export function computeDeposit(
	amount: Money,
	navPerUnit: Money,
): DepositComputation {
	const safeNav = navPerUnit > 0n ? navPerUnit : MONEY_SCALE;
	const unitsIssued = unitsForAmount(amount, safeNav);
	return {
		navPerUnit: safeNav,
		unitsIssued,
		principal: amount,
		highWaterNav: safeNav,
	};
}

export interface PayoutComputationInput {
	navPerUnit: Money;
	units: Units;
	highWaterNav: Money;
	feeBps: number;
}

export interface PayoutComputation {
	/** NAV gain above the high-water mark, before fees. */
	available: Money;
	fee: Money;
	net: Money;
	/** Units the distribution redeems at the current NAV. */
	unitsRedeemed: Units;
	/** The high-water mark to store if the obligation is fully settled. */
	settledHighWaterNav: Money;
	profitPerUnit: Money;
	shouldPay: boolean;
}

/**
 * Computes one lot's full profit distribution.
 *
 * `available` is the entire NAV gain, not a cash-limited amount. If the book
 * cannot fund it, the caller records an `unfunded` obligation and must not
 * advance the high-water mark. A partial payment may redeem fewer units; the
 * caller keeps the old HWM until the obligation is fully settled.
 */
export function computePayout(
	input: PayoutComputationInput,
): PayoutComputation {
	const { navPerUnit, units, highWaterNav, feeBps } = input;
	const profitPerUnit = navPerUnit - highWaterNav;

	if (units <= 0n || profitPerUnit <= 0n) {
		return {
			available: 0n,
			fee: 0n,
			net: 0n,
			unitsRedeemed: 0n,
			settledHighWaterNav: maxMoney(highWaterNav, navPerUnit),
			profitPerUnit: maxMoney(profitPerUnit, 0n),
			shouldPay: false,
		};
	}

	const available = divideRound(profitPerUnit * units, UNIT_SCALE);
	const fee = mulBps(available, feeBps);
	const net = available - fee;
	const unitsRedeemed = unitsForRedemption(available, navPerUnit);

	return {
		available,
		fee,
		net,
		unitsRedeemed: unitsRedeemed > units ? units : unitsRedeemed,
		settledHighWaterNav: navPerUnit,
		profitPerUnit,
		shouldPay: available > 0n,
	};
}

export interface WithdrawalComputationInput {
	navPerUnit: Money;
	units: Units;
	principal: Money;
	/** Requested cash amount; omit/0 for a full exit. */
	requestedAmount?: string | number | null;
	performanceFeeEnabled: boolean;
	feeBps: number;
	exitFeeBps: number;
}

export interface WithdrawalComputation {
	unitsToRedeem: Units;
	grossValue: Money;
	principalBasis: Money;
	profit: Money;
	loss: Money;
	performanceFee: Money;
	exitFee: Money;
	net: Money;
}

/**
 * Quotes a withdrawal.
 *
 * `grossValue` is capped at the lot's full value: a request above it is a full
 * exit, not a negative remainder. The performance fee applies only to the
 * positive profit portion and is waived on a loss. The exit fee, if configured,
 * is charged on the gross value regardless of profit/loss and is always shown
 * separately.
 */
export function computeWithdrawal(
	input: WithdrawalComputationInput,
): WithdrawalComputation {
	const { navPerUnit, units, principal } = input;

	if (units <= 0n || navPerUnit <= 0n) {
		return {
			unitsToRedeem: 0n,
			grossValue: 0n,
			principalBasis: 0n,
			profit: 0n,
			loss: 0n,
			performanceFee: 0n,
			exitFee: 0n,
			net: 0n,
		};
	}

	const fullValue = valueOfUnits(navPerUnit, units);
	const requested = input.requestedAmount
		? parseMoney(input.requestedAmount)
		: fullValue;
	const grossValue = clampMoney(requested, fullValue);
	const unitsToRedeem =
		grossValue >= fullValue
			? units
			: unitsForRedemption(grossValue, navPerUnit);

	const principalBasis = divideRound(principal * unitsToRedeem, units);
	const profit = maxMoney(grossValue - principalBasis, 0n);
	const loss = maxMoney(principalBasis - grossValue, 0n);

	const performanceFee =
		input.performanceFeeEnabled && profit > 0n
			? mulBps(profit, input.feeBps)
			: 0n;
	const exitFee = mulBps(grossValue, input.exitFeeBps);
	const net = maxMoney(grossValue - performanceFee - exitFee, 0n);

	return {
		unitsToRedeem,
		grossValue,
		principalBasis,
		profit,
		loss,
		performanceFee,
		exitFee,
		net,
	};
}

export interface InvestorMetricsInput {
	principal: Money;
	units: Units;
	navPerUnit: Money;
	cumulativePayouts: Money;
	cumulativeFees: Money;
	openedAt: Date;
	now: Date;
	cashFlows?: Array<{ at: Date; amount: number }>;
}

export interface InvestorMetrics {
	currentValue: Money;
	totalProfit: Money;
	totalReturnPct: number | null;
	daysInvested: number | null;
	aprPct: number | null;
	xirrPct: number | null;
}

function totalReturnPct(totalProfit: Money, principal: Money): number | null {
	if (principal <= 0n) return null;
	return (moneyToNumber(totalProfit) / moneyToNumber(principal)) * 100;
}

/**
 * XIRR via bisection.
 *
 * Percentage rates in this range are display figures, so `number` is
 * acceptable here. Returns null when there is no sign change in the sensible
 * rate range, which is the honest answer for a cash-flow set with no solution.
 */
export function computeXirr(
	flows: Array<{ at: Date; amount: number }>,
): number | null {
	if (flows.length < 2) return null;
	const start = flows.reduce(
		(earliest, flow) =>
			flow.at.getTime() < earliest ? flow.at.getTime() : earliest,
		Number.POSITIVE_INFINITY,
	);
	if (!Number.isFinite(start)) return null;

	const hasPositive = flows.some((flow) => flow.amount > 0);
	const hasNegative = flows.some((flow) => flow.amount < 0);
	if (!hasPositive || !hasNegative) return null;

	const dayMs = 86_400_000;
	const npv = (rate: number): number => {
		let total = 0;
		for (const flow of flows) {
			const years = (flow.at.getTime() - start) / dayMs / 365;
			total += flow.amount / (1 + rate) ** years;
		}
		return total;
	};

	let low = -0.9999;
	let high = 10;
	let lowValue = npv(low);
	let highValue = npv(high);

	if (!Number.isFinite(lowValue) || !Number.isFinite(highValue)) return null;
	if (lowValue * highValue > 0) return null;

	for (let i = 0; i < 200; i++) {
		const mid = (low + high) / 2;
		const midValue = npv(mid);
		if (Math.abs(midValue) < 1e-7) return mid * 100;
		if (lowValue * midValue <= 0) {
			high = mid;
			highValue = midValue;
		} else {
			low = mid;
			lowValue = midValue;
		}
	}

	const result = ((low + high) / 2) * 100;
	return Number.isFinite(result) ? result : null;
}

/** Derives the investor-facing value/profit/APR/XIRR numbers for one lot. */
export function computeInvestorMetrics(
	input: InvestorMetricsInput,
): InvestorMetrics {
	const currentValue = valueOfUnits(input.navPerUnit, input.units);
	const totalProfit = currentValue - input.principal + input.cumulativePayouts;
	const totalPct = totalReturnPct(totalProfit, input.principal);
	const days = daysBetween(input.openedAt, input.now);
	const aprPct =
		totalPct !== null && days >= 1 ? totalPct * (365 / days) : null;

	let xirrPct: number | null = null;
	if (input.cashFlows && input.cashFlows.length >= 2) {
		xirrPct = computeXirr(input.cashFlows);
	}

	return {
		currentValue,
		totalProfit,
		totalReturnPct: totalPct,
		daysInvested: days > 0 ? days : null,
		aprPct,
		xirrPct,
	};
}

/** A compact, human-readable summary of a NAV mark for logs/embeds. */
export function describeNav(nav: CapitalNav): string {
	return `NAV ${formatMoney(nav.navPerUnit)}/unit · value ${formatMoney(nav.totalValue)} · cash ${formatMoney(nav.cash)} · units ${formatUnits(nav.units)}`;
}

/** Guards a caller that wants to compare a payout against free cash. */
export function capPayoutToCash(
	gross: Money,
	freeCash: Money,
): { payable: Money; shortfall: Money } {
	if (freeCash <= 0n) return { payable: 0n, shortfall: gross };
	const payable = gross <= freeCash ? gross : freeCash;
	return { payable, shortfall: absMoney(gross - payable) };
}
