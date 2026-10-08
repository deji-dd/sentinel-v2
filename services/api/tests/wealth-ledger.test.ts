import { afterAll, describe, expect, test } from "bun:test";
import {
	db,
	eq,
	inArray,
	ledgerEvents,
	systemStates,
	wealthAccountSnapshots,
} from "@sentinel/database";
import type {
	WealthAnalyticsResponse,
	WealthStateResponse,
	WealthTransactionsResponse,
} from "@sentinel/schemas";
import { app } from "../src/app";

/**
 * Route-level coverage for the wealth ledger endpoint.
 *
 * The engine's arithmetic is covered by `packages/utils/tests/wealth` and the
 * rule table's integrity by `wealth-rules`; what is checked here is the wiring no
 * unit test can see — that the routes read the ledger, that the anchor unwinds
 * correctly, that coverage is reported rather than swallowed, and that the
 * payload obeys the shared contract the userscript renders.
 *
 * Every fixture id is prefixed `wealth_test_` so this runs against a database
 * holding a live ledger without touching its rows. It writes nothing to
 * `personal_logs` on purpose: the scheduler's ledger tests reconcile that table
 * globally, so a stray row from another test file makes them fail.
 */

const PREFIX = "wealth_test_";
const ANCHOR_TS = Math.floor(Date.UTC(2026, 9, 8) / 1000);
const STATE_ID = "personal:wealth";

/** Every row this file writes, so cleanup cannot leave a stray id behind. */
const TEST_IDS = [
	`${PREFIX}anchor_ev`,
	`${PREFIX}unpriced_ev`,
	`${PREFIX}mirror_ev`,
	`${PREFIX}other_ev`,
];

async function cleanup(): Promise<void> {
	await db.delete(ledgerEvents).where(inArray(ledgerEvents.id, TEST_IDS));
	await db
		.delete(wealthAccountSnapshots)
		.where(eq(wealthAccountSnapshots.id, `${PREFIX}anchor`));
}

function eventRow(
	id: string,
	overrides: Partial<typeof ledgerEvents.$inferInsert>,
): typeof ledgerEvents.$inferInsert {
	return {
		id,
		logId: `${PREFIX}log`,
		timestamp: new Date((ANCHOR_TS + 3600) * 1000),
		type: "inflow",
		categoryId: 0,
		transactionName: "Test movement",
		assetsAffected: [],
		cashFlow: 0,
		realizedPnl: 0,
		rawLog: null,
		logType: 4810,
		wealthCategory: "bank",
		walletDelta: 0,
		account: null,
		accountDelta: 0,
		assetDelta: 0,
		priced: true,
		...overrides,
	};
}

async function seed(): Promise<void> {
	await cleanup();

	// The anchor records OPENING balances: observed minus the day's activity, so
	// the replayed events are not counted a second time.
	await db.insert(wealthAccountSnapshots).values({
		id: `${PREFIX}anchor`,
		timestamp: new Date(ANCHOR_TS * 1000),
		source: "anchor",
		wallet: 1_000_000,
		points: 100,
		vault: 500_000,
		company: 250_000,
		cityBank: 0,
		caymanBank: 0,
		piggyBank: 0,
		bookie: 0,
		itemsValue: 100_000,
		trackedNetWorth: 1_850_000,
		tornNetWorth: 2_000_000,
		netWorthDrift: null,
		raw: {},
	});

	// A priced wallet movement and an unpriced item movement, plus a mirrored row
	// that must not contribute to the totals.
	await db.insert(ledgerEvents).values([
		eventRow(`${PREFIX}anchor_ev`, {
			walletDelta: 25_000,
			assetDelta: 25_000,
			priced: true,
		}),
		eventRow(`${PREFIX}unpriced_ev`, {
			logId: `${PREFIX}log`,
			logType: 7011,
			wealthCategory: "items",
			walletDelta: 0,
			assetDelta: 0,
			priced: false,
		}),
		eventRow(`${PREFIX}mirror_ev`, {
			logId: `${PREFIX}mirror`,
			logType: 6736,
			wealthCategory: "faction",
			walletDelta: 0,
			assetDelta: 0,
			priced: false,
		}),
	]);

	const stateData = {
		status: "completed",
		initialised: true,
		anchorTimestamp: ANCHOR_TS,
		anchorDate: new Date(ANCHOR_TS * 1000).toISOString(),
		totalIndexedEvents: 3,
		lastReconciledAt: new Date().toISOString(),
		lastError: null,
		updatedAt: new Date().toISOString(),
		logTypesSyncedAt: null,
	};

	// `data` must be overwritten on conflict, not only on first insert: another
	// test file can already have written this state id with defaults, and a
	// partial upsert would leave those in place and silently anchor the ledger at
	// `null`.
	await db
		.insert(systemStates)
		.values({
			id: STATE_ID,
			init: true,
			data: stateData,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: systemStates.id,
			set: { init: true, data: stateData, updatedAt: new Date() },
		});
}

