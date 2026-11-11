import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	and,
	capitalInvestments,
	db,
	eq,
	resetCapitalPaperBook,
	updateCapitalConfig,
	users,
	userSessions,
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
		{ publicShowHoldings: true, maxPositions: 12 },
		null,
	);
	await resetCapitalPaperBook("150000000000", null);
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
		};
		expect(body.success).toBe(true);
		expect(body.summary.book).toBe("paper");
		expect(body.warnings.some((warning) => warning.includes("Simulated"))).toBe(
			true,
		);
		expect(Array.isArray(body.trades)).toBe(true);
		expect(Array.isArray(body.holdings)).toBe(true);
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
					maxPositions: 8,
				}),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			settings: { publicShowHoldings: boolean; maxPositions: number };
		};
		expect(body.settings.publicShowHoldings).toBe(true);
		expect(body.settings.maxPositions).toBe(8);
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
});
