import type {
	CompanyUpgradeAdvice,
	CompanyUpgradeRecommendation,
	CompanyUpgradeStep,
} from "../../schemas/src/company";

/**
 * Company upgrade advice.
 *
 * WHY THIS IS A SEPARATE ENGINE. Company size, staff room and warehouse are the
 * only three upgrades an oil rig can buy, and each answers a different question:
 *
 *   - company size  -> can the rig hold more sell-through seats?
 *   - staff room    -> is the headcount outgrowing the room that keeps
 *                      environment at 100%?
 *   - warehouse     -> is storage the last remaining buffer once every seat
 *                      lever is exhausted?
 *
 * None of them is a "buy it when you have the cash" recommendation. Each is tied
 * to a measured condition on the rig, and each carries the full tier chain so a
 * director two sizes short sees the real cost rather than one step of it.
 *
 * PRICES come from Torn's company upgrade tables (Oil Rig, startup $10.5B). The
 * API exposes only the current tier (`profile.upgrades`), never the prices, so
 * the catalog is mirrored here and is the one place to update them.
 */

export interface OilRigCompanySizeTier {
	employees: number;
	label: string;
	cost: number;
}

export interface OilRigStaffRoomTier {
	/** Torn's own label. Must match `profile.upgrades.staff_room` exactly. */
	key: string;
	label: string;
	/**
	 * Headcount this room is sized for. Torn does not publish a hard threshold and
	 * the environment effect is continuous, so these are the company-size tiers:
	 * a room one size below the headcount is the point at which environment starts
	 * to pay for it. The rig's recorded environment is the evidence, not the rule.
	 */
	supportsEmployees: number;
	cost: number;
}

export interface OilRigWarehouseTier {
	/** Torn's own label. Must match `profile.upgrades.storage` exactly. */
	key: string;
	label: string;
	cost: number;
}

/** Torn oil-rig company-size tiers. The first is the startup tier. */
export const OIL_RIG_COMPANY_SIZE_TIERS: OilRigCompanySizeTier[] = [
	{ employees: 12, label: "12 employees", cost: 0 },
	{ employees: 15, label: "15 employees", cost: 1_050_000_000 },
	{ employees: 18, label: "18 employees", cost: 2_100_000_000 },
	{ employees: 21, label: "21 employees", cost: 3_150_000_000 },
	{ employees: 24, label: "24 employees", cost: 4_200_000_000 },
	{ employees: 27, label: "27 employees", cost: 5_250_000_000 },
	{ employees: 30, label: "30 employees", cost: 6_300_000_000 },
];

/** Torn oil-rig staff-room tiers. The first is the startup tier. */
export const OIL_RIG_STAFF_ROOM_TIERS: OilRigStaffRoomTier[] = [
	{
		key: "No staff room",
		label: "No staff room",
		supportsEmployees: 12,
		cost: 0,
	},
	{
		key: "Small staff room",
		label: "Small staff room",
		supportsEmployees: 15,
		cost: 262_500_000,
	},
	{
		key: "Standard staff room",
		label: "Standard staff room",
		supportsEmployees: 18,
		cost: 525_000_000,
	},
	{
		key: "Large staff room",
		label: "Large staff room",
		supportsEmployees: 21,
		cost: 787_500_000,
	},
	{
		key: "Very large staff room",
		label: "Very large staff room",
		supportsEmployees: 24,
		cost: 1_050_000_000,
	},
	{
		key: "Huge staff room",
		label: "Huge staff room",
		supportsEmployees: 27,
		cost: 1_312_500_000,
	},
	{
		key: "Colossal staff room",
		label: "Colossal staff room",
		supportsEmployees: 30,
		cost: 1_575_000_000,
	},
];

