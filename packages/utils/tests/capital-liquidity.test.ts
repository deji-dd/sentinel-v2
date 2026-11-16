import { describe, expect, test } from "bun:test";

import {
	type CapitalLiquidityCandidate,
	liquiditySellPriority,
	planWithdrawalLiquiditySales,
} from "../src/capital-liquidity";
import { parseMoney } from "../src/capital-money";

function candidate(
	patch: Partial<CapitalLiquidityCandidate> & { stockId: number },
): CapitalLiquidityCandidate {
	return {
		shares: 1_000,
		price: 10,
		score: 50,
		averageCost: 10,
		targetPrice: 20,
		daysHeld: 5,
		openOrderShares: 0,
		...patch,
	};
}

describe("withdrawal liquidity", () => {
	test("weak conviction sells before strong conviction", () => {
		const strong = candidate({ stockId: 1, score: 90 });
		const weak = candidate({ stockId: 2, score: 20 });
		expect(liquiditySellPriority(weak)).toBeGreaterThan(
			liquiditySellPriority(strong),
		);
	});

	test("a position at its target is the first to be sold", () => {
		const atTarget = candidate({
			stockId: 1,
			price: 12,
			averageCost: 10,
			targetPrice: 11.5,
			score: 99,
		});
		const weak = candidate({ stockId: 2, score: 1, averageCost: 10 });
		expect(liquiditySellPriority(atTarget)).toBeGreaterThan(
			liquiditySellPriority(weak),
		);
	});

	test("among equal conviction, gains sell before losses", () => {
		const winner = candidate({ stockId: 1, price: 12, averageCost: 10 });
		const loser = candidate({ stockId: 2, price: 8, averageCost: 10 });
		expect(liquiditySellPriority(winner)).toBeGreaterThan(
			liquiditySellPriority(loser),
		);
	});

	test("sells the weakest position first and only as many shares as needed", () => {
		const plan = planWithdrawalLiquiditySales({
			requiredCash: parseMoney("5000"),
			availableCash: parseMoney("1000"),
			saleFeeBps: 0,
			candidates: [
				candidate({ stockId: 1, score: 80 }),
				candidate({ stockId: 2, score: 10, shares: 1_000 }),
			],
		});

		expect(plan.shortfall).toBe(parseMoney("4000"));
		expect(plan.sales).toHaveLength(1);
		expect(plan.sales[0]?.stockId).toBe(2);
		expect(plan.sales[0]?.shares).toBe(400);
		expect(plan.uncovered).toBe(0n);
	});

	test("counts open sell orders towards coverage and does not double-sell", () => {
		const plan = planWithdrawalLiquiditySales({
			requiredCash: parseMoney("4000"),
			availableCash: parseMoney("1000"),
			saleFeeBps: 0,
			candidates: [
				candidate({ stockId: 1, score: 80, openOrderShares: 300 }),
				candidate({ stockId: 2, score: 10 }),
			],
		});

		// 300 open shares × $10 = $3,000 covers most of the $3,000 shortfall.
		expect(plan.openOrderProceeds).toBe(parseMoney("3000"));
		expect(plan.sales).toHaveLength(0);
		expect(plan.uncovered).toBe(0n);
	});

	test("still plans a sale when open orders do not cover the shortfall", () => {
		const plan = planWithdrawalLiquiditySales({
			requiredCash: parseMoney("6000"),
			availableCash: parseMoney("1000"),
			saleFeeBps: 0,
			candidates: [
				candidate({ stockId: 1, score: 80, openOrderShares: 200 }),
				candidate({ stockId: 2, score: 10 }),
			],
		});

		expect(plan.openOrderProceeds).toBe(parseMoney("2000"));
		expect(plan.sales[0]?.stockId).toBe(2);
		expect(plan.sales[0]?.shares).toBe(300);
		expect(plan.uncovered).toBe(0n);
	});

	test("reports the part of the shortfall no position can cover", () => {
		const plan = planWithdrawalLiquiditySales({
			requiredCash: parseMoney("50000"),
			availableCash: parseMoney("1000"),
			saleFeeBps: 0,
			candidates: [candidate({ stockId: 1, shares: 1_000 })],
		});

		// $10,000 of stock against a $49,000 shortfall.
		expect(plan.sales[0]?.shares).toBe(1_000);
		expect(plan.uncovered).toBe(parseMoney("39000"));
	});

	test("does nothing when cash already covers the obligation", () => {
		const plan = planWithdrawalLiquiditySales({
			requiredCash: parseMoney("4000"),
			availableCash: parseMoney("5000"),
			saleFeeBps: 0,
			candidates: [candidate({ stockId: 1 })],
		});

		expect(plan.shortfall).toBe(0n);
		expect(plan.sales).toHaveLength(0);
	});
});
