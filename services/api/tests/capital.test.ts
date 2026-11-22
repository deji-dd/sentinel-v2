import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	and,
	capitalDepositStateId,
	capitalFills,
	capitalInvestments,
	capitalOrders,
	capitalPayoutObligations,
	capitalTransactions,
	db,
	eq,
	inArray,
	resetCapitalPaperBook,
	updateCapitalConfig,
	users,
	userSessions,
	workerState,
} from "@sentinel/database";

import { app } from "../src/app";

function cookieFor(sessionId: string): Record<string, string> {
	return { cookie: `session=${sessionId}` };
}

let userId: number | null = null;
let sessionId: string | null = null;

beforeAll(async () => {
	await resetCapitalPaperBook("150000000000", null);
	const suffix = crypto.randomUUID().slice(0, 8);
	const [user] = await db
		.insert(users)
		.values({
			discordId: `capital-test-${suffix}`,
			username: `capital-test-${suffix}`,
			role: "owner",
		})
		.returning();
	if (!user) throw new Error("Failed to create test user.");
	userId = user.id;
	const [session] = await db
		.insert(userSessions)
		.values({
			userId: user.id,
			expiresAt: new Date(Date.now() + 86_400_000),
		})
		.returning();
	if (!session) throw new Error("Failed to create test session.");
	sessionId = session.id;
});

afterAll(async () => {
	if (userId !== null) {
		await db.delete(users).where(eq(users.id, userId));
	}
	await updateCapitalConfig(
		"paper",
		{ publicShowHoldings: true, minEntryScore: 65 },
		null,
	);
	await resetCapitalPaperBook("150000000000", null);
	await db
		.delete(workerState)
		.where(eq(workerState.workerId, capitalDepositStateId("paper")));
});

