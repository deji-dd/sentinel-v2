/**
 * Pure ranking engine for the YABA faction activity report.
 *
 * Mirrors the Google Sheet methodology: each entity gets a percentile (0-100)
 * for every selected metric, the score is the weighted average of those
 * percentiles, and rank 1 is the highest score. Factions are scored from the
 * median of their members so a single outlier cannot skew the result.
 *
 * No I/O, no database and no Torn types live here — the collectors feed it
 * plain cumulative snapshots and battle-score estimates.
 */

export const YABA_WINDOWS = ["1d", "7d", "30d", "90d"] as const;
export type YabaWindow = (typeof YABA_WINDOWS)[number];

export const YABA_WINDOW_MS: Record<YabaWindow, number> = {
	"1d": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
	"90d": 90 * 24 * 60 * 60 * 1000,
};

export const YABA_METRICS = [
	"xanax",
	"activity",
	"hits",
	"revives",
	"battle",
	"winRate",
	"damagePerHit",
	"critRate",
	"reviveSkill",
] as const;
export type YabaMetric = (typeof YABA_METRICS)[number];

export const YABA_METRIC_LABELS: Record<YabaMetric, string> = {
	xanax: "Xanax taken",
	activity: "Hours active",
	hits: "Ranked war hits",
	revives: "Revives given",
	battle: "Battle score (FFScouter)",
	winRate: "Attack win rate",
	damagePerHit: "Damage per hit",
	critRate: "Critical hit rate",
	reviveSkill: "Revive skill",
};

export function isYabaMetric(value: string): value is YabaMetric {
	return (YABA_METRICS as readonly string[]).includes(value);
}

export function isYabaWindow(value: string): value is YabaWindow {
	return (YABA_WINDOWS as readonly string[]).includes(value);
}

/** The four metrics used by the original Google Sheet. */
export function defaultYabaMetrics(type: "combat" | "revive"): YabaMetric[] {
	return type === "revive"
		? ["xanax", "activity", "revives", "battle"]
		: ["xanax", "activity", "hits", "battle"];
}

export type YabaAnchor = {
	tornId: number;
	at: number;
	xanax: number | null;
	activitySeconds: number | null;
	rankedWarHits: number | null;
	revives: number | null;
	factionRespect: number | null;
	attacksWon: number | null;
	attacksLost: number | null;
	hitsSuccess: number | null;
	hitsCritical: number | null;
	damageTotal: number | null;
	reviveSkill: number | null;
};

export type YabaBattleEstimate = {
	tornId: number;
	score: number | null;
	capturedAt?: number;
};

export type YabaMemberInput = {
	tornId: number;
	name: string;
	factionId: number;
	level?: number | null;
	daysInFaction?: number | null;
};

export type YabaRankingInput = {
	scope: "faction" | "member";
	factionType: "combat" | "revive";
	window: YabaWindow;
	metrics: YabaMetric[];
	weights?: Partial<Record<YabaMetric, number>>;
	now: number;
	members: YabaMemberInput[];
	anchors: YabaAnchor[];
	estimates: YabaBattleEstimate[];
};

export type YabaRankingRow = {
	id: number;
	name: string;
	factionId: number | null;
	score: number;
	rank: number;
	components: Partial<Record<YabaMetric, number | null>>;
	sampleSize: number;
	coverage: number;
	membersCount?: number;
};

export type YabaRankingResult = {
	rows: YabaRankingRow[];
	unrankedCount: number;
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const low = sorted[middle - 1];
	const high = sorted[middle];
	if (low === undefined || high === undefined) return sorted[0] ?? null;
	return sorted.length % 2 === 0 ? (low + high) / 2 : high;
}

function delta(current: number | null, baseline: number | null): number | null {
	if (current === null || baseline === null) return null;
	const difference = current - baseline;
	// A reset/replaced account is treated as unknown, never as a negative score.
	return difference < 0 ? null : difference;
}

function ratio(
	numerator: number | null,
	denominator: number | null,
): number | null {
	if (numerator === null || denominator === null || denominator <= 0) {
		return null;
	}
	return numerator / denominator;
}

