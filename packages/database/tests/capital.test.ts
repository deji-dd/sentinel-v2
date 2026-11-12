import { afterAll, describe, expect, test } from "bun:test";

import {
	formatMoney,
	moneyFromPriceShares,
	mulBps,
	parseMoney,
} from "../../utils/src/capital-money";
import {
	applyCapitalFill,
	capitalFills,
	capitalInvestors,
	capitalMarketCandles,
	capitalNavSnapshots,
	capitalOrderOutcomes,
	capitalOrders,
	capitalPositions,
	capitalTransactions,
	clearCapitalPaperBook,
	db,
	eq,
	expireCapitalOrders,
	getCapitalRiskContext,
	getCapitalState,
	resetCapitalPaperBook,
	tryAcquireCapitalEngineLock,
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

describe("paper reset and frozen entry metadata", () => {
	const RESET_STOCK_ID = 9_000_012;

	test("a blank reset clears everything and seeds no operator", async () => {
		await resetCapitalPaperBook("1000", null);
		await clearCapitalPaperBook(null);
		const state = await getCapitalState("paper");
		expect(parseMoney(state.cash)).toBe(0n);
		expect(parseMoney(state.units)).toBe(0n);
		expect(state.positions).toHaveLength(0);
		const investors = await db
			.select()
			.from(capitalInvestors)
			.where(eq(capitalInvestors.book, "paper"));
		expect(investors).toHaveLength(0);
		const fills = await db
			.select()
			.from(capitalFills)
			.where(eq(capitalFills.book, "paper"));
		expect(fills).toHaveLength(0);
	});

	test("freezes the entry stop/target/peak and resets on re-entry", async () => {
		await clearCapitalPaperBook(null);
		const now = new Date();
		const buy = async (price: number, shares: number, stop: number) => {
			await withCapitalTransaction("paper", async (tx) => {
				await applyCapitalFill(tx, {
					book: "paper",
					stockId: RESET_STOCK_ID,
					side: "buy",
					shares,
					price: price.toFixed(6),
					notional: formatMoney(moneyFromPriceShares(price, shares)),
					fees: "0",
					cashDelta: formatMoney(-moneyFromPriceShares(price, shares)),
					totalCost: formatMoney(moneyFromPriceShares(price, shares)),
					source: "paper",
					entry: {
						price: price.toFixed(6),
						stopPrice: stop.toFixed(6),
						targetPrice: (price + (price - stop) * 2).toFixed(6),
					},
					occurredAt: now,
				});
			});
		};
		const read = async () => {
			const [position] = await db
				.select()
				.from(capitalPositions)
				.where(eq(capitalPositions.book, "paper"));
			return position;
		};

		await buy(100, 1000, 98);
		let position = await read();
		expect(Number(position?.entryPrice)).toBeCloseTo(100, 6);
		expect(Number(position?.stopPrice)).toBeCloseTo(98, 6);
		expect(Number(position?.targetPrice)).toBeCloseTo(104, 6);
		expect(Number(position?.peakPrice)).toBeCloseTo(100, 6);
		expect(position?.scaledOutAt).toBeNull();

		// A +1R trim marks the position but leaves the frozen risk in place.
		await withCapitalTransaction("paper", async (tx) => {
			const notional = moneyFromPriceShares(102, 300);
			await applyCapitalFill(tx, {
				book: "paper",
				stockId: RESET_STOCK_ID,
				side: "sell",
				shares: 300,
				price: "102",
				notional: formatMoney(notional),
				fees: "0",
				cashDelta: formatMoney(notional),
				totalCost: "0",
				source: "paper",
				exitReason: "scale_out",
				occurredAt: now,
			});
		});
		position = await read();
		expect(position?.shares).toBe(700);
		expect(Number(position?.stopPrice)).toBeCloseTo(98, 6);
		expect(position?.scaledOutAt).not.toBeNull();

		// A full exit clears the entry metadata.
		await withCapitalTransaction("paper", async (tx) => {
			const notional = moneyFromPriceShares(104, 700);
			await applyCapitalFill(tx, {
				book: "paper",
				stockId: RESET_STOCK_ID,
				side: "sell",
				shares: 700,
				price: "104",
				notional: formatMoney(notional),
				fees: "0",
				cashDelta: formatMoney(notional),
				totalCost: "0",
				source: "paper",
				exitReason: "target",
				occurredAt: now,
			});
		});
		position = await read();
		expect(position?.shares).toBe(0);
		expect(position?.stopPrice).toBeNull();
		expect(position?.targetPrice).toBeNull();
		expect(position?.peakPrice).toBeNull();
		expect(position?.scaledOutAt).toBeNull();

		// Re-entry starts a new trade instead of inheriting the old stop/openedAt.
		await buy(90, 500, 88);
		position = await read();
		expect(position?.shares).toBe(500);
		expect(Number(position?.stopPrice)).toBeCloseTo(88, 6);
		expect(Number(position?.peakPrice)).toBeCloseTo(90, 6);
		expect(position?.scaledOutAt).toBeNull();
	});
});

describe("risk context", () => {
	const COOLDOWN_STOCK_ID = 9_000_013;

	test("uses the previous day's close and finds recent stop-outs", async () => {
		await clearCapitalPaperBook(null);
		const now = new Date("2026-11-12T12:00:00Z");
		const previousClose = new Date("2026-11-11T23:00:00Z");
		const todayOpen = new Date("2026-11-12T00:00:00Z");
		const snapshot = (capturedAt: Date, navPerUnit: string) => ({
			book: "paper" as const,
			capturedAt,
			granularity: "hourly",
			cash: "100",
			positionsValue: "0",
			totalValue: "100",
			unitsOutstanding: "100",
			navPerUnit,
			investedCapital: "100",
			cumulativePayouts: "0",
			cumulativeFees: "0",
			investorCount: 0,
		});
		await db.insert(capitalNavSnapshots).values([
			snapshot(previousClose, "1"),
			// The 00:00 row is upserted all day, so it holds the current NAV,
			// not the opening mark. The context must ignore it for day-start.
			snapshot(todayOpen, "0.95"),
		]);
		await db.insert(capitalFills).values({
			book: "paper",
			stockId: COOLDOWN_STOCK_ID,
			side: "sell",
			shares: 10,
			price: "10",
			notional: "100",
			source: "paper",
			exitReason: "stop",
			occurredAt: new Date("2026-11-11T12:00:00Z"),
		});

		const context = await getCapitalRiskContext("paper", now, 3);
		expect(context.peakNavPerUnit).toBe("1.000000");
		expect(context.dayStartNavPerUnit).toBe("1.000000");
		expect(context.stoppedOutStockIds).toContain(COOLDOWN_STOCK_ID);

		const older = await getCapitalRiskContext("paper", now, 0);
		expect(older.stoppedOutStockIds).toHaveLength(0);
	});
});

describe("engine operations", () => {
	test("expires open orders past their validity window", async () => {
		await clearCapitalPaperBook(null);
		const [expired] = await db
			.insert(capitalOrders)
			.values({
				book: "paper",
				stockId: 9_000_014,
				side: "buy",
				status: "recommended",
				recommendedShares: 10,
				priceGuide: "10",
				expiresAt: new Date(Date.now() - 60_000),
			})
			.returning();
		const [fresh] = await db
			.insert(capitalOrders)
			.values({
				book: "paper",
				stockId: 9_000_015,
				side: "buy",
				status: "recommended",
				recommendedShares: 10,
				priceGuide: "10",
				expiresAt: new Date(Date.now() + 60_000),
			})
			.returning();
		const count = await expireCapitalOrders("paper");
		expect(count).toBe(1);
		const rows = await db
			.select()
			.from(capitalOrders)
			.where(eq(capitalOrders.book, "paper"));
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get(expired?.id ?? "")?.status).toBe("expired");
		expect(byId.get(fresh?.id ?? "")?.status).toBe("recommended");
	});

	test("the engine cycle lock is exclusive across sessions", async () => {
		const first = await tryAcquireCapitalEngineLock();
		expect(first).not.toBeNull();
		const second = await tryAcquireCapitalEngineLock();
		expect(second).toBeNull();
		await first?.release();
		const third = await tryAcquireCapitalEngineLock();
		expect(third).not.toBeNull();
		await third?.release();
	});
});

