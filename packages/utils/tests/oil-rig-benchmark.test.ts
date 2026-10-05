import { describe, expect, it } from "bun:test";
import { deriveRosterBaseline, getOptimalRoleQuotas } from "../src/oil-rig";
import {
	type BenchmarkApiClient,
	buildRoleBlueprint,
	captureRosterBenchmark,
	describeRosterBenchmark,
	isCaptureStale,
	median,
	type SampledRig,
	totalStaff,
} from "../src/oil-rig-benchmark";

const NOW = 1_791_220_800;
const DAY = 86_400;

/**
 * A stub industry API.
 *
 * `total` is the crucial part: the real listing is paginated and returns 100
 * companies per page however large `limit` is, so the page length is NOT the
 * industry size.
 */
function stubClient(options: {
	total: number;
	pageSize?: number;
	rigs: Array<{ id: number; rating: number; roles: string[] }>;
	failIds?: number[];
	/** Records every path requested, so a test can assert the call cost. */
	requested?: string[];
}): BenchmarkApiClient {
	const pageSize = options.pageSize ?? 100;
	return {
		async get(path, request) {
			options.requested?.push(path);
			if (path.endsWith("/companies")) {
				// The type id arrives as a path param, not baked into the path.
				if (request?.pathParams?.typeId === undefined) {
					throw new Error("listing request omitted its typeId path param");
				}
				// The listing carries rating, staffing and financials for every rig in
				// the industry. That is the whole reason no per-rig profile request is
				// needed: a profile would return a strict subset of this.
				return {
					companies: options.rigs.slice(0, pageSize).map((rig) => ({
						id: rig.id,
						name: `Rig ${rig.id}`,
						rating: rig.rating,
						employees: { hired: rig.roles.length, capacity: rig.roles.length },
						income: { daily: 160_000_000, weekly: 1_120_000_000 },
						customers: { daily: 4, weekly: 30 },
					})),
					_metadata: { total: options.total },
				};
			}
			if (!path.endsWith("/employees")) {
				// A profile request here would be a regression, not a stray call.
				throw new Error(`unexpected request for ${path}`);
			}
			const id = Number(request?.pathParams?.id);
			if (options.failIds?.includes(id)) {
				throw new Error("Simulated unreadable rig");
			}
			const rig = options.rigs.find((candidate) => candidate.id === id);
			if (!rig) throw new Error("unknown rig");
			return { employees: rig.roles.map((name) => ({ position: { name } })) };
		},
	};
}

/** The real industry shape: 75 ten-star rigs in a 432-rig field. */
const realishRigs = Array.from({ length: 12 }, (_, i) => ({
	id: 1_000 + i,
	rating: i < 10 ? 10 : 9,
	roles: [
		...Array(8).fill("Driller"),
		...Array(3).fill("Motor Hand"),
		...Array(2).fill("Secretary"),
		...Array(4).fill("Derrick Hand"),
		...Array(6).fill("Roughneck"),
		...Array(7).fill("Sales Executive"),
	],
}));

