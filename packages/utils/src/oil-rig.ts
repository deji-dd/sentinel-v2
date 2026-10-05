import {
	type AdRankModel,
	type AdRecommendation,
	type AdResponseEstimate,
	recommendAdBudget,
} from "./oil-rig-advertising";
import { type BarrelDemandFit, fitBarrelDemand } from "./oil-rig-demand";
import {
	OIL_RIG_POLICY,
	type OilRigCapacityPolicy,
	type OilRigInventoryState,
	type OilRigPolicy,
	resolveInventoryState,
	resolveWarehouseCritical,
} from "./oil-rig-policy";

// The tuning lives in `oil-rig-policy.ts` so all four engines are configured in
// one place; these names stay re-exported here because that is where callers have
// always imported them from.
export {
	OIL_RIG_CAPACITY_POLICY,
	OIL_RIG_POLICY,
	resolveInventoryState,
	resolveWarehouseCritical,
} from "./oil-rig-policy";

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
 * The hand-written fallback roster blueprint.
 *
 * Maps total staff count to target role counts based on the 10★ Oil Rig blueprint
 * (Benchmark: 8 Driller, 7 Sales, 6 Roughneck, 4 Derrick, 3 Motor, 2 Secretary).
 *
 * This is a guess refined by hand. Where a measured baseline of how the top rigs
 * in the game are actually staffed is available, `getOptimalRoleQuotas` prefers
 * it; see `deriveRosterBaseline`.
 */
