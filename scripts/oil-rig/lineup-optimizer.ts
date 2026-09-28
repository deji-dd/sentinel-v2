import { Logger, loadLatestSnapshotFromDb } from "../../packages/utils";
import { calcRoleFit, OIL_RIG_ROLES } from "./role-audit";

const logger = new Logger("LineupOptimizer");

interface Employee {
	id: number;
	name: string;
	currentPosition: string;
	daysInCompany: number;
	wage: number;
	stats: {
		manual_labor: number;
		intelligence: number;
		endurance: number;
	};
	effectiveness: {
		working_stats: number;
		settled_in: number;
		director_education: number;
		addiction: number;
		inactivity: number;
		total: number;
	};
}

async function main(): Promise<void> {
	const snapshot = await loadLatestSnapshotFromDb();
	if (!snapshot) {
		logger.error("No oil rig snapshot found in database.");
		process.exit(1);
	}

	const employees: Employee[] = (snapshot.employees ?? []).map((e) => ({
		id: e.id,
		name: e.name,
		currentPosition: e.position?.name ?? "Unassigned",
		daysInCompany: e.days_in_company,
		wage: e.wage,
		stats: e.stats,
		effectiveness: e.effectiveness,
	}));

	logger.info(
		"==========================================================================================",
	);
	logger.info(
		`             OPTIMAL LINEUP MODEL: ${snapshot.profile.name} (${snapshot.profile.rating}★)`,
	);
	logger.info(
		"==========================================================================================",
	);

	// Recommended Role Target Counts for 17 Active Staff:
	// - 1 Inspector (Trainer) -> Generates trains daily for company
	// - 2 Drillers (Supervisors) -> Ramirez (anchor) + ExpiredCheese (co-supervisor)
	// - 2 Sales Executives -> HeavyBrony + chamaleon (clears barrel stock)
	// - 1 Secretary -> Analytics & office support
	// - 2 Roughnecks (Cleaners) -> Keeps Environment ~100% (prevents 33% revenue penalty)
	// - 2 Derrick Hands -> Impaler (powerhouse) + Hog
	// - 2 Motor Hands -> 2you_49 + N4iled
	// - Remaining 5 workers: Secondary/filler roles while being trained or evaluated for firing

	interface ProposedAssignment {
		employee: Employee;
		currentRole: string;
		newRole: string;
		currentWS: number;
		newWS: number;
		netDelta: number;
		totalEffEst: number;
		rolePerk: string;
		action: "MOVE" | "STAY" | "CONSIDER_FIRE";
	}

	const assignments: ProposedAssignment[] = [
		// 1. Core Specialists
		{
			name: "HT-IngCognito",
			newRole: "Inspector",
			perk: "Trainer (generates ~1.3 trains/day)",
		},
		{
			name: "Ramirez",
			newRole: "Driller",
			perk: "Drill Supervisor (378k MAN anchor)",
		},
		{
			name: "ExpiredCheese",
			newRole: "Driller",
			perk: "Drill Supervisor (200k MAN)",
		},
		{
			name: "Impaler",
			newRole: "Derrick Hand",
			perk: "Platform Powerhouse (391k MAN)",
		},
		{
			name: "2you_49",
			newRole: "Motor Hand",
			perk: "Engine Maintenance (123k MAN)",
		},
		{
			name: "HeavyBrony",
			newRole: "Sales Executive",
			perk: "Sales Deal Closer",
		},
		{
			name: "chamaleon",
			newRole: "Sales Executive",
			perk: "Sales Deal Closer (131k INT)",
		},
		{
			name: "braKOOM",
			newRole: "Secretary",
			perk: "Secretary Analytics",
		},
		{
			name: "Hog",
			newRole: "Roughneck",
			perk: "Cleaner (Environment Booster)",
		},
		{
			name: "Starrows",
			newRole: "Roughneck",
			perk: "Cleaner (Environment Booster)",
		},
		// Low-stat support / candidates
		{
			name: "Mattfridge",
			newRole: "Motor Hand",
			perk: "Engine Helper",
		},
		{
			name: "N4iled",
			newRole: "Derrick Hand",
			perk: "Platform Helper",
		},
		{
			name: "3MBER",
			newRole: "Roughneck",
			perk: "Cleaner Trainee",
		},
		{
			name: "RaeRee",
			newRole: "Motor Hand",
			perk: "Trainee",
		},
		{
			name: "ppbro",
			newRole: "Motor Hand",
			perk: "Trainee (0/10 settled)",
		},
		{
			name: "vbprog",
			newRole: "Motor Hand",
			perk: "Trainee",
		},
		{
			name: "_Ashcrow_",
			newRole: "Roughneck",
			perk: "Trainee",
		},
	].map((item) => {
		const emp = employees.find((e) => e.name === item.name);
		if (!emp) throw new Error(`Missing ${item.name}`);

		const roleDef = OIL_RIG_ROLES[item.newRole];
		if (!roleDef) throw new Error(`Missing role ${item.newRole}`);

		const curRoleDef = OIL_RIG_ROLES[emp.currentPosition];
		const currentWS = curRoleDef
			? calcRoleFit(emp.stats, curRoleDef)
			: emp.effectiveness.working_stats;
		const newWS = calcRoleFit(emp.stats, roleDef);
		const netDelta = newWS - currentWS;

		const totalEffEst =
			newWS +
			emp.effectiveness.settled_in +
			emp.effectiveness.director_education +
			emp.effectiveness.addiction +
			emp.effectiveness.inactivity;

		let action: "MOVE" | "STAY" | "CONSIDER_FIRE" = "STAY";
		if (totalEffEst < 40 && emp.stats.manual_labor < 15_000) {
			action = "CONSIDER_FIRE";
		} else if (emp.currentPosition !== item.newRole) {
			action = "MOVE";
		}

		return {
			employee: emp,
			currentRole: emp.currentPosition,
			newRole: item.newRole,
			currentWS,
			newWS,
			netDelta,
			totalEffEst,
			rolePerk: item.perk,
			action,
		};
	});

	console.log("\n--- PROPOSED LINEUP ALLOCATION ---");
	console.log(
		"Employee".padEnd(16) +
			"Current Role".padEnd(18) +
			"➔ Proposed Role".padEnd(20) +
			"Score".padEnd(10) +
			"EstEff".padEnd(9) +
			"Action".padEnd(16) +
			"Perk / Function",
	);
	console.log("-".repeat(110));

	for (const a of assignments) {
		const scoreDiff = a.netDelta >= 0 ? `+${a.netDelta}` : `${a.netDelta}`;
		const scoreDisplay = `${a.newWS} (${scoreDiff})`;
		const actionDisplay =
			a.action === "MOVE"
				? "⚡ REASSIGN"
				: a.action === "CONSIDER_FIRE"
					? "⚠️ REPLACE"
					: "✓ KEEP";

		console.log(
			a.employee.name.padEnd(16) +
				a.currentRole.padEnd(18) +
				`➔ ${a.newRole}`.padEnd(20) +
				scoreDisplay.padEnd(10) +
				String(a.totalEffEst).padEnd(9) +
				actionDisplay.padEnd(16) +
				a.rolePerk,
		);
	}
	console.log("-".repeat(110));

	// Aggregated Metrics
	const _currentAvgEff = snapshot.profile.efficiency;
	const currentTotalWS = employees.reduce(
		(sum, e) => sum + e.effectiveness.working_stats,
		0,
	);

	const proposedTotalWS = assignments.reduce((sum, a) => sum + a.newWS, 0);
	const netCompanyGain = proposedTotalWS - currentTotalWS;

	console.log("\n=================== NET LINEUP IMPACT ===================");
	console.log(
		`• Total Working Stats Efficiency: ${currentTotalWS} ➔ ${proposedTotalWS} (Net Gain: +${netCompanyGain} pts)`,
	);
	console.log("• Key Role Upgrades:");
	console.log(
		"   1. Driller (Crucial Supervisor): Ramirez (102 score) + ExpiredCheese (94 score)",
	);
	console.log(
		"   2. Inspector (Daily Trains): HT-IngCognito unlocked (+1.3 trains/day to develop team)",
	);
	console.log(
		"   3. Environment (Cleaners): Hog & Starrows locked to Roughneck, ensuring 100% environment",
	);
	console.log("   4. Sales: chamaleon & HeavyBrony clear barrel inventory");

	console.log(
		"\n=================== HIRING & FIRING AUDIT ===================",
	);
	const fireCandidates = assignments.filter(
		(a) => a.action === "CONSIDER_FIRE",
	);
	console.log(
		`⚠️ CANDIDATES RECOMMENDED FOR REPLACEMENT (${fireCandidates.length} staff):`,
	);
	for (const c of fireCandidates) {
		console.log(
			`   • ${c.employee.name.padEnd(12)}: MAN ${c.employee.stats.manual_labor.toLocaleString()} | INT ${c.employee.stats.intelligence.toLocaleString()} | END ${c.employee.stats.endurance.toLocaleString()} (Total Eff: ${c.totalEffEst})`,
		);
	}
	console.log(
		"\n   💡 Why replace these? In an Oil Rig, positions require 75k - 225k stats.",
	);
	console.log(
		"   A worker with 5k stats contributes ~3 efficiency and takes months of director trains to fix.",
	);
	console.log(
		"   Hiring an employee off the job board with 40k+ stats will match their output on Day 1",
	);
	console.log("   and achieve 80+ efficiency once settled.");
	console.log("=========================================================\n");
}

void main();