describe("capital API", () => {
	test("public overview is readable without a session", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/capital/public"),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			summary: { book: string };
			trades: unknown[];
		};
		expect(body.success).toBe(true);
		expect(body.summary.book).toBe("live");
	});

	test("paper public overview is readable without a session", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/capital/public?book=paper"),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			summary: { book: string };
			warnings: string[];
			trades: unknown[];
			holdings: unknown[];
			positions: unknown[];
			investors: unknown[];
		};
		expect(body.success).toBe(true);
		expect(body.summary.book).toBe("paper");
		expect(body.warnings.some((warning) => warning.includes("Simulated"))).toBe(
			true,
		);
		expect(Array.isArray(body.trades)).toBe(true);
		expect(Array.isArray(body.holdings)).toBe(true);
		expect(Array.isArray(body.positions)).toBe(true);
		expect(Array.isArray(body.investors)).toBe(true);
		for (const investor of body.investors) {
			expect((investor as Record<string, unknown>).displayName).toBeUndefined();
		}
	});

	test("capital rejects another dashboard origin", async () => {
		const blocked = await app.handle(
			new Request("http://localhost/v2/capital/public", {
				headers: { origin: "https://dashboard.blasted-labs.tech" },
			}),
		);
		expect(blocked.status).toBe(403);

		const allowed = await app.handle(
			new Request("http://localhost/v2/capital/public", {
				headers: { origin: "https://stocks.blasted-labs.tech" },
			}),
		);
		expect(allowed.status).toBe(200);
	});

	test("admin overview requires an owner session", async () => {
		const denied = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/overview"),
		);
		expect(denied.status).toBe(403);

		if (!sessionId) throw new Error("No session fixture.");
		const allowed = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/overview", {
				headers: cookieFor(sessionId),
			}),
		);
		expect(allowed.status).toBe(200);
		const body = (await allowed.json()) as {
			success: boolean;
			summary: { book: string };
			positions: unknown[];
		};
		expect(body.success).toBe(true);
		expect(body.summary.book).toBe("paper");
		expect(Array.isArray(body.positions)).toBe(true);
	});

	test("settings update accepts a partial typed patch", async () => {
		if (!sessionId) throw new Error("No session fixture.");
		const response = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/settings", {
				method: "PUT",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					publicShowHoldings: true,
					minEntryScore: 70,
					// Sizing is hardcoded policy now; the API must ignore this.
					maxPositions: 8,
				}),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			settings: {
				publicShowHoldings: boolean;
				maxPositions: number;
				minEntryScore: number;
			};
		};
		expect(body.settings.publicShowHoldings).toBe(true);
		expect(body.settings.minEntryScore).toBe(70);
		expect(body.settings.maxPositions).toBe(12);
	});

	test("payment intents carry the deposit cadence", async () => {
		if (!sessionId) throw new Error("No session fixture.");
		const investors = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/overview", {
				headers: cookieFor(sessionId),
			}),
		);
		const overview = (await investors.json()) as {
			investors: Array<{ investor: { id: string } }>;
		};
		const investorId = overview.investors[0]?.investor.id;
		expect(investorId).toBeTruthy();
		if (!investorId) return;

		const response = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/payment-intents", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					kind: "deposit",
					investorId,
					frequency: "weekly",
					payoutMode: "reinvest",
					expectedAmount: "5000000",
				}),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			intent: {
				frequency: string;
				expectedAmount: string;
				referenceCode: string;
			};
		};
		expect(body.intent.frequency).toBe("weekly");
		expect(body.intent.expectedAmount).toBe("5000000.000000");
		expect(body.intent.referenceCode.startsWith("DEP-")).toBe(true);
	});

	test("live investors require a Torn ID and cannot be test investors", async () => {
		if (!sessionId) throw new Error("No session fixture.");

		const testKind = await app.handle(
			new Request("http://localhost/v2/capital/admin/live/investors", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					kind: "test",
					displayName: "Not A Live Test Investor",
					tornId: 1934909,
				}),
			}),
		);
		expect(testKind.status).toBe(400);

		const missingTornId = await app.handle(
			new Request("http://localhost/v2/capital/admin/live/investors", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					kind: "user",
					displayName: "Missing Torn ID",
				}),
			}),
		);
		expect(missingTornId.status).toBe(400);
	});

	test("a deposit creates a lot and appears in the desk", async () => {
		if (!sessionId) throw new Error("No session fixture.");

		const created = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/investors", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					displayName: "API Test Investor",
					frequency: "weekly",
					payoutMode: "cash",
				}),
			}),
		);
		expect(created.status).toBe(200);
		const createdBody = (await created.json()) as {
			investor: { id: string; kind: string; tornId: number | null };
		};
		expect(createdBody.investor.kind).toBe("test");
		expect(createdBody.investor.tornId).toBeNull();

		const deposit = await app.handle(
			new Request(
				`http://localhost/v2/capital/admin/paper/investors/${createdBody.investor.id}/deposits`,
				{
					method: "POST",
					headers: {
						...cookieFor(sessionId),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						amount: "1000000",
					}),
				},
			),
		);
		expect(deposit.status).toBe(200);
		const depositBody = (await deposit.json()) as {
			success: boolean;
			investmentId: string;
		};
		expect(depositBody.success).toBe(true);

		// The deposit must also stamp the per-book marker the engine reads to
		// defer new entries.
		const [marker] = await db
			.select()
			.from(workerState)
			.where(eq(workerState.workerId, capitalDepositStateId("paper")))
			.limit(1);
		expect(marker).toBeDefined();
		const markedAt = new Date(marker?.details.lastDepositAt as string);
		expect(Number.isNaN(markedAt.getTime())).toBe(false);
		expect(Math.abs(Date.now() - markedAt.getTime())).toBeLessThan(60_000);

		const preferences = await app.handle(
			new Request(
				`http://localhost/v2/capital/admin/paper/investors/${createdBody.investor.id}`,
				{
					method: "PATCH",
					headers: {
						...cookieFor(sessionId),
						"content-type": "application/json",
					},
					body: JSON.stringify({ payoutMode: "reinvest" }),
				},
			),
		);
		expect(preferences.status).toBe(200);

		const secondDeposit = await app.handle(
			new Request(
				`http://localhost/v2/capital/admin/paper/investors/${createdBody.investor.id}/deposits`,
				{
					method: "POST",
					headers: {
						...cookieFor(sessionId),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						amount: "2000000",
					}),
				},
			),
		);
		expect(secondDeposit.status).toBe(200);

		const weeklyLots = await db
			.select()
			.from(capitalInvestments)
			.where(
				and(
					eq(capitalInvestments.investorId, createdBody.investor.id),
					eq(capitalInvestments.frequency, "weekly"),
				),
			);
		expect(weeklyLots).toHaveLength(2);
		expect(weeklyLots[0]?.nextPayoutAt?.toISOString()).toBe(
			weeklyLots[1]?.nextPayoutAt?.toISOString(),
		);
		expect(weeklyLots[1]?.payoutMode).toBe("reinvest");
		expect(weeklyLots[0]?.nextPayoutAt?.getUTCHours()).toBe(0);

		const overview = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/overview", {
				headers: cookieFor(sessionId),
			}),
		);
		expect(overview.status).toBe(200);
		const overviewBody = (await overview.json()) as {
			investors: Array<{
				investor: { displayName: string };
				principal: string;
				activeLots: number;
			}>;
		};
		const row = overviewBody.investors.find(
			(investor) => investor.investor.displayName === "API Test Investor",
		);
		expect(row?.principal).toBe("3000000");
		expect(row?.activeLots).toBe(2);
	});

	test("operator withdrawals waive performance and exit fees", async () => {
		if (!sessionId) throw new Error("No session fixture.");
		await updateCapitalConfig(
			"paper",
			{ withdrawalPerformanceFeeEnabled: true, withdrawalExitFeeBps: 100 },
			null,
		);

		const overviewResponse = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/overview", {
				headers: cookieFor(sessionId),
			}),
		);
		const overview = (await overviewResponse.json()) as {
			investors: Array<{ investor: { id: string; kind: string } }>;
		};
		const operator = overview.investors.find(
			(row) => row.investor.kind === "operator",
		);
		expect(operator).toBeTruthy();
		if (!operator) return;

		const deposit = await app.handle(
			new Request(
				`http://localhost/v2/capital/admin/paper/investors/${operator.investor.id}/deposits`,
				{
					method: "POST",
					headers: {
						...cookieFor(sessionId),
						"content-type": "application/json",
					},
					body: JSON.stringify({ amount: "1000000" }),
				},
			),
		);
		expect(deposit.status).toBe(200);

		const request = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/withdrawals", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					investorId: operator.investor.id,
					amount: "500000",
				}),
			}),
		);
		expect(request.status).toBe(200);
		const body = (await request.json()) as {
			request: {
				performanceFee: string;
				exitFee: string;
				netAmount: string;
				grossValue: string;
			};
		};
		expect(Number(body.request.performanceFee)).toBe(0);
		expect(Number(body.request.exitFee)).toBe(0);
		expect(body.request.netAmount).toBe(body.request.grossValue);

		await updateCapitalConfig(
			"paper",
			{ withdrawalPerformanceFeeEnabled: true, withdrawalExitFeeBps: 0 },
			null,
		);
	});

	test("operator payouts waive performance fees and do not book fee noise", async () => {
		if (!sessionId) throw new Error("No session fixture.");

		const overviewResponse = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/overview", {
				headers: cookieFor(sessionId),
			}),
		);
		const overview = (await overviewResponse.json()) as {
			investors: Array<{
				investor: { id: string; kind: string };
				activeLots: number;
			}>;
		};
		const operator = overview.investors.find(
			(row) => row.investor.kind === "operator",
		);
		expect(operator).toBeTruthy();
		if (!operator) return;

		// Fetch operator's active lot
		const [lot] = await db
			.select()
			.from(capitalInvestments)
			.where(
				and(
					eq(capitalInvestments.book, "paper"),
					eq(capitalInvestments.investorId, operator.investor.id),
					eq(capitalInvestments.status, "active"),
				),
			)
			.limit(1);
		expect(lot).toBeTruthy();
		if (!lot) return;

		// Seed a payout obligation for the operator lot with hypothetical fee
		const now = new Date();
		const [obligation] = await db
			.insert(capitalPayoutObligations)
			.values({
				book: "paper",
				investmentId: lot.id,
				investorId: operator.investor.id,
				frequency: "monthly",
				periodStart: lot.openedAt,
				periodEnd: now,
				dueAt: now,
				grossAmount: "100000",
				feeAmount: "20000",
				netAmount: "80000",
				paidAmount: "0",
				remainingAmount: "100000",
				status: "due",
				highWaterNav: lot.highWaterNav,
				navAtCreation: "1",
			})
			.returning();
		expect(obligation).toBeTruthy();
		if (!obligation) return;

		const payResponse = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/payouts/pay", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					obligationId: obligation.id,
				}),
			}),
		);
		expect(payResponse.status).toBe(200);

		// Verify no fee transaction was booked for this payout
		const feeTx = await db
			.select()
			.from(capitalTransactions)
			.where(
				and(
					eq(capitalTransactions.book, "paper"),
					eq(capitalTransactions.payoutId, obligation.id),
					eq(capitalTransactions.type, "fee"),
				),
			);
		expect(feeTx.length).toBe(0);
	});

	test("manual fills clamp a sell to the held shares", async () => {
		if (!sessionId) throw new Error("No session fixture.");
		const buy = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/fills", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					stockId: 9_000_020,
					side: "buy",
					shares: 1000,
					price: "10",
				}),
			}),
		);
		expect(buy.status).toBe(200);

		const sell = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/fills", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					stockId: 9_000_020,
					side: "sell",
					shares: 5000,
					price: "12",
				}),
			}),
		);
		expect(sell.status).toBe(200);
		const body = (await sell.json()) as { fill: { shares: number } };
		expect(body.fill.shares).toBe(1000);
	});

	test("manual fills reject an order from another book", async () => {
		if (!sessionId) throw new Error("No session fixture.");
		const [liveOrder] = await db
			.insert(capitalOrders)
			.values({
				book: "live",
				stockId: 9_000_021,
				side: "buy",
				status: "recommended",
				recommendedShares: 10,
				priceGuide: "10",
				expiresAt: new Date(Date.now() + 3_600_000),
			})
			.returning();
		const response = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/fills", {
				method: "POST",
				headers: {
					...cookieFor(sessionId),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					stockId: 9_000_021,
					side: "buy",
					shares: 10,
					price: "10",
					orderId: liveOrder?.id,
				}),
			}),
		);
		expect(response.status).toBe(400);
		if (liveOrder) {
			await db.delete(capitalOrders).where(eq(capitalOrders.id, liveOrder.id));
		}
	});

	test("paper reset clears everything and recreates the operator", async () => {
		if (!sessionId) throw new Error("No session fixture.");
		const reset = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/reset", {
				method: "POST",
				headers: cookieFor(sessionId),
			}),
		);
		expect(reset.status).toBe(200);

		const overview = await app.handle(
			new Request("http://localhost/v2/capital/admin/paper/overview", {
				headers: cookieFor(sessionId),
			}),
		);
		expect(overview.status).toBe(200);
		const body = (await overview.json()) as {
			summary: { cash: string; positionsValue: string };
			investors: Array<{ investor: { kind: string } }>;
			positions: unknown[];
			recentFills: unknown[];
		};
		expect(body.investors).toHaveLength(1);
		expect(body.investors[0]?.investor.kind).toBe("operator");
		expect(body.positions).toHaveLength(0);
		expect(body.recentFills).toHaveLength(0);
		expect(Number(body.summary.cash)).toBe(0);
		expect(Number(body.summary.positionsValue)).toBe(0);
	});

	test("recent trades are paginated newest-first on public and admin endpoints", async () => {
		if (!sessionId) throw new Error("No session fixture.");
		const base = Date.now() - 60_000;
		const created = await db
			.insert(capitalFills)
			.values(
				[1, 2, 3].map((offset) => ({
					book: "paper" as const,
					stockId: 9_000_100 + offset,
					side: "buy" as const,
					shares: 10 * offset,
					price: "10.000000",
					notional: `${100 * offset}.000000`,
					source: "manual" as const,
					occurredAt: new Date(base + offset * 1_000),
				})),
			)
			.returning();
		const ids = created.map((row) => row.id);
		try {
			const first = await app.handle(
				new Request(
					"http://localhost/v2/capital/public/trades?book=paper&page=1&pageSize=2",
				),
			);
			expect(first.status).toBe(200);
			const firstBody = (await first.json()) as {
				trades: Array<{ id: string }>;
				pagination: {
					page: number;
					pageSize: number;
					total: number;
					totalPages: number;
					hasNextPage: boolean;
					hasPrevPage: boolean;
				};
			};
			expect(firstBody.trades).toHaveLength(2);
			expect(firstBody.trades[0]?.id).toBe(ids[2]);
			expect(firstBody.pagination).toEqual({
				page: 1,
				pageSize: 2,
				total: 3,
				totalPages: 2,
				hasNextPage: true,
				hasPrevPage: false,
			});

			const second = await app.handle(
				new Request(
					"http://localhost/v2/capital/public/trades?book=paper&page=2&pageSize=2",
				),
			);
			expect(second.status).toBe(200);
			const secondBody = (await second.json()) as {
				trades: Array<{ id: string }>;
			};
			expect(secondBody.trades).toHaveLength(1);
			expect(secondBody.trades[0]?.id).toBe(ids[0]);

			const admin = await app.handle(
				new Request(
					"http://localhost/v2/capital/admin/paper/fills?page=2&pageSize=2",
					{ headers: cookieFor(sessionId) },
				),
			);
			expect(admin.status).toBe(200);
			const adminBody = (await admin.json()) as {
				fills: Array<{ id: string }>;
				pagination: { total: number; hasPrevPage: boolean };
			};
			expect(adminBody.fills).toHaveLength(1);
			expect(adminBody.fills[0]?.id).toBe(ids[0]);
			expect(adminBody.pagination.total).toBe(3);
			expect(adminBody.pagination.hasPrevPage).toBe(true);
		} finally {
			await db.delete(capitalFills).where(inArray(capitalFills.id, ids));
		}
	});
});
