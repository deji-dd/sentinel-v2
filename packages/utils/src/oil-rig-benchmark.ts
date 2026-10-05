import { Logger } from "./logger";

const logger = new Logger("RosterBenchmark");

/**
 * Measures how the best-staffed rigs in the industry are actually run.
 *
 * WHY THIS IS A MODULE AND NOT A SCRIPT. The roster blueprint is the one lever
 * that is publicly observable, so it is the one that does not have to be guessed -
 * but a guess is all it is until it has been measured, and a measurement that only
 * happens when somebody remembers to run a script by hand is a guess with extra
 * steps. The capture, the aggregation and the persistence therefore live here,
 * where the scheduler can call them on the same daily tick as the briefing, and
 * the CLI script is a thin wrapper over the same code so the two can never
 * disagree about what was measured.
 *
 * The Torn client is injected rather than imported: this package is bundled for
 * the browser, and the module only ever needs `get`.
 */

/**
 * The single API surface this module needs.
 *
 * Structural, not nominal, so the real `TornApiClient` satisfies it and a test can
 * satisfy it with an object literal. `packages/torn-api` is deliberately not
 * imported, so nothing here can drag it into a browser bundle.
 */
export interface BenchmarkApiClient {
	get(
		path: string,
		options: { apiKey: string; pathParams?: Record<string, string | number> },
	): Promise<unknown>;
}

/**
 * Listing entry from `/company/{typeId}/companies`.
 *
 * The listing carries the rating, the staffing and the financials for every
 * company in the industry, which is why no per-rig profile request is needed: a
 * profile call would fetch a strict subset of what has already been paid for.
 */
export interface CompanySummary {
	id: number;
	name: string;
	rating: number;
	employees?: { hired: number; capacity: number };
	income?: { daily?: number; weekly?: number };
	customers?: { daily?: number; weekly?: number };
}

/** One successfully sampled rig, as measured and as persisted in `topRigs`. */
export interface SampledRig {
	id: number;
	name: string;
	rating: number;
	weeklyIncome: number;
	weeklyCustomers: number;
	dailyIncome: number;
	dailyCustomers: number;
	hired: number;
	capacity: number;
	roleCounts: Record<string, number>;
}

export interface RoleBlueprint {
	roleCounts: Record<string, number>;
	roleShares: Record<string, number>;
}

export interface RosterBenchmarkCapture {
	capturedAt: Date;
	/** Rating band the sample describes. */
	rating: number;
	/** Total same-type companies in the industry listing. */
	fieldSize: number;
	/** Rigs the listing offered. */
	offered: number;
	/** Rigs actually read. */
	sampleSize: number;
	/** Listing entries that could not be read, so the sample's gaps are visible. */
	failedRigIds: number[];
	avgWeeklyRevenue: number;
	avgWeeklyCustomers: number;
	avgHired: number;
	avgCapacity: number;
	roleCounts: Record<string, number>;
	roleShares: Record<string, number>;
	topRigs: SampledRig[];
}

/**
 * Median of a numeric sample.
 *
 * Pure and exported so the aggregation below is testable in isolation. An empty
 * sample is explicitly 0 rather than NaN: a rig with no staff has no share of
 * anything, and NaN would silently poison every downstream figure.
 */
export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Arithmetic mean of a sample; 0 for an empty sample. */
function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Count staff per role name, which is the raw measurement behind a roster. */
function countRoles(
	employees: Array<{ position?: { name?: string } }>,
): Record<string, number> {
	const roleCounts: Record<string, number> = {};
	for (const employee of employees) {
		const role = employee.position?.name;
		if (!role) continue;
		roleCounts[role] = (roleCounts[role] ?? 0) + 1;
	}
	return roleCounts;
}

/** Total staff on a roster: the denominator behind every role share. */
export function totalStaff(roleCounts: Record<string, number>): number {
	return Object.values(roleCounts).reduce((sum, count) => sum + count, 0);
}

