import { closeDatabase, db, oilRigBenchmarks } from "../../packages/database";
import { TornApiClient } from "../../packages/torn-api";
import { Logger } from "../../packages/utils";

const logger = new Logger("CompetitorBenchmark");

/**
 * How many of the top-rated rigs to sample.
 *
 * The medians below are only meaningful if the sample is wide enough that one
 * unusual roster cannot move them, so this is a bound on the sample rather than
 * a fixed size: fewer rigs are sampled when the listing has fewer to offer.
 */
const SAMPLE_SIZE = 8;

interface CompanySummary {
	id: number;
	name: string;
	rating: number;
	employees: { hired: number; capacity: number };
}

interface CompanyProfileDetail {
	id: number;
	name: string;
	rating: number;
	income: { daily: number; weekly: number };
	customers: { daily: number; weekly: number };
	employees: { hired: number; capacity: number };
}

interface PublicEmployee {
	id: number;
	name: string;
	position: { id: number; name: string };
	days_in_company: number;
}

/** One successfully sampled rig, as measured and as persisted in `topRigs`. */
interface SampledRig {
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

interface RoleBlueprint {
	roleCounts: Record<string, number>;
	roleShares: Record<string, number>;
}

/**
 * Median of a numeric sample.
 *
 * Pure and exported so the aggregation below is testable in isolation, and used
 * for every median in this file. An empty sample is explicitly 0 rather than
 * NaN: a rig with no staff has no share of anything, and a sample with no rigs
 * has no medians at all - NaN would silently poison every downstream figure.
 */
export function median(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) {
		return sorted[mid] ?? 0;
	}

	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Arithmetic mean of a sample; 0 for an empty sample. */
function mean(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}

	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Count staff per role name, which is the raw measurement behind a roster. */
function countRoles(employees: PublicEmployee[]): Record<string, number> {
	const roleCounts: Record<string, number> = {};
	for (const emp of employees) {
		const role = emp.position.name;
		roleCounts[role] = (roleCounts[role] ?? 0) + 1;
	}
	return roleCounts;
}

/** Total staff on a roster: the denominator behind every role share. */
function totalStaff(roleCounts: Record<string, number>): number {
	return Object.values(roleCounts).reduce((sum, count) => sum + count, 0);
}

/**
 * Aggregate a sample of rigs into a roster blueprint.
 *
 * Both figures are median-of-per-rig values rather than ratios of aggregate
 * totals, because the aggregate is dominated by whichever rig happens to be
 * biggest. A rig with 130 staff next to rigs with 80 would otherwise pull every
 * single role upward and invent a blueprint no real top rig actually runs.
 *
 * `roleShares` is the median of each rig's own `count / totalStaff` ratio, not
 * the median count divided by the median staff count. Averaging the ratios
 * instead of the counts is what makes the result scale-invariant. A rig with no
 * staff contributes a 0 share and a 0 count for every role it is missing, so a
 * role that only some rigs staff is measured against the whole sample rather
 * than only against the rigs that happen to staff it. Because these are per-role
 * medians the shares sum to approximately 1 (exactly 1 when the sampled rosters
 * are homogeneous).
 */
export function buildRoleBlueprint(rigs: SampledRig[]): RoleBlueprint {
	const roles = new Set<string>();
	for (const rig of rigs) {
		for (const role of Object.keys(rig.roleCounts)) {
			roles.add(role);
		}
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

async function main(): Promise<void> {
	const apiKey = process.env.TORN_API_KEY;
	if (!apiKey) {
		logger.error("No Torn API key found.");
		process.exit(1);
	}

	const client = new TornApiClient();
	logger.info("Fetching all Oil Rigs (Type 28)...");

	const listRes = (await client.get("/company/28/companies", {
		apiKey,
	})) as { companies: CompanySummary[] };

	const allRigs = listRes.companies ?? [];
	// `fieldSize` is the size of the industry, so it is taken from the complete
	// listing - never from the bounded sample below, which is a subset by design.
	const fieldSize = allRigs.length;
	logger.info(`Found ${fieldSize} total Oil Rigs.`);

	// Sort by rating descending
	const tenStarRigs = allRigs.filter((c) => c.rating === 10);
	const nineStarRigs = allRigs.filter((c) => c.rating === 9);

	logger.info(
		`Industry Composition: ${tenStarRigs.length} 10★ Rigs, ${nineStarRigs.length} 9★ Rigs.`,
	);

	// Benchmark the top-rated rigs + Succession Oil (id: 90288)
	const sampleRigs = tenStarRigs.slice(0, SAMPLE_SIZE);
	const ourRigSummary = allRigs.find((r) => r.id === 90288);

	console.log(
		"\n==========================================================================================",
	);
	console.log("                       TOP 10★ OIL RIG BENCHMARKING REPORT");
	console.log(
		"==========================================================================================\n",
	);

	const sampled: SampledRig[] = [];

	for (const rig of sampleRigs) {
		try {
			const profileRes = (await client.get("/company/{id}/profile", {
				apiKey,
				pathParams: { id: rig.id },
			})) as { profile: CompanyProfileDetail };

			const empRes = (await client.get("/company/{id}/employees", {
				apiKey,
				pathParams: { id: rig.id },
			})) as { employees: PublicEmployee[] };

			const prof = profileRes.profile;
			const emps = empRes.employees ?? [];

			// Count positions
			const roleCounts = countRoles(emps);

			console.log(`🏆 [10★] ${prof.name} (ID: ${prof.id})`);
			console.log(
				`   Weekly Revenue: $${prof.income.weekly.toLocaleString()} ($${prof.income.daily.toLocaleString()}/day)`,
			);
			console.log(
				`   Weekly Customers: ${prof.customers.weekly} (${prof.customers.daily}/day)`,
			);
			console.log(
				`   Staff Capacity: ${prof.employees.hired}/${prof.employees.capacity} employees`,
			);
			console.log("   Role Breakdown:");
			for (const [role, count] of Object.entries(roleCounts).sort(
				(a, b) => b[1] - a[1],
			)) {
				console.log(`      • ${role.padEnd(18)}: ${count}`);
			}
			console.log("-".repeat(80));

			sampled.push({
				id: prof.id,
				name: prof.name,
				rating: prof.rating,
				weeklyIncome: prof.income.weekly,
				weeklyCustomers: prof.customers.weekly,
				dailyIncome: prof.income.daily,
				dailyCustomers: prof.customers.daily,
				hired: prof.employees.hired,
				capacity: prof.employees.capacity,
				roleCounts,
			});
		} catch (err) {
			// One unreadable rig must not cost the whole capture: the sample is a
			// sample, and the medians stay honest as long as the skipped rig is
			// reported and `sampleSize` reflects what was actually loaded.
			logger.warn(`Could not load details for rig ${rig.id}: ${err}`);
		}
	}

	// Now show Succession Oil for direct side-by-side comparison
	if (ourRigSummary) {
		const ourProf = (await client.get("/company/{id}/profile", {
			apiKey,
			pathParams: { id: 90288 },
		})) as { profile: CompanyProfileDetail };

		const ourEmps = (await client.get("/company/{id}/employees", {
			apiKey,
			pathParams: { id: 90288 },
		})) as { employees: PublicEmployee[] };

		const roleCounts = countRoles(ourEmps.employees ?? []);

		console.log(`\n🎯 [4★ CURRENT TARGET] ${ourProf.profile.name} (ID: 90288)`);
		console.log(
			`   Weekly Revenue: $${ourProf.profile.income.weekly.toLocaleString()} ($${ourProf.profile.income.daily.toLocaleString()}/day)`,
		);
		console.log(
			`   Weekly Customers: ${ourProf.profile.customers.weekly} (${ourProf.profile.customers.daily}/day)`,
		);
		console.log(
			`   Staff Capacity: ${ourProf.profile.employees.hired}/${ourProf.profile.employees.capacity} employees`,
		);
		console.log("   Role Breakdown:");
		for (const [role, count] of Object.entries(roleCounts).sort(
			(a, b) => b[1] - a[1],
		)) {
			console.log(`      • ${role.padEnd(18)}: ${count}`);
		}
		console.log(
			"==========================================================================================\n",
		);
	}

	// Persist the measured baseline now that the report has been printed.
	if (sampled.length === 0) {
		logger.warn(
			"No rigs loaded successfully, skipping benchmark persistence (an all-zero row would be worse than no row).",
		);
		await closeDatabase();
		return;
	}

	const { roleCounts, roleShares } = buildRoleBlueprint(sampled);
	const shareTotal = Object.values(roleShares).reduce(
		(sum, share) => sum + share,
		0,
	);

	// The sampled rigs are all in the same rating band, so the lowest value is
	// the band itself. Taken as a minimum rather than from the first rig so a
	// single stale profile cannot mislabel the whole capture.
	const rating = Math.min(...sampled.map((rig) => rig.rating));

	const capturedAt = new Date();
	const benchmarkId = `oil_rig_bench_${Date.now()}`;

	try {
		await db
			.insert(oilRigBenchmarks)
			.values({
				id: benchmarkId,
				capturedAt,
				rating,
				fieldSize,
				sampleSize: sampled.length,
				avgWeeklyRevenue: mean(sampled.map((rig) => rig.weeklyIncome)),
				avgWeeklyCustomers: mean(sampled.map((rig) => rig.weeklyCustomers)),
				avgHired: mean(sampled.map((rig) => rig.hired)),
				avgCapacity: mean(sampled.map((rig) => rig.capacity)),
				roleCounts,
				roleShares,
				topRigs: sampled,
				createdAt: capturedAt,
			})
			// Captures are append-only: an id already in the table is an earlier
			// capture, and overwriting it would rewrite measured history.
			.onConflictDoNothing({ target: oilRigBenchmarks.id });

		logger.info(
			`Benchmark ${benchmarkId} persisted: ${sampled.length}/${fieldSize} rigs sampled at ${rating}★, median staff ${Object.values(roleCounts).reduce((sum, count) => sum + count, 0)}, role shares summing to ${shareTotal.toFixed(3)}.`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to persist competitor benchmark: ${message}`);
		process.exitCode = 1;
	}

	// The pool is created with `idle_timeout: 0` (see `createSqlClient`), so it
	// holds its socket open forever: a one-shot script has to close it or the
	// process hangs after the insert instead of returning to the shell.
	await closeDatabase();
}

void main();