function metricFromAnchors(
	metric: YabaMetric,
	current: YabaAnchor | undefined,
	baseline: YabaAnchor | undefined,
	estimate: YabaBattleEstimate | undefined,
): number | null {
	if (metric === "battle") {
		return estimate?.score ?? null;
	}
	if (!current) return null;

	if (metric === "reviveSkill") {
		return current.reviveSkill ?? null;
	}
	if (!baseline) return null;

	switch (metric) {
		case "xanax":
			return delta(current.xanax, baseline.xanax);
		case "activity": {
			const seconds = delta(current.activitySeconds, baseline.activitySeconds);
			return seconds === null ? null : seconds / 3600;
		}
		case "hits":
			return delta(current.rankedWarHits, baseline.rankedWarHits);
		case "revives":
			return delta(current.revives, baseline.revives);
		case "winRate": {
			const won = delta(current.attacksWon, baseline.attacksWon);
			const lost = delta(current.attacksLost, baseline.attacksLost);
			if (won === null || lost === null) return null;
			return ratio(won, won + lost);
		}
		case "damagePerHit":
			return ratio(
				delta(current.damageTotal, baseline.damageTotal),
				delta(current.hitsSuccess, baseline.hitsSuccess),
			);
		case "critRate":
			return ratio(
				delta(current.hitsCritical, baseline.hitsCritical),
				delta(current.hitsSuccess, baseline.hitsSuccess),
			);
	}
}