describe("Roster benchmark capture", () => {
	it("takes the field size from _metadata.total, not the page length", async () => {
		// The listing is paginated: 100 per page from a 432-rig industry. Using the
		// page length would understate the field by 4.3x, and the field size is a
		// DENOMINATOR in the advertising rank step (40% / field size), so
		// understating it overstates what one rank is worth.
		const capture = await captureRosterBenchmark({
			client: stubClient({ total: 432, rigs: realishRigs }),
			apiKey: "test",
			sampleSize: 8,
			now: () => new Date(NOW * 1000),
		});

		expect(capture.fieldSize).toBe(432);
		expect(capture.topRigs.length).toBe(8);
		expect(capture.sampleSize).toBe(8);
		expect(capture.rating).toBe(10);
	});

	it("costs one request per rig and never re-fetches a profile", async () => {
		// The listing already carries rating, staffing, income and customers for
		// every rig, so a profile request per rig is pure waste: it returns a subset
		// of data already paid for, and it doubled the run from nine requests to
		// seventeen.
		const requested: string[] = [];
		const capture = await captureRosterBenchmark({
			client: stubClient({ total: 432, rigs: realishRigs, requested }),
			apiKey: "test",
			sampleSize: 8,
			now: () => new Date(NOW * 1000),
		});

		expect(
			requested.filter((path) => path.endsWith("/companies")),
		).toHaveLength(1);
		expect(
			requested.filter((path) => path.endsWith("/employees")),
		).toHaveLength(8);
		expect(requested.some((path) => path.includes("/profile"))).toBe(false);
		expect(requested).toHaveLength(9);

		// Every path must be a Torn v2 schema KEY with its parameter passed
		// separately. An assembled literal like `/company/28/companies` is a v1-shaped
		// path: it forces callers onto the legacy raw endpoint, which builds a
		// `https://api.torn.com` v1 URL and fails at runtime with "Incorrect ID"
		// rather than at compile time.
		expect(requested[0]).toBe("/company/{typeId}/companies");
		for (const path of requested) {
			expect(path).toContain("{");
			expect(path).not.toMatch(/\d/);
		}

		// The listing's financial and staffing figures still reach the sample, so
		// dropping the profile call lost nothing.
		expect(capture.topRigs[0]?.weeklyIncome).toBe(1_120_000_000);
		expect(capture.topRigs[0]?.hired).toBe(realishRigs[0]?.roles.length);
		expect(capture.avgWeeklyRevenue).toBe(1_120_000_000);
	});

	it("does not search the listing for our own rig", async () => {
		// The listing is one page of 100, sorted by rating descending, so a
		// mid-rated rig is never on it. The capture must not pretend otherwise: a
		// comparison block that silently produced nothing on every run was worse
		// than no comparison block, so our own rig is the caller's job.
		const requested: string[] = [];
		const capture = await captureRosterBenchmark({
			client: stubClient({ total: 432, rigs: realishRigs, requested }),
			apiKey: "test",
			sampleSize: 3,
			ourCompanyId: 1_008,
			now: () => new Date(NOW * 1000),
		});

		// Listing plus three sampled rigs, and nothing extra for our own rig.
		expect(requested).toHaveLength(4);
		expect(requested.some((path) => path.includes("/profile"))).toBe(false);
		expect(capture.sampleSize).toBe(3);
	});

	it("falls back to the page length only when the listing declares no total", async () => {
		const client: BenchmarkApiClient = {
			async get(path) {
				if (path.endsWith("/companies")) {
					return {
						companies: realishRigs
							.slice(0, 5)
							.map((r) => ({ ...r, name: "x" })),
					};
				}
				return { profile: { id: 1, name: "x", rating: 10 }, employees: [] };
			},
		};
		const capture = await captureRosterBenchmark({
			client,
			apiKey: "test",
			sampleSize: 1,
			now: () => new Date(NOW * 1000),
		});
		expect(capture.fieldSize).toBe(5);
	});

	it("excludes an unreadable rig from the medians but records it", async () => {
		const capture = await captureRosterBenchmark({
			client: stubClient({
				total: 432,
				rigs: realishRigs,
				failIds: [1_002],
			}),
			apiKey: "test",
			sampleSize: 8,
			now: () => new Date(NOW * 1000),
		});
		expect(capture.failedRigIds).toEqual([1_002]);
		// Seven of eight loaded, and sampleSize says so rather than implying eight.
		expect(capture.sampleSize).toBe(7);
		expect(capture.topRigs.some((rig) => rig.id === 1_002)).toBe(false);
	});

	it("refuses a capture with no readable rigs", async () => {
		const capture = await captureRosterBenchmark({
			client: stubClient({
				total: 432,
				rigs: realishRigs,
				failIds: realishRigs.map((rig) => rig.id),
			}),
			apiKey: "test",
			sampleSize: 8,
			now: () => new Date(NOW * 1000),
		});
		// An all-zero capture must never be persisted: the baseline derivation would
		// read it as "top rigs staff nobody" and steer the blueprint accordingly.
		expect(capture.sampleSize).toBe(0);
		expect(capture.roleShares).toEqual({});
	});

	it("throws when the listing itself cannot be read", async () => {
		const client: BenchmarkApiClient = {
			async get() {
				return { companies: [] };
			},
		};
		await expect(
			captureRosterBenchmark({
				client,
				apiKey: "test",
				now: () => new Date(NOW * 1000),
			}),
		).rejects.toThrow("returned no companies");
	});
});

describe("Roster benchmark aggregation", () => {
	const rig = (roles: string[]): SampledRig => ({
		id: 1,
		name: "r",
		rating: 10,
		weeklyIncome: 0,
		weeklyCustomers: 0,
		dailyIncome: 0,
		dailyCustomers: 0,
		hired: roles.length,
		capacity: roles.length,
		roleCounts: roles.reduce<Record<string, number>>((acc, role) => {
			acc[role] = (acc[role] ?? 0) + 1;
			return acc;
		}, {}),
	});

	it("measures shares as a median of per-rig ratios, so it is scale-invariant", () => {
		// A 4-staff rig and a 40-staff rig with the same shape must agree.
		const small = rig(["Driller", "Driller", "Sales Executive", "Secretary"]);
		const large = rig([
			...Array(20).fill("Driller"),
			...Array(10).fill("Sales Executive"),
			...Array(10).fill("Secretary"),
		]);
		const blueprint = buildRoleBlueprint([small, large]);
		expect(blueprint.roleShares.Driller).toBeCloseTo(0.5, 5);
		expect(blueprint.roleShares["Sales Executive"]).toBeCloseTo(0.25, 5);
		expect(blueprint.roleShares.Secretary).toBeCloseTo(0.25, 5);
	});

	it("counts a role a rig does not staff as zero rather than ignoring it", () => {
		const withSecretary = rig(["Driller", "Secretary"]);
		const without = rig(["Driller", "Driller"]);
		const blueprint = buildRoleBlueprint([withSecretary, without]);
		// Median of [0.5, 0] is 0.25, not the 1.0 an only-rigs-that-staff-it average
		// would produce.
		expect(blueprint.roleShares.Secretary).toBeCloseTo(0.25, 5);
		expect(blueprint.roleCounts.Secretary).toBe(0.5);
	});

	it("returns explicit zeros instead of NaN for empty samples", () => {
		expect(median([])).toBe(0);
		expect(median([3])).toBe(3);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(totalStaff({})).toBe(0);
	});
});