function blueprintRoleQuotas(staffCount: number): Record<string, number> {
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

/** A measured roster baseline: how the best-staffed rigs in the industry look. */
export interface RosterBaseline {
	/** Where the numbers came from, for rendering and audit. */
	source: string;
	/** Role -> share of total staff (0..1). Normalised on derivation. */
	roleShares: Record<string, number>;
	/** Rating band the baseline describes. */
	rating: number;
	/** Capture time, epoch seconds. */
	capturedAt: number;
	/** Rigs sampled. */
	sampleSize: number;
	/** Industry field size at capture, reused by the advertising rank model. */
	fieldSize?: number;
	avgWeeklyRevenue?: number;
}

/** Row shape of a stored benchmark capture, decoupled from the ORM types. */
export interface RosterBaselineRow {
	capturedAt: Date | number | string;
	rating: number;
	fieldSize: number;
	sampleSize: number;
	roleShares: Record<string, number>;
	avgWeeklyRevenue?: number;
}

/**
 * The role order used everywhere - slot expansion, quota diffs, rendering - so
 * two runs over the same data always iterate roles in the same sequence and
 * therefore always produce the same answer.
 */
export const OIL_RIG_ROLE_ORDER: OilRigRoleName[] = [
	"Driller",
	"Sales Executive",
	"Roughneck",
	"Derrick Hand",
	"Motor Hand",
	"Secretary",
];

/**
 * Turns a measured benchmark capture into a usable baseline.
 *
 * Returns undefined rather than a default when the capture is missing or stale:
 * an out-of-date picture of the top rigs is not obviously better than the
 * hand-written blueprint, and silently substituting one for the other would make
 * the advice change for reasons the director cannot see.
 *
 * An override is not applied silently either - the caller records
 * `baseline.source` so the brief can state which blueprint it steered toward.
 */
export function deriveRosterBaseline(
	row: RosterBaselineRow | undefined | null,
	options?: { maxAgeDays?: number; asOfSeconds?: number },
): RosterBaseline | undefined {
	if (!row) return undefined;
	const maxAgeDays = options?.maxAgeDays ?? 45;
	const capturedAt =
		row.capturedAt instanceof Date
			? Math.floor(row.capturedAt.getTime() / 1000)
			: typeof row.capturedAt === "number"
				? row.capturedAt
				: Math.floor(new Date(row.capturedAt).getTime() / 1000);
	if (!Number.isFinite(capturedAt)) return undefined;

	const asOf = options?.asOfSeconds ?? Math.floor(Date.now() / 1000);
	if (asOf - capturedAt > maxAgeDays * 86_400) return undefined;

	const entries = Object.entries(row.roleShares ?? {}).filter(
		([role, share]) =>
			role in OIL_RIG_ROLES && Number.isFinite(share) && share > 0,
	);
	const total = entries.reduce((sum, [, share]) => sum + share, 0);
	if (entries.length === 0 || total <= 0) return undefined;

	const roleShares: Record<string, number> = {};
	for (const [role, share] of entries) {
		roleShares[role] = share / total;
	}

	return {
		source: `top-${row.rating}★ rig benchmark captured ${new Date(capturedAt * 1000).toISOString().slice(0, 10)} across ${row.sampleSize} rig${row.sampleSize === 1 ? "" : "s"}`,
		roleShares,
		rating: row.rating,
		capturedAt,
		sampleSize: row.sampleSize,
		fieldSize: row.fieldSize,
		avgWeeklyRevenue: row.avgWeeklyRevenue,
	};
}

/**
 * Scales a measured baseline to an exact headcount.
 *
 * Uses the largest-remainder method with a fixed role order, so the counts sum
 * to `staffCount` exactly and are reproducible; naive rounding can leave the
 * quotas short of or over the roster size, which previously left employees
 * assigned to no target role at all.
 */
export function quotaFromBaseline(
	staffCount: number,
	baseline: RosterBaseline,
): Record<string, number> {
	if (staffCount <= 0) return {};
	const ordered = [
		...OIL_RIG_ROLE_ORDER.filter(
			(role) => (baseline.roleShares[role] ?? 0) > 0,
		),
		...Object.keys(baseline.roleShares)
			.filter(
				(role) =>
					!(OIL_RIG_ROLE_ORDER as string[]).includes(role) &&
					(baseline.roleShares[role] ?? 0) > 0,
			)
			.sort(),
	];
	if (ordered.length === 0) return {};
	if (staffCount < ordered.length) {
		// Fewer seats than roles: fill the most heavily weighted roles first.
		const byShare = [...ordered].sort(
			(a, b) =>
				(baseline.roleShares[b] ?? 0) - (baseline.roleShares[a] ?? 0) ||
				OIL_RIG_ROLE_ORDER.indexOf(a as OilRigRoleName) -
					OIL_RIG_ROLE_ORDER.indexOf(b as OilRigRoleName),
		);
		const quotas: Record<string, number> = {};
		for (const role of byShare.slice(0, staffCount)) quotas[role] = 1;
		return quotas;
	}

	const quotas: Record<string, number> = {};
	const remainders: Array<{ role: string; remainder: number }> = [];
	let assigned = 0;
	for (const role of ordered) {
		const exact = (baseline.roleShares[role] ?? 0) * staffCount;
		const base = Math.floor(exact);
		quotas[role] = base;
		assigned += base;
		remainders.push({ role, remainder: exact - base });
	}

	remainders.sort(
		(a, b) =>
			b.remainder - a.remainder ||
			OIL_RIG_ROLE_ORDER.indexOf(a.role as OilRigRoleName) -
				OIL_RIG_ROLE_ORDER.indexOf(b.role as OilRigRoleName),
	);
	let index = 0;
	while (assigned < staffCount && remainders.length > 0) {
		const next = remainders[index % remainders.length];
		if (next) {
			quotas[next.role] = (quotas[next.role] ?? 0) + 1;
			assigned += 1;
		}
		index += 1;
	}

	return quotas;
}

/**
 * The roster blueprint to steer toward.
 *
 * Prefers a measured top-rig baseline when one is supplied and fresh; otherwise
 * falls back to the hand-written blueprint. The baseline is passed in rather than
 * read here so the engine stays pure and the same inputs always give the same
 * answer.
 */
export function getOptimalRoleQuotas(
	staffCount: number,
	baseline?: RosterBaseline,
): Record<string, number> {
	if (staffCount <= 0) return {};
	if (baseline) {
		const measured = quotaFromBaseline(staffCount, baseline);
		if (Object.keys(measured).length > 0) return measured;
	}
	return blueprintRoleQuotas(staffCount);
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
	/** Current headcount per role, so a capacity plan can be idempotent. */
	currentCounts: Record<string, number>;
	/** Which blueprint the quotas came from, for audit and rendering. */
	blueprintSource: string;
	rehabTiers: {
		tier1: Array<{ name: string; penalty: number; role: string }>;
		tier2: Array<{ name: string; penalty: number; role: string }>;
		tier3: Array<{ name: string; penalty: number; role: string }>;
	};
}

export interface SolveRosterOptions {
	bottleneck?: { extractionBound?: boolean; maxShift?: number };
	/** Measured top-rig baseline to steer toward, when one is available. */
	baseline?: RosterBaseline;
}

const UNASSIGNED = "Unassigned";

/** The role an employee currently holds, normalised. */
export function roleOfEmployee(employee: EmployeeData): string {
	const name = employee.position?.name ?? employee.positionName;
	return name && name.trim() !== "" ? name : UNASSIGNED;
}

/** Current headcount per role. */
export function countRoles(employees: EmployeeData[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const employee of employees) {
		const role = roleOfEmployee(employee);
		counts[role] = (counts[role] ?? 0) + 1;
	}
	return counts;
}

/**
 * Stable sort key. The API and the database are free to return employees in any
 * order, and the solver's output must not depend on that: two briefs over
 * identical data that named different people to move is exactly the "it told me
 * something different" failure. Ordering by id (falling back to name) fixes it.
 */
function employeeSortKey(employee: EmployeeData): string {
	const id =
		employee.id === undefined ? "" : String(employee.id).padStart(12, "0");
	return `${id}|${employee.name}`;
}

/** Roles to consider, in a fixed order, so every loop is reproducible. */
function orderedQuotaRoles(quotas: Record<string, number>): string[] {
	const known = OIL_RIG_ROLE_ORDER.filter((role) => (quotas[role] ?? 0) > 0);
	const extra = Object.keys(quotas)
		.filter(
			(role) =>
				!(OIL_RIG_ROLE_ORDER as string[]).includes(role) &&
				(quotas[role] ?? 0) > 0,
		)
		.sort();
	return [...known, ...extra];
}

function _expandSlots(quotas: Record<string, number>): OilRigRoleName[] {
	const slots: OilRigRoleName[] = [];
	for (const role of orderedQuotaRoles(quotas)) {
		const count = Math.max(0, Math.floor(quotas[role] ?? 0));
		for (let i = 0; i < count; i++) slots.push(role as OilRigRoleName);
	}
	return slots;
}

/**
 * How well an employee fits a role, including the strategic domain anchors the
 * engine has always applied (a very high-INT worker anchors sales, a very high-MAN
 * worker anchors drilling).
 */
function fitScore(employee: EmployeeData, role: OilRigRoleName): number {
	const roleDef = OIL_RIG_ROLES[role];
	if (!roleDef) return 0;
	const stats = employee.stats ?? {};
	const manLabor = stats.manual_labor ?? stats.manualLabor ?? 0;
	const intelligence = stats.intelligence ?? 0;

	let score = calcRoleFit(employee.stats, roleDef);
	if (intelligence >= 400_000 && role === "Sales Executive") score += 50;
	if (manLabor >= 300_000 && role === "Driller") score += 50;
	return Number.isFinite(score) ? score : 0;
}

/** Stats highlight and rationale shown beside a recommended move. */
function describeTransfer(
	employee: EmployeeData,
	fromRole: string,
	toRole: string,
): { statsStr: string; rationale: string } {
	const stats = employee.stats ?? {};
	const manK = `${Math.round((stats.manual_labor ?? stats.manualLabor ?? 0) / 1000)}k MAN`;
	const intK = `${Math.round((stats.intelligence ?? 0) / 1000)}k INT`;
	const endK = `${Math.round((stats.endurance ?? 0) / 1000)}k END`;

	let statsStr = manK;
	let rationale = "Optimizes department balance";
	if (fromRole === UNASSIGNED) {
		rationale = `Initial placement into ${toRole}`;
		if (toRole === "Sales Executive") statsStr = intK;
		else if (toRole === "Secretary") statsStr = endK;
	} else if (toRole === "Driller") {
		statsStr = manK;
		rationale = "Anchors drilling throughput";
	} else if (toRole === "Sales Executive") {
		statsStr = intK;
		rationale = "Expands sales volume";
	} else if (toRole === "Roughneck") {
		statsStr = manK;
		rationale = "Cleaner, protects 100% Environment";
	} else if (toRole === "Secretary") {
		statsStr = endK;
		rationale = "Corporate analytics";
	} else if (toRole === "Derrick Hand") {
		statsStr = manK;
		rationale = "Platform stability";
	} else if (toRole === "Motor Hand") {
		statsStr = manK;
		rationale = "Machinery maintenance";
	}
	return { statsStr, rationale };
}

/**
 * Solves the target lineup.
 *
 * WHY TWO PASSES. The previous version maximised total role fit subject only to a
 * small "already in this role" bonus, which made churn an optimisation variable
 * rather than a constraint. Two consequences, both reproduced:
 *
 *  - a quota change of two seats moved eight people, because a better global
 *    assignment was worth more than the inertia bonus; and
 *  - a roster already exactly on the blueprint was still told to swap two
 *    employees, because the fit scores are close enough that the solver preferred
 *    a different-but-equally-good matching and named a different pair depending
 *    on the order the employees arrived in.
 *
 * So "who keeps their job" is decided first, deterministically, and the Hungarian
 * matching is used only on the employees who could not be settled. Moves are then
 * proportional to the quota delta - which is the quantity the director is
 * actually being asked to change - instead of to the spread of fit scores.
 */
export function solveOptimalRoster(
	employees: EmployeeData[],
	options?: SolveRosterOptions,
): OptimalRosterResult {
	const ordered = [...employees].sort((a, b) =>
		employeeSortKey(a).localeCompare(employeeSortKey(b)),
	);

	const baseQuotas = getOptimalRoleQuotas(ordered.length, options?.baseline);
	// The blueprint is the long-run target, but a warehouse that cannot clear
	// changes which seats are worth holding, so re-shape it before assigning.
	// Doing it here keeps one source of truth: a single assignment solves both the
	// blueprint and the bottleneck, so advice can never contradict itself.
	const { quotas } = buildBottleneckQuotas(baseQuotas, {
		extractionBound: options?.bottleneck?.extractionBound ?? false,
		maxShift: options?.bottleneck?.maxShift,
	});

	const currentCounts = countRoles(ordered);
	const quotaRoles = orderedQuotaRoles(quotas);

	// ---- Pass 1: settle incumbents into their existing roles -------------------
	const assigned: Array<string | undefined> = new Array(ordered.length).fill(
		undefined,
	);
	const seatsLeft: Record<string, number> = {};
	for (const role of quotaRoles) {
		seatsLeft[role] = Math.max(0, Math.floor(quotas[role] ?? 0));
	}

	for (const role of quotaRoles) {
		const seats = seatsLeft[role] ?? 0;
		if (seats <= 0) continue;
		const incumbents = ordered
			.map((employee, index) => ({ index, employee }))
			.filter(({ employee }) => roleOfEmployee(employee) === role)
			.map(({ index, employee }) => ({
				index,
				fit: fitScore(employee, role as OilRigRoleName),
			}))
			// The best-fitting incumbents keep their seats, so a role that is over
			// quota sheds its weakest members rather than an arbitrary pair. Exact
			// ties fall back to the stable employee order.
			.sort((a, b) => b.fit - a.fit || a.index - b.index);

		const keep = incumbents.slice(0, seats);
		for (const { index } of keep) assigned[index] = role;
		seatsLeft[role] = seats - keep.length;
	}

	// ---- Pass 2: optimise only the unsettled employees ------------------------
	const unmatched: number[] = [];
	for (let index = 0; index < ordered.length; index++) {
		if (assigned[index] === undefined) unmatched.push(index);
	}

	const openSlots: OilRigRoleName[] = [];
	for (const role of quotaRoles) {
		const seats = seatsLeft[role] ?? 0;
		for (let i = 0; i < seats; i++) openSlots.push(role as OilRigRoleName);
	}

	if (unmatched.length > 0 && openSlots.length > 0) {
		const costMatrix = unmatched.map((index) => {
			const employee = ordered[index];
			return employee
				? openSlots.map((role) => fitScore(employee, role))
				: openSlots.map(() => 0);
		});
		const match = maxWeightBipartiteMatching(costMatrix);
		unmatched.forEach((index, row) => {
			const slotIdx = match[row] ?? -1;
			const role = openSlots[slotIdx];
			if (role !== undefined) assigned[index] = role;
		});
	}

	// ---- Outputs --------------------------------------------------------------
	const activeTransfers: ActiveTransfer[] = [];
	const lockedEmployees: Array<{ name: string; role: string }> = [];
	const rosterByRole: Record<string, string[]> = {};

	ordered.forEach((employee, index) => {
		const currentRole = roleOfEmployee(employee);
		// Employees with no seat left keep the role they already hold rather than
		// being invented into one; the quotas are a target, not a straitjacket.
		const assignedRole = assigned[index] ?? currentRole;

		if (!rosterByRole[assignedRole]) rosterByRole[assignedRole] = [];
		rosterByRole[assignedRole].push(employee.name);

		if (currentRole !== assignedRole) {
			const { statsStr, rationale } = describeTransfer(
				employee,
				currentRole,
				assignedRole,
			);
			activeTransfers.push({
				name: employee.name,
				fromRole: currentRole,
				toRole: assignedRole,
				statsStr,
				rationale,
			});
		} else {
			lockedEmployees.push({ name: employee.name, role: assignedRole });
		}
	});

	for (const role of Object.keys(rosterByRole)) {
		rosterByRole[role]?.sort((a, b) => a.localeCompare(b));
	}
	activeTransfers.sort((a, b) => a.name.localeCompare(b.name));
	lockedEmployees.sort((a, b) => a.name.localeCompare(b.name));

	// Rehab Tiers: worst addiction first, name as the stable tie-break.
	const addicted = ordered
		.filter((employee) => (employee.effectiveness?.addiction ?? 0) < 0)
		.sort((a, b) => {
			const diff =
				(a.effectiveness?.addiction ?? 0) - (b.effectiveness?.addiction ?? 0);
			return diff !== 0 ? diff : a.name.localeCompare(b.name);
		});

	const tier1: Array<{ name: string; penalty: number; role: string }> = [];
	const tier2: Array<{ name: string; penalty: number; role: string }> = [];
	const tier3: Array<{ name: string; penalty: number; role: string }> = [];

	for (const employee of addicted) {
		const penalty = employee.effectiveness?.addiction ?? 0;
		const role = roleOfEmployee(employee);
		if (penalty <= -10) {
			tier1.push({ name: employee.name, penalty, role });
		} else if (penalty <= -6) {
			tier2.push({ name: employee.name, penalty, role });
		} else {
			tier3.push({ name: employee.name, penalty, role });
		}
	}

	return {
		targetQuotas: quotas,
		activeTransfers,
		lockedEmployees,
		rosterByRole,
		currentCounts,
		blueprintSource: options?.baseline
			? options.baseline.source
			: "built-in hand-written blueprint",
		rehabTiers: { tier1, tier2, tier3 },
	};
}

/** How a day's extraction figure was established. */
export type ProductionConfidence = "none" | "low" | "medium" | "high";

export interface ProductionEstimate {
	/** Smoothed barrels/day, or undefined when extraction was never measurable. */
	dailyProduced?: number;
	/** Measured days the estimate rests on. */
	samples: number;
	confidence: ProductionConfidence;
	/** Individual measured values, most recent last. */
	values: number[];
	/** True when the most recent records were taken at full storage. */
	capped: boolean;
	summary: string;
}

/**
 * The production values in a history that are genuinely measured.
 *
 * This is the single definition of "measured", and every estimator uses it, so
 * the drain model, the discard estimate and the capacity regime can never
 * disagree about which days count.
 *
 * Two rules, both of which exist because of a bug this codebase already had:
 *
 *  - A record whose `producedMeasured` is explicitly false was filled in for
 *    display only and is not evidence of anything.
 *  - The FIRST record in a window can never be measured, whatever it claims:
 *    production is derived from the change in stored barrels between two records,
 *    and the first record has no predecessor to difference against. Treating it as
 *    measured makes "production equals sales" look observed, which declares the
 *    warehouse unable to drain and triggers a roster restructure off a single row.
 */
export function measuredProductionValues(
	history: OilRigHistoryRecord[],
): number[] {
	const values: number[] = [];
	history.forEach((record, index) => {
		if (index === 0 && record.producedMeasured !== true) return;
		if (record.producedMeasured === false) return;
		const value = record.dailyProduced;
		if (value === undefined || value <= 0) return;
		values.push(value);
	});
	return values;
}

/**
 * Smoothed extraction estimate with an explicit confidence.
 *
 * A single stock delta is a weak basis for a decision as consequential as
 * restructuring the roster, so the estimate is the median of the last few
 * *measured* days, and the confidence is reported alongside it so the advice can
 * downgrade itself when the sample is thin.
 */
export function estimateMeasuredProduction(
	history: OilRigHistoryRecord[],
	options?: { policy?: OilRigCapacityPolicy; latestMeasured?: number },
): ProductionEstimate {
	const policy = options?.policy ?? OIL_RIG_POLICY.capacity;
	const measured = measuredProductionValues(history);

	if (
		options?.latestMeasured !== undefined &&
		options.latestMeasured > 0 &&
		measured[measured.length - 1] !== options.latestMeasured
	) {
		measured.push(options.latestMeasured);
	}

	const values = measured.slice(-policy.smoothedProductionDays);
	const lastRecord = history[history.length - 1];
	const capped =
		(lastRecord?.stock?.fillPct ?? 0) >=
		OIL_RIG_POLICY.inventory.criticalEnterPct;

	if (values.length === 0) {
		return {
			samples: 0,
			confidence: "none",
			values: [],
			capped,
			summary:
				"Extraction could not be measured: it is derived from the change in stored barrels between two recorded days, and no usable pair of days exists yet.",
		};
	}

	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
			: (sorted[mid] ?? 0);
	const dailyProduced = Math.round(median);

	const confidence: ProductionConfidence =
		values.length >= policy.confidentProductionSamples
			? "high"
			: values.length >= 2
				? "medium"
				: "low";

	return {
		dailyProduced,
		samples: values.length,
		confidence,
		values,
		capped,
		summary: `Extraction of about ${dailyProduced.toLocaleString()} bbl/day, the median of ${values.length} measured day${values.length === 1 ? "" : "s"} (${confidence} confidence).${
			capped
				? " Storage was at or above the critical fill on the most recent record, where the stock delta is clamped at zero, so true extraction is at least this high."
				: ""
		}${confidence === "low" ? " One measured day is not enough to separate a real rate from a single unusual day." : ""}`,
	};
}

/** Whether the barrel price has been shown to move volume on this rig. */
export type PriceLeverVerdict = "works" | "does_not_work" | "unknown";

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
	/**
	 * True when this state was carried over from the previous brief rather than
	 * re-entered. The state is hysteretic, so "held" is the expected reading while
	 * the warehouse sits between the enter and exit thresholds.
	 */
	stateHeld: boolean;
	stateDescription: string;
	/** Set when the surplus is structural and no price/ad setting can clear it. */
	structuralAdvice?: string;
	/** How extraction was measured, and how much to trust it. */
	production: ProductionEstimate;
	/** Whether price has been shown to move volume on this rig. */
	priceLever: PriceLeverVerdict;
	/** The fitted demand curve, usable or not, so the reader sees the evidence. */
	demand: BarrelDemandFit;
	recommendedPrice: {
		min: number;
		max: number;
		exact: number;
		action: "increase" | "maintain" | "decrease";
		formatted: string;
		rationale: string;
		/** True only while the current setting differs from the target. */
		changeNeeded: boolean;
		/** What the recommendation rests on. */
		basis:
			| "demand_fit"
			| "inventory_buffer"
			| "measured_unresponsive"
			| "policy_band";
		confidence: ProductionConfidence;
	};
	recommendedAdSpend: {
		amount: number;
		action: "freeze" | "maintain" | "increase" | "decrease";
		formatted: string;
		rationale: string;
		/** True only while the current setting differs from the target. */
		changeNeeded: boolean;
		basis: string;
	};
	/** The economic frame for advertising: what one rank step is worth. */
	adRankModel: AdRankModel;
	/** What this rig's own past ad budget changes actually bought. */
	adResponse: AdResponseEstimate;
}

