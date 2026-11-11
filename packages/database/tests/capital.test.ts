import { afterAll, describe, expect, test } from "bun:test";

import {
	formatMoney,
	moneyFromPriceShares,
	mulBps,
	parseMoney,
} from "../../utils/src/capital-money";
import {
	applyCapitalFill,
	capitalPositions,
	capitalTransactions,
	db,
	eq,
	getCapitalState,
	resetCapitalPaperBook,
	withCapitalTransaction,
} from "../index";

const TEST_STOCK_ID = 9_000_011;

afterAll(async () => {
	await resetCapitalPaperBook("150000000000", null);
});

describe("capital ledger", () => {
	test("seeds the paper book with virtual cash and units", async () => {
		await resetCapitalPaperBook("150000000000", null);
		const state = await getCapitalState("paper");
		expect(parseMoney(state.cash)).toBe(parseMoney("150000000000"));
		expect(parseMoney(state.units)).toBe(parseMoney("150000000000"));
		expect(state.positions).toHaveLength(0);
	});

	test("marks an off-recommendation buy as an error trade", async () => {
		await resetCapitalPaperBook("150000000000", null);
		const shares = 1000;
		const price = 50;
		const notional = moneyFromPriceShares(price, shares);
		await withCapitalTransaction("paper", async (tx) => {
			await applyCapitalFill(tx, {
				book: "paper",
				stockId: TEST_STOCK_ID,
				side: "buy",
				shares,
				price: price.toString(),
				notional: formatMoney(notional),
				fees: "0",
				cashDelta: formatMoney(-notional),
				totalCost: formatMoney(notional),
				source: "decision",
				unplanned: true,
				occurredAt: new Date(),
			});
		});
		const [position] = await db
			.select()
			.from(capitalPositions)
			.where(eq(capitalPositions.book, "paper"));
		expect(position?.isUnplanned).toBe(true);
	});

	test("applies a buy and a partial sell with average cost", async () => {
		await resetCapitalPaperBook("150000000000", null);

		const shares = 1_000_000;
		const price = 100;
		const notional = moneyFromPriceShares(price, shares);
		await withCapitalTransaction("paper", async (tx) => {
			await applyCapitalFill(tx, {
				book: "paper",
				stockId: TEST_STOCK_ID,
				side: "buy",
				shares,
				price: price.toString(),
				notional: formatMoney(notional),
				fees: "0",
				cashDelta: formatMoney(-notional),
				totalCost: formatMoney(notional),
				source: "paper",
				occurredAt: new Date(),
			});
		});

		const sellShares = 500_000;
		const sellPrice = 110;
		const sellNotional = moneyFromPriceShares(sellPrice, sellShares);
		const sellFees = mulBps(sellNotional, 10);
		await withCapitalTransaction("paper", async (tx) => {
			await applyCapitalFill(tx, {
				book: "paper",
				stockId: TEST_STOCK_ID,
				side: "sell",
				shares: sellShares,
				price: sellPrice.toString(),
				notional: formatMoney(sellNotional),
				fees: formatMoney(sellFees),
				cashDelta: formatMoney(sellNotional - sellFees),
				totalCost: formatMoney(sellNotional),
				source: "paper",
				occurredAt: new Date(),
			});
		});

		const [position] = await db
			.select()
			.from(capitalPositions)
			.where(eq(capitalPositions.book, "paper"));
		expect(position?.shares).toBe(500_000);
		expect(parseMoney(position?.costBasis ?? "0")).toBe(parseMoney("50000000"));
		expect(parseMoney(position?.realized ?? "0")).toBe(parseMoney("4945000"));

		const transactions = await db
			.select()
			.from(capitalTransactions)
			.where(eq(capitalTransactions.book, "paper"));
		expect(transactions.some((row) => row.type === "buy")).toBe(true);
		expect(transactions.some((row) => row.type === "sell")).toBe(true);
	});
});