afterAll(async () => {
	await cleanup();
});

describe("Wealth ledger routes", () => {
	test("GET /state reports the anchor and the ledger's health", async () => {
		await seed();
		const response = await app.handle(
			new Request("http://localhost/v2/system/wealth-ledger/state"),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as WealthStateResponse;
		expect(body.success).toBe(true);
		expect(body.state.initialised).toBe(true);
		// The anchor is the start of a UTC day, not the moment the sync ran.
		expect(body.state.anchorTimestamp).toBe(ANCHOR_TS);
		expect(body.state.anchorDate?.endsWith("T00:00:00.000Z")).toBe(true);
		expect(typeof body.state.coverage.pricedEvents).toBe("number");
		expect(Array.isArray(body.state.coverage.unclassified)).toBe(true);
	});

	test("GET /accounts unwinds the anchor into current balances", async () => {
		await seed();
		const response = await app.handle(
			new Request("http://localhost/v2/system/wealth-ledger/accounts"),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			balances: WealthStateResponse["balances"];
		};
		expect(body.success).toBe(true);
		// Opening 1,000,000 plus the 25,000 that moved since the anchor.
		expect(body.balances.wallet).toBe(1_025_000);
		expect(body.balances.accounts.vault).toBe(500_000);
		expect(body.balances.trackedNetWorth).toBe(1_875_000);
		// Drift is reported rather than hidden: it is the only signal that a rule
		// is wrong.
		expect(body.balances.netWorthDrift).toBe(1_875_000 - 2_000_000);
	});

	test("GET /analytics returns the full contract the tab renders", async () => {
		await seed();
		const response = await app.handle(
			new Request("http://localhost/v2/system/wealth-ledger/analytics?days=30"),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as WealthAnalyticsResponse;
		expect(body.success).toBe(true);
		expect(body.timeframe.days).toBe("30");
		expect(typeof body.kpis.walletIn).toBe("number");
		expect(typeof body.kpis.netWorthDelta).toBe("number");
		expect(Array.isArray(body.timeline)).toBe(true);
		expect(Array.isArray(body.categories)).toBe(true);
		expect(Array.isArray(body.topEvents)).toBe(true);
		// Every field the tab reads must be present, or it renders "undefined".
		for (const point of body.timeline) {
			expect(typeof point.date).toBe("string");
			expect(typeof point.walletIn).toBe("number");
			expect(typeof point.walletOut).toBe("number");
			expect(typeof point.netWorthDelta).toBe("number");
			expect(typeof point.events).toBe("number");
		}
		for (const category of body.categories) {
			expect(typeof category.category).toBe("string");
			expect(typeof category.unpricedEvents).toBe("number");
		}
	});

	test("GET /analytics accepts an all-time window", async () => {
		await seed();
		const response = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/analytics?days=all",
			),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as WealthAnalyticsResponse;
		expect(body.timeframe.days).toBe("all");
		expect(body.timeframe.from).toBeNull();
	});

	test("GET /transactions pages the ledger", async () => {
		await seed();
		const response = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/transactions?limit=10&offset=0",
			),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as WealthTransactionsResponse;
		expect(body.success).toBe(true);
		expect(body.limit).toBe(10);
		expect(body.offset).toBe(0);
		expect(Array.isArray(body.transactions)).toBe(true);
		for (const transaction of body.transactions) {
			expect(typeof transaction.label).toBe("string");
			expect(typeof transaction.walletDelta).toBe("number");
			expect(typeof transaction.netWorthDelta).toBe("number");
			expect(typeof transaction.priced).toBe("boolean");
			expect(Array.isArray(transaction.itemsIn)).toBe(true);
			expect(Array.isArray(transaction.itemsOut)).toBe(true);
		}
	});

	test("the movements view hides events that changed nothing", async () => {
		await seed();
		// A neutral row: real history, but not a transaction.
		await db.insert(ledgerEvents).values(
			eventRow(`${PREFIX}neutral_ev`, {
				logId: `${PREFIX}log`,
				logType: 8160,
				wealthCategory: "attacks",
				transactionName: "Hospitalised a target",
				walletDelta: 0,
				assetDelta: 0,
			}),
		);

		// The default list is movements, which is what a reader scanning day by day
		// wants: a table of zero-value rows buries the ones that matter.
		const movements = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/transactions?limit=50",
			),
		);
		const movementBody = (await movements.json()) as WealthTransactionsResponse;
		expect(
			movementBody.transactions.some((row) => row.id === `${PREFIX}neutral_ev`),
		).toBe(false);

		// Asking for everything brings it back.
		const all = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/transactions?limit=50&movements=0",
			),
		);
		const allBody = (await all.json()) as WealthTransactionsResponse;
		expect(allBody.total).toBeGreaterThan(movementBody.total);

		await db
			.delete(ledgerEvents)
			.where(eq(ledgerEvents.id, `${PREFIX}neutral_ev`));
	});

	test("an unpriced row says why it is unpriced", async () => {
		await seed();
		// `movements=0` matters here: an event the ledger could not value usually
		// has a recorded movement of zero, which is exactly why it needs looking
		// at. Filtering by movement would return an empty table for the very
		// question this view exists to answer.
		const response = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/transactions?priced=0&payloads=1&movements=0&limit=50",
			),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as WealthTransactionsResponse;
		expect(body.transactions.length).toBeGreaterThan(0);
		for (const row of body.transactions) {
			expect(row.priced).toBe(false);
			// "Unpriced" alone is not actionable, so every row carries a reason.
			expect(typeof row.pricingNote).toBe("string");
			expect(row.pricingNote?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test("the priced filter is exact in both directions", async () => {
		await seed();
		const priced = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/transactions?priced=1&movements=0&limit=50",
			),
		);
		const pricedBody = (await priced.json()) as WealthTransactionsResponse;
		for (const row of pricedBody.transactions) expect(row.priced).toBe(true);

		const unpriced = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/transactions?priced=0&movements=0&limit=50",
			),
		);
		const unpricedBody = (await unpriced.json()) as WealthTransactionsResponse;
		for (const row of unpricedBody.transactions) expect(row.priced).toBe(false);
	});

	test("paging reports the total so the client can size the table", async () => {
		await seed();
		const response = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/transactions?limit=1&offset=0&movements=0",
			),
		);
		const body = (await response.json()) as WealthTransactionsResponse;
		expect(body.transactions.length).toBeLessThanOrEqual(1);
		expect(body.total).toBeGreaterThanOrEqual(body.transactions.length);
	});

	test("an unrecognised log type surfaces in coverage instead of vanishing", async () => {
		await seed();
		await db.insert(ledgerEvents).values(
			eventRow(`${PREFIX}other_ev`, {
				logId: `${PREFIX}log`,
				logType: 424_242,
				wealthCategory: "other",
				transactionName: "Log type 424242",
				priced: false,
			}),
		);

		const response = await app.handle(
			new Request("http://localhost/v2/system/wealth-ledger/state"),
		);
		const body = (await response.json()) as WealthStateResponse;
		const entry = body.state.coverage.unclassified.find(
			(item) => item.logType === 424_242,
		);
		expect(entry).toBeDefined();
		expect(entry?.events).toBeGreaterThanOrEqual(1);

		await db
			.delete(ledgerEvents)
			.where(eq(ledgerEvents.id, `${PREFIX}other_ev`));
	});

	test("a negative wallet delta lands in money out, not money in", async () => {
		await seed();
		await db
			.update(ledgerEvents)
			.set({ walletDelta: -10_000, assetDelta: -10_000 })
			.where(eq(ledgerEvents.id, `${PREFIX}anchor_ev`));

		const response = await app.handle(
			new Request(
				"http://localhost/v2/system/wealth-ledger/analytics?days=all",
			),
		);
		const body = (await response.json()) as WealthAnalyticsResponse;
		const bank = body.categories.find((row) => row.category === "bank");
		expect(bank?.walletOut).toBe(10_000);
		expect(bank?.walletIn).toBe(0);

		await db
			.update(ledgerEvents)
			.set({ walletDelta: 25_000, assetDelta: 25_000 })
			.where(eq(ledgerEvents.id, `${PREFIX}anchor_ev`));
	});
});