/** Sentinel for `daysOfSales` meaning the warehouse will not drain on its own. */
export const INFINITE_DAYS_OF_SALES = 999;

/**
 * Recommends a barrel price from measured demand rather than a fixed band.
 *
 * Order of precedence, and why:
 *
 * 1. A deficit overrides revenue maximisation. When the warehouse is short the
 *    objective is to rebuild it, so the price is held high to slow sell-through.
 * 2. When price has been MEASURED not to move volume, no price change is
 *    recommended at all. The old engine computed exactly that verdict in
 *    `analyzeSellThroughResponse` and printed it in the same briefing while
 *    simultaneously recommending a price cut - the brief contradicted itself.
 * 3. A trustworthy fitted demand curve supplies the revenue-maximising price.
 * 4. With no usable fit, the policy band supplies a fallback, and the
 *    recommendation says so instead of implying a measurement.
 *
 * Movement is capped at `maxStepPerAdvice` and suppressed entirely below
 * `deadband`, so a boundary case cannot produce a $1 demand on every fetch.
 */
export function recommendBarrelPrice(input: {
	currentPrice: number;
	state: OilRigInventoryState;
	priceLever: PriceLeverVerdict;
	demand: BarrelDemandFit;
	policy?: OilRigPolicy;
}): StockAnalysis["recommendedPrice"] {
	const policy = (input.policy ?? OIL_RIG_POLICY).price;
	const current = input.currentPrice;
	const clamp = (value: number) =>
		Math.max(policy.floor, Math.min(policy.ceiling, Math.round(value)));

	const hold = (
		rationale: string,
		basis: StockAnalysis["recommendedPrice"]["basis"],
		confidence: ProductionConfidence = "high",
	) => ({
		min: current,
		max: current,
		exact: current,
		action: "maintain" as const,
		formatted: `Maintain at $${current}/barrel.`,
		rationale,
		changeNeeded: false,
		basis,
		confidence,
	});

	const demandConfident =
		input.demand.usable && input.demand.r2 >= policy.minR2ForFit;

	// 1. Deficit: rebuild reserves by slowing sell-through.
	if (input.state === "deficit") {
		const anchor = clamp(policy.deficitHoldPrice);
		if (Math.abs(anchor - current) < policy.deadband) {
			return hold(
				`Maintain at $${current}/barrel. Stock is below the safe buffer and the price is already at the top of the workable band, which slows sell-through while extraction rebuilds reserves toward ${OIL_RIG_POLICY.inventory.bufferLowPct}%–${OIL_RIG_POLICY.inventory.bufferHighPct}% full.`,
				"inventory_buffer",
			);
		}
		const target = stepToward(current, anchor, policy.maxStepPerAdvice);
		return {
			min: Math.min(target, clamp(target + 1)),
			max: Math.max(target, clamp(target + 1)),
			exact: target,
			action: target > current ? "increase" : "decrease",
			formatted: `Recommend $${target}/barrel.`,
			rationale: `Raise to $${target}/barrel. Stock is below the safe buffer, so the objective is to rebuild it: a higher price slows sell-through while extraction continues. This target is fixed, so no further change is required once it is reached.`,
			changeNeeded: true,
			basis: "inventory_buffer",
			confidence: "high",
		};
	}

	// 2. Measured to be ineffective: do not ask for another cut.
	if (input.state === "surplus" && input.priceLever === "does_not_work") {
		return hold(
			`Maintain at $${current}/barrel. Price cuts have been measured on this rig and did not move volume, so the surplus is not a pricing problem and a further cut would surrender margin for nothing. The binding constraint is sell-through capacity, which the capacity section addresses.`,
			"measured_unresponsive",
		);
	}

	// 3. A trustworthy fitted curve.
	if (demandConfident) {
		const anchor = clamp(input.demand.revenueMaxPrice);
		if (Math.abs(anchor - current) < policy.deadband) {
			return hold(
				`Maintain at $${current}/barrel. The fitted demand curve puts the revenue-maximising price at about $${input.demand.revenueMaxPrice}, within $${policy.deadband} of the current setting, so no change is worth making. ${input.demand.reason}`,
				"demand_fit",
				"high",
			);
		}
		const target = stepToward(current, anchor, policy.maxStepPerAdvice);
		return {
			min: Math.min(target, clamp(target + 1)),
			max: Math.max(target, clamp(target + 1)),
			exact: target,
			action: target > current ? "increase" : "decrease",
			formatted: `Recommend $${target}/barrel.`,
			rationale: `Move to $${target}/barrel. ${input.demand.reason} This is an absolute target, so no further change is required once it is reached.`,
			changeNeeded: true,
			basis: "demand_fit",
			confidence: "high",
		};
	}

	// 4. No usable fit: fall back to the band, and label it as a policy default
	//    rather than letting it read like a measured optimum.
	if (input.state === "equilibrium") {
		return hold(
			`Maintain at $${current}/barrel. Inventory is inside the healthy buffer and there is no measured reason to move the price. ${input.demand.reason}`,
			"policy_band",
			"none",
		);
	}

	const anchor = clamp(policy.floor);
	// At or below the floor there is nothing useful left to do with price: cutting
	// further surrenders margin for no reliable gain, and raising would work
	// against clearing the surplus.
	if (
		current <= policy.floor + policy.tolerance ||
		Math.abs(anchor - current) < policy.deadband
	) {
		return hold(
			`Maintain at $${current}/barrel. Price is already at or below the floor of the workable band ($${policy.floor}–$${policy.ceiling}) while stock is above the healthy buffer: a further cut would surrender margin for no reliable sell-through gain, and a rise would work against clearing the surplus. ${input.demand.reason}`,
			"policy_band",
			"none",
		);
	}
	const target = stepToward(current, anchor, policy.maxStepPerAdvice);
	return {
		min: Math.min(target, clamp(target + 1)),
		max: Math.max(target, clamp(target + 1)),
		exact: target,
		action: target > current ? "increase" : "decrease",
		formatted: `Recommend $${target}/barrel.`,
		rationale: `Move toward $${target}/barrel, the floor of the workable band ($${policy.floor}–$${policy.ceiling}), because stock is above the healthy buffer. This is a POLICY DEFAULT, not a measured optimum: ${input.demand.reason} It is a fixed target, so no further change is required once it is reached.`,
		changeNeeded: true,
		basis: "policy_band",
		confidence: "none",
	};
}

