import { Logger, loadLatestSnapshotFromDb } from "../packages/utils";

const logger = new Logger("OilRigAudit");

export interface RoleDef {
	title: string;
	primaryStat: "manual_labor" | "intelligence" | "endurance";
	primaryReq: number;
	secondaryStat: "manual_labor" | "intelligence" | "endurance";
	secondaryReq: number;
	special: string;
	description: string;
}

export const OIL_RIG_ROLES: Record<string, RoleDef> = {
	Driller: {
		title: "Driller",
		primaryStat: "manual_labor",
		primaryReq: 150_000,
		secondaryStat: "intelligence",
		secondaryReq: 75_000,
		special: "Supervisor (Required)",
		description:
			"Required to supervise drilling. Drills will not function without a driller.",
	},
	Roughneck: {
		title: "Roughneck",
		primaryStat: "manual_labor",
		primaryReq: 75_000,
		secondaryStat: "endurance",
		secondaryReq: 37_500,
		special: "Cleaner",
		description:
			"Improves Environment score (prevents up to 33% revenue loss).",
	},
	"Derrick Hand": {
		title: "Derrick Hand",
		primaryStat: "manual_labor",
		primaryReq: 94_000,
		secondaryStat: "endurance",
		secondaryReq: 47_000,
		special: "None",
		description: "Works on drilling platform to steady pipes.",
	},
	Secretary: {
		title: "Secretary",
		primaryStat: "endurance",
		primaryReq: 112_500,
		secondaryStat: "intelligence",
		secondaryReq: 56_250,
		special: "Secretary",
		description:
			"Answers calls, finalizes big deals, provides detailed staff analytics.",
	},
	Inspector: {
		title: "Inspector",
		primaryStat: "intelligence",
		primaryReq: 225_000,
		secondaryStat: "endurance",
		secondaryReq: 112_500,
		special: "Trainer",
		description: "Generates 0.1 trains per 10 effectiveness to train staff.",
	},
	"Sales Executive": {
		title: "Sales Executive",
		primaryStat: "intelligence",
		primaryReq: 131_500,
		secondaryStat: "endurance",
		secondaryReq: 65_750,
		special: "Sales",
		description: "Sells crude oil to refineries to clear barrel stock.",
	},
	"Motor Hand": {
		title: "Motor Hand",
		primaryStat: "manual_labor",
		primaryReq: 112_500,
		secondaryStat: "intelligence",
		secondaryReq: 56_250,
		special: "None",
		description: "Maintains and repairs engines and drilling machinery.",
	},
};

/**
 * Calculates raw working stats efficiency based on Torn formula:
 * FLOOR(MIN(45, (45 / $required) * $stat) + MAX(0, (5 * LOG($stat / $required, 2))))
 */
function calcStatScore(stat: number, req: number): number {
	const linear = Math.min(45, (45 / req) * stat);
	const logBonus = stat > req ? 5 * Math.log2(stat / req) : 0;
	return linear + logBonus;
}

export function calcRoleFit(
	stats: { manual_labor: number; intelligence: number; endurance: number },
	role: RoleDef,
): number {
	const pri = calcStatScore(stats[role.primaryStat], role.primaryReq);
	const sec = calcStatScore(stats[role.secondaryStat], role.secondaryReq);
	return Math.floor(pri + sec);
}

