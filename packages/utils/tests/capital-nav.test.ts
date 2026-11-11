import { describe, expect, test } from "bun:test";

import { formatMoney, formatUnits, parseMoney } from "../src/capital-money";
import {
	computeDeposit,
	computeInvestorMetrics,
	computeNav,
	computePayout,
	computeWithdrawal,
	computeXirr,
} from "../src/capital-nav";

describe("capital NAV", () => {
	test("marks cash and positions to market", () => {
		const nav = computeNav({
			cash: "150000000000",
			units: "1000000000",
			positions: [{ shares: 1_000_000, price: "100" }],
		});
		expect(formatMoney(nav.positionsValue)).toBe("100000000");
		expect(formatMoney(nav.totalValue)).toBe("150100000000");
		expect(formatMoney(nav.navPerUnit)).toBe("150.1");
	});

	test("issues units at NAV", () => {
		const deposit = computeDeposit(parseMoney("1000"), parseMoney("2"));
		expect(formatUnits(deposit.unitsIssued)).toBe("500");
		expect(formatMoney(deposit.highWaterNav)).toBe("2");
	});

	test("pays the NAV gain above the high-water mark", () => {
		const payout = computePayout({
			navPerUnit: parseMoney("1.1"),
			units: 1_000_000n,
			highWaterNav: parseMoney("1"),
			feeBps: 2500,
		});
		expect(formatMoney(payout.available)).toBe("0.1");
		expect(formatMoney(payout.fee)).toBe("0.025");
		expect(formatMoney(payout.net)).toBe("0.075");
		expect(formatMoney(payout.settledHighWaterNav)).toBe("1.1");
		expect(payout.shouldPay).toBe(true);
	});

	test("does not pay or advance the HWM below it", () => {
		const payout = computePayout({
			navPerUnit: parseMoney("0.9"),
			units: 1_000_000n,
			highWaterNav: parseMoney("1"),
			feeBps: 2500,
		});
		expect(payout.shouldPay).toBe(false);
		expect(formatMoney(payout.available)).toBe("0");
		expect(formatMoney(payout.settledHighWaterNav)).toBe("1");
	});

	test("quotes a profitable withdrawal with performance and exit fees", () => {
		const quote = computeWithdrawal({
			navPerUnit: parseMoney("1.2"),
			units: 1_000_000_000_000n,
			principal: parseMoney("1000000"),
			requestedAmount: null,
			performanceFeeEnabled: true,
			feeBps: 2500,
			exitFeeBps: 50,
		});
		expect(formatMoney(quote.grossValue)).toBe("1200000");
		expect(formatMoney(quote.principalBasis)).toBe("1000000");
		expect(formatMoney(quote.profit)).toBe("200000");
		expect(formatMoney(quote.loss)).toBe("0");
		expect(formatMoney(quote.performanceFee)).toBe("50000");
		expect(formatMoney(quote.exitFee)).toBe("6000");
		expect(formatMoney(quote.net)).toBe("1144000");
	});

	test("waives the performance fee on a loss", () => {
		const quote = computeWithdrawal({
			navPerUnit: parseMoney("0.9"),
			units: 1_000_000_000_000n,
			principal: parseMoney("1000000"),
			requestedAmount: null,
			performanceFeeEnabled: true,
			feeBps: 2500,
			exitFeeBps: 0,
		});
		expect(formatMoney(quote.grossValue)).toBe("900000");
		expect(formatMoney(quote.loss)).toBe("100000");
		expect(formatMoney(quote.performanceFee)).toBe("0");
		expect(formatMoney(quote.net)).toBe("900000");
	});

	test("computes APR and investor value", () => {
		const metrics = computeInvestorMetrics({
			principal: parseMoney("1000000"),
			units: 1_000_000_000_000n,
			navPerUnit: parseMoney("1.1"),
			cumulativePayouts: parseMoney("50000"),
			cumulativeFees: parseMoney("12500"),
			openedAt: new Date("2025-01-01T00:00:00Z"),
			now: new Date("2026-01-01T00:00:00Z"),
			cashFlows: [
				{ at: new Date("2025-01-01T00:00:00Z"), amount: -1_000_000 },
				{ at: new Date("2025-07-01T00:00:00Z"), amount: 50_000 },
				{ at: new Date("2026-01-01T00:00:00Z"), amount: 1_100_000 },
			],
		});
		expect(formatMoney(metrics.currentValue)).toBe("1100000");
		expect(formatMoney(metrics.totalProfit)).toBe("150000");
		expect(metrics.daysInvested).toBe(365);
		expect(metrics.aprPct).toBeCloseTo(15, 2);
		expect(metrics.xirrPct).not.toBeNull();
	});

	test("XIRR solves a simple one-year 10% return", () => {
		const xirr = computeXirr([
			{ at: new Date("2025-01-01T00:00:00Z"), amount: -1000 },
			{ at: new Date("2026-01-01T00:00:00Z"), amount: 1100 },
		]);
		expect(xirr).not.toBeNull();
		expect(xirr ?? 0).toBeCloseTo(10, 1);
	});
});