/** Moves `from` toward `to` by at most `maxStep`, leaving whole dollars. */
function stepToward(from: number, to: number, maxStep: number): number {
	if (Math.abs(to - from) <= maxStep) return to;
	return Math.round(from + Math.sign(to - from) * maxStep);
}

export function analyzeStockAndPricing(params: {
	inStock: number;
	storageCap: number;
	dailySold: number;
	dailyProduced?: number;
	currentPrice: number;
	adBudget: number;
	dailyIncome: number;
	/**
	 * Recorded whole-day revenue used to size the advertising rank model. Passed
	 * separately from `dailyIncome` because the ad budget itself moves revenue, and
	 * scaling a target off a value the target moves is a ratchet.
	 */
	referenceDailyRevenue?: number;
	/**
	 * Inventory state recorded by the previous brief. Supplying it turns the state
	 * thresholds into a Schmitt trigger so the advice cannot chatter across the
	 * boundary; omitting it uses the enter thresholds directly.
	 */
	previousState?: OilRigInventoryState;
	previousCritical?: boolean;
	/** Recorded history, for the demand fit and the advertising probe measurement. */
	history?: OilRigHistoryRecord[];
	/**
	 * True when the live ad setting already differs from the last recorded tick,
	 * meaning a change is in flight and has not produced a measurable outcome yet.
	 * Without it the ad engine cannot tell "no probe has been run" from "a probe is
	 * running", and would demand another increase on every fetch.
	 */
	pendingSettingChange?: boolean;
	/** Whether price cuts have been measured to move volume on this rig. */
	priceLever?: PriceLeverVerdict;
	asOfSeconds?: number;
	policy?: OilRigPolicy;
}): StockAnalysis {
	const policy = params.policy ?? OIL_RIG_POLICY;
	const inv = policy.inventory;
	const storageCap = params.storageCap > 0 ? params.storageCap : 750_000;
	const fillPct = Number(((params.inStock / storageCap) * 100).toFixed(1));
	const currentPrice =
		params.currentPrice > 0
			? params.currentPrice
			: policy.price.floor + policy.price.tolerance;
	const adBudget = params.adBudget > 0 ? params.adBudget : 0;
	const dailyIncome = params.dailyIncome > 0 ? params.dailyIncome : 0;
	const history = params.history ?? [];
	const referenceDailyRevenue =
		params.referenceDailyRevenue !== undefined &&
		params.referenceDailyRevenue > 0
			? params.referenceDailyRevenue
			: dailyIncome;

	const production = estimateMeasuredProduction(history, {
		policy: policy.capacity,
		latestMeasured: params.dailyProduced,
	});
	const measuredProduced = production.dailyProduced;

	// Drain model. `daysOfSales` means "days until the warehouse empties", so it
	// is only finite when sales genuinely outpace extraction.
	let daysOfSales = INFINITE_DAYS_OF_SALES;
	let netDrainPerDay: number | undefined;
	let netFillPerDay: number | undefined;
	let isFillingUp = false;

	if (measuredProduced !== undefined && measuredProduced > 0) {
		const netChange = measuredProduced - params.dailySold;
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

	// Hysteretic state: one hard threshold made the whole recommendation chatter,
	// because fill percentage moves continuously while the advice does not.
	const warehouseCritical = resolveWarehouseCritical({
		fillPct,
		previous: params.previousCritical,
		policy: inv,
	});
	const state = resolveInventoryState({
		fillPct,
		daysOfSales,
		previous: params.previousState,
		policy: inv,
	});
	const stateHeld = params.previousState === state;

	const priceLever: PriceLeverVerdict = params.priceLever ?? "unknown";
	const demand = fitBarrelDemand(history, { policy: policy.price });

	const recommendedPrice = recommendBarrelPrice({
		currentPrice,
		state,
		priceLever,
		demand,
		policy,
	});

	const adRecommendation: AdRecommendation = recommendAdBudget({
		currentAdBudget: adBudget,
		referenceDailyRevenue,
		state,
		extractionBound: isFillingUp || warehouseCritical,
		history,
		policy: policy.advertising,
		pendingSettingChange: params.pendingSettingChange,
		asOfSeconds: params.asOfSeconds,
	});

	const recommendedAdSpend: StockAnalysis["recommendedAdSpend"] = {
		amount: adRecommendation.amount,
		action: adRecommendation.action,
		formatted: adRecommendation.formatted,
		rationale: adRecommendation.rationale,
		changeNeeded: adRecommendation.changeNeeded,
		basis: adRecommendation.basis,
	};

	const stateDescription =
		state === "deficit"
			? `Inventory is in deficit (${fillPct}% full${
					daysOfSales < INFINITE_DAYS_OF_SALES
						? `, ${daysOfSales} days of stock left`
						: ""
				}).`
			: state === "surplus"
				? warehouseCritical
					? isFillingUp
						? `Warehouse is full (${fillPct}%) and cannot drain on its own: extraction matches or exceeds sales.`
						: `Warehouse is effectively full (${fillPct}% full).`
					: netDrainPerDay !== undefined
						? `Inventory is above the healthy buffer (${fillPct}% full) but still draining at ${netDrainPerDay.toLocaleString()} bbl/day.`
						: `Inventory is above the healthy buffer (${fillPct}% full).`
				: `Inventory is operating in a healthy equilibrium buffer (${fillPct}% full).`;

	// When the warehouse is full and extraction still keeps pace with sales, no
	// price or ad setting can clear it: the constraint is structural. Storage
	// upgrades are deliberately not offered as a fix, because a bigger warehouse
	// only postpones the same cap.
	let structuralAdvice: string | undefined;
	if (state === "surplus") {
		if (warehouseCritical) {
			structuralAdvice = isFillingUp
				? `Storage is full (${fillPct}% of ${storageCap.toLocaleString()} bbl) while extraction still matches or outpaces sales, so barrels produced beyond the sales rate are discarded. Price and ad changes cannot clear this and the binding constraint is sell-through capacity; extra storage would only postpone the cap.${
						priceLever === "does_not_work"
							? " Price has been measured to be ineffective on this rig, which confirms it is not the constraint."
							: priceLever === "works"
								? " Price does move volume on this rig, but cutting it cannot remove a cap imposed by how fast the rig can sell."
								: ""
					}`
				: `Storage is full (${fillPct}% of ${storageCap.toLocaleString()} bbl). Confirm extraction volume against the sales rate; any production above it is being discarded. Raise sell-through capacity rather than adding storage.`;
		} else if (isFillingUp) {
			structuralAdvice =
				"Extraction currently matches or outpaces sales, so the warehouse will keep filling until it hits the storage limit. Raise sell-through capacity (Sales Executives, customer volume); more storage would only delay the same outcome.";
		}
		if (production.confidence === "low" || production.confidence === "none") {
			structuralAdvice =
				`${structuralAdvice ?? ""}${structuralAdvice ? " " : ""}Extraction confidence is ${production.confidence} (${production.samples} measured day${production.samples === 1 ? "" : "s"}), so this constraint is reported for observation rather than acted on: the roster is not restructured until the extraction rate is measured across more days.`.trim();
		}
	}

	return {
		fillPct,
		daysOfSales,
		netDrainPerDay,
		netFillPerDay,
		isFillingUp,
		warehouseCritical,
		state,
		stateHeld,
		stateDescription,
		structuralAdvice,
		production,
		priceLever,
		demand,
		recommendedPrice,
		recommendedAdSpend,
		adRankModel: adRecommendation.rankModel,
		adResponse: adRecommendation.response,
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
	/** Reported daily customers. The only direct signal of advertising's effect. */
	dailyCustomers?: number;
	dailyWages?: number;
	dailyProfit?: number;
	dailyProduced?: number;
	/**
	 * False when `dailyProduced` was not derived from a real stock delta and was
	 * filled in for display only. Legacy records omit it, which is read as
	 * "measured" so existing rows keep working.
	 */
	producedMeasured?: boolean;
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
	/**
	 * Measured production only. Undefined when extraction could not be derived
	 * from a real stock delta, so the log never asserts a fabricated figure.
	 */
	producedBarrels?: number;
	/** True when barrels moved but production could not be measured that day. */
	producedEstimated?: boolean;
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
			const measured =
				h.producedMeasured !== false &&
				h.dailyProduced !== undefined &&
				h.dailyProduced > 0;

			entriesMap.set(h.isoDate, {
				isoDate: h.isoDate,
				dayOfWeek,
				revenue: h.dailyIncome,
				wages,
				adBudget,
				profit,
				soldBarrels: h.stock?.soldAmount ?? 0,
				// Production is only reported when it was actually derived from a
				// stock delta. The old fallback to that day's sales invented an
				// extraction figure on the first day of every window and then added
				// it to the week's totals, overstating both the barrels and their
				// stated value.
				producedBarrels: measured ? h.dailyProduced : undefined,
				producedEstimated: !measured && (h.stock?.soldAmount ?? 0) > 0,
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
	const measuredDays = summary.entries.filter(
		(e) => e.producedBarrels !== undefined,
	);
	const unmeasuredDays = summary.entries.length - measuredDays.length;
	const producedVal = measuredDays.reduce(
		(s, e) => s + (e.producedBarrels ?? 0) * e.barrelPrice,
		0,
	);

	return `• **WTD Net Profit:** **${profitSign}$${summary.totalProfit.toLocaleString()}**
• **WTD Gross Revenue:** **$${summary.totalRevenue.toLocaleString()}**
• **Operating Costs:** **$${operatingCosts.toLocaleString()}** (Wages: $${(summary.totalWages / 1_000_000).toFixed(1)}M | Ad: $${(summary.totalAd / 1_000_000).toFixed(1)}M)
• **Barrels Sold:** **${summary.totalSold.toLocaleString()}** bbl
• **Barrels Produced:** **${summary.totalProduced.toLocaleString()}** bbl${producedVal > 0 ? ` ($${producedVal.toLocaleString()} value, measured days only)` : ""}${unmeasuredDays > 0 ? `\n• **Production coverage:** ${measuredDays.length} of ${summary.entries.length} days measurable; extraction on the remaining ${unmeasuredDays} could not be derived from a stock delta and is excluded rather than estimated.` : ""}`;
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
export interface DiscardedBarrelsEstimate {
	/** Median measured surplus per day across uncapped days. */
	medianSurplus: number;
	peakSurplus: number;
	/** Number of uncapped days the median is based on. */
	samples: number;
	/**
	 * Lower bound on discard derived from days that WERE capped. On a capped day
	 * the stock delta is clamped at zero, so measured production collapses to the
	 * sales rate; the true figure is at least that sales rate, and any day the
	 * clamped measurement still exceeds sales proves discard is happening.
	 */
	cappedLowerBound: number;
	/** Days in the window where storage was already at or above critical fill. */
	cappedDays: number;
	/** True when no uncapped evidence exists, so only the lower bound is available. */
	evidenceThin: boolean;
	/** Plain-language statement of what the numbers do and do not prove. */
	summary: string;
}

/**
 * Estimates how many barrels per day are produced beyond what the rig can sell.
 *
 * `dailyProduced` is derived from stock deltas, which are clamped at zero when
 * the warehouse is full, so the *capped* days understate true extraction. The
 * uncapped days are therefore the honest evidence and their median surplus is
 * used so one unusual day cannot drive the figure.
 *
 * The old implementation discarded capped days entirely, which meant a warehouse
 * that had been full all week reported zero discarded barrels with zero samples -
 * precisely the situation in which the question matters most, and the situation
 * in which the briefing was nonetheless demanding a roster restructure. Capped
 * days are now used as a lower bound, and `evidenceThin` says plainly when the
 * median rests on too little to justify a structural change.
 */
export function estimateDiscardedBarrels(
	history: OilRigHistoryRecord[],
	criticalFillPct = 95,
): DiscardedBarrelsEstimate {
	// Only records the estimator also accepts may contribute evidence, so the
	// discard figure and the drain model can never disagree about a day.
	const measuredIndexes = new Set(
		history
			.map((h, index) => ({ h, index }))
			.filter(({ h, index }) => {
				if (index === 0 && h.producedMeasured !== true) return false;
				return h.producedMeasured !== false && (h.dailyProduced ?? 0) > 0;
			})
			.map(({ index }) => index),
	);

	const capped = history.filter(
		(h) => (h.stock?.fillPct ?? 0) >= criticalFillPct,
	);

	const surpluses = history
		.map((h, index) => ({ h, index }))
		.filter(({ index }) => measuredIndexes.has(index))
		.filter(({ h }) => (h.stock?.fillPct ?? 0) < criticalFillPct)
		.map(({ h }) => (h.dailyProduced ?? 0) - (h.stock?.soldAmount ?? 0))
		.filter((value) => value > 0)
		.sort((a, b) => a - b);

	// On a capped day the measured production is the sales rate, so any excess is
	// invisible. The measurable lower bound is therefore zero unless production
	// still exceeded sales despite the cap, which does happen when storage filled
	// mid-day.
	const cappedSurpluses = history
		.map((h, index) => ({ h, index }))
		.filter(({ index }) => measuredIndexes.has(index))
		.filter(({ h }) => (h.stock?.fillPct ?? 0) >= criticalFillPct)
		.map(({ h }) => (h.dailyProduced ?? 0) - (h.stock?.soldAmount ?? 0))
		.filter((value) => value > 0);

	const cappedLowerBound =
		cappedSurpluses.length > 0 ? Math.round(Math.max(...cappedSurpluses)) : 0;

	if (surpluses.length === 0) {
		return {
			medianSurplus: 0,
			peakSurplus: 0,
			samples: 0,
			cappedLowerBound,
			cappedDays: capped.length,
			evidenceThin: true,
			summary:
				capped.length > 0
					? `Storage was at or above ${criticalFillPct}% on all ${capped.length} recorded day${capped.length === 1 ? "" : "s"}, and a full warehouse clamps the measured stock delta to zero, so the discarded volume cannot be measured from these records. Output above the sales rate is being lost, but its size is unknown.`
					: "No recorded days yet, so discarded output cannot be estimated.",
		};
	}

	const mid = Math.floor(surpluses.length / 2);
	const median =
		surpluses.length % 2 === 0
			? ((surpluses[mid - 1] ?? 0) + (surpluses[mid] ?? 0)) / 2
			: (surpluses[mid] ?? 0);
	const peak = Math.round(surpluses[surpluses.length - 1] ?? 0);
	const evidenceThin = surpluses.length < 3;

	return {
		medianSurplus: Math.round(median),
		peakSurplus: peak,
		samples: surpluses.length,
		cappedLowerBound,
		cappedDays: capped.length,
		evidenceThin,
		summary: `Measured across ${surpluses.length} day${surpluses.length === 1 ? "" : "s"} where storage had room: a median ${Math.round(median).toLocaleString()} bbl/day and a peak ${peak.toLocaleString()} bbl/day were produced beyond what the rig sold.${capped.length > 0 ? ` A further ${capped.length} day${capped.length === 1 ? " was" : "s were"} already at or above ${criticalFillPct}% fill, where the stock delta is clamped and any excess is unmeasurable, so these figures are a lower bound.` : ""}${evidenceThin ? " Fewer than three usable days means this is not yet enough evidence to restructure the roster on." : ""}`,
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

// The capacity tuning now lives in `oil-rig-policy.ts` alongside the other three
// engines' policy, and is re-exported from the top of this module as
// OIL_RIG_CAPACITY_POLICY for callers that have always imported it from here.

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

	const maxShift = options.maxShift ?? OIL_RIG_POLICY.capacity.maxShift;
	let shifted = 0;

	for (const role of EXTRACTION_SIDE_ROLES) {
		if (shifted >= maxShift) break;
		const current = quotas[role] ?? 0;
		const floor = OIL_RIG_POLICY.capacity.minExtractionRoleCount;
		const take = Math.min(
			Math.max(0, current - floor),
			OIL_RIG_POLICY.capacity.maxShiftPerRole,
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

export type CapacityRegimeName = "balanced" | "extraction_bound";

export interface CapacityRegime {
	regime: CapacityRegimeName;
	/** True when the regime was carried over from the previous brief. */
	held: boolean;
	/** Consecutive recorded days supporting the current reading. */
	dwellDays: number;
	/** Measured days in the window where extraction matched or beat sales. */
	fillingDays: number;
	/** Measured days in the window where sales beat extraction. */
	drainingDays: number;
	/** Epoch seconds the current regime began. */
	since: number;
	reason: string;
}

/**
 * Decides whether the rig is structurally unable to clear its output.
 *
 * WHY THIS IS STATEFUL. The condition "extraction outruns sales" is *removed by
 * the remedy for it*: add sell-through capacity and extraction no longer outruns
 * sales, so the justification for the capacity you just added disappears. With a
 * single threshold on that condition the advice formed a limit cycle - adding two
 * Sales Executives, then removing three, then adding two again, indefinitely.
 *
 * Entry and exit therefore use different rules. Entry needs two consecutive
 * measured days of net filling, or storage at critical fill. Exit needs three
 * consecutive measured days of drain AND storage back at or below
 * `exitMaxFillPct`. The asymmetry is the point: a rig that has just started
 * draining is not yet proven to have a sell-through surplus.
 */
export function assessCapacityRegime(input: {
	history: OilRigHistoryRecord[];
	fillPct: number;
	isFillingUp: boolean;
	warehouseCritical: boolean;
	previousRegime?: CapacityRegimeName;
	/** When the previous regime began, so `since` survives across briefs. */
	previousSince?: number;
	asOfSeconds?: number;
	policy?: OilRigCapacityPolicy;
}): CapacityRegime {
	const policy = input.policy ?? OIL_RIG_POLICY.capacity;
	const asOf = input.asOfSeconds ?? Math.floor(Date.now() / 1000);

	// Same "measured" definition as the production estimator, so a regime can never
	// be entered on a day the drain model considers unmeasured.
	const measured = input.history.filter((h, index) => {
		if (index === 0 && h.producedMeasured !== true) return false;
		return h.producedMeasured !== false && h.dailyProduced !== undefined;
	});

	let trailingFilling = 0;
	let trailingDraining = 0;
	let fillingDays = 0;
	let drainingDays = 0;

	for (const record of measured) {
		const net = (record.dailyProduced ?? 0) - (record.stock?.soldAmount ?? 0);
		if (net >= 0) fillingDays += 1;
		else drainingDays += 1;
	}

	// Trailing streaks only: a fill day three weeks ago says nothing about whether
	// the rig is filling now.
	for (let i = measured.length - 1; i >= 0; i--) {
		const record = measured[i];
		if (!record) break;
		const net = (record.dailyProduced ?? 0) - (record.stock?.soldAmount ?? 0);
		if (net >= 0) {
			if (trailingDraining > 0) break;
			trailingFilling += 1;
		} else {
			if (trailingFilling > 0) break;
			trailingDraining += 1;
		}
	}

	// Entry needs BOTH the fill trend and storage pressure. Net fill alone is not a
	// problem: a rig below its healthy buffer wants stock to accumulate, and
	// treating that as a bottleneck demanded sell-through capacity for a warehouse
	// that was already running dry.
	const underPressure = input.fillPct >= policy.enterMinFillPct;
	const atCriticalFill =
		input.fillPct >= OIL_RIG_POLICY.inventory.criticalEnterPct;
	const enterEvidence =
		atCriticalFill ||
		(underPressure && trailingFilling >= policy.enterConsecutiveFillDays);
	const exitEvidence =
		trailingDraining >= policy.exitConsecutiveDrainDays &&
		input.fillPct <= policy.exitMaxFillPct;

	const previous = input.previousRegime;
	let regime: CapacityRegimeName;
	let held = false;

	if (previous === "extraction_bound") {
		if (exitEvidence) {
			regime = "balanced";
		} else {
			regime = "extraction_bound";
			held = true;
		}
	} else if (enterEvidence) {
		regime = "extraction_bound";
	} else {
		regime = "balanced";
		held = previous === "balanced";
	}

	const since =
		previous === regime && input.previousSince !== undefined
			? input.previousSince
			: asOf;

	const dwellDays =
		regime === "extraction_bound" ? trailingFilling : trailingDraining;

	let reason: string;
	if (regime === "extraction_bound") {
		const because = atCriticalFill
			? `storage is at ${input.fillPct}% of capacity, where the stock delta is clamped and output above the sales rate cannot be stored`
			: `${trailingFilling} consecutive measured day${trailingFilling === 1 ? "" : "s"} showed extraction matching or beating sales while storage was at ${input.fillPct}%, above the ${policy.enterMinFillPct}% pressure threshold`;
		reason = held
			? `Extraction-bound regime continues: ${because}. It is held until sales outpace extraction for ${policy.exitConsecutiveDrainDays} consecutive recorded days with storage at or below ${policy.exitMaxFillPct}% full, so a single draining day does not revoke it.`
			: `Extraction-bound regime entered: ${because}.`;
	} else {
		const why =
			held === false && previous === "extraction_bound"
				? `released: sales outpaced extraction for ${trailingDraining} consecutive recorded day${trailingDraining === 1 ? "" : "s"} and storage is back at ${input.fillPct}% full`
				: `not entered: storage is at ${input.fillPct}%, ${
						underPressure
							? "and extraction is not consistently outpacing sales"
							: `below the ${policy.enterMinFillPct}% pressure threshold, where accumulating stock is desirable rather than a constraint`
					}`;
		reason = held
			? "Extraction and sell-through remain balanced."
			: `Extraction-bound regime ${why}.`;
	}

	return {
		regime,
		held,
		dwellDays,
		fillingDays,
		drainingDays,
		since,
		reason,
	};
}

export interface CapacityRebalanceAction {
	kind: "rebalance" | "hire" | "storage";
	reason: string;
	/** Upper-bound revenue per day this unlocks, at the current barrel price. */
	estimatedGainPerDay: number;
	/** True when the change should be undone once stock normalises. */
	temporary: boolean;
}

/** Whether the plan is asking for anything, and if not, why not. */
export type CapacityPlanState = "balanced" | "action_required" | "holding";

export interface CapacityRebalancePlan {
	/** True when extraction structurally outruns what the rig can sell. */
	extractionBound: boolean;
	state: CapacityPlanState;
	/** True when the plan compared the target against the actual roster. */
	countsKnown: boolean;
	/** Barrels per day being produced beyond sell-through. */
	discardedBarrelsPerDay: number;
	/** Value of those barrels at the current price (upper bound). */
	discardedValuePerDay: number;
	/** Quota moves that carry the rebalance into the target lineup. */
	quotaShifts: QuotaShift[];
	/** Seats still to move per role to reach the target, when counts are known. */
	seatDeltas: Record<string, number>;
	/** Sell-through seats to fill from open capacity. */
	hires: number;
	actions: CapacityRebalanceAction[];
	summary: string;
	/** The exact condition under which the rebalance should be undone. */
	revertCondition: string;
	regime: CapacityRegime;
}

export interface CapacityPlanInput {
	/** Staff count the blueprint quotas are derived from. */
	staffCount: number;
	stock: StockAnalysis;
	barrelPrice: number;
	openSeats: number;
	/** Extra barrels/day produced beyond sales, from uncapped history. */
	discardedBarrelsPerDay?: number;
	/**
	 * Current headcount per role. Supplying it is what makes the plan idempotent:
	 * the plan then reports only the seats that still have to move, so a brief
	 * issued after the director complies stops asking for the same change.
	 * Omitting it falls back to reporting the blueprint-to-target quota move.
	 */
	currentCounts?: Record<string, number>;
	/** Hysteretic regime, preferred over the raw stock flags when supplied. */
	regime?: CapacityRegime;
	/** Measured top-rig baseline, when one is available. */
	baseline?: RosterBaseline;
	/** True when the discarded figure rests on too few measured days. */
	discardedEvidenceThin?: boolean;
	policy?: OilRigCapacityPolicy;
	asOfSeconds?: number;
}

/**
 * Plans a roster rebalance when the warehouse cannot clear what it produces.
 *
 * The economics are decisive: advertising and pricing only try to shift demand,
 * but a barrel that cannot be stored is worth nothing at all, while a barrel that
 * clears is worth its full sale price (wages are committed either way). So the
 * cheapest fix is to move capacity from extraction into sell-through.
 *
 * TWO THINGS THE PREVIOUS VERSION GOT WRONG, both reproduced against real state:
 *
 *  - it recomputed the quota shift from the blueprint on every call and never
 *    looked at the roster, so after the director complied the brief repeated the
 *    identical "2 seats move into Sales Executive (4 ➔ 6)" demand forever, because
 *    the target was already met and nothing could detect it. It now compares the
 *    target against `currentCounts` and reports only the outstanding delta, or
 *    announces that it is holding.
 *  - it acted whenever extraction outran sales, with no hysteresis, which is what
 *    drove the add-two-remove-three cycle. The regime now enters and exits under
 *    different conditions.
 */
export function planCapacityRebalance(
	params: CapacityPlanInput,
): CapacityRebalancePlan {
	const policy = params.policy ?? OIL_RIG_POLICY.capacity;
	const { stock } = params;
	const extractionBound = params.regime
		? params.regime.regime === "extraction_bound"
		: stock.isFillingUp || stock.warehouseCritical;

	const discarded = Math.max(
		0,
		Math.round(params.discardedBarrelsPerDay ?? stock.netFillPerDay ?? 0),
	);
	const discardedValuePerDay = discarded * params.barrelPrice;

	const regime: CapacityRegime =
		params.regime ??
		assessCapacityRegime({
			history: [],
			fillPct: stock.fillPct,
			isFillingUp: stock.isFillingUp,
			warehouseCritical: stock.warehouseCritical,
			asOfSeconds: params.asOfSeconds,
			policy,
		});

	const revertCondition = `Revert once sales outpace extraction for ${policy.exitConsecutiveDrainDays} consecutive recorded days with storage at or below ${policy.exitMaxFillPct}% full.`;

	if (!extractionBound) {
		return {
			extractionBound: false,
			state: "balanced",
			countsKnown: params.currentCounts !== undefined,
			discardedBarrelsPerDay: 0,
			discardedValuePerDay: 0,
			quotaShifts: [],
			seatDeltas: {},
			hires: 0,
			actions: [],
			summary:
				"Extraction and sell-through are balanced, so no rebalancing is needed.",
			revertCondition,
			regime,
		};
	}

	const base = getOptimalRoleQuotas(params.staffCount, params.baseline);
	const { shifts, quotas } = buildBottleneckQuotas(base, {
		extractionBound: true,
	});
	const salesShift = shifts.find((s) => s.role === SELL_THROUGH_ROLE);
	const drawnFrom = shifts
		.filter((s) => s.role !== SELL_THROUGH_ROLE)
		.map((s) => `${s.role} ${s.from} ➔ ${s.to}`)
		.join(", ");

	const counts = params.currentCounts;
	const countsKnown = counts !== undefined;
	const seatDeltas: Record<string, number> = {};
	if (counts) {
		for (const role of new Set([
			...Object.keys(quotas),
			...Object.keys(counts),
		])) {
			seatDeltas[role] = (quotas[role] ?? 0) - (counts[role] ?? 0);
		}
	}

	const salesTarget = quotas[SELL_THROUGH_ROLE] ?? 0;
	const salesCurrent = counts?.[SELL_THROUGH_ROLE];
	const seatsStillRequired = counts
		? Math.max(0, salesTarget - (salesCurrent ?? 0))
		: salesShift
			? salesShift.to - salesShift.from
			: 0;

	const evidenceNote =
		discarded > 0
			? `About ${discarded.toLocaleString()} bbl/day (~$${discardedValuePerDay.toLocaleString()}/day at $${params.barrelPrice}/bbl) is produced beyond what the rig clears.`
			: params.discardedEvidenceThin
				? `The size of the loss is unknown: storage has been at or above the critical fill on every recorded day, and a full warehouse clamps the stock delta to zero, so the excess cannot be measured. Extraction matching or beating sales is measured; the quantity is not.`
				: `Extraction matches or beats sales, so the warehouse cannot drain on its own; the discarded quantity is not measurable from the current records.`;

	const actions: CapacityRebalanceAction[] = [];
	let state: CapacityPlanState = "action_required";

	// 1. Reallocate first: moving an existing employee adds no wage cost, which
	//    matters when the wage bill is already the heaviest cost on the rig.
	if (seatsStillRequired > 0) {
		const fromLabel = countsKnown
			? `${salesCurrent ?? 0} ➔ ${salesTarget}`
			: `${salesShift?.from ?? 0} ➔ ${salesShift?.to ?? 0}`;
		actions.push({
			kind: "rebalance",
			reason: `${seatsStillRequired} seat${seatsStillRequired > 1 ? "s" : ""} move into ${SELL_THROUGH_ROLE} (${fromLabel}), taken from extraction-side headcount${drawnFrom ? ` (${drawnFrom})` : ""}, because extraction already outruns what the rig can sell. Reallocating adds no wage cost, and the target lineup reflects it. ${revertCondition}`,
			estimatedGainPerDay: discardedValuePerDay,
			temporary: true,
		});
	} else {
		// The roster already carries the sell-through weight this bottleneck needs.
		state = "holding";
	}

	// 2. Open seats add sell-through without taking anything out of extraction.
	//    This is capacity growth rather than a correction, so it is offered even
	//    while holding, and never presented as an outstanding fault.
	const hires = Math.min(Math.max(0, params.openSeats), policy.maxHiresPerPlan);
	if (hires > 0) {
		actions.push({
			kind: "hire",
			reason: `${hires} unfilled seat${hires > 1 ? "s" : ""} can be hired straight into ${SELL_THROUGH_ROLE} roles, which raises sell-through without reducing extraction at all. This is optional growth capacity, not a correction.`,
			estimatedGainPerDay: discardedValuePerDay,
			temporary: false,
		});
	}

	// 3. Storage only ever postpones this, so it is a fallback, never a fix.
	if (actions.length === 0) {
		state = "holding";
		actions.push({
			kind: "storage",
			reason:
				"No seat can be shifted out of extraction and no seat is free, so sell-through capacity cannot rise right now. Extra storage would only postpone the cap rather than remove it.",
			estimatedGainPerDay: 0,
			temporary: false,
		});
	}

	const summary =
		state === "holding"
			? `Extraction outruns sell-through, and the roster already carries the sell-through weight this calls for (${salesTarget} of ${salesTarget} target seats${countsKnown ? `, currently ${salesCurrent ?? 0}` : ""}). No seat change is outstanding. ${evidenceNote} ${revertCondition}`
			: `Extraction outruns sell-through, so ${seatsStillRequired} seat${seatsStillRequired > 1 ? "s" : ""} still need to move into ${SELL_THROUGH_ROLE}. ${evidenceNote} ${revertCondition}`;

	return {
		extractionBound: true,
		state,
		countsKnown,
		discardedBarrelsPerDay: discarded,
		discardedValuePerDay,
		quotaShifts: shifts,
		seatDeltas,
		hires,
		actions,
		summary,
		revertCondition,
		regime,
	};
}
