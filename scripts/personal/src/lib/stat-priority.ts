import { calculateGymGainBreakdown } from "../config";
import type { StatType } from "../types";

/**
 * Which stat to train next, in one place.
 *
 * There were two copies of this: the Battlestats tab scored stats against a
 * hardcoded gym (George's, id 24) and the gym page observer scored them against
 * whichever gym the player actually had selected, scraped from the DOM. The two
 * surfaces could therefore recommend different stats for the same account, with
 * the badge on the gym page and the KPI in the drawer disagreeing.
 *
 * Both now call this. The gym used for each stat is supplied by the caller: the
 * drawer from Torn's own efficiency payload, the gym page from the selected gym
 * control, so the same numbers feed both.
 *
 * The other half of the job is the answer when there is no answer. Scoring an
 * on-target stat as -1 and then sorting left the top of the list holding a real
 * stat with a score of -1, so a player who was already on target was told to train
 * strength — while the same card's subtitle said "On target". Here, a stat that is
 * not behind its target is not a candidate at all, and `recommended` is null when
 * none is.
 */

const STATS: StatType[] = ["strength", "defense", "speed", "dexterity"];

/** How much of the priority score comes from the ratio deficit vs efficiency. */
const DEFICIT_WEIGHT = 0.5;
const EFFICIENCY_WEIGHT = 0.5;

/**
 * The parts of a gym the calculation needs.
 *
 * Deliberately narrower than `ActiveGymData`: the API's efficiency payload and the
 * hardcoded gym table both satisfy this, and neither should have to invent an id or
 * a membership cost to be scored.
 */
export interface GymProfile {
	name: string;
	energy: number;
	strength: number;
	defense: number;
	speed: number;
	dexterity: number;
}

export interface StatPriorityInput {
	stats: Record<StatType, number>;
	/** Target share of total stats per attribute, from the chosen ratio formula. */
	ratios: Record<StatType, number>;
	/** The gym each attribute is trained at, when known. */
	gyms?: Partial<Record<StatType, GymProfile | null>>;
	/** Used for any attribute with no gym of its own. */
	fallbackGym: GymProfile;
	maxHappy: number;
	perks?: Partial<Record<StatType, number>>;
}

export interface StatPerformance {
	statType: StatType;
	current: number;
	/** Share of total stats this attribute should hold. */
	target: number;
	/** current − target; negative means a deficit. */
	diff: number;
	/** Share of the target that is missing, 0 when on or above target. */
	deficitPct: number;
	gainPerE: number;
	gainPerTrain: number;
	gymName: string;
	isOnTarget: boolean;
	/** 0 for an on-target attribute, higher is a better candidate. */
	priorityScore: number;
}

export interface StatPriorityResult {
	/** Every attribute, in the canonical strength/defence/speed/dexterity order. */
	rows: StatPerformance[];
	/** Candidates only, best first. Empty when every attribute is on target. */
	ranked: StatPerformance[];
	/** The attribute to train, or null when nothing is behind its target. */
	recommended: StatPerformance | null;
	/** True when every attribute is at or above its target. */
	allOnTarget: boolean;
	/** The largest deficit regardless of eligibility, for context lines. */
	largestDeficit: StatPerformance | null;
}

export function analyseStatPriority(
	input: StatPriorityInput,
): StatPriorityResult {
	const { stats, ratios, gyms, fallbackGym, maxHappy, perks } = input;
	const totalStats = STATS.reduce((sum, stat) => sum + (stats[stat] ?? 0), 0);

	const rows: StatPerformance[] = STATS.map((statType) => {
		const current = stats[statType] ?? 0;
		const target = totalStats * (ratios[statType] ?? 0);
		const diff = current - target;
		const gym = gyms?.[statType] ?? fallbackGym;
		const dots = gym[statType];
		const energy = gym.energy;
		const perk = perks?.[statType] ?? 1;

		const breakdown = calculateGymGainBreakdown(
			statType,
			current,
			maxHappy,
			dots,
			energy,
			perk,
		);

		const isOnTarget = current >= target;
		const deficitPct =
			!isOnTarget && target > 0 ? (target - current) / target : 0;

		return {
			statType,
			current,
			target,
			diff,
			deficitPct,
			gainPerE: breakdown.gainPerE,
			gainPerTrain: breakdown.totalGain,
			gymName: gym.name,
			isOnTarget,
			priorityScore: 0,
		};
	});

	// Normalised against the best available gain, so a stat that is both behind its
	// target and fast to train wins. A zero floor avoids dividing by a maximum of
	// zero when the payload is empty.
	const maxGainPerE = Math.max(...rows.map((row) => row.gainPerE), 1);

	for (const row of rows) {
		if (row.isOnTarget) {
			row.priorityScore = 0;
			continue;
		}
		const relativeEfficiency = maxGainPerE > 0 ? row.gainPerE / maxGainPerE : 0;
		row.priorityScore =
			row.deficitPct * DEFICIT_WEIGHT + relativeEfficiency * EFFICIENCY_WEIGHT;
	}

	const ranked = rows
		.filter((row) => !row.isOnTarget)
		.sort((a, b) => b.priorityScore - a.priorityScore);

	const largestDeficit = [...rows].sort(
		(a, b) => b.deficitPct - a.deficitPct,
	)[0];

	return {
		rows,
		ranked,
		recommended: ranked[0] ?? null,
		allOnTarget: ranked.length === 0,
		largestDeficit:
			largestDeficit && largestDeficit.deficitPct > 0 ? largestDeficit : null,
	};
}

export { STATS as STAT_ORDER };
