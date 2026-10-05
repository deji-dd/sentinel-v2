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
	positionId?: number;
	positionName?: string;
	days_in_company?: number;
	daysInCompany?: number;
	stats: {
		manual_labor?: number;
		manualLabor?: number;
		intelligence?: number;
		endurance?: number;
	};
	effectiveness?: {
		working_stats?: number;
		workingStats?: number;
		settled_in?: number;
		settledIn?: number;
		director_education?: number;
		directorEducation?: number;
		addiction?: number;
		inactivity?: number;
		total?: number;
	};
}

export function calcStatScore(stat: number, req: number): number {
	if (
		!stat ||
		stat <= 0 ||
		!req ||
		req <= 0 ||
		!Number.isFinite(stat) ||
		!Number.isFinite(req)
	) {
		return 0;
	}
	const linear = Math.min(45, (45 * stat) / req);
	const logBonus = stat > req ? 5 * Math.log2(stat / req) : 0;
	const res = linear + logBonus;
	return Number.isFinite(res) ? res : 0;
}

export function calcRoleFit(
	stats: {
		manual_labor?: number;
		manualLabor?: number;
		intelligence?: number;
		endurance?: number;
	},
	role: RoleDef,
): number {
	const getStat = (statName: "manual_labor" | "intelligence" | "endurance") => {
		if (statName === "manual_labor") {
			return stats.manual_labor ?? stats.manualLabor ?? 0;
		}
		return stats[statName] ?? 0;
	};

	const pri = calcStatScore(getStat(role.primaryStat), role.primaryReq);
	const sec = calcStatScore(getStat(role.secondaryStat), role.secondaryReq);
	const total = Math.floor(pri + sec);
	return Number.isFinite(total) ? total : 0;
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
		Array.from({ length: dim }, (_, j) => {
			const val = i < n && j < m ? costMatrix[i]?.[j] : 0;
			return typeof val === "number" && Number.isFinite(val) ? val : 0;
		}),
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
		let outerLoopGuard = 0;
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
			if (!Number.isFinite(delta) || delta === Infinity) {
				break;
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
			if (++outerLoopGuard > dim * 5) {
				break;
			}
		} while ((p[j0] ?? 0) !== 0);

		let innerLoopGuard = 0;
		do {
			const j1 = way[j0] ?? 0;
			p[j0] = p[j1] ?? 0;
			j0 = j1;
			if (++innerLoopGuard > dim * 5) {
				break;
			}
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
	options?: { bottleneck?: { extractionBound?: boolean; maxShift?: number } },
): OptimalRosterResult {
	const baseQuotas = getOptimalRoleQuotas(employees.length);
	// The blueprint is the long-run target, but a warehouse that cannot clear
	// changes which seats are worth holding, so re-shape it before assigning.
	// Doing it here keeps one source of truth: a single assignment solves both
	// the blueprint and the bottleneck, so advice can never contradict itself.
	const { quotas } = buildBottleneckQuotas(baseQuotas, {
		extractionBound: options?.bottleneck?.extractionBound ?? false,
		maxShift: options?.bottleneck?.maxShift,
	});

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
		const stats = emp.stats ?? {};
		const manLabor = stats.manual_labor ?? stats.manualLabor ?? 0;
		const intell = stats.intelligence ?? 0;
		const currentRoleName = emp.position?.name ?? emp.positionName;
		const eff = emp.effectiveness ?? {};
		const settleBonus = eff.settled_in ?? eff.settledIn ?? 0;

		for (const role of slots) {
			const roleDef = OIL_RIG_ROLES[role];
			let score = roleDef ? calcRoleFit(emp.stats, roleDef) : 0;

			// Strategic domain anchors:
			// High-INT worker (>400k) should anchor Sales Executive
			if (intell >= 400_000 && role === "Sales Executive") {
				score += 50;
			}
			// High-MAN worker (>300k) should anchor Driller
			if (manLabor >= 300_000 && role === "Driller") {
				score += 50;
			}

			// Role Stability / Anti-Churn Inertia:
			// If employee is already in this role, give an inertia bonus so we don't shuffle
			// workers back and forth due to minor temporary stat changes or small addiction debuffs.
			if (
				currentRoleName &&
				(currentRoleName as string) === role &&
				currentRoleName !== "Unassigned"
			) {
				score += 15 + settleBonus;
			}

			row.push(Number.isFinite(score) ? score : 0);
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

		const currentRoleName = emp.position?.name ?? emp.positionName;
		const slotIdx = match[i] ?? -1;
		const assignedRole = slots[slotIdx] ?? currentRoleName ?? "Roughneck";

		if (!rosterByRole[assignedRole]) {
			rosterByRole[assignedRole] = [];
		}
		rosterByRole[assignedRole].push(emp.name);

		const fromRole =
			currentRoleName && currentRoleName.trim() !== ""
				? currentRoleName
				: "Unassigned";

		if (fromRole !== assignedRole) {
			const stats = emp.stats ?? {};
			const manLabor = stats.manual_labor ?? stats.manualLabor ?? 0;
			const intelligence = stats.intelligence ?? 0;
			const endurance = stats.endurance ?? 0;

			const manK = `${Math.round(manLabor / 1000)}k MAN`;
			const intK = `${Math.round(intelligence / 1000)}k INT`;
			const endK = `${Math.round(endurance / 1000)}k END`;

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
		.filter((e) => (e.effectiveness?.addiction ?? 0) < 0)
		.sort(
			(a, b) =>
				(a.effectiveness?.addiction ?? 0) - (b.effectiveness?.addiction ?? 0),
		);

	const tier1: Array<{ name: string; penalty: number; role: string }> = [];
	const tier2: Array<{ name: string; penalty: number; role: string }> = [];
	const tier3: Array<{ name: string; penalty: number; role: string }> = [];

	for (const e of addicted) {
		const penalty = e.effectiveness?.addiction ?? 0;
		const role = e.position?.name ?? e.positionName ?? "Unassigned";
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
	/**
	 * Days until the warehouse empties at the current net drain rate.
	 * `INFINITE_DAYS_OF_SALES` means extraction matches or outpaces sales, so the
	 * warehouse cannot drain on its own.
	 */
	daysOfSales: number;
	netDrainPerDay?: number;
	/** Barrels per day accumulating in storage (set when production >= sales). */
	netFillPerDay?: number;
	/** True when extraction matches or outpaces sales: stock cannot self-drain. */
	isFillingUp: boolean;
	/** True at/above the critical fill threshold, where output may be discarded. */
	warehouseCritical: boolean;
	state: "deficit" | "equilibrium" | "surplus";
	stateDescription: string;
	/** Set when the surplus is structural and no price/ad setting can clear it. */
	structuralAdvice?: string;
	recommendedPrice: {
		min: number;
		max: number;
		exact: number;
		action: "increase" | "maintain" | "decrease";
		formatted: string;
		rationale: string;
		/** True only while the current setting differs from the target. */
		changeNeeded: boolean;
	};
	recommendedAdSpend: {
		amount: number;
		action: "freeze" | "maintain" | "increase";
		formatted: string;
		rationale: string;
		/** True only while the current setting differs from the target. */
		changeNeeded: boolean;
	};
}

/** Sentinel for `daysOfSales` meaning the warehouse will not drain on its own. */
export const INFINITE_DAYS_OF_SALES = 999;

/** Stock below this many days is treated as effectively exhausted. */
const MIN_DAYS_OF_STOCK = 1.5;

/**
 * Tunable economics for the stock/pricing engine.
 *
 * Every target below is ABSOLUTE - derived from this policy, daily revenue and
 * fill level - rather than a step relative to the current setting. That is
 * deliberate: a relative step is never idempotent, so re-running the analysis
 * after the director applies the advice would immediately demand another step,
 * forever.
 *
 * IMPORTANT: the price and ad figures below are DIRECTOR POLICY, not measured
 * market facts. Defaults were chosen from this rig's own recorded operating
 * range ($176-$185/bbl over the first recorded week). Change them here to change
 * the advice; nothing else needs editing.
 */
export interface OilRigPricingPolicy {
	/**
	 * Lowest barrel price the engine will ever recommend. Surplus advice targets
	 * this and never proposes going below it, so the price cannot ratchet down
	 * indefinitely.
	 */
	marketPriceFloor: number;
	/** Highest barrel price used as the deficit target. */
	marketPriceCeiling: number;
	/** A price within this many dollars of target counts as already on target. */
	priceTolerance: number;
	/** Deficit target: hold the top of the band to rebuild reserves. */
	deficitPriceTarget: number;
	/** Surplus target: at most this share of daily revenue on advertising. */
	surplusAdRevenueShare: number;
	/** Hard ceiling no ad recommendation may ever exceed, as a share of revenue. */
	maxAdRevenueShare: number;
	/** Current spend within this many dollars of target counts as on target. */
	adTolerance: number;
	/** Ad targets are rounded down to this granularity for clean numbers. */
	adRounding: number;
	/** Below this fill percentage the warehouse is in deficit. */
	fillDeficitPct: number;
	/** Above this fill percentage the warehouse is in surplus. */
	fillSurplusPct: number;
	/** At/above this fill percentage output may be discarded: storage is full. */
	fillCriticalPct: number;
}

export const OIL_RIG_PRICING_POLICY: OilRigPricingPolicy = {
	marketPriceFloor: 180,
	marketPriceCeiling: 185,
	priceTolerance: 1,
	deficitPriceTarget: 185,
	surplusAdRevenueShare: 0.1,
	maxAdRevenueShare: 0.15,
	adTolerance: 50_000,
	adRounding: 100_000,
	fillDeficitPct: 35,
	fillSurplusPct: 75,
	fillCriticalPct: 95,
};

export function analyzeStockAndPricing(params: {
	inStock: number;
	storageCap: number;
	dailySold: number;
	dailyProduced?: number;
	currentPrice: number;
	adBudget: number;
	dailyIncome: number;
}): StockAnalysis {
	const policy = OIL_RIG_PRICING_POLICY;
	const storageCap = params.storageCap > 0 ? params.storageCap : 750_000;
	const fillPct = Number(((params.inStock / storageCap) * 100).toFixed(1));
	const currentPrice =
		params.currentPrice > 0
			? params.currentPrice
			: policy.marketPriceFloor + policy.priceTolerance;
	const adBudget = params.adBudget > 0 ? params.adBudget : 0;
	const dailyIncome = params.dailyIncome > 0 ? params.dailyIncome : 0;

	// Drain model. `daysOfSales` means "days until the warehouse empties", so it
	// is only finite when sales genuinely outpace extraction.
	let daysOfSales = INFINITE_DAYS_OF_SALES;
	let netDrainPerDay: number | undefined;
	let netFillPerDay: number | undefined;
	let isFillingUp = false;

	if (params.dailyProduced !== undefined && params.dailyProduced > 0) {
		const netChange = params.dailyProduced - params.dailySold;
		if (netChange < 0) {
			netDrainPerDay = Math.abs(netChange);
			daysOfSales = Number((params.inStock / netDrainPerDay).toFixed(1));
		} else {
			netFillPerDay = netChange;
			isFillingUp = true;
		}
	} else if (params.dailySold > 0) {
		daysOfSales = Number((params.inStock / params.dailySold).toFixed(1));
	}

	const warehouseCritical = fillPct >= policy.fillCriticalPct;

	// Deficit State: under 35% full, or under 1.5 days of stock remaining.
	if (fillPct < policy.fillDeficitPct || daysOfSales < MIN_DAYS_OF_STOCK) {
		const targetPrice = policy.deficitPriceTarget;
		const isAlreadyElevated =
			currentPrice >= targetPrice - policy.priceTolerance;
		const targetPriceMin = isAlreadyElevated ? currentPrice : 183;
		const targetPriceMax = isAlreadyElevated ? currentPrice : 186;
		const exact = isAlreadyElevated ? currentPrice : targetPrice;
		const action = isAlreadyElevated ? "maintain" : "increase";
		const formatted = isAlreadyElevated
			? `Maintain at $${currentPrice}/barrel.`
			: `Recommend $${targetPriceMin}–$${targetPriceMax}/barrel ($${exact}).`;
		const rationale = isAlreadyElevated
			? `Price is already at the top of the target band ($${policy.marketPriceFloor}–$${policy.marketPriceCeiling}) at $${currentPrice}/barrel, which moderates sales velocity while extraction rebuilds warehouse reserves toward a safe 50%–60% buffer.`
			: `Raise price to $${targetPrice}/barrel, the top of the target band ($${policy.marketPriceFloor}–$${policy.marketPriceCeiling}). This captures maximum margin per barrel and slows sales so extraction can rebuild reserves toward a safe 50%–60% buffer. This is a fixed target: no further change is required once reached.`;

		return {
			fillPct,
			daysOfSales,
			netDrainPerDay,
			netFillPerDay,
			isFillingUp,
			warehouseCritical,
			state: "deficit",
			stateDescription: `Inventory is in a critical deficit (${fillPct}% full${
				daysOfSales < INFINITE_DAYS_OF_SALES
					? `, ${daysOfSales} days of stock left`
					: ""
			}).`,
			recommendedPrice: {
				min: targetPriceMin,
				max: targetPriceMax,
				exact,
				action,
				formatted,
				rationale,
				changeNeeded: !isAlreadyElevated,
			},
			recommendedAdSpend: {
				amount: adBudget,
				action: "freeze",
				formatted: `Hold at $${adBudget.toLocaleString()}/day.`,
				rationale: `Do not raise ad spend while stock is short at $${adBudget.toLocaleString()}/day: extra customers cannot be served and would only drain reserves faster.`,
				changeNeeded: false,
			},
		};
	}

	// Surplus State: above 75% full.
	//
	// Both targets are ABSOLUTE, which is what makes this advice idempotent:
	// applying it and re-running this analysis reports "maintain" instead of
	// demanding the same change again. The previous implementation stepped the
	// price down relative to the *current* price and added a flat $500k to the
	// *current* ad budget, so every fetch produced a fresh, lower price target
	// and an ever-larger ad budget - an endless loop that could never be
	// satisfied by complying with it.
	if (fillPct > policy.fillSurplusPct) {
		const priceOnTarget =
			currentPrice <= policy.marketPriceFloor + policy.priceTolerance;
		const recommendedPrice: StockAnalysis["recommendedPrice"] = priceOnTarget
			? {
					min: currentPrice,
					max: currentPrice,
					exact: currentPrice,
					action: "maintain",
					formatted: `Maintain at $${currentPrice}/barrel.`,
					rationale: `Price is already at or below the $${policy.marketPriceFloor}–$${policy.marketPriceCeiling} target band floor at $${currentPrice}/barrel. A further cut would surrender margin for no reliable sell-through gain, so clear the surplus with sell-through capacity rather than price.`,
					changeNeeded: false,
				}
			: {
					min: policy.marketPriceFloor,
					max: policy.marketPriceFloor + 1,
					exact: policy.marketPriceFloor,
					action: "decrease",
					formatted: `Recommend $${policy.marketPriceFloor}–$${policy.marketPriceFloor + 1}/barrel ($${policy.marketPriceFloor}).`,
					rationale: `Move to $${policy.marketPriceFloor}/barrel, the floor of the $${policy.marketPriceFloor}–$${policy.marketPriceCeiling} target band, to lift sell-through while protecting margin. This is a fixed target: no further price change is required once it is reached.`,
					changeNeeded: true,
				};

		// The ad target is an absolute, revenue-bounded figure scaled by how
		// urgently the surplus must be cleared. It never references the current
		// budget, so it converges after a single increase and cannot ratchet.
		const urgency = isFillingUp
			? 1
			: Math.min(
					1,
					Math.max(
						0.4,
						(fillPct - policy.fillSurplusPct) / (100 - policy.fillSurplusPct),
					),
				);
		const adCeiling =
			Math.floor((dailyIncome * policy.maxAdRevenueShare) / policy.adRounding) *
			policy.adRounding;
		const adTarget = Math.min(
			Math.floor(
				(dailyIncome * policy.surplusAdRevenueShare * urgency) /
					policy.adRounding,
			) * policy.adRounding,
			adCeiling,
		);
		const adOnTarget = adBudget >= adTarget - policy.adTolerance;
		const recommendedAdSpend: StockAnalysis["recommendedAdSpend"] = adOnTarget
			? {
					amount: adBudget,
					action: "maintain",
					formatted: `Maintain at $${adBudget.toLocaleString()}/day.`,
					rationale: `Ad spend is already at or above the $${adTarget.toLocaleString()}/day ceiling appropriate for this fill level (${Math.round(policy.surplusAdRevenueShare * 100)}% of daily revenue). Raising it further would buy customers the rig cannot serve profitably while stock is over the safe buffer.`,
					changeNeeded: false,
				}
			: {
					amount: adTarget,
					action: "increase",
					formatted: `Recommend $${adTarget.toLocaleString()}/day.`,
					rationale: `Scale ad spend to $${adTarget.toLocaleString()}/day to accelerate customer acquisition and clear surplus inventory. This is a fixed target bounded by daily revenue, not a recurring step.`,
					changeNeeded: true,
				};

		// When the warehouse is full and extraction still keeps pace with sales,
		// no price or ad setting can clear it: the constraint is structural.
		// Storage upgrades are deliberately not offered as a fix - with extraction
		// above sell-through, a bigger warehouse only postpones the same cap.
		const structuralAdvice = warehouseCritical
			? isFillingUp
				? `Storage is full (${fillPct}% of ${storageCap.toLocaleString()} bbl) while extraction still matches or outpaces sales, so barrels produced beyond the sales rate are discarded. Price and ad changes cannot clear this and the binding constraint is sell-through capacity; extra storage would only postpone the cap.${
						priceOnTarget
							? " The price is already at or below the configured target band, confirming price is not the constraint."
							: ""
					}`
				: `Storage is full (${fillPct}% of ${storageCap.toLocaleString()} bbl). Confirm extraction volume against the sales rate; any production above it is being discarded. Raise sell-through capacity rather than adding storage.`
			: isFillingUp
				? "Extraction currently matches or outpaces sales, so the warehouse will keep filling until it hits the storage limit. Raise sell-through capacity (Sales Executives, customer volume); more storage would only delay the same outcome."
				: undefined;

		const stateDescription = warehouseCritical
			? isFillingUp
				? `Warehouse is full (${fillPct}%) and cannot drain on its own: extraction matches or exceeds sales.`
				: `Warehouse is effectively full (${fillPct}% full).`
			: netDrainPerDay !== undefined
				? `Inventory is above the healthy buffer (${fillPct}% full) but still draining at ${netDrainPerDay.toLocaleString()} bbl/day.`
				: `Inventory is above the healthy buffer (${fillPct}% full).`;

		return {
			fillPct,
			daysOfSales,
			netDrainPerDay,
			netFillPerDay,
			isFillingUp,
			warehouseCritical,
			state: "surplus",
			stateDescription,
			structuralAdvice,
			recommendedPrice,
			recommendedAdSpend,
		};
	}

	// Equilibrium State: 35% to 75%.
	return {
		fillPct,
		daysOfSales,
		netDrainPerDay,
		netFillPerDay,
		isFillingUp,
		warehouseCritical,
		state: "equilibrium",
		stateDescription: `Inventory is operating in a healthy equilibrium buffer (${fillPct}% full).`,
		recommendedPrice: {
			min: currentPrice,
			max: currentPrice,
			exact: currentPrice,
			action: "maintain",
			formatted: `Maintain at $${currentPrice}/barrel.`,
			rationale: `Maintain current price at $${currentPrice}/barrel; stock is inside the healthy 35%–75% buffer.`,
			changeNeeded: false,
		},
		recommendedAdSpend: {
			amount: adBudget,
			action: "maintain",
			formatted: `Maintain at $${adBudget.toLocaleString()}/day.`,
			rationale: `Maintain current ad spend at $${adBudget.toLocaleString()}/day to sustain customer traffic.`,
			changeNeeded: false,
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
	const topWeekly =
		params.topCompetitorWeeklyIncome ??
		OIL_RIG_BENCHMARKS.topWeeklyRevenueReference;
	const popularityPct = Number(
		((params.weeklyIncome / topWeekly) * 100).toFixed(1),
	);
	const weeklyIncomeGap = Math.max(0, topWeekly - params.weeklyIncome);
	const nextStar = Math.min(10, params.currentStars + 1);

	let recommendation = `Target progression from **${params.currentStars}★ ➔ ${nextStar}★**. Current weekly revenue is $${params.weeklyIncome.toLocaleString()} (${popularityPct}% of the ${OIL_RIG_BENCHMARKS.referenceLabel}). `;

	if (params.addictedCount > 0) {
		recommendation += `Clearing the ${params.addictedCount} addicted employees will immediately restore efficiency to 100% and accelerate daily rating points. `;
	}
	if (params.environment < 100) {
		recommendation += `URGENT: Environment is at ${params.environment}%. Cleaners must restore this to 100% immediately to avert Torn's -33% revenue penalty. `;
	}
	recommendation += `Maintain unbroken daily stock sales and avoid stockouts to accumulate daily director rating stars.`;

	const shortSummary = `Target ${params.currentStars}★ ➔ ${nextStar}★. Weekly revenue: $${Math.round(params.weeklyIncome / 1_000_000)}M (${popularityPct}% of the ${OIL_RIG_BENCHMARKS.referenceLabel}).`;

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
	dailyWages?: number;
	dailyProfit?: number;
	dailyProduced?: number;
	stock: {
		barrelPrice: number;
		inStock: number;
		soldAmount: number;
		fillPct: number;
	};
	metrics: {
		totalAddictionPenalty: number;
		employeesWithAddiction: number;
		emptyEmployeeSlots?: number;
		unsettledEmployees?: number;
	};
}

/**
 * Estimates daily extraction between two snapshots.
 *
 * `sold` is the sales recorded at the *later* snapshot, while the stock delta
 * spans every day between the two samples, so the delta is amortised per day.
 * Snapshots are normally one day apart (gapDays = 1), which reduces to the
 * simple `delta + sold` form; without the division a missed daily tick would
 * report several days of production as a single day's output.
 *
 * Note: when the warehouse is physically full the delta is capped at zero, so
 * this returns the sales rate and *understates* true extraction (the excess is
 * discarded by the game). Treat production == sales at full fill as "extraction
 * at least keeps pace with sales", which is exactly what `isFillingUp` reports.
 */
export function estimateDailyProduced(params: {
	current: { inStock: number; sold: number; timestamp: number };
	previous?: { inStock: number; timestamp: number };
}): number | undefined {
	const { current, previous } = params;
	if (!previous) return undefined;

	const gapDays = Math.max(
		1,
		Math.round((current.timestamp - previous.timestamp) / 86_400),
	);
	const delta = current.inStock - previous.inStock;
	const estimate = current.sold + delta / gapDays;
	return estimate >= 0 ? Math.round(estimate) : undefined;
}

/**
 * Latest *measured* daily extraction from a rolling history, or `undefined` when
 * extraction could not be measured.
 *
 * Production is derived from the stock delta between two snapshots, so a single
 * recorded snapshot cannot measure it. `loadRollingHistory` fills that gap with
 * the day's sales so tables and charts still show something, but that estimate
 * must never be fed to the drain model: "production equals sales" is a strong
 * claim that makes the engine conclude the warehouse cannot drain and recommend a
 * full capacity rebalance. Unknown production is a much quieter state, and this
 * helper is the boundary between the two.
 */
export function latestMeasuredProduction(
	history: OilRigHistoryRecord[],
): number | undefined {
	if (history.length < 2) return undefined;
	return history[history.length - 1]?.dailyProduced;
}

/**
 * Calculates the Date corresponding to Monday 00:00:00 UTC of the week containing date `d`.
 * Weeks strictly run Monday through Sunday in Torn accounting.
 */
export function getMondayOfWeek(d: Date = new Date()): Date {
	const date = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
	);
	const day = date.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
	const diff = (day + 6) % 7; // days elapsed since Monday
	date.setUTCDate(date.getUTCDate() - diff);
	date.setUTCHours(0, 0, 0, 0);
	return date;
}

export interface WeekDayLogEntry {
	isoDate: string;
	dayOfWeek: string;
	revenue: number;
	wages: number;
	adBudget: number;
	profit: number;
	soldBarrels: number;
	producedBarrels?: number;
	barrelPrice: number;
}

export interface WeekToDateSummary {
	entries: WeekDayLogEntry[];
	totalRevenue: number;
	totalWages: number;
	totalAd: number;
	totalProfit: number;
	totalSold: number;
	totalProduced: number;
	mondayIso: string;
	sundayIso: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function buildWeekToDateLogEntries(params: {
	history: OilRigHistoryRecord[];
	referenceDate?: Date;
}): WeekToDateSummary {
	const refDate = params.referenceDate ?? new Date();
	const mondayDate = getMondayOfWeek(refDate);
	const mondayIso = mondayDate.toISOString().slice(0, 10);
	const sundayDate = new Date(mondayDate);
	sundayDate.setUTCDate(mondayDate.getUTCDate() + 6);
	const sundayIso = sundayDate.toISOString().slice(0, 10);

	const entriesMap = new Map<string, WeekDayLogEntry>();

	for (const h of params.history) {
		if (h.isoDate >= mondayIso && h.isoDate <= sundayIso) {
			const d = new Date(`${h.isoDate}T00:00:00Z`);
			const dayOfWeek = DAY_NAMES[d.getUTCDay()] ?? "Mon";
			const wages = h.dailyWages ?? 0;
			const adBudget = h.adBudget ?? 0;
			const profit = h.dailyProfit ?? h.dailyIncome - wages - adBudget;

			entriesMap.set(h.isoDate, {
				isoDate: h.isoDate,
				dayOfWeek,
				revenue: h.dailyIncome,
				wages,
				adBudget,
				profit,
				soldBarrels: h.stock?.soldAmount ?? 0,
				producedBarrels:
					h.dailyProduced !== undefined && h.dailyProduced > 0
						? h.dailyProduced
						: (h.stock?.soldAmount ?? 0) > 0
							? h.stock.soldAmount
							: 0,
				barrelPrice: h.stock?.barrelPrice ?? 0,
			});
		}
	}

	const sortedEntries = Array.from(entriesMap.values()).sort((a, b) =>
		a.isoDate.localeCompare(b.isoDate),
	);

	let totalRevenue = 0;
	let totalWages = 0;
	let totalAd = 0;
	let totalProfit = 0;
	let totalSold = 0;
	let totalProduced = 0;

	for (const e of sortedEntries) {
		totalRevenue += e.revenue;
		totalWages += e.wages;
		totalAd += e.adBudget;
		totalProfit += e.profit;
		totalSold += e.soldBarrels;
		totalProduced += e.producedBarrels ?? 0;
	}

	return {
		entries: sortedEntries,
		totalRevenue,
		totalWages,
		totalAd,
		totalProfit,
		totalSold,
		totalProduced,
		mondayIso,
		sundayIso,
	};
}

function fmtMoney(val: number): string {
	const sign = val < 0 ? "-" : "";
	const abs = Math.abs(val);
	if (abs >= 1_000_000) {
		return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
	}
	if (abs >= 1000) {
		return `${sign}$${(abs / 1000).toFixed(0)}k`;
	}
	return `${sign}$${abs.toFixed(0)}`;
}

function fmtProfit(val: number): string {
	const sign = val > 0 ? "+" : val < 0 ? "-" : "";
	const abs = Math.abs(val);
	if (abs >= 1_000_000) {
		return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
	}
	if (abs >= 1000) {
		return `${sign}$${(abs / 1000).toFixed(0)}k`;
	}
	return `${sign}$${abs.toFixed(0)}`;
}

function fmtThousands(val?: number): string {
	if (val === undefined) return "-";
	return `${Math.round(val / 1000)}k`;
}

export function formatWeekToDateTable(summary: WeekToDateSummary): string {
	if (summary.entries.length === 0) {
		return `_No logs recorded yet for current week (${summary.mondayIso} ➔ ${summary.sundayIso}). Today's snapshot will be recorded as Day 1._`;
	}

	const header =
		"Date   Day    Revenue    Wages     Ad      Profit    Sold   Prod   Price";
	const divider =
		"───────────────────────────────────────────────────────────────────────";

	const rows = summary.entries.map((e) => {
		const dt = e.isoDate.slice(5); // "MM-DD"
		const day = e.dayOfWeek.padEnd(3);
		const rev = fmtMoney(e.revenue).padStart(9);
		const wag = fmtMoney(e.wages).padStart(8);
		const ad = fmtMoney(e.adBudget).padStart(7);
		const prof = fmtProfit(e.profit).padStart(11);
		const sold = fmtThousands(e.soldBarrels).padStart(7);
		const prod = fmtThousands(e.producedBarrels).padStart(6);
		const price = `$${e.barrelPrice}`.padStart(6);

		return `${dt}  ${day}  ${rev}  ${wag}  ${ad}  ${prof}  ${sold}  ${prod}  ${price}`;
	});

	const totRev = fmtMoney(summary.totalRevenue).padStart(9);
	const totWag = fmtMoney(summary.totalWages).padStart(8);
	const totAd = fmtMoney(summary.totalAd).padStart(7);
	const totProf = fmtProfit(summary.totalProfit).padStart(11);
	const totSold = fmtThousands(summary.totalSold).padStart(7);
	const totProd = fmtThousands(summary.totalProduced).padStart(6);
	const totalsRow = `WTD    Tot  ${totRev}  ${totWag}  ${totAd}  ${totProf}  ${totSold}  ${totProd}        `;

	return `\`\`\`\n${header}\n${divider}\n${rows.join("\n")}\n${divider}\n${totalsRow}\n\`\`\``;
}

export function formatWeekToDateSummary(summary: WeekToDateSummary): string {
	const profitSign = summary.totalProfit >= 0 ? "+" : "";
	const operatingCosts = summary.totalWages + summary.totalAd;
	const producedVal =
		summary.entries.length > 0
			? summary.entries.reduce(
					(s, e) => s + (e.producedBarrels ?? 0) * e.barrelPrice,
					0,
				)
			: 0;

	return `• **WTD Net Profit:** **${profitSign}$${summary.totalProfit.toLocaleString()}**
• **WTD Gross Revenue:** **$${summary.totalRevenue.toLocaleString()}**
• **Operating Costs:** **$${operatingCosts.toLocaleString()}** (Wages: $${(summary.totalWages / 1_000_000).toFixed(1)}M | Ad: $${(summary.totalAd / 1_000_000).toFixed(1)}M)
• **Barrels Sold:** **${summary.totalSold.toLocaleString()}** bbl
• **Barrels Produced:** **${summary.totalProduced.toLocaleString()}** bbl${producedVal > 0 ? ` ($${producedVal.toLocaleString()} value)` : ""}`;
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

/**
 * Director-maintained external reference figures.
 *
 * These are NOT measured values and must never be presented as verified facts.
 * To replace them with real numbers, run `scripts/oil-rig/competitor-benchmark.ts`,
 * which pulls live 10* rig profiles (income, customers, staff, role breakdown)
 * from the Torn API, then paste the results here.
 */
export const OIL_RIG_BENCHMARKS = {
	/** Weekly revenue of a top-10* rig, used only as a progression yardstick. */
	topWeeklyRevenueReference: 1_163_000_000,
	/** Label attached to that figure wherever it is shown. */
	referenceLabel: "director-maintained reference target",
} as const;

export interface SellThroughResponseAnalysis {
	/** Number of usable history samples. */
	samples: number;
	/** Change in barrel price across the window, in dollars and percent. */
	priceChange: number;
	priceChangePct: number;
	/** Change in barrels sold per day across the window. */
	volumeChange: number;
	volumeChangePct: number;
	/** Change in daily revenue across the window. */
	revenueChange: number;
	revenueChangePct: number;
	verdict:
		| "insufficient_data"
		| "unresponsive"
		| "partially_responsive"
		| "responsive";
	/** Plain-language conclusion for the briefing and the LLM. */
	summary: string;
}

/**
 * Measures how barrel sales actually responded to recent price changes.
 *
 * This is the check that the old engine never made: it kept recommending price
 * cuts on the assumption that cheaper barrels sell faster, without ever looking
 * at whether the previous cuts had moved any volume at all.
 */
export function analyzeSellThroughResponse(
	history: OilRigHistoryRecord[],
): SellThroughResponseAnalysis {
	const usable = history.filter((h) => (h.stock?.soldAmount ?? 0) > 0);

	if (usable.length < 3) {
		return {
			samples: usable.length,
			priceChange: 0,
			priceChangePct: 0,
			volumeChange: 0,
			volumeChangePct: 0,
			revenueChange: 0,
			revenueChangePct: 0,
			verdict: "insufficient_data",
			summary:
				"Not enough recorded days to measure how sales respond to price yet.",
		};
	}

	// Compare the first and last third of the window so a single odd day cannot
	// drive the conclusion.
	const third = Math.max(1, Math.floor(usable.length / 3));
	const first = usable.slice(0, third);
	const last = usable.slice(-third);
	const avg = (list: typeof usable, pick: (h: OilRigHistoryRecord) => number) =>
		list.reduce((sum, h) => sum + pick(h), 0) / list.length;

	const priceStart = avg(first, (h) => h.stock?.barrelPrice ?? 0);
	const priceEnd = avg(last, (h) => h.stock?.barrelPrice ?? 0);
	const volStart = avg(first, (h) => h.stock?.soldAmount ?? 0);
	const volEnd = avg(last, (h) => h.stock?.soldAmount ?? 0);
	const revStart = avg(first, (h) => h.dailyIncome);
	const revEnd = avg(last, (h) => h.dailyIncome);

	const pct = (start: number, end: number) =>
		start > 0 ? Number((((end - start) / start) * 100).toFixed(1)) : 0;

	const priceChangePct = pct(priceStart, priceEnd);
	const volumeChangePct = pct(volStart, volEnd);
	const revenueChangePct = pct(revStart, revEnd);

	let verdict: SellThroughResponseAnalysis["verdict"] = "unresponsive";
	let summary: string;

	// A "response" only counts if volume actually moved a meaningful fraction of
	// the price move. Without that bar, a rounding-level volume change would be
	// reported as partial success and the price lever would look alive when it is
	// not - which is exactly the mistake that kept the old advice looping.
	const priceMove = Math.abs(priceChangePct);
	const responseRatio = priceMove > 0 ? volumeChangePct / priceMove : 0;

	if (priceChangePct > -1) {
		verdict = "insufficient_data";
		summary = `Price has been broadly flat (${priceChangePct > 0 ? "+" : ""}${priceChangePct}%) over the window, so no price response can be measured. Sales moved ${volumeChangePct > 0 ? "+" : ""}${volumeChangePct}%.`;
	} else if (responseRatio >= 0.75) {
		verdict = "responsive";
		summary = `Sales are price responsive: a ${priceChangePct}% price move produced ${volumeChangePct > 0 ? "+" : ""}${volumeChangePct}% volume, holding revenue ${revenueChangePct > 0 ? "+" : ""}${revenueChangePct}%.`;
	} else if (responseRatio >= 0.25) {
		verdict = "partially_responsive";
		summary = `Price cuts are only partly effective: ${priceChangePct}% off the barrel price bought just ${volumeChangePct > 0 ? "+" : ""}${volumeChangePct}% volume, leaving revenue ${revenueChangePct > 0 ? "+" : ""}${revenueChangePct}%.`;
	} else {
		verdict = "unresponsive";
		summary = `Price cuts are NOT working: ${priceChangePct}% off the barrel price produced ${volumeChangePct}% volume and ${revenueChangePct}% revenue. Sell-through is demand-capped, so price is not the lever.`;
	}

	return {
		samples: usable.length,
		priceChange: Number((priceEnd - priceStart).toFixed(2)),
		priceChangePct,
		volumeChange: Math.round(volEnd - volStart),
		volumeChangePct,
		revenueChange: Math.round(revEnd - revStart),
		revenueChangePct,
		verdict,
		summary,
	};
}

/**
 * Estimates how many barrels per day are being produced beyond what the rig can
 * sell, i.e. output that is discarded once the warehouse is at capacity.
 *
 * Daily production is derived from stock deltas, which are capped at zero when
 * the warehouse is full, so the *capped* days understate true extraction. The
 * uncapped days in the window are therefore the honest evidence, and the median
 * of their surplus is used so one unusual day cannot drive the figure.
 */
export function estimateDiscardedBarrels(
	history: OilRigHistoryRecord[],
	criticalFillPct = 95,
): { medianSurplus: number; peakSurplus: number; samples: number } {
	const surpluses = history
		.filter((h) => (h.stock?.fillPct ?? 0) < criticalFillPct)
		.map((h) => (h.dailyProduced ?? 0) - (h.stock?.soldAmount ?? 0))
		.filter((value) => value > 0)
		.sort((a, b) => a - b);

	if (surpluses.length === 0) {
		return { medianSurplus: 0, peakSurplus: 0, samples: 0 };
	}

	const mid = Math.floor(surpluses.length / 2);
	const median =
		surpluses.length % 2 === 0
			? ((surpluses[mid - 1] ?? 0) + (surpluses[mid] ?? 0)) / 2
			: (surpluses[mid] ?? 0);

	return {
		medianSurplus: Math.round(median),
		peakSurplus: Math.round(surpluses[surpluses.length - 1] ?? 0),
		samples: surpluses.length,
	};
}

/**
 * Extraction-side roles, in the order capacity is given up once stock cannot
 * clear. Motor Hands and Derrick Hands are auxiliary, so they are drawn down
 * before drillers.
 */
const EXTRACTION_SIDE_ROLES = [
	"Motor Hand",
	"Derrick Hand",
	"Driller",
] as const;

/** The role that clears stock instead of adding to it. */
const SELL_THROUGH_ROLE = "Sales Executive";

export const OIL_RIG_CAPACITY_POLICY = {
	/**
	 * Every extraction-side role keeps at least this many seats. Drilling also
	 * stops entirely without a driller, so this is a hard floor, not a nicety.
	 */
	minExtractionRoleCount: 1,
	/** Seats moved from extraction into sell-through in one rebalance. */
	maxShift: 2,
	/** Most seats taken from any single role, so a rebalance stays measured. */
	maxShiftPerRole: 1,
	/** Open seats proposed for hiring into sell-through. */
	maxHiresPerPlan: 2,
} as const;

export interface QuotaShift {
	role: string;
	from: number;
	to: number;
}

/**
 * Re-shapes the blueprint quotas for the current bottleneck.
 *
 * `getOptimalRoleQuotas` encodes a fixed long-run progression blueprint. It is
 * the right target in general, but it is blind to the current constraint: while
 * extraction outruns sell-through, every extra extraction seat produces barrels
 * that get discarded, so the seat worth holding is sell-through.
 *
 * Shifting the *quota* rather than moving named employees keeps one source of
 * truth: the optimal assignment is still solved once against the adjusted
 * quotas, so the recommended lineup can never contradict the rebalance advice.
 */
export function buildBottleneckQuotas(
	baseQuotas: Record<string, number>,
	options?: { extractionBound?: boolean; maxShift?: number },
): { quotas: Record<string, number>; shifts: QuotaShift[] } {
	const quotas = { ...baseQuotas };
	const shifts: QuotaShift[] = [];
	if (!options?.extractionBound) return { quotas, shifts };

	const maxShift = options.maxShift ?? OIL_RIG_CAPACITY_POLICY.maxShift;
	let shifted = 0;

	for (const role of EXTRACTION_SIDE_ROLES) {
		if (shifted >= maxShift) break;
		const current = quotas[role] ?? 0;
		const floor = OIL_RIG_CAPACITY_POLICY.minExtractionRoleCount;
		const take = Math.min(
			Math.max(0, current - floor),
			OIL_RIG_CAPACITY_POLICY.maxShiftPerRole,
			maxShift - shifted,
		);
		if (take <= 0) continue;

		quotas[role] = current - take;
		shifts.push({ role, from: current, to: current - take });
		shifted += take;
	}

	if (shifted > 0) {
		const current = quotas[SELL_THROUGH_ROLE] ?? 0;
		quotas[SELL_THROUGH_ROLE] = current + shifted;
		shifts.push({
			role: SELL_THROUGH_ROLE,
			from: current,
			to: current + shifted,
		});
	}

	return { quotas, shifts };
}

export interface CapacityRebalanceAction {
	kind: "rebalance" | "hire" | "storage";
	reason: string;
	/** Upper-bound revenue per day this unlocks, at the current barrel price. */
	estimatedGainPerDay: number;
	/** True when the change should be undone once stock normalises. */
	temporary: boolean;
}

export interface CapacityRebalancePlan {
	/** True when extraction structurally outruns what the rig can sell. */
	extractionBound: boolean;
	/** Barrels per day being produced beyond sell-through. */
	discardedBarrelsPerDay: number;
	/** Value of those barrels at the current price (upper bound). */
	discardedValuePerDay: number;
	/** Quota moves that carry the rebalance into the target lineup. */
	quotaShifts: QuotaShift[];
	/** Sell-through seats to fill from open capacity. */
	hires: number;
	actions: CapacityRebalanceAction[];
	summary: string;
}

/**
 * Plans a roster rebalance when the warehouse is full because extraction
 * outruns sell-through.
 *
 * The economics are decisive: advertising and pricing only try to shift demand,
 * but a barrel that cannot be stored is worth nothing at all, while a barrel
 * that clears is worth its full sale price (wages are committed either way). So
 * the cheapest fix is to move capacity from extraction into sell-through. The
 * seat moves are handed to the roster solver via `buildBottleneckQuotas`, and
 * every gain is an upper bound because the marginal sell-through of a single
 * Sales Executive is not observable from the API.
 */
export function planCapacityRebalance(params: {
	/** Staff count the blueprint quotas are derived from. */
	staffCount: number;
	stock: StockAnalysis;
	barrelPrice: number;
	openSeats: number;
	/** Extra barrels/day produced beyond sales, from uncapped history. */
	discardedBarrelsPerDay?: number;
}): CapacityRebalancePlan {
	const policy = OIL_RIG_CAPACITY_POLICY;
	const { stock } = params;
	const extractionBound = stock.isFillingUp || stock.warehouseCritical;
	const discarded = Math.max(
		0,
		Math.round(params.discardedBarrelsPerDay ?? stock.netFillPerDay ?? 0),
	);
	const discardedValuePerDay = discarded * params.barrelPrice;

	const empty: CapacityRebalancePlan = {
		extractionBound: false,
		discardedBarrelsPerDay: 0,
		discardedValuePerDay: 0,
		quotaShifts: [],
		hires: 0,
		actions: [],
		summary:
			"Extraction and sell-through are balanced, so no rebalancing is needed.",
	};
	if (!extractionBound) return empty;

	const base = getOptimalRoleQuotas(params.staffCount);
	const { shifts } = buildBottleneckQuotas(base, { extractionBound });
	const salesShift = shifts.find((s) => s.role === SELL_THROUGH_ROLE);
	const shiftedSeats = salesShift ? salesShift.to - salesShift.from : 0;
	const drawnFrom = shifts
		.filter((s) => s.role !== SELL_THROUGH_ROLE)
		.map((s) => `${s.role} ${s.from} ➔ ${s.to}`)
		.join(", ");

	const actions: CapacityRebalanceAction[] = [];

	// 1. Reallocate first: moving an existing employee adds no wage cost, which
	//    matters when the wage bill is already the heaviest cost on the rig.
	if (shiftedSeats > 0 && salesShift) {
		actions.push({
			kind: "rebalance",
			reason: `${shiftedSeats} seat${shiftedSeats > 1 ? "s" : ""} move into ${SELL_THROUGH_ROLE} (${salesShift.from} ➔ ${salesShift.to}), taken from extraction-side headcount (${drawnFrom}), because extraction already outruns what the rig can sell. Reallocating adds no wage cost, and the target lineup reflects it.`,
			estimatedGainPerDay: discardedValuePerDay,
			temporary: true,
		});
	}

	// 2. Open seats add sell-through without taking anything out of extraction.
	const hires = Math.min(Math.max(0, params.openSeats), policy.maxHiresPerPlan);
	if (hires > 0) {
		actions.push({
			kind: "hire",
			reason: `${hires} unfilled seat${hires > 1 ? "s" : ""} can also be hired straight into ${SELL_THROUGH_ROLE} roles, which raises sell-through without reducing extraction at all.`,
			estimatedGainPerDay: discardedValuePerDay,
			temporary: false,
		});
	}

	// 3. Storage only ever postpones this, so it is a fallback, never a fix.
	if (actions.length === 0) {
		actions.push({
			kind: "storage",
			reason:
				"No seat can be shifted out of extraction and no seat is free, so sell-through capacity cannot rise right now. Extra storage would only postpone the cap rather than remove it.",
			estimatedGainPerDay: 0,
			temporary: false,
		});
	}

	const summary =
		discarded > 0
			? `Extraction outruns sell-through by about ${discarded.toLocaleString()} bbl/day (~$${discardedValuePerDay.toLocaleString()}/day at $${params.barrelPrice}/bbl), so those barrels are discarded while storage is full. Reallocate capacity into ${SELL_THROUGH_ROLE}.`
			: `Extraction outruns sell-through, so the warehouse cannot drain on its own. Reallocate capacity into ${SELL_THROUGH_ROLE}.`;

	return {
		extractionBound: true,
		discardedBarrelsPerDay: discarded,
		discardedValuePerDay,
		quotaShifts: shifts,
		hires,
		actions,
		summary,
	};
}
