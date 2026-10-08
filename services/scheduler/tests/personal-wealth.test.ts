import { afterEach, describe, expect, test } from "bun:test";
import { tornApi } from "@sentinel/torn-api";
import {
	clearWealthCaches,
	normalizeLogTypes,
	snapshotBalances,
} from "../src/workers/personal/wealth";

/**
 * Coverage for the wealth worker's Torn reads.
 *
 * These tests exist because of a specific production failure. The worker used
 * `getPersonalRaw`, which targets the **v1** base, while every shape it expected
 * was a **v2** shape. All three reads failed in ways that looked like success:
 *
 *   - `money` came back flat instead of nested, so every balance read as zero
 *     and the panel showed "Wallet $0, Tracked net worth $0";
 *   - `/user/inventory` is not a v1 path, so Torn answered with the player's
 *     profile and the inventory came back empty;
 *   - `/torn` returned the log types as an id-to-title map, and iterating it threw
 *     `{} is not iterable`, leaving the ledger stuck in `running` with no anchor.
 *
 * A wrong shape producing zeros is worse than a wrong shape throwing, because
 * zeros anchor the whole ledger. So the guards below are the specification:
 * missing data must throw, and the one shape that legitimately varies (the log
 * type list) must be accepted either way.
 */

const originalGet = tornApi.get;

afterEach(() => {
	tornApi.get = originalGet;
	clearWealthCaches();
});

/** A key stand-in: the snapshot never inspects it beyond passing it along. */
const TEST_KEY = { apiKey: "test-key", userId: 1_934_909, keyType: "personal" };

describe("log type list normalisation", () => {
	test("reads the v2 list", () => {
		expect(
			normalizeLogTypes([
				{ id: 101, title: "Successful login" },
				{ id: 4810, title: "Money receive" },
			]),
		).toEqual([
			{ id: 101, title: "Successful login" },
			{ id: 4810, title: "Money receive" },
		]);
	});

	test("reads the v1 id-to-title map, which is what crashed the worker", () => {
		// Iterating this shape with `for...of` throws "{} is not iterable".
		expect(
			normalizeLogTypes({ "101": "Successful login", "4810": "Money receive" }),
		).toEqual([
			{ id: 101, title: "Successful login" },
			{ id: 4810, title: "Money receive" },
		]);
	});

	test("survives rubbish without throwing", () => {
		expect(normalizeLogTypes(undefined)).toEqual([]);
		expect(normalizeLogTypes({})).toEqual([]);
		expect(normalizeLogTypes([])).toEqual([]);
		// Entries that are not usable ids are dropped, not turned into NaN rows.
		expect(normalizeLogTypes([{ id: 0 }, { title: "no id" }])).toEqual([]);
		expect(normalizeLogTypes({ notAnId: "x" })).toEqual([]);
	});
});

describe("ledger readiness", () => {
	test("readiness is decided by the anchor row, not by the saved flag", async () => {
		// The production failure: `initialised` was written before the work, so a
		// crashed init left a state that claimed to be anchored with no anchor
		// behind it, and the module then reconciled a ledger of zeros forever.
		const { db, eq, wealthAccountSnapshots } = await import(
			"@sentinel/database"
		);
		const { hasAnchorSnapshot } = await import(
			"../src/workers/personal/wealth"
		);

		const id = "wealth_test_anchor_probe";
		await db
			.delete(wealthAccountSnapshots)
			.where(eq(wealthAccountSnapshots.id, id));

		expect(await hasAnchorSnapshot()).toBe(false);

		await db.insert(wealthAccountSnapshots).values({
			id,
			timestamp: new Date(),
			source: "anchor",
			wallet: 1,
			points: 0,
			vault: 0,
			company: 0,
			cityBank: 0,
			caymanBank: 0,
			piggyBank: 0,
			bookie: 0,
			itemsValue: 0,
			trackedNetWorth: 1,
			tornNetWorth: null,
			netWorthDrift: null,
			raw: {},
		});

		expect(await hasAnchorSnapshot()).toBe(true);

		await db
			.delete(wealthAccountSnapshots)
			.where(eq(wealthAccountSnapshots.id, id));
	});

	test("an init that cannot run does not claim to be initialised", async () => {
		// In a test process init refuses to run because anchoring rebuilds the
		// ledger. What matters is that it reports `initialised: false`, so the next
		// cycle tries again rather than reconciling against nothing.
		const { initWealthTracking } = await import(
			"../src/workers/personal/wealth"
		);
		const result = await initWealthTracking();
		expect(result.state.initialised).toBe(false);
		expect(result.eventsWritten).toBe(0);
	});
});

describe("concurrent anchoring", () => {
	test("a second caller waits for the anchor instead of starting a rival one", async () => {
		// Both the module's startup call and the runner's immediate first tick
		// reach init on the same boot. Two rebuilds would interleave their deletes
		// and race for the same anchor row.
		const { initWealthTracking, resetWealthInitGuard } = await import(
			"../src/workers/personal/wealth"
		);
		resetWealthInitGuard();

		// In a test process init refuses to run, but the guard is what is under
		// test: the second call must receive the SAME promise, not a new attempt.
		const first = initWealthTracking();
		const second = initWealthTracking();
		expect(second).toBe(first);

		await first;
		// Once it settles the guard clears, so the hourly retry can try again.
		const third = initWealthTracking();
		expect(third).not.toBe(first);
		await third;
	});
});

