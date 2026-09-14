export interface RankedWarFactionMember {
	id: number;
	name: string;
	level: number;
	attacks: number;
	score: number;
}

export interface RankedWarFactionReport {
	id: number;
	name: string;
	attacks: number;
	score: number;
	members: RankedWarFactionMember[];
}

export interface TermedCheckOptions {
	/**
	 * Percentage (0–100) of active hitters within [mode - 2, mode + 2] required to flag as termed.
	 * Defaults to 60%.
	 */
	clusterPercentageThreshold?: number;
	/**
	 * Minimum active members with attacks > 0 needed to evaluate statistical clustering.
	 * Defaults to 5.
	 */
	minActiveHitters?: number;
	/**
	 * Minimum mode attacks to count as a deliberate quota (e.g. >= 8 hits).
	 * Defaults to 8.
	 */
	minQuotaAttacks?: number;
	/**
	 * Coefficient of variation ceiling (stdDev / mean).
	 * Defaults to 0.22.
	 */
	maxCoefficientOfVariation?: number;
}

export interface FactionTermedMetrics {
	factionId: number;
	factionName: string;
	activeHitters: number;
	modeAttacks: number;
	clusteredHittersCount: number;
	clusteredPercentage: number;
	coefficientOfVariation: number;
	meanAttacks: number;
	stdDevAttacks: number;
	flagged: boolean;
	flagReason: string | null;
}

export interface TermedWarDetectionResult {
	isTermed: boolean;
	reason: string | null;
	factions: FactionTermedMetrics[];
}

/**
 * Detects whether a ranked war was an agreed / scripted "termed" war
 * based on hit clustering and unnatural uniformity across active hitters.
 */
export function detectTermedWar(
	factions: RankedWarFactionReport[],
	options: TermedCheckOptions = {},
): TermedWarDetectionResult {
	const clusterThreshold = options.clusterPercentageThreshold ?? 60;
	const minActiveHitters = options.minActiveHitters ?? 5;
	const minQuotaAttacks = options.minQuotaAttacks ?? 8;
	const maxCV = options.maxCoefficientOfVariation ?? 0.22;

	const factionMetrics: FactionTermedMetrics[] = [];
	let warIsTermed = false;
	const reasons: string[] = [];

	for (const faction of factions) {
		const activeMembers = faction.members.filter((m) => m.attacks > 0);

		if (activeMembers.length < minActiveHitters) {
			factionMetrics.push({
				factionId: faction.id,
				factionName: faction.name,
				activeHitters: activeMembers.length,
				modeAttacks: 0,
				clusteredHittersCount: 0,
				clusteredPercentage: 0,
				coefficientOfVariation: 0,
				meanAttacks: 0,
				stdDevAttacks: 0,
				flagged: false,
				flagReason: null,
			});
			continue;
		}

		// Calculate frequency distribution
		const freqMap = new Map<number, number>();
		let totalAttacks = 0;

		for (const member of activeMembers) {
			totalAttacks += member.attacks;
			const current = freqMap.get(member.attacks) ?? 0;
			freqMap.set(member.attacks, current + 1);
		}

		// Find mode
		let mode = 0;
		let maxFreq = 0;
		for (const [attacks, freq] of freqMap.entries()) {
			if (freq > maxFreq) {
				maxFreq = freq;
				mode = attacks;
			}
		}

		// Count members in window [mode - 2, mode + 2]
		const windowMin = Math.max(1, mode - 2);
		const windowMax = mode + 2;
		let inWindowCount = 0;

		for (const member of activeMembers) {
			if (member.attacks >= windowMin && member.attacks <= windowMax) {
				inWindowCount++;
			}
		}

		const clusteredPercentage = (inWindowCount / activeMembers.length) * 100;

		// Calculate mean, variance, and standard deviation
		const mean = totalAttacks / activeMembers.length;
		let varianceSum = 0;
		for (const member of activeMembers) {
			varianceSum += (member.attacks - mean) ** 2;
		}
		const stdDev = Math.sqrt(varianceSum / activeMembers.length);
		const cv = mean > 0 ? stdDev / mean : 0;

		let flagged = false;
		let flagReason: string | null = null;

		// Flag 1: High clustering around a target quota
		if (mode >= minQuotaAttacks && clusteredPercentage >= clusterThreshold) {
			flagged = true;
			flagReason = `${clusteredPercentage.toFixed(1)}% of hitters clustered in [${windowMin}, ${windowMax}] hits (target ~${mode})`;
		}
		// Flag 2: Unnaturally low coefficient of variation for larger active roster
		else if (
			activeMembers.length >= 8 &&
			mode >= minQuotaAttacks &&
			cv < maxCV
		) {
			flagged = true;
			flagReason = `Unnatural hit uniformity (CV: ${cv.toFixed(2)} < ${maxCV}, mean: ${mean.toFixed(1)})`;
		}

		if (flagged && flagReason) {
			warIsTermed = true;
			reasons.push(`${faction.name}: ${flagReason}`);
		}

		factionMetrics.push({
			factionId: faction.id,
			factionName: faction.name,
			activeHitters: activeMembers.length,
			modeAttacks: mode,
			clusteredHittersCount: inWindowCount,
			clusteredPercentage: Number(clusteredPercentage.toFixed(2)),
			coefficientOfVariation: Number(cv.toFixed(4)),
			meanAttacks: Number(mean.toFixed(2)),
			stdDevAttacks: Number(stdDev.toFixed(2)),
			flagged,
			flagReason,
		});
	}

	return {
		isTermed: warIsTermed,
		reason: reasons.length > 0 ? reasons.join("; ") : null,
		factions: factionMetrics,
	};
}