/** Torn oil-rig warehouse tiers. The first is the startup tier. */
export const OIL_RIG_WAREHOUSE_TIERS: OilRigWarehouseTier[] = [
	{ key: "Small room", label: "Small room", cost: 0 },
	{ key: "Standard room", label: "Standard room", cost: 525_000_000 },
	{ key: "Large room", label: "Large room", cost: 1_050_000_000 },
	{ key: "Huge room", label: "Huge room", cost: 1_575_000_000 },
	{ key: "Warehouse", label: "Warehouse", cost: 2_100_000_000 },
	{ key: "Large warehouse", label: "Large warehouse", cost: 2_625_000_000 },
	{ key: "Huge warehouse", label: "Huge warehouse", cost: 3_150_000_000 },
];

export interface OilRigUpgradeInput {
	profile: {
		environment: number;
		employees: { hired: number; capacity: number };
		upgrades: {
			staff_room?: string;
			storage?: string;
			storage_capacity?: number;
		};
	};
	/** Staff on the books; environment pressure comes from headcount, not seats. */
	staffCount: number;
	/** capacity - hired. A size upgrade is only due when this is zero. */
	openSeats: number;
	stock: {
		fillPct: number;
		netFillPerDay?: number;
		warehouseCritical: boolean;
		isFillingUp: boolean;
	};
	discarded: {
		barrelsPerDay: number;
		valuePerDay: number;
		evidenceThin: boolean;
	};
	/** The hysteretic capacity regime the roster was solved against. */
	extractionBound: boolean;
	/**
	 * The capacity plan's own state. `holding` means the roster already carries
	 * the sell-through weight it can, so a size upgrade is the only remaining way
	 * to add seats. `action_required` means a free seat move or hire is still
	 * outstanding; the size upgrade is listed after it at medium priority.
	 */
	capacityPlanState: "balanced" | "action_required" | "holding";
	barrelPrice: number;
}

function exactIndex<T extends { key: string }>(
	tiers: T[],
	key: string | undefined,
): number | undefined {
	if (!key) return undefined;
	const normalised = key.trim().toLowerCase();
	const index = tiers.findIndex(
		(tier) => tier.key.trim().toLowerCase() === normalised,
	);
	return index >= 0 ? index : undefined;
}

/**
 * The catalog index for a capacity Torn reported.
 *
 * Live responses always land on a catalog tier. Hand-built snapshots and unusual
 * legacy data may not, so the highest tier at or below the capacity is used:
 * recommending a size the rig already has would be a downgrade.
 */
function companySizeIndex(capacity: number): number | undefined {
	let best: number | undefined;
	for (let index = 0; index < OIL_RIG_COMPANY_SIZE_TIERS.length; index++) {
		const tier = OIL_RIG_COMPANY_SIZE_TIERS[index];
		if (tier && tier.employees <= capacity) best = index;
	}
	return best;
}

function requiredStaffRoomIndex(headcount: number): number {
	for (let index = 0; index < OIL_RIG_STAFF_ROOM_TIERS.length; index++) {
		const tier = OIL_RIG_STAFF_ROOM_TIERS[index];
		if (tier && tier.supportsEmployees >= headcount) return index;
	}
	return OIL_RIG_STAFF_ROOM_TIERS.length - 1;
}

function stepsBetween(
	tiers: Array<{ label: string; cost: number }>,
	fromIndex: number,
	toIndex: number,
): CompanyUpgradeStep[] {
	const steps: CompanyUpgradeStep[] = [];
	for (let index = fromIndex + 1; index <= toIndex; index++) {
		const tier = tiers[index];
		if (!tier) continue;
		steps.push({ tier: tier.label, cost: tier.cost });
	}
	return steps;
}

function sumCost(steps: CompanyUpgradeStep[]): number {
	return steps.reduce((total, step) => total + step.cost, 0);
}