/** Deterministic id for a metric/weight combo so snapshots are reproducible. */
export function hashYabaPreset(
	metrics: YabaMetric[],
	weights: Partial<Record<YabaMetric, number>> = {},
): string {
	const source = `${[...metrics].sort().join(",")}|${Object.entries(weights)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}:${value}`)
		.join(",")}`;
	let hash = 2166136261;
	for (let index = 0; index < source.length; index++) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function percentile(value: number, all: number[]): number {
	if (all.length <= 1) return 50;
	let below = 0;
	let equal = 0;
	for (const other of all) {
		if (other < value) below++;
		else if (other === value) equal++;
	}
	return ((below + equal / 2) / all.length) * 100;
}

function averageRanked(values: number[]): number[] {
	const order = values
		.map((value, index) => ({ value, index }))
		.sort((a, b) => b.value - a.value);
	const ranks = new Array<number>(values.length).fill(0);
	let position = 0;
	while (position < order.length) {
		let end = position + 1;
		while (end < order.length && order[end]?.value === order[position]?.value) {
			end++;
		}
		const rank = (position + 1 + end) / 2;
		for (let cursor = position; cursor < end; cursor++) {
			const entry = order[cursor];
			if (entry) ranks[entry.index] = rank;
		}
		position = end;
	}
	return ranks;
}

/**
 * Computes one ranking snapshot. Entities with no data for any selected metric
 * are returned in `unrankedCount` rather than being given a zero score.
 */
export function computeYabaRanking(input: YabaRankingInput): YabaRankingResult {
	const cutoff = input.now - YABA_WINDOW_MS[input.window];
	const anchorsByMember = new Map<number, YabaAnchor[]>();
	for (const anchor of input.anchors) {
		const list = anchorsByMember.get(anchor.tornId) ?? [];
		list.push(anchor);
		anchorsByMember.set(anchor.tornId, list);
	}
	const estimatesByMember = new Map<number, YabaBattleEstimate>();
	for (const estimate of input.estimates) {
		estimatesByMember.set(estimate.tornId, estimate);
	}

	const entityValues = new Map<
		number,
		Partial<Record<YabaMetric, number | null>>
	>();
	const factionMemberValues = new Map<
		number,
		Partial<Record<YabaMetric, number[]>>
	>();
	const entitySizes = new Map<number, number>();
	const entityLabels = new Map<
		number,
		{ name: string; factionId: number | null }
	>();

	const members = input.members.filter((member) =>
		input.scope === "member"
			? true
			: member.factionId !== undefined && member.factionId !== null,
	);

	for (const member of members) {
		const anchors = (anchorsByMember.get(member.tornId) ?? [])
			.filter((anchor) => anchor.at <= input.now)
			.sort((a, b) => a.at - b.at);
		const current = anchors.at(-1);
		const baseline = [...anchors]
			.reverse()
			.find((anchor) => anchor.at <= cutoff);
		const estimate = estimatesByMember.get(member.tornId);
		const components: Partial<Record<YabaMetric, number | null>> = {};
		for (const metric of input.metrics) {
			components[metric] = metricFromAnchors(
				metric,
				current,
				baseline,
				estimate,
			);
		}

		if (input.scope === "member") {
			entityValues.set(member.tornId, components);
			entityLabels.set(member.tornId, {
				name: member.name,
				factionId: member.factionId,
			});
			entitySizes.set(member.tornId, 1);
		} else {
			const existing = factionMemberValues.get(member.factionId) ?? {};
			for (const metric of input.metrics) {
				const value = components[metric] ?? null;
				if (value === null) continue;
				existing[metric] = [...(existing[metric] ?? []), value];
			}
			factionMemberValues.set(member.factionId, existing);
			entityLabels.set(member.factionId, {
				name: `Faction ${member.factionId}`,
				factionId: member.factionId,
			});
			entitySizes.set(
				member.factionId,
				(entitySizes.get(member.factionId) ?? 0) + 1,
			);
		}
	}

	// Faction components are medians of the per-member arrays collected above.
	if (input.scope === "faction") {
		for (const [factionId, components] of factionMemberValues) {
			const medians: Partial<Record<YabaMetric, number | null>> = {};
			for (const metric of input.metrics) {
				medians[metric] = median(components[metric] ?? []);
			}
			entityValues.set(factionId, medians);
		}
	}

	const allPercentiles = new Map<number, Partial<Record<YabaMetric, number>>>();
	const metricPools = new Map<YabaMetric, number[]>();
	for (const metric of input.metrics) {
		metricPools.set(
			metric,
			[...entityValues.values()]
				.map((components) => components[metric] ?? null)
				.filter((value): value is number => value !== null),
		);
	}

	for (const [entityId, components] of entityValues) {
		const percentileSet: Partial<Record<YabaMetric, number>> = {};
		for (const metric of input.metrics) {
			const value = components[metric] ?? null;
			if (value === null) continue;
			percentileSet[metric] = percentile(value, metricPools.get(metric) ?? []);
		}
		allPercentiles.set(entityId, percentileSet);
	}

	const weights = input.weights ?? {};
	const scoreById = new Map<number, number>();
	let unrankedCount = 0;
	for (const [entityId, percentileSet] of allPercentiles) {
		let totalWeight = 0;
		let weighted = 0;
		for (const metric of input.metrics) {
			const value = percentileSet[metric];
			if (value === undefined) continue;
			const weight = weights[metric] ?? 1;
			if (weight <= 0) continue;
			weighted += value * weight;
			totalWeight += weight;
		}
		if (totalWeight === 0) {
			unrankedCount++;
			continue;
		}
		scoreById.set(entityId, weighted / totalWeight);
	}

	const sortedIds = [...scoreById.keys()].sort(
		(a, b) => (scoreById.get(b) ?? 0) - (scoreById.get(a) ?? 0),
	);
	const ranks = averageRanked(sortedIds.map((id) => scoreById.get(id) ?? 0));
	const rows: YabaRankingRow[] = sortedIds.map((id, index) => {
		const components = entityValues.get(id) ?? {};
		const available = input.metrics.filter(
			(metric) =>
				components[metric] !== null && components[metric] !== undefined,
		).length;
		const label = entityLabels.get(id);
		return {
			id,
			name: label?.name ?? `${input.scope} ${id}`,
			factionId: label?.factionId ?? null,
			score: Number((scoreById.get(id) ?? 0).toFixed(2)),
			rank: ranks[index] ?? index + 1,
			components: Object.fromEntries(
				input.metrics.map((metric) => [metric, components[metric] ?? null]),
			) as Partial<Record<YabaMetric, number | null>>,
			sampleSize: entitySizes.get(id) ?? 1,
			coverage: Number(
				(available / Math.max(1, input.metrics.length)).toFixed(2),
			),
			...(input.scope === "faction"
				? { membersCount: entitySizes.get(id) ?? 0 }
				: {}),
		};
	});

	return { rows, unrankedCount };
}
