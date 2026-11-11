import { describe, expect, test } from "bun:test";

import {
	type CapitalMatchableOrder,
	type CapitalPaymentMatch,
	computeFillVariance,
	extractReferenceCode,
	matchPaymentIntent,
	readCapitalMoneyLog,
	readCapitalStockFill,
	readCapitalTradeCompleted,
	selectOrderForFill,
} from "../src/capital-matching";

const NOW = new Date("2026-01-01T12:00:00Z");

describe("capital stock log matching", () => {
	test("reads a buy log into a fill event", () => {
		const event = readCapitalStockFill({
			id: "5510-1",
			log: 5510,
			timestamp: 1_700_000_000,
			data: {
				data: { stock: 7, amount: 1_000, worth: 100_000, price: 100 },
			},
		});
		expect(event).not.toBeNull();
		expect(event?.side).toBe("buy");
		expect(event?.stockId).toBe(7);
		expect(event?.shares).toBe(1_000);
		expect(event?.price).toBe(100);
	});

	test("matches only the same stock and side", () => {
		const event = readCapitalStockFill({
			id: "5510-1",
			log: 5510,
			timestamp: 1_700_000_100,
			data: {
				data: { stock: 7, amount: 1_000, worth: 100_000, price: 100 },
			},
		});
		if (!event) throw new Error("fixture failed");

		const orders: CapitalMatchableOrder[] = [
			{
				id: "same",
				stockId: 7,
				side: "buy",
				status: "recommended",
				recommendedShares: 10_000,
				filledShares: 0,
				priceGuide: "99",
				generatedAt: new Date(1_700_000_000 * 1000),
				expiresAt: new Date(1_700_003_600 * 1000),
			},
			{
				id: "different-stock",
				stockId: 8,
				side: "buy",
				status: "recommended",
				recommendedShares: 10_000,
				filledShares: 0,
				priceGuide: "99",
				generatedAt: new Date(1_700_000_000 * 1000),
				expiresAt: new Date(1_700_003_600 * 1000),
			},
			{
				id: "wrong-side",
				stockId: 7,
				side: "sell",
				status: "recommended",
				recommendedShares: 10_000,
				filledShares: 0,
				priceGuide: "99",
				generatedAt: new Date(1_700_000_000 * 1000),
				expiresAt: new Date(1_700_003_600 * 1000),
			},
		];

		expect(selectOrderForFill(event, orders)?.id).toBe("same");
		expect(
			selectOrderForFill(
				event,
				orders.filter((o) => o.id !== "same"),
			),
		).toBeNull();
	});

	test("computes execution variance", () => {
		const variance = computeFillVariance({
			order: {
				recommendedShares: 10_000,
				filledShares: 0,
				priceGuide: "100",
				generatedAt: new Date(1_700_000_000 * 1000),
			},
			fill: { shares: 12_000, price: 101, timestamp: 1_700_000_120 },
		});
		expect(variance.sharesDelta).toBe(2_000);
		expect(variance.priceDelta).toBe("1.000000");
		expect(variance.slippageBps).toBeCloseTo(100, 5);
		expect(variance.delaySeconds).toBe(120);
	});
});

describe("capital money log matching", () => {
	test("reads a receive log with a reference code", () => {
		const event = readCapitalMoneyLog({
			id: "4810-1",
			log: 4810,
			timestamp: 1_700_000_000,
			data: {
				data: {
					money: 350_000,
					sender: 439_132,
					message: "Deposit DEP-ABCD1234 thanks",
				},
			},
		});
		expect(event).not.toBeNull();
		expect(event?.direction).toBe("receive");
		expect(event?.amountRaw).toBe("350000");
		expect(event?.counterpartyTornId).toBe(439_132);
		expect(extractReferenceCode(event?.message ?? null)).toBe("DEP-ABCD1234");
	});

	test("reads a trade money-add log with its trade id", () => {
		const event = readCapitalMoneyLog({
			id: "4440-1",
			log: 4440,
			timestamp: 1_700_000_000,
			data: {
				data: {
					user: 2683610,
					parsed_trade_id: 13000876,
					money: 67_422_393,
				},
			},
		});
		expect(event?.direction).toBe("send");
		expect(event?.counterpartyTornId).toBe(2683610);
		expect(event?.tradeId).toBe("13000876");
		expect(event?.amountRaw).toBe("67422393");
	});

	test("reads a completed trade and its counterparty", () => {
		const completed = readCapitalTradeCompleted({
			id: "4430-1",
			log: 4430,
			timestamp: 1_700_000_000,
			data: {
				data: {
					user: 2683610,
					parsed_trade_id: 13000876,
				},
			},
		});
		expect(completed?.tradeId).toBe("13000876");
		expect(completed?.counterpartyTornId).toBe(2683610);
	});

	test("matches a payment intent by code before amount", () => {
		const event = readCapitalMoneyLog({
			id: "4810-2",
			log: 4810,
			timestamp: 1_700_000_000,
			data: {
				data: {
					money: 100,
					sender: 111,
					message: "PAY-AAAA1111",
				},
			},
		});
		if (!event) throw new Error("fixture failed");

		const match: CapitalPaymentMatch | null = matchPaymentIntent(
			event,
			[
				{
					id: "other",
					kind: "deposit",
					status: "pending",
					counterpartyTornId: 111,
					expectedAmount: "100",
					tolerancePct: 1,
					referenceCode: "DEP-OTHER123",
					expiresAt: NOW,
				},
				{
					id: "code",
					kind: "deposit",
					status: "pending",
					counterpartyTornId: 111,
					expectedAmount: "999",
					tolerancePct: 1,
					referenceCode: "PAY-AAAA1111",
					expiresAt: NOW,
				},
			],
			NOW,
		);
		expect(match?.intent.id).toBe("code");
		expect(match?.matchType).toBe("reference");
	});

	test("falls back to counterparty and amount within tolerance", () => {
		const event = readCapitalMoneyLog({
			id: "4810-3",
			log: 4810,
			timestamp: 1_700_000_000,
			data: {
				data: { money: 100_500, sender: 222, message: "" },
			},
		});
		if (!event) throw new Error("fixture failed");

		const match = matchPaymentIntent(
			event,
			[
				{
					id: "amount",
					kind: "deposit",
					status: "pending",
					counterpartyTornId: 222,
					expectedAmount: "100000",
					tolerancePct: 1,
					referenceCode: "DEP-NOCODE12",
					expiresAt: NOW,
				},
			],
			NOW,
		);
		expect(match?.intent.id).toBe("amount");
		expect(match?.matchType).toBe("counterparty");
	});

	test("ignores an expired or out-of-tolerance intent", () => {
		const event = readCapitalMoneyLog({
			id: "4810-4",
			log: 4810,
			timestamp: 1_700_000_000,
			data: {
				data: { money: 200_000, sender: 333, message: "" },
			},
		});
		if (!event) throw new Error("fixture failed");

		expect(
			matchPaymentIntent(
				event,
				[
					{
						id: "expired",
						kind: "deposit",
						status: "pending",
						counterpartyTornId: 333,
						expectedAmount: "200000",
						tolerancePct: 1,
						referenceCode: "DEP-EXPIRED1",
						expiresAt: new Date("2025-01-01T00:00:00Z"),
					},
				],
				NOW,
			),
		).toBeNull();
	});
});
