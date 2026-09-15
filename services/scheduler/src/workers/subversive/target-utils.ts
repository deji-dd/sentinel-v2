/**
 * Computes an estimated battle stat score (sqrt(str) + sqrt(spd) + sqrt(def) + sqrt(dex)).
 */
export function computeScoreFromEstimate(
	bsEstimate: number | null,
	distribution?: {
		stats_percentage?: {
			strength?: number;
			speed?: number;
			defense?: number;
			dexterity?: number;
		};
	} | null,
): number {
	if (!bsEstimate || bsEstimate <= 0) return 0;

	if (distribution?.stats_percentage) {
		const strPct = (distribution.stats_percentage.strength ?? 25) / 100;
		const spdPct = (distribution.stats_percentage.speed ?? 25) / 100;
		const defPct = (distribution.stats_percentage.defense ?? 25) / 100;
		const dexPct = (distribution.stats_percentage.dexterity ?? 25) / 100;

		const str = bsEstimate * strPct;
		const spd = bsEstimate * spdPct;
		const def = bsEstimate * defPct;
		const dex = bsEstimate * dexPct;

		return (
			Math.sqrt(Math.max(0, str)) +
			Math.sqrt(Math.max(0, spd)) +
			Math.sqrt(Math.max(0, def)) +
			Math.sqrt(Math.max(0, dex))
		);
	}

	// Default balanced distribution: 4 * sqrt(total / 4) = 2 * sqrt(total)
	return 2 * Math.sqrt(bsEstimate);
}