describe("balance snapshot", () => {
	test("reads the v2 nested money selection", async () => {
		tornApi.get = (async (path: string) => {
			if (path === "/user/money") {
				return {
					money: {
						points: 110,
						wallet: 11_840,
						vault: 0,
						company: 515_420_705,
						cayman_bank: 0,
						city_bank: { amount: 2_344_400_000, profit: 344_400_000 },
						faction: { money: 0, points: 0 },
						daily_networth: 119_811_908_178,
					},
				};
			}
			if (path === "/user") {
				return { display: [], bazaar: [] };
			}
			if (path === "/user/inventory") {
				return { inventory: { items: [] } };
			}
			throw new Error(`unexpected path ${path}`);
		}) as unknown as typeof tornApi.get;

		const snapshot = await snapshotBalances(TEST_KEY);

		expect(snapshot.wallet).toBe(11_840);
		expect(snapshot.points).toBe(110);
		expect(snapshot.company).toBe(515_420_705);
		expect(snapshot.cityBank).toBe(2_344_400_000);
		expect(snapshot.tornNetWorth).toBe(119_811_908_178);
	});

	test("throws rather than anchoring on zeros when the money selection is missing", async () => {
		// This is the flat v1 shape the worker used to receive: no `money` key at
		// all. Returning zeros here is what put "Wallet $0" in front of the reader
		// and made the ledger reconcile against a net worth of nothing.
		tornApi.get = (async () => ({
			points: 110,
			cayman_bank: 0,
			vault_amount: null,
			company_funds: 515_420_705,
			daily_networth: 119_811_908_178,
			money_onhand: 11_840,
			city_bank: { amount: 2_344_400_000 },
		})) as unknown as typeof tornApi.getPersonal;

		await expect(snapshotBalances(TEST_KEY)).rejects.toThrow(/money/i);
	});

	test("throws when the money selection is not an object", async () => {
		tornApi.get = (async () => ({
			money: "unavailable",
		})) as unknown as typeof tornApi.get;

		await expect(snapshotBalances(TEST_KEY)).rejects.toThrow(/money/i);
	});

	test("walks every inventory category Torn accepts", async () => {
		const requested: string[] = [];
		tornApi.get = (async (
			path: string,
			options?: { queryParams?: Record<string, unknown> },
		) => {
			if (path === "/user/money") {
				return { money: { wallet: 0, points: 0 } };
			}
			if (path === "/user") {
				return { display: [], bazaar: [] };
			}
			if (path === "/user/inventory") {
				requested.push(String(options?.queryParams?.cat));
				return { inventory: { items: [] } };
			}
			throw new Error(`unexpected path ${path}`);
		}) as unknown as typeof tornApi.get;

		await snapshotBalances(TEST_KEY);

		// The categories Torn rejects must never be asked for: reading them out of
		// `torn_items` used to request `Weapon`, `Armor` and `Unused`, which always
		// fail, and never requested the five that hold weapons.
		expect(requested).not.toContain("Weapon");
		expect(requested).not.toContain("Armor");
		expect(requested).not.toContain("Unused");
		expect(requested).not.toContain("All");

		// And the weapon categories must be asked for, since that is where weapons
		// actually live.
		expect(requested).toContain("Melee");
		expect(requested).toContain("Primary");
		expect(requested).toContain("Secondary");
		expect(requested).toContain("Defensive");
		expect(requested.length).toBeGreaterThan(20);
	});

	test("records a category that fails instead of treating it as empty", async () => {
		tornApi.get = (async (
			path: string,
			options?: { queryParams?: Record<string, unknown> },
		) => {
			if (path === "/user/money") {
				return { money: { wallet: 0, points: 0 } };
			}
			if (path === "/user") {
				return { display: [], bazaar: [] };
			}
			if (path === "/user/inventory") {
				if (options?.queryParams?.cat === "Melee") {
					throw new Error("Incorrect category");
				}
				return { inventory: { items: [] } };
			}
			throw new Error(`unexpected path ${path}`);
		}) as unknown as typeof tornApi.get;

		const snapshot = await snapshotBalances(TEST_KEY);
		expect(snapshot.failures.some((line) => line.startsWith("Melee"))).toBe(
			true,
		);
	});

	test("prices the display case and the bazaar alongside the inventory", async () => {
		tornApi.get = (async (path: string) => {
			if (path === "/user/money") {
				return { money: { wallet: 0, points: 0 } };
			}
			if (path === "/user") {
				return {
					display: [{ ID: 1296, name: "Ban Hammer", quantity: 1 }],
					bazaar: [{ ID: 1118, name: "Armor Cache", amount: 2 }],
				};
			}
			if (path === "/user/inventory") {
				return { inventory: { items: [] } };
			}
			throw new Error(`unexpected path ${path}`);
		}) as unknown as typeof tornApi.get;

		const snapshot = await snapshotBalances(TEST_KEY);
		expect(snapshot.items.map((item) => item.location).sort()).toEqual([
			"bazaar",
			"display",
		]);
		// Quantities: `quantity` on the display entry, `amount` on the bazaar one.
		expect(snapshot.items.find((i) => i.location === "bazaar")?.quantity).toBe(
			2,
		);
	});
});