describe("Roster benchmark refresh guard", () => {
	it("treats a missing capture as stale", () => {
		expect(isCaptureStale(undefined, { now: new Date(NOW * 1000) })).toBe(true);
	});

	it("skips a capture taken inside the refresh window", () => {
		const recent = new Date((NOW - 3 * 3_600) * 1000);
		expect(
			isCaptureStale(recent, { minAgeHours: 20, now: new Date(NOW * 1000) }),
		).toBe(false);
	});

	it("refreshes once the window has passed", () => {
		const old = new Date((NOW - 30 * 3_600) * 1000);
		expect(
			isCaptureStale(old, { minAgeHours: 20, now: new Date(NOW * 1000) }),
		).toBe(true);
	});
});

/**
 * A capture reads only a handful of rigs, and the daily refresh means a new
 * sample every day. Without smoothing, one day's slightly different sample would
 * move a share across a rounding boundary and demand a seat move.
 */
describe("Baseline smoothing across captures", () => {
	const capture = (daysAgo: number, shares: Record<string, number>) => ({
		capturedAt: new Date((NOW - daysAgo * DAY) * 1000),
		rating: 10,
		fieldSize: 432,
		sampleSize: 8,
		roleShares: shares,
	});

	const steady = {
		Driller: 8 / 30,
		"Sales Executive": 7 / 30,
		Roughneck: 6 / 30,
		"Derrick Hand": 4 / 30,
		"Motor Hand": 3 / 30,
		Secretary: 2 / 30,
	};

	it("uses the median share across captures, so one odd sample cannot move it", () => {
		const baseline = deriveRosterBaseline(
			[
				capture(0, { ...steady }),
				capture(1, { ...steady, Secretary: 0.4, Driller: 0.1 }), // odd sample
				capture(2, { ...steady }),
			],
			{ asOfSeconds: NOW, smoothingCaptures: 5 },
		);

		expect(baseline).toBeDefined();
		// Median of [2/30, 0.4, 2/30] is 2/30, not the outlying 0.4.
		expect(baseline?.roleShares.Secretary).toBeCloseTo(2 / 30, 4);
		expect(baseline?.source).toContain("median of 3 daily captures");
	});

	it("scales the smoothed blueprint to an exact headcount", () => {
		const baseline = deriveRosterBaseline([capture(0, steady)], {
			asOfSeconds: NOW,
		});
		const quotas = getOptimalRoleQuotas(30, baseline);
		expect(quotas.Driller).toBe(8);
		expect(quotas["Sales Executive"]).toBe(7);
		expect(quotas.Roughneck).toBe(6);
		expect(Object.values(quotas).reduce((a, b) => a + b, 0)).toBe(30);
	});

	it("ignores captures older than the age limit", () => {
		expect(
			deriveRosterBaseline([capture(90, steady)], {
				asOfSeconds: NOW,
				maxAgeDays: 45,
			}),
		).toBeUndefined();
	});

	it("ignores a capture with no recognisable roles", () => {
		expect(
			deriveRosterBaseline([capture(0, { Wrench: 0.5, Sprocket: 0.5 })], {
				asOfSeconds: NOW,
			}),
		).toBeUndefined();
	});

	it("summarises a capture for logs without leaking the roster", () => {
		const summary = describeRosterBenchmark(
			{
				capturedAt: new Date(NOW * 1000),
				rating: 10,
				fieldSize: 432,
				offered: 12,
				sampleSize: 8,
				failedRigIds: [],
				avgWeeklyRevenue: 0,
				avgWeeklyCustomers: 0,
				avgHired: 0,
				avgCapacity: 0,
				roleCounts: { Driller: 8 },
				roleShares: { Driller: 1 },
				topRigs: [],
			},
			"oil_rig_bench_1",
		);
		expect(summary).toContain("8/12 top-10★");
		expect(summary).toContain("432-rig industry");
		expect(summary).toContain("oil_rig_bench_1");
	});
});
