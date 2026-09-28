import { TornApiClient } from "../../packages/torn-api";
import { Logger } from "../../packages/utils";

const logger = new Logger("CompetitorBenchmark");

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
	logger.info(`Found ${allRigs.length} total Oil Rigs.`);

	// Sort by rating descending
	const tenStarRigs = allRigs.filter((c) => c.rating === 10);
	const nineStarRigs = allRigs.filter((c) => c.rating === 9);

	logger.info(
		`Industry Composition: ${tenStarRigs.length} 10★ Rigs, ${nineStarRigs.length} 9★ Rigs.`,
	);

	// Benchmark top 4 10* rigs + Succession Oil (id: 90288)
	const sampleRigs = [...tenStarRigs.slice(0, 4)];
	const ourRigSummary = allRigs.find((r) => r.id === 90288);

	console.log(
		"\n==========================================================================================",
	);
	console.log("                       TOP 10★ OIL RIG BENCHMARKING REPORT");
	console.log(
		"==========================================================================================\n",
	);

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
			const roleCounts: Record<string, number> = {};
			for (const emp of emps) {
				const role = emp.position.name;
				roleCounts[role] = (roleCounts[role] ?? 0) + 1;
			}

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
		} catch (err) {
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

		const roleCounts: Record<string, number> = {};
		for (const emp of ourEmps.employees ?? []) {
			const role = emp.position.name;
			roleCounts[role] = (roleCounts[role] ?? 0) + 1;
		}

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
}

void main();