async function main(): Promise<void> {
	const snapshot = await loadLatestSnapshotFromDb();
	if (!snapshot) {
		logger.error("No oil rig snapshot found in database.");
		process.exit(1);
	}

	const employees = snapshot.employees ?? [];

	logger.info(
		"==========================================================================================",
	);
	logger.info(
		`             OIL RIG ROLE AUDIT: ${snapshot.profile.name} (${snapshot.profile.rating}★)`,
	);
	logger.info(
		"==========================================================================================",
	);

	const roleNames = Object.keys(OIL_RIG_ROLES);

	interface AuditResult {
		name: string;
		currentRole: string;
		currentEff: number;
		bestRole: string;
		bestScore: number;
		scores: Record<string, number>;
		addiction: number;
	}

	const results: AuditResult[] = [];

	for (const emp of employees) {
		const scores: Record<string, number> = {};
		let bestRole = "";
		let bestScore = -1;

		for (const roleName of roleNames) {
			const roleDef = OIL_RIG_ROLES[roleName];
			if (!roleDef) continue;
			const score = calcRoleFit(emp.stats, roleDef);
			scores[roleName] = score;

			if (score > bestScore) {
				bestScore = score;
				bestRole = roleName;
			}
		}

		results.push({
			name: emp.name,
			currentRole: emp.position?.name ?? "Unassigned",
			currentEff: emp.effectiveness.working_stats,
			bestRole,
			bestScore,
			scores,
			addiction: emp.effectiveness.addiction ?? 0,
		});
	}

	// Print summary table
	console.log("\n--- EMPLOYEE ROLE FIT AUDIT ---");
	console.log(
		"Employee".padEnd(16) +
			"Current Role".padEnd(18) +
			"CurScore".padEnd(10) +
			"Best Role".padEnd(18) +
			"BestScore".padEnd(11) +
			"Delta".padEnd(8) +
			"Addiction",
	);
	console.log("-".repeat(95));

	for (const res of results) {
		const delta = res.bestScore - (res.scores[res.currentRole] ?? 0);
		const deltaStr = delta > 0 ? `+${delta}` : "0";
		const addictionStr = res.addiction < 0 ? `${res.addiction} pts` : "Clean";

		console.log(
			res.name.padEnd(16) +
				res.currentRole.padEnd(18) +
				String(res.scores[res.currentRole] ?? 0).padEnd(10) +
				res.bestRole.padEnd(18) +
				String(res.bestScore).padEnd(11) +
				deltaStr.padEnd(8) +
				addictionStr,
		);
	}

	console.log("-".repeat(95));

	// Strategic insights
	console.log("\n=================== STRATEGIC INSIGHTS ===================");

	// 1. Check for Ramirez
	const ramirez = results.find((r) => r.name === "Ramirez");
	if (ramirez) {
		console.log("\n💡 HIGH-VALUE REALIGNMENT: Ramirez");
		console.log(
			`   Currently: Sales Executive (Score: ${ramirez.scores["Sales Executive"]})`,
		);
		console.log(
			`   Optimal: Driller (Score: ${ramirez.scores.Driller}) or Derrick Hand (${ramirez.scores["Derrick Hand"]})`,
		);
		console.log(
			"   Why: Ramirez has 378k MAN and 163k INT. He can easily replace your weakest driller and anchor rig production!",
		);
	}

	// 2. Check for Inspector / Trainer role
	const ht = results.find((r) => r.name === "HT-IngCognito");
	if (ht) {
		console.log("\n💡 TRAINING ENGINE: HT-IngCognito");
		console.log(
			`   Stats: 539k INT / 266k END. Score as Inspector: ${ht.scores.Inspector}`,
		);
		console.log(
			"   Why: If set to Inspector, HT will act as a high-potency Trainer, generating trains daily to boost your 6 low-stat workers!",
		);
	}

	// 3. Low-Stat Employee Summary
	const lowStatWorkers = results.filter(
		(r) => (r.scores[r.currentRole] ?? 0) < 50,
	);
	console.log(
		`\n⚠️ DRAG ALERT: ${lowStatWorkers.length} employees have <50 working stat effectiveness:`,
	);
	for (const low of lowStatWorkers) {
		console.log(
			`   • ${low.name} (${low.currentRole}): score ${low.scores[low.currentRole]}`,
		);
	}
	console.log(
		"   These 6 workers are heavily pulling down company efficiency (currently 92%).",
	);

	console.log("==========================================================\n");
}

void main();