/**
 * Aggregate a sample of rigs into a roster blueprint.
 *
 * Both figures are median-of-per-rig values rather than ratios of aggregate
 * totals, because the aggregate is dominated by whichever rig happens to be
 * biggest: a rig with 130 staff next to rigs with 80 would pull every role upward
 * and invent a blueprint no real top rig runs.
 *
 * `roleShares` is the median of each rig's own `count / totalStaff` ratio, not the
 * median count divided by the median staff count. Averaging the ratios is what
 * makes the result scale-invariant, so a blueprint measured from 30-staff rigs can
 * steer a 19-staff rig. A rig missing a role contributes 0 for it, so a role only
 * some rigs staff is measured against the whole sample. Because these are per-role
 * medians, the shares sum to approximately 1 (exactly 1 when the sample is
 * homogeneous), which is why the baseline derivation renormalises.
 */
export function buildRoleBlueprint(rigs: SampledRig[]): RoleBlueprint {
	const roles = new Set<string>();
	for (const rig of rigs) {
		for (const role of Object.keys(rig.roleCounts)) roles.add(role);
	}

	const roleCounts: Record<string, number> = {};
	const roleShares: Record<string, number> = {};

	for (const role of roles) {
		roleCounts[role] = median(rigs.map((rig) => rig.roleCounts[role] ?? 0));
		roleShares[role] = median(
			rigs.map((rig) => {
				const staff = totalStaff(rig.roleCounts);
				return staff > 0 ? (rig.roleCounts[role] ?? 0) / staff : 0;
			}),
		);
	}

	return { roleCounts, roleShares };
}

export interface CaptureRosterBenchmarkInput {
	client: BenchmarkApiClient;
	apiKey: string;
	/** Oil rig company type id in Torn's company listing. */
	companyTypeId?: number;
	/**
	 * How many of the top-rated rigs to sample.
	 *
	 * The medians are only meaningful if the sample is wide enough that one
	 * unusual roster cannot move them, so this is a bound rather than a fixed
	 * size: fewer rigs are sampled when the listing offers fewer.
	 *
	 * COST: one listing request plus ONE request per sampled rig, so the default of
	 * eight is nine requests. Anything that raises this raises the daily API cost
	 * linearly, and the calls go through the shared per-user rate limiter.
	 */
	sampleSize?: number;
	/**
	 * Our own company id.
	 *
	 * NOT used to look our rig up in the listing: the listing is paginated to 100
	 * rows and sorted by rating descending, so a mid-rated rig is never on the page
	 * this module reads. A comparison block that silently produced nothing on every
	 * run was worse than no comparison block. Callers that want our own rig fetch it
	 * themselves.
	 */
	ourCompanyId?: number;
	/** Called once per rig that loaded, for progress reporting. */
	onRigSampled?: (rig: SampledRig) => void;
	/** Injected so tests are deterministic. */
	now?: () => Date;
}

/**
 * Reads the industry listing and measures the top-rated rigs from it.
 *
 * Throws only when the listing itself cannot be read, because that leaves nothing
 * to measure. A single unreadable rig does not fail the capture: the sample is a
 * sample, and the medians stay honest as long as the skip is reported and
 * `sampleSize` reflects what actually loaded.
 */
