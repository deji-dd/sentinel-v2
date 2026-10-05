import { closeDatabase } from "../../packages/database";
import { TornApiClient } from "../../packages/torn-api";
import {
	type BenchmarkApiClient,
	captureRosterBenchmark,
	describeRosterBenchmark,
	persistRosterBenchmark,
} from "../../packages/utils";

/**
 * CLI wrapper over the shared roster benchmark.
 *
 * The capture, aggregation and persistence live in `@sentinel/utils` so the
 * scheduler can run exactly the same measurement on its daily tick. This script
 * exists for the two things a worker should not do: print a human-readable report,
 * and let a person run the capture on demand.
 *
 *   bun run scripts/oil-rig/competitor-benchmark.ts
 */
const OUR_COMPANY_ID = 90288;
const COMPANY_TYPE_ID = 28;

function printReport(
	capture: Awaited<ReturnType<typeof captureRosterBenchmark>>,
	ours:
		| { name: string; weeklyIncome: number; roleCounts: Record<string, number> }
		| undefined,
): void {
	const line = "=".repeat(88);
	console.log(`\n${line}`);
	console.log("                       OIL RIG INDUSTRY BENCHMARK");
	console.log(line);

	for (const rig of capture.topRigs) {
		console.log(`\n🏆 [${rig.rating}★] ${rig.name} (ID: ${rig.id})`);
		console.log(
			`   Weekly Revenue: $${rig.weeklyIncome.toLocaleString()} ($${rig.dailyIncome.toLocaleString()}/day)`,
		);
		console.log(
			`   Weekly Customers: ${rig.weeklyCustomers} (${rig.dailyCustomers}/day)`,
		);
		console.log(`   Staff: ${rig.hired}/${rig.capacity}`);
		console.log("   Role Breakdown:");
		for (const [role, count] of Object.entries(rig.roleCounts).sort(
			(a, b) => b[1] - a[1],
		)) {
			console.log(`      • ${role.padEnd(18)}: ${count}`);
		}
	}

	if (ours) {
		console.log(`\n🎯 [CURRENT TARGET] ${ours.name} (ID: ${OUR_COMPANY_ID})`);
		console.log(`   Weekly Revenue: $${ours.weeklyIncome.toLocaleString()}`);
		console.log("   Role Breakdown:");
		for (const [role, count] of Object.entries(ours.roleCounts).sort(
			(a, b) => b[1] - a[1],
		)) {
			console.log(`      • ${role.padEnd(18)}: ${count}`);
		}
	}

	console.log(`\n${line}`);
	console.log(`Median blueprint across ${capture.sampleSize} sampled rig(s):`);
	for (const [role, count] of Object.entries(capture.roleCounts).sort(
		(a, b) => b[1] - a[1],
	)) {
		const share = ((capture.roleShares[role] ?? 0) * 100).toFixed(1);
		console.log(`   ${role.padEnd(18)}: ${count} median (${share}% of staff)`);
	}
	console.log(
		`\nIndustry size: ${capture.fieldSize} rigs (from the listing's _metadata.total, not the page size).`,
	);
	if (capture.failedRigIds.length > 0) {
		console.log(
			`Unreadable (excluded from the medians): ${capture.failedRigIds.join(", ")}`,
		);
	}
	console.log(`${line}\n`);
}

/**
 * Our own rig, for the side-by-side block.
 *
 * Two requests, and CLI-only: this is context for a person reading the report,
 * not an input to the blueprint, and the scheduled worker does not pay for it.
 */
async function readOurRig(
	client: BenchmarkApiClient,
	apiKey: string,
): Promise<
	| { name: string; weeklyIncome: number; roleCounts: Record<string, number> }
	| undefined
> {
	try {
		const profile = (await client.get("/company/{id}/profile", {
			apiKey,
			pathParams: { id: OUR_COMPANY_ID },
		})) as { profile?: { name?: string; income?: { weekly?: number } } };
		const employees = (await client.get("/company/{id}/employees", {
			apiKey,
			pathParams: { id: OUR_COMPANY_ID },
		})) as { employees?: Array<{ position?: { name?: string } }> };
		if (!profile.profile?.name) return undefined;

		const roleCounts: Record<string, number> = {};
		for (const employee of employees.employees ?? []) {
			const role = employee.position?.name;
			if (role) roleCounts[role] = (roleCounts[role] ?? 0) + 1;
		}
		return {
			name: profile.profile.name,
			weeklyIncome: profile.profile.income?.weekly ?? 0,
			roleCounts,
		};
	} catch (err) {
		console.warn(
			`Could not load our own rig for comparison: ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}

async function main(): Promise<void> {
	const apiKey = process.env.TORN_API_KEY;
	if (!apiKey) {
		console.error("No Torn API key found (TORN_API_KEY).");
		process.exitCode = 1;
		return;
	}

	// Deliberately unthrottled: a hand-run script issues nine requests once and
	// exits, and there is no shared budget for it to police. The scheduler's daily
	// refresh is the path that has to respect the limiter, because it runs
	// alongside every other worker on the same key.
	const client = new TornApiClient();
	const adapter: BenchmarkApiClient = {
		get: (path, options) => client.get(path, options) as Promise<unknown>,
	};

	try {
		const capture = await captureRosterBenchmark({
			client: adapter,
			apiKey,
			companyTypeId: COMPANY_TYPE_ID,
			ourCompanyId: OUR_COMPANY_ID,
		});
		// Our own rig is fetched explicitly. It cannot come from the listing: that is
		// paginated to 100 rows sorted by rating descending, and a mid-rated rig is
		// never on the page the capture reads.
		const ours = await readOurRig(adapter, apiKey);

		console.log(
			`Read ${capture.offered} rig(s) in ${capture.offered + 1} API request(s)${ours ? ", plus 2 for our own rig" : ""}.`,
		);

		printReport(capture, ours);

		if (capture.sampleSize === 0) {
			console.warn(
				"No rigs could be read, so nothing was persisted (an all-zero row would be worse than no row).",
			);
			return;
		}

		const persistedId = await persistRosterBenchmark(capture);
		console.log(describeRosterBenchmark(capture, persistedId));
	} catch (err) {
		console.error(
			`Benchmark failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exitCode = 1;
	} finally {
		// The pool is created with `idle_timeout: 0` (see `createSqlClient`), so it
		// holds its socket open forever: a one-shot script has to close it or the
		// process hangs after the insert instead of returning to the shell.
		await closeDatabase();
	}
}

void main();