function withPriority(
	category: CompanyUpgradeRecommendation["category"],
	currentTier: string,
	steps: CompanyUpgradeStep[],
	priority: CompanyUpgradeRecommendation["priority"],
	reason: string,
	estimatedGainPerDay?: number,
): CompanyUpgradeRecommendation {
	const next = steps[0];
	const target = steps[steps.length - 1];
	if (!next || !target) {
		throw new Error(`Upgrade recommendation for ${category} has no steps.`);
	}
	return {
		category,
		currentTier,
		nextTier: next.tier,
		targetTier: target.tier,
		nextCost: next.cost,
		steps,
		totalCostToTarget: sumCost(steps),
		priority,
		reason,
		estimatedGainPerDay,
	};
}

/**
 * Decides which upgrades are due, from the same analysis the other directives use.
 *
 * Pure. Every recommendation names the measured condition that triggered it; when
 * none is due it says so rather than inventing a "consider upgrading" nudge.
 */
export function analyzeUpgrades(
	input: OilRigUpgradeInput,
): CompanyUpgradeAdvice {
	const recommendations: CompanyUpgradeRecommendation[] = [];
	const { profile } = input;
	// The roster array and the profile's headcount can disagree on a hand-built
	// snapshot; the larger of the two is the headcount that exerts pressure, and
	// using it means a missing roster cannot silently suppress the recommendation.
	const headcount = Math.max(input.staffCount, profile.employees.hired);
	const sizeIndex = companySizeIndex(profile.employees.capacity);
	const roomIndex = exactIndex(
		OIL_RIG_STAFF_ROOM_TIERS,
		profile.upgrades.staff_room,
	);
	const warehouseIndex = exactIndex(
		OIL_RIG_WAREHOUSE_TIERS,
		profile.upgrades.storage,
	);

	// ---- Staff room --------------------------------------------------------
	// Headcount is what exerts environment pressure. The room is due when it is
	// sized for fewer staff than the rig actually carries; environment below 100
	// is the evidence that the shortfall is already being paid for.
	if (roomIndex !== undefined) {
		const requiredIndex = requiredStaffRoomIndex(headcount);
		if (requiredIndex > roomIndex) {
			const current = OIL_RIG_STAFF_ROOM_TIERS[roomIndex];
			const steps = stepsBetween(
				OIL_RIG_STAFF_ROOM_TIERS,
				roomIndex,
				requiredIndex,
			);
			const priority =
				profile.environment < 90
					? "critical"
					: profile.environment < 100
						? "high"
						: "medium";
			const environmentClause =
				profile.environment < 100
					? `Environment is ${profile.environment}%, below the 100% the room is meant to protect.`
					: `Environment is still 100%, so this is preventive.`;
			recommendations.push(
				withPriority(
					"staff_room",
					current?.label ?? "Unknown staff room",
					steps,
					priority,
					`The ${current?.label ?? "current staff room"} is sized for ${current?.supportsEmployees ?? 0} staff, but the rig carries ${headcount} staff. ${environmentClause}`,
				),
			);
		}
	}

	// ---- Company size ------------------------------------------------------
	// Due whenever the rig is full, extraction genuinely outruns sell-through and
	// no free seat exists. A capacity plan that still has a seat move outstanding
	// is the first step; the size upgrade is listed after it, not withheld, because
	// the purchase can be planned while the free move is applied. An open seat is
	// different: hire into it first, because that costs nothing.
	if (
		sizeIndex !== undefined &&
		sizeIndex < OIL_RIG_COMPANY_SIZE_TIERS.length - 1 &&
		input.openSeats === 0 &&
		input.extractionBound
	) {
		const nextIndex = sizeIndex + 1;
		const steps = stepsBetween(
			OIL_RIG_COMPANY_SIZE_TIERS,
			sizeIndex,
			nextIndex,
		);
		const addedSeats = Math.max(
			0,
			(OIL_RIG_COMPANY_SIZE_TIERS[nextIndex]?.employees ?? 0) -
				profile.employees.capacity,
		);
		// The value at stake: output already being lost, or the stock accumulating
		// faster than the rig sells it. Both are upper bounds, not promises.
		const gain =
			input.discarded.valuePerDay > 0
				? input.discarded.valuePerDay
				: input.stock.netFillPerDay !== undefined
					? input.stock.netFillPerDay * input.barrelPrice
					: undefined;
		const gainClause =
			input.discarded.barrelsPerDay > 0
				? `${input.discarded.barrelsPerDay.toLocaleString()} bbl/day is already being discarded.`
				: input.stock.netFillPerDay !== undefined
					? `Stock is accumulating ${input.stock.netFillPerDay.toLocaleString()} bbl/day faster than the rig sells it.`
					: "Extraction outruns what the rig can sell.";
		const seatingClause =
			input.capacityPlanState === "holding"
				? "No seat is left to move into sell-through."
				: "A seat move is still outstanding, so do that first; after it, a bigger company is the only way to add more sell-through.";
		const staffRoomClause =
			roomIndex !== undefined && requiredStaffRoomIndex(headcount) > roomIndex
				? " Upgrade the staff room first: the extra staff would otherwise deepen the environment penalty."
				: "";
		recommendations.push(
			withPriority(
				"company_size",
				OIL_RIG_COMPANY_SIZE_TIERS[sizeIndex]?.label ?? "Current size",
				steps,
				input.capacityPlanState === "holding"
					? input.discarded.barrelsPerDay > 0
						? "critical"
						: "high"
					: "medium",
				`The rig is full at ${profile.employees.hired}/${profile.employees.capacity} staff. ${seatingClause} ${gainClause} ${addedSeats} more seat${addedSeats === 1 ? "" : "s"} would be available for Sales Executives.${staffRoomClause}`,
				gain,
			),
		);
	}

	// ---- Warehouse ---------------------------------------------------------
	// Deliberately the last lever. Before the company is maxed, a size upgrade is
	// strictly better: it adds sell-through, while storage only postpones the cap.
	// Even at max size this is recommended only when the roster has no seat move
	// left and output is genuinely being discarded.
	if (
		sizeIndex === OIL_RIG_COMPANY_SIZE_TIERS.length - 1 &&
		warehouseIndex !== undefined &&
		warehouseIndex < OIL_RIG_WAREHOUSE_TIERS.length - 1 &&
		input.capacityPlanState === "holding" &&
		input.stock.warehouseCritical &&
		input.stock.isFillingUp
	) {
		const steps = stepsBetween(
			OIL_RIG_WAREHOUSE_TIERS,
			warehouseIndex,
			warehouseIndex + 1,
		);
		const lossClause =
			input.discarded.barrelsPerDay > 0
				? `Output is being discarded at the cap.`
				: "The warehouse is at its cap and cannot drain on its own.";
		recommendations.push(
			withPriority(
				"warehouse",
				OIL_RIG_WAREHOUSE_TIERS[warehouseIndex]?.label ?? "Current warehouse",
				steps,
				input.discarded.barrelsPerDay > 0 || input.discarded.evidenceThin
					? "medium"
					: "low",
				`Company size is maxed at 30 and the roster already carries the sell-through weight it can. ${lossClause} A bigger warehouse is the only remaining buffer, and it only postpones the cap.`,
			),
		);
	}

	const allMaxed =
		sizeIndex === OIL_RIG_COMPANY_SIZE_TIERS.length - 1 &&
		roomIndex === OIL_RIG_STAFF_ROOM_TIERS.length - 1 &&
		warehouseIndex === OIL_RIG_WAREHOUSE_TIERS.length - 1;

	return {
		recommendations,
		summary:
			recommendations.length === 0
				? allMaxed
					? "Every company upgrade is at its final tier."
					: "No company upgrade is due on the current operational picture."
				: recommendations
						.map(
							(recommendation) =>
								`${recommendation.currentTier} → ${recommendation.targetTier} (${recommendation.priority}): ${recommendation.reason}`,
						)
						.join(" "),
		allMaxed,
	};
}