export async function captureRosterBenchmark(
	input: CaptureRosterBenchmarkInput,
): Promise<RosterBenchmarkCapture> {
	const sampleSizeBound = input.sampleSize ?? 8;
	const companyTypeId = input.companyTypeId ?? 28;
	const now = input.now ?? (() => new Date());

	// A v2 schema path KEY with its parameter passed separately, not an assembled
	// URL. Only `get`-style v2 clients understand the key form, and the assembled
	// form (`/company/28/companies`) is a v1-shaped literal that forces callers onto
	// the legacy raw endpoint.
	const listRes = (await input.client.get("/company/{typeId}/companies", {
		apiKey: input.apiKey,
		pathParams: { typeId: companyTypeId },
	})) as {
		companies?: CompanySummary[];
		_metadata?: { total?: number };
	};

	const allRigs = listRes.companies ?? [];
	if (allRigs.length === 0) {
		throw new Error(
			`Industry listing for company type ${companyTypeId} returned no companies.`,
		);
	}

	// THE LISTING IS PAGINATED. It returns one page of 100 however large `limit` is,
	// and the true industry size is only in `_metadata.total`. Taking
	// `companies.length` as the field size was wrong by a factor of four: this is a
	// DENOMINATOR in the advertising rank step (40% / field size), so understating
	// it overstates what a rank is worth and over-funds the probe - the unsafe
	// direction. `_metadata.total` is authoritative.
	//
	// The listing is also sorted by rating descending, so the first page already
	// contains every top-rated rig; the sample below is therefore a genuine sample
	// of the top band rather than an arbitrary page.
	const declaredTotal = listRes._metadata?.total;
	const fieldSize =
		typeof declaredTotal === "number" && declaredTotal > 0
			? declaredTotal
			: allRigs.length;
	if (typeof declaredTotal !== "number" || declaredTotal <= 0) {
		logger.warn(
			`Listing reported no _metadata.total, so the field size falls back to the ${allRigs.length} companies on the first page and the advertising rank step is overstated.`,
		);
	}

	const topRated = allRigs
		.filter((rig) => rig.rating === Math.max(...allRigs.map((r) => r.rating)))
		.slice(0, sampleSizeBound);

	const topRigs: SampledRig[] = [];
	const failedRigIds: number[] = [];

	for (const rig of topRated) {
		// ONE request per rig, not two. The listing above already carried this rig's
		// rating, staffing and financials, so the only thing still missing is the
		// role breakdown, which lives in its own endpoint. The previous version also
		// fetched `/company/{id}/profile` for every rig - seventeen requests a run
		// for data it already had.
		try {
			const employeesRes = (await input.client.get("/company/{id}/employees", {
				apiKey: input.apiKey,
				pathParams: { id: rig.id },
			})) as { employees?: Array<{ position?: { name?: string } }> };

			const sampled: SampledRig = {
				id: rig.id,
				name: rig.name,
				rating: rig.rating,
				weeklyIncome: rig.income?.weekly ?? 0,
				weeklyCustomers: rig.customers?.weekly ?? 0,
				dailyIncome: rig.income?.daily ?? 0,
				dailyCustomers: rig.customers?.daily ?? 0,
				hired: rig.employees?.hired ?? 0,
				capacity: rig.employees?.capacity ?? 0,
				roleCounts: countRoles(employeesRes.employees ?? []),
			};

			topRigs.push(sampled);
			input.onRigSampled?.(sampled);
		} catch (err) {
			failedRigIds.push(rig.id);
			logger.warn(
				`Could not read rig ${rig.id} (${rig.name}); excluded from the sample: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const { roleCounts, roleShares } = buildRoleBlueprint(topRigs);

	return {
		capturedAt: now(),
		// The sampled rigs share a rating band, so the minimum is the band itself.
		// Taken as a minimum rather than from the first rig so one stale profile
		// cannot mislabel the whole capture.
		rating:
			topRigs.length > 0 ? Math.min(...topRigs.map((rig) => rig.rating)) : 0,
		fieldSize,
		offered: topRated.length,
		sampleSize: topRigs.length,
		failedRigIds,
		avgWeeklyRevenue: mean(topRigs.map((rig) => rig.weeklyIncome)),
		avgWeeklyCustomers: mean(topRigs.map((rig) => rig.weeklyCustomers)),
		avgHired: mean(topRigs.map((rig) => rig.hired)),
		avgCapacity: mean(topRigs.map((rig) => rig.capacity)),
		roleCounts,
		roleShares,
		topRigs,
	};
}

/** Ids are derived from the capture time, so a capture is addressable and stable. */
function benchmarkId(capturedAt: Date): string {
	return `oil_rig_bench_${capturedAt.getTime()}`;
}

/**
 * Persists a capture, append-only.
 *
 * An id already in the table is an earlier capture of the same millisecond, and
 * overwriting it would rewrite measured history.
 */
export async function persistRosterBenchmark(
	capture: RosterBenchmarkCapture,
): Promise<string | undefined> {
	if (capture.sampleSize === 0) {
		// An all-zero row would be worse than no row: the baseline derivation would
		// read it as "top rigs staff nobody" and steer the blueprint accordingly.
		logger.warn(
			"Refusing to persist a capture with no successfully read rigs.",
		);
		return undefined;
	}

	const id = benchmarkId(capture.capturedAt);
	try {
		const { db, oilRigBenchmarks } = await import("../../database");
		await db
			.insert(oilRigBenchmarks)
			.values({
				id,
				capturedAt: capture.capturedAt,
				rating: capture.rating,
				fieldSize: capture.fieldSize,
				sampleSize: capture.sampleSize,
				avgWeeklyRevenue: capture.avgWeeklyRevenue,
				avgWeeklyCustomers: capture.avgWeeklyCustomers,
				avgHired: capture.avgHired,
				avgCapacity: capture.avgCapacity,
				roleCounts: capture.roleCounts,
				roleShares: capture.roleShares,
				topRigs: capture.topRigs,
				createdAt: capture.capturedAt,
			})
			.onConflictDoNothing({ target: oilRigBenchmarks.id });
		return id;
	} catch (err) {
		logger.error(
			`Failed to persist the roster benchmark: ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}

/** One-line summary for logs, used by both the worker and the CLI. */
export function describeRosterBenchmark(
	capture: RosterBenchmarkCapture,
	persistedId?: string,
): string {
	const shareTotal = Object.values(capture.roleShares).reduce(
		(sum, share) => sum + share,
		0,
	);
	const staff = totalStaff(capture.roleCounts);
	return `Captured ${capture.sampleSize}/${capture.offered} top-${capture.rating}★ rigs out of a ${capture.fieldSize}-rig industry${capture.failedRigIds.length > 0 ? ` (${capture.failedRigIds.length} unreadable)` : ""}: median staff ${staff}, role shares summing to ${shareTotal.toFixed(3)}${persistedId ? `, persisted as ${persistedId}` : ""}.`;
}

export interface RefreshRosterBenchmarkInput
	extends CaptureRosterBenchmarkInput {
	/**
	 * Skip the capture when a fresh one already exists.
	 *
	 * The daily tick is the trigger, but it is not guaranteed to fire exactly once:
	 * a restart can re-detect the same log line. Without this guard a re-detected
	 * tick would spend another seventeen API calls re-measuring a number that
	 * changes over weeks.
	 */
	minAgeHours?: number;
	/** Capture regardless of the age of the newest row. */
	force?: boolean;
}

export interface RefreshRosterBenchmarkResult {
	skipped: boolean;
	reason: string;
	capture?: RosterBenchmarkCapture;
	persistedId?: string;
}

/** Whether the newest stored capture is old enough to be worth replacing. */
export function isCaptureStale(
	capturedAt: Date | undefined,
	options: { minAgeHours?: number; now?: Date },
): boolean {
	if (!capturedAt) return true;
	const minAgeHours = options.minAgeHours ?? 20;
	const now = options.now ?? new Date();
	const ageHours = (now.getTime() - capturedAt.getTime()) / 3_600_000;
	return ageHours >= minAgeHours;
}

/**
 * Captures and stores a fresh baseline when the stored one is stale.
 *
 * This is what the daily worker calls. It never throws on a capture failure it
 * can absorb: the caller's real job is the briefing, and a stale baseline is a
 * far smaller problem than a briefing that does not run.
 */
export async function refreshRosterBenchmark(
	input: RefreshRosterBenchmarkInput,
): Promise<RefreshRosterBenchmarkResult> {
	const { loadLatestRosterBaselineRow } = await import("./oil-rig-brief-store");

	if (!input.force) {
		const latest = await loadLatestRosterBaselineRow();
		if (
			!isCaptureStale(latest?.capturedAt, { minAgeHours: input.minAgeHours })
		) {
			return {
				skipped: true,
				reason: `Newest capture is ${((Date.now() - (latest?.capturedAt?.getTime() ?? 0)) / 3_600_000).toFixed(1)}h old, inside the ${input.minAgeHours ?? 20}h refresh window.`,
			};
		}
	}

	try {
		const capture = await captureRosterBenchmark(input);
		const persistedId = await persistRosterBenchmark(capture);
		return {
			skipped: false,
			reason: describeRosterBenchmark(capture, persistedId),
			capture,
			persistedId,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		logger.warn(
			`Roster benchmark refresh failed; the existing baseline is kept: ${reason}`,
		);
		return { skipped: true, reason: `Capture failed: ${reason}` };
	}
}