describe("order outcomes", () => {
	const OUTCOME_STOCK_ID = 9_000_016;

	test("writes 1d/5d outcomes once enough daily candles exist", async () => {
		const { evaluateCapitalOrderOutcomes } =
			await import("../../../services/scheduler/src/workers/capital/outcomes");
		await clearCapitalPaperBook(null);
		const entryAt = new Date(Date.now() - 5 * 86_400_000);
		const [order] = await db
			.insert(capitalOrders)
			.values({
				book: "paper",
				stockId: OUTCOME_STOCK_ID,
				side: "buy",
				status: "filled",
				recommendedShares: 10,
				filledShares: 10,
				priceGuide: "100",
				averageFillPrice: "100",
				generatedAt: entryAt,
				acceptedAt: entryAt,
				expiresAt: new Date(entryAt.getTime() + 3_600_000),
			})
			.returning();
		expect(order).toBeDefined();

		const closes = [101, 102, 103, 104, 105];
		await db.insert(capitalMarketCandles).values(
			closes.map((close, index) => ({
				stockId: OUTCOME_STOCK_ID,
				intervalMinutes: 1_440,
				bucketStart: new Date(entryAt.getTime() + index * 86_400_000),
				open: String(close),
				high: String(close + 1),
				low: String(close - 1),
				close: String(close),
				samples: 1,
			})),
		);

		await evaluateCapitalOrderOutcomes("paper");
		const rows = await db
			.select()
			.from(capitalOrderOutcomes)
			.where(eq(capitalOrderOutcomes.orderId, order?.id ?? ""));
		const byHorizon = new Map(rows.map((row) => [row.horizon, row]));
		expect(byHorizon.get("1d")?.returnPct).toBeCloseTo(1, 5);
		expect(byHorizon.get("5d")?.returnPct).toBeCloseTo(5, 5);
		expect(byHorizon.get("20d")).toBeUndefined();
		// Keep the table clean for the next suite.
		await db
			.delete(capitalMarketCandles)
			.where(eq(capitalMarketCandles.stockId, OUTCOME_STOCK_ID));
		if (order) {
			await db.delete(capitalOrders).where(eq(capitalOrders.id, order.id));
		}
	});
});
