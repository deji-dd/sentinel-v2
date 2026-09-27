export interface RoleDef {
	title: string;
	primaryStat: "manual_labor" | "intelligence" | "endurance";
	primaryReq: number;
	secondaryStat: "manual_labor" | "intelligence" | "endurance";
	secondaryReq: number;
	special: string;
	description: string;
}

export type OilRigRoleName =
	| "Driller"
	| "Roughneck"
	| "Derrick Hand"
	| "Secretary"
	| "Inspector"
	| "Sales Executive"
	| "Motor Hand";

export const OIL_RIG_ROLES: Record<OilRigRoleName, RoleDef> = {
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

export interface EmployeeData {
	id?: number;
	name: string;
	position?: { id?: number; name?: string } | null;
	stats: {
		manual_labor: number;
		intelligence: number;
		endurance: number;
	};
	effectiveness: {
		working_stats?: number;
		settled_in?: number;
		addiction?: number;
		inactivity?: number;
		total?: number;
	};
}

export function calcStatScore(stat: number, req: number): number {
	const linear = Math.min(45, (45 * stat) / req);
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

/**
 * Maps total staff count to target role counts based on the 10★ Oil Rig blueprint
 * (Benchmark: 8 Driller, 7 Sales, 6 Roughneck, 4 Derrick, 3 Motor, 2 Secretary).
 */
export function getOptimalRoleQuotas(
	staffCount: number,
): Record<string, number> {
	if (staffCount <= 0) return {};
	if (staffCount <= 12) {
		return {
			Driller: Math.max(1, Math.round(staffCount * 0.35)),
			"Sales Executive": Math.max(1, Math.round(staffCount * 0.25)),
			Roughneck: Math.max(1, Math.round(staffCount * 0.2)),
			"Derrick Hand": Math.max(0, Math.round(staffCount * 0.1)),
			"Motor Hand": Math.max(0, Math.round(staffCount * 0.1)),
			Secretary: 0,
		};
	}

	if (staffCount <= 17) {
		return {
			Driller: 5,
			"Sales Executive": 4,
			Roughneck: 3,
			"Derrick Hand": 2,
			"Motor Hand": 2,
			Secretary: 1,
		};
	}

	if (staffCount <= 21) {
		// Incremental allocation adhering to hiring priority roadmap:
		// 18th seat (+1): Roughneck (Cleaner to secure 100% Environment)
		// 19th seat (+2): Driller (Production extraction anchor)
		// 20th seat (+3): Sales Executive (Sales clearance volume)
		// 21st seat (+4): Derrick Hand (Platform stability)
		const base = {
			Driller: 5,
			"Sales Executive": 4,
			Roughneck: 3,
			"Derrick Hand": 2,
			"Motor Hand": 2,
			Secretary: 1,
		};
		const extra = staffCount - 17;
		if (extra >= 1) base.Roughneck += 1;
		if (extra >= 2) base.Driller += 1;
		if (extra >= 3) base["Sales Executive"] += 1;
		if (extra >= 4) base["Derrick Hand"] += 1;
		return base;
	}

	// 22-30 capacity scaling
	return {
		Driller: Math.round(staffCount * 0.27),
		"Sales Executive": Math.round(staffCount * 0.23),
		Roughneck: Math.round(staffCount * 0.2),
		"Derrick Hand": Math.round(staffCount * 0.13),
		"Motor Hand": Math.round(staffCount * 0.1),
		Secretary: Math.max(
			1,
			staffCount -
				(Math.round(staffCount * 0.27) +
					Math.round(staffCount * 0.23) +
					Math.round(staffCount * 0.2) +
					Math.round(staffCount * 0.13) +
					Math.round(staffCount * 0.1)),
		),
	};
}

// Hungarian / Kuhn-Munkres algorithm for max-weight bipartite matching
function maxWeightBipartiteMatching(costMatrix: number[][]): number[] {
	const n = costMatrix.length;
	const m = costMatrix[0]?.length ?? 0;
	if (n === 0 || m === 0) return [];

	const dim = Math.max(n, m);
	const a: number[][] = Array.from({ length: dim }, (_, i) =>
		Array.from({ length: dim }, (_, j) =>
			i < n && j < m ? (costMatrix[i]?.[j] ?? 0) : 0,
		),
	);

	const u = new Array(dim + 1).fill(0);
	const v = new Array(dim + 1).fill(0);
	const p = new Array(dim + 1).fill(0);
	const way = new Array(dim + 1).fill(0);

	for (let i = 1; i <= dim; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array(dim + 1).fill(Infinity);
		const used = new Array(dim + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0] ?? 0;
			let delta = Infinity;
			let j1 = 0;
			for (let j = 1; j <= dim; j++) {
				if (!used[j]) {
					const cur = -(a[i0 - 1]?.[j - 1] ?? 0) - (u[i0] ?? 0) - (v[j] ?? 0);
					if (cur < (minv[j] ?? Infinity)) {
						minv[j] = cur;
						way[j] = j0;
					}
					if ((minv[j] ?? Infinity) < delta) {
						delta = minv[j] ?? Infinity;
						j1 = j;
					}
				}
			}
			for (let j = 0; j <= dim; j++) {
				if (used[j]) {
					u[p[j] ?? 0] += delta;
					v[j] += delta;
				} else {
					minv[j] -= delta;
				}
			}
			j0 = j1;
		} while ((p[j0] ?? 0) !== 0);

		do {
			const j1 = way[j0] ?? 0;
			p[j0] = p[j1] ?? 0;
			j0 = j1;
		} while (j0 !== 0);
	}

	const assignment = new Array(n).fill(-1);
	for (let j = 1; j <= dim; j++) {
		const workerIdx = (p[j] ?? 0) - 1;
		if (workerIdx >= 0 && workerIdx < n && j - 1 < m) {
			assignment[workerIdx] = j - 1;
		}
	}
	return assignment;
}

export interface ActiveTransfer {
	name: string;
	fromRole: string;
	toRole: string;
	statsStr: string;
	rationale: string;
}

export interface OptimalRosterResult {
	targetQuotas: Record<string, number>;
	activeTransfers: ActiveTransfer[];
	lockedEmployees: Array<{ name: string; role: string }>;
	rosterByRole: Record<string, string[]>;
	rehabTiers: {
		tier1: Array<{ name: string; penalty: number; role: string }>;
		tier2: Array<{ name: string; penalty: number; role: string }>;
		tier3: Array<{ name: string; penalty: number; role: string }>;
	};
}

export function solveOptimalRoster(
	employees: EmployeeData[],
): OptimalRosterResult {
	const quotas = getOptimalRoleQuotas(employees.length);

	// Expand slots from quotas
	const slots: OilRigRoleName[] = [];
	for (const [role, count] of Object.entries(quotas)) {
		for (let i = 0; i < count; i++) {
			slots.push(role as OilRigRoleName);
		}
	}

	// Build cost matrix
	const costMatrix: number[][] = [];
	for (const emp of employees) {
		const row: number[] = [];
		for (const role of slots) {
			const roleDef = OIL_RIG_ROLES[role];
			let score = roleDef ? calcRoleFit(emp.stats, roleDef) : 0;

			// Strategic domain anchors:
			// High-INT worker (>400k) should anchor Sales Executive
			if (emp.stats.intelligence >= 400_000 && role === "Sales Executive") {
				score += 50;
			}
			// High-MAN worker (>300k) should anchor Driller
			if (emp.stats.manual_labor >= 300_000 && role === "Driller") {
				score += 50;
			}

			// Role Stability / Anti-Churn Inertia:
			// If employee is already in this role, give an inertia bonus so we don't shuffle
			// workers back and forth due to minor temporary stat changes or small addiction debuffs.
			const currentRoleName = emp.position?.name;
			if (
				currentRoleName &&
				(currentRoleName as string) === role &&
				currentRoleName !== "Unassigned"
			) {
				const settleBonus = emp.effectiveness?.settled_in ?? 0;
				score += 15 + settleBonus;
			}

			row.push(score);
		}
		costMatrix.push(row);
	}

	const match = maxWeightBipartiteMatching(costMatrix);

	const activeTransfers: ActiveTransfer[] = [];
	const lockedEmployees: Array<{ name: string; role: string }> = [];
	const rosterByRole: Record<string, string[]> = {};

	for (let i = 0; i < employees.length; i++) {
		const emp = employees[i];
		if (!emp) continue;

		const slotIdx = match[i] ?? -1;
		const assignedRole = slots[slotIdx] ?? emp.position?.name ?? "Roughneck";

		if (!rosterByRole[assignedRole]) {
			rosterByRole[assignedRole] = [];
		}
		rosterByRole[assignedRole].push(emp.name);

		const fromRole =
			emp.position?.name && emp.position.name.trim() !== ""
				? emp.position.name
				: "Unassigned";

		if (fromRole !== assignedRole) {
			const manK = `${Math.round(emp.stats.manual_labor / 1000)}k MAN`;
			const intK = `${Math.round(emp.stats.intelligence / 1000)}k INT`;
			const endK = `${Math.round(emp.stats.endurance / 1000)}k END`;

			let statsStr = manK;
			let rationale = "Optimizes department balance";
			if (fromRole === "Unassigned") {
				rationale = `Initial placement into ${assignedRole}`;
				if (assignedRole === "Sales Executive") statsStr = intK;
				else if (assignedRole === "Secretary") statsStr = endK;
			} else if (assignedRole === "Driller") {
				statsStr = manK;
				rationale = "Anchors drilling throughput";
			} else if (assignedRole === "Sales Executive") {
				statsStr = intK;
				rationale = "Expands sales volume";
			} else if (assignedRole === "Roughneck") {
				statsStr = manK;
				rationale = "Cleaner, protects 100% Environment";
			} else if (assignedRole === "Secretary") {
				statsStr = endK;
				rationale = "Corporate analytics";
			} else if (assignedRole === "Derrick Hand") {
				statsStr = manK;
				rationale = "Platform stability";
			} else if (assignedRole === "Motor Hand") {
				statsStr = manK;
				rationale = "Machinery maintenance";
			}

			activeTransfers.push({
				name: emp.name,
				fromRole,
				toRole: assignedRole,
				statsStr,
				rationale,
			});
		} else {
			lockedEmployees.push({
				name: emp.name,
				role: assignedRole,
			});
		}
	}

	// Rehab Tiers
	const addicted = employees
		.filter((e) => (e.effectiveness.addiction ?? 0) < 0)
		.sort(
			(a, b) =>
				(a.effectiveness.addiction ?? 0) - (b.effectiveness.addiction ?? 0),
		);

	const tier1: Array<{ name: string; penalty: number; role: string }> = [];
	const tier2: Array<{ name: string; penalty: number; role: string }> = [];
	const tier3: Array<{ name: string; penalty: number; role: string }> = [];

	for (const e of addicted) {
		const penalty = e.effectiveness.addiction ?? 0;
		const role = e.position?.name ?? "Unassigned";
		if (penalty <= -10) {
			tier1.push({ name: e.name, penalty, role });
		} else if (penalty <= -6) {
			tier2.push({ name: e.name, penalty, role });
		} else {
			tier3.push({ name: e.name, penalty, role });
		}
	}

	return {
		targetQuotas: quotas,
		activeTransfers,
		lockedEmployees,
		rosterByRole,
		rehabTiers: { tier1, tier2, tier3 },
	};
}

export interface StockAnalysis {
	fillPct: number;
	daysOfSales: number;
	netDrainPerDay?: number;
	state: "deficit" | "equilibrium" | "surplus";
	stateDescription: string;
	recommendedPrice: {
		min: number;
		max: number;
		exact: number;
		action: "increase" | "maintain" | "decrease";
		formatted: string;
		rationale: string;
	};
	recommendedAdSpend: {
		amount: number;
		action: "freeze" | "maintain" | "increase";
		formatted: string;
		rationale: string;
	};
}

export function analyzeStockAndPricing(params: {
	inStock: number;
	storageCap: number;
	dailySold: number;
	dailyProduced?: number;
	currentPrice: number;
	adBudget: number;
	dailyIncome: number;
}): StockAnalysis {
	const storageCap = params.storageCap > 0 ? params.storageCap : 750_000;
	const fillPct = Number(((params.inStock / storageCap) * 100).toFixed(1));

	let daysOfSales = 999;
	let netDrainPerDay: number | undefined;

	if (params.dailyProduced !== undefined && params.dailyProduced > 0) {
		const netChange = params.dailyProduced - params.dailySold;
		if (netChange < 0) {
			netDrainPerDay = Math.abs(netChange);
			daysOfSales = Number((params.inStock / netDrainPerDay).toFixed(1));
		} else {
			daysOfSales = 999;
		}
	} else if (params.dailySold > 0) {
		daysOfSales = Number((params.inStock / params.dailySold).toFixed(1));
	}

	const currentPrice = params.currentPrice > 0 ? params.currentPrice : 181;
	const adBudget = params.adBudget;

	// Deficit State: Less than 35% capacity or under 1.5 days of sales volume
	if (fillPct < 35 || daysOfSales < 1.5) {
		const isAlreadyElevated = currentPrice >= 185;
		const targetPriceMin = isAlreadyElevated ? currentPrice : 183;
		const targetPriceMax = isAlreadyElevated ? currentPrice : 186;
		const exact = isAlreadyElevated ? currentPrice : 185;
		const action = isAlreadyElevated ? "maintain" : "increase";
		const formatted = isAlreadyElevated
			? `Maintain at $${currentPrice}/barrel.`
			: `Recommend $${targetPriceMin}–$${targetPriceMax}/barrel ($${exact}).`;
		const rationale = isAlreadyElevated
			? `Price is already elevated at $${currentPrice}/barrel to moderate sales velocity. Maintain price to allow drilling extraction to rebuild warehouse reserves toward a safe 50%–60% buffer.`
			: `A marginal price increase dampens sales velocity slightly, allowing drilling extraction to rebuild warehouse reserves toward a safe 50%–60% buffer while capturing higher margins per barrel.`;

		return {
			fillPct,
			daysOfSales,
			netDrainPerDay,
			state: "deficit",
			stateDescription: `Inventory is in a critical deficit (${fillPct}% full).`,
			recommendedPrice: {
				min: targetPriceMin,
				max: targetPriceMax,
				exact,
				action,
				formatted,
				rationale,
			},
			recommendedAdSpend: {
				amount: adBudget,
				action: "freeze",
				formatted: `Recommend $${adBudget.toLocaleString()}/day.`,
				rationale: `Maintain or freeze ad spend at $${adBudget.toLocaleString()}/day.`,
			},
		};
	}

	// Surplus State: Above 75% capacity
	if (fillPct > 75) {
		const targetPriceMin = Math.max(160, currentPrice - 4);
		const targetPriceMax = Math.max(165, currentPrice - 2);
		const exact = targetPriceMin + 1;
		return {
			fillPct,
			daysOfSales,
			netDrainPerDay,
			state: "surplus",
			stateDescription: `Inventory is nearing warehouse capacity (${fillPct}% full).`,
			recommendedPrice: {
				min: targetPriceMin,
				max: targetPriceMax,
				exact,
				action: "decrease",
				formatted: `Recommend $${targetPriceMin}–$${targetPriceMax}/barrel ($${exact}).`,
				rationale: `Discount price slightly to accelerate sales volume and clear storage space before hitting warehouse limits.`,
			},
			recommendedAdSpend: {
				amount: adBudget + 500_000,
				action: "increase",
				formatted: `Recommend $${(adBudget + 500_000).toLocaleString()}/day.`,
				rationale: `Scale ad spend up to accelerate customer acquisition and clear surplus barrel inventory.`,
			},
		};
	}

	// Equilibrium State: 35% to 75%
	return {
		fillPct,
		daysOfSales,
		netDrainPerDay,
		state: "equilibrium",
		stateDescription: `Inventory is operating in a healthy equilibrium buffer (${fillPct}% full).`,
		recommendedPrice: {
			min: currentPrice,
			max: currentPrice,
			exact: currentPrice,
			action: "maintain",
			formatted: `Maintain at $${currentPrice}/barrel.`,
			rationale: `Maintain current price at $${currentPrice}/barrel.`,
		},
		recommendedAdSpend: {
			amount: adBudget,
			action: "maintain",
			formatted: `Maintain at $${adBudget.toLocaleString()}/day.`,
			rationale: `Maintain current ad spend at $${adBudget.toLocaleString()}/day to sustain customer traffic.`,
		},
	};
}

export interface HiringPriority {
	role: string;
	countNeeded: number;
	priority: "CRITICAL" | "HIGH" | "MEDIUM";
	rationale: string;
}

export interface HiringAnalysis {
	openSeats: number;
	hired: number;
	capacity: number;
	priorities: HiringPriority[];
	summary: string;
	shortSummary: string;
}

export function analyzeHiringPriorities(
	hired: number,
	capacity: number,
	currentRosterByRole: Record<string, string[]>,
): HiringAnalysis {
	const openSeats = Math.max(0, capacity - hired);
	if (openSeats === 0) {
		return {
			openSeats: 0,
			hired,
			capacity,
			priorities: [],
			summary: `Company is currently at maximum staff capacity (${hired}/${capacity}). Focus on increasing star rating and director perks to unlock the next capacity expansion tier.`,
			shortSummary: "At capacity.",
		};
	}

	const targetQuotas = getOptimalRoleQuotas(capacity);
	const deficits: Array<{ role: string; deficit: number }> = [];

	for (const [role, targetCount] of Object.entries(targetQuotas)) {
		const currentCount = currentRosterByRole[role]?.length ?? 0;
		if (targetCount > currentCount) {
			deficits.push({ role, deficit: targetCount - currentCount });
		}
	}

	const roleWeight: Record<string, number> = {
		Roughneck: 100,
		Driller: 80,
		"Sales Executive": 70,
		"Derrick Hand": 50,
		"Motor Hand": 40,
		Secretary: 30,
	};

	deficits.sort(
		(a, b) => (roleWeight[b.role] ?? 0) - (roleWeight[a.role] ?? 0),
	);

	const priorities: HiringPriority[] = [];
	let seatsAllocated = 0;

	for (const item of deficits) {
		if (seatsAllocated >= openSeats) break;
		const take = Math.min(item.deficit, openSeats - seatsAllocated);
		seatsAllocated += take;

		let prio: "CRITICAL" | "HIGH" | "MEDIUM" = "MEDIUM";
		let rationale = "Expands operational efficiency";

		if (item.role === "Roughneck") {
			prio = "CRITICAL";
			rationale =
				"Guarantees 100% Environment permanently, insulating against employee inactivity or addiction creep.";
		} else if (item.role === "Driller") {
			prio = "HIGH";
			rationale =
				"Scales raw extraction volume to prevent warehouse stockouts as sales grow.";
		} else if (item.role === "Sales Executive") {
			prio = "HIGH";
			rationale =
				"Expands daily barrel clearance capacity to convert crude oil inventory into top-line gross revenue.";
		} else if (item.role === "Derrick Hand" || item.role === "Motor Hand") {
			prio = "MEDIUM";
			rationale =
				"Balances machinery maintenance and drilling platform stability.";
		} else if (item.role === "Secretary") {
			prio = "MEDIUM";
			rationale = "Boosts company deal finalization and operational analytics.";
		}

		priorities.push({
			role: item.role,
			countNeeded: take,
			priority: prio,
			rationale,
		});
	}

	const summary = priorities
		.map((p) => `• **+${p.countNeeded} ${p.role}:** ${p.rationale}`)
		.join("\n");

	const shortSummary =
		priorities.length > 0
			? priorities.map((p) => `+${p.countNeeded} ${p.role}`).join(", ")
			: "At capacity.";

	return {
		openSeats,
		hired,
		capacity,
		priorities,
		summary,
		shortSummary,
	};
}

export interface StarProgressionAnalysis {
	currentStars: number;
	nextStar: number;
	weeklyIncome: number;
	topCompetitorWeeklyIncome: number;
	popularityPct: number;
	weeklyIncomeGap: number;
	recommendation: string;
	shortSummary: string;
}

export function analyzeStarProgression(params: {
	currentStars: number;
	weeklyIncome: number;
	topCompetitorWeeklyIncome?: number;
	efficiency: number;
	environment: number;
	unsettledCount: number;
	addictedCount: number;
}): StarProgressionAnalysis {
	const topWeekly = params.topCompetitorWeeklyIncome ?? 1_163_000_000;
	const popularityPct = Number(
		((params.weeklyIncome / topWeekly) * 100).toFixed(1),
	);
	const weeklyIncomeGap = Math.max(0, topWeekly - params.weeklyIncome);
	const nextStar = Math.min(10, params.currentStars + 1);

	let recommendation = `Target progression from **${params.currentStars}★ ➔ ${nextStar}★**. Current weekly revenue is $${params.weeklyIncome.toLocaleString()} (${popularityPct}% of top 10★ rigs). `;

	if (params.addictedCount > 0) {
		recommendation += `Clearing the ${params.addictedCount} addicted employees will immediately restore efficiency to 100% and accelerate daily rating points. `;
	}
	if (params.environment < 100) {
		recommendation += `URGENT: Environment is at ${params.environment}%. Cleaners must restore this to 100% immediately to avert Torn's -33% revenue penalty. `;
	}
	recommendation += `Maintain unbroken daily stock sales and avoid stockouts to accumulate daily director rating stars.`;

	const shortSummary = `Target ${params.currentStars}★ ➔ ${nextStar}★. Weekly revenue: $${Math.round(params.weeklyIncome / 1_000_000)}M (${popularityPct}% of $1.16B 10★ benchmark).`;

	return {
		currentStars: params.currentStars,
		nextStar,
		weeklyIncome: params.weeklyIncome,
		topCompetitorWeeklyIncome: topWeekly,
		popularityPct,
		weeklyIncomeGap,
		recommendation,
		shortSummary,
	};
}

export interface OilRigHistoryRecord {
	timestamp: number;
	isoDate: string;
	stars: number;
	dailyIncome: number;
	weeklyIncome: number;
	efficiency: number;
	environment: number;
	popularity?: number;
	adBudget: number;
	stock: {
		barrelPrice: number;
		inStock: number;
		soldAmount: number;
		fillPct: number;
	};
	metrics: {
		totalAddictionPenalty: number;
		employeesWithAddiction: number;
	};
}

export function formatHistoryTable(history: OilRigHistoryRecord[]): string {
	if (history.length === 0) {
		return "_No historical entries recorded yet. Today's snapshot will serve as Day 1 baseline._";
	}

	const header =
		"| Date | Stars | Daily Rev | Barrels Sold | In Stock | Fill % | Price | Ad Budget | Eff % | Env % | Addiction Loss |\n|---|---|---|---|---|---|---|---|---|---|---|";
	const rows = history.map((h) => {
		const revM = `$${(h.dailyIncome / 1_000_000).toFixed(1)}M`;
		const soldK = `${Math.round((h.stock?.soldAmount ?? 0) / 1000)}k`;
		const stockK = `${Math.round((h.stock?.inStock ?? 0) / 1000)}k`;
		const fill = `${h.stock?.fillPct ?? 0}%`;
		const price = `$${h.stock?.barrelPrice ?? 0}`;
		const ad = `$${((h.adBudget ?? 0) / 1_000_000).toFixed(1)}M`;
		const eff = `${h.efficiency}%`;
		const env = `${h.environment}%`;
		const addLoss = `-${h.metrics?.totalAddictionPenalty ?? 0} pts`;
		return `| ${h.isoDate} | ${h.stars}★ | ${revM} | ${soldK} | ${stockK} | ${fill} | ${price} | ${ad} | ${eff} | ${env} | ${addLoss} |`;
	});

	return `${header}\n${rows.join("\n")}`;
}

export function getCompetitorBenchmarkContext(): string {
	return `Top 10★ Oil Rigs Industry Benchmark (30/30 Staff Capacity):
• Weekly Revenue: ~$1,163,000,000 (~$166,000,000/day)
• Daily Customers: ~250/day (~1,750/week)
• Typical Barrel Pricing: $181–$185
• Proven 10★ Staff Configuration: 8 Drillers, 7 Sales Executives, 6 Roughnecks (Cleaners), 4 Derrick Hands, 3 Motor Hands, 2 Secretaries, 0 Trainers
• Sector Popularity Anchor: 100% (Top rigs set the maximum weekly income ceiling for the entire sector)

Mid-Tier Oil Rigs Benchmark (7★–9★, 24–27 Staff Capacity):
• Weekly Revenue: $600,000,000 – $900,000,000 ($85M–$130M/day)
• Typical Barrel Pricing: $180–$185`;
}
