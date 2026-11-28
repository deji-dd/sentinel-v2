import { describe, expect, test } from "bun:test";

import {
	computeYabaRanking,
	defaultYabaMetrics,
	hashYabaPreset,
	YABA_METRICS,
	type YabaAnchor,
	type YabaMemberInput,
} from "../src/yaba-ranking";

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function anchor(
	tornId: number,
	at: number,
	overrides: Partial<YabaAnchor> = {},
): YabaAnchor {
	return {
		tornId,
		at,
		xanax: 0,
		activitySeconds: 0,
		rankedWarHits: 0,
		revives: 0,
		factionRespect: 0,
		attacksWon: 0,
		attacksLost: 0,
		hitsSuccess: 0,
		hitsCritical: 0,
		damageTotal: 0,
		reviveSkill: 0,
		...overrides,
	};
}

const members: YabaMemberInput[] = [
	{ tornId: 1, name: "Alice", factionId: 100 },
	{ tornId: 2, name: "Bob", factionId: 100 },
	{ tornId: 3, name: "Carol", factionId: 200 },
];

describe("YABA ranking", () => {
	test("default preset mirrors the sheet for each faction type", () => {
		expect(defaultYabaMetrics("combat")).toEqual([
			"xanax",
			"activity",
			"hits",
			"battle",
		]);
		expect(defaultYabaMetrics("revive")).toEqual([
			"xanax",
			"activity",
			"revives",
			"battle",
		]);
		for (const metric of defaultYabaMetrics("combat")) {
			expect(YABA_METRICS).toContain(metric);
		}
	});

	test("preset hash is deterministic and order-independent", () => {
		expect(hashYabaPreset(["xanax", "hits"])).toBe(
			hashYabaPreset(["hits", "xanax"]),
		);
		expect(hashYabaPreset(["xanax"])).not.toBe(hashYabaPreset(["hits"]));
	});

	test("member window deltas use cumulative anchors and produce percentiles", () => {
		const result = computeYabaRanking({
			scope: "member",
			factionType: "combat",
			window: "30d",
			metrics: ["xanax", "activity", "hits", "battle"],
			now: NOW,
			members,
			anchors: [
				anchor(1, NOW - 31 * DAY, { xanax: 10, rankedWarHits: 5 }),
				anchor(1, NOW, { xanax: 40, activitySeconds: 3600, rankedWarHits: 35 }),
				anchor(2, NOW - 31 * DAY, { xanax: 20 }),
				anchor(2, NOW, { xanax: 25, rankedWarHits: 10 }),
				anchor(3, NOW - 31 * DAY, { xanax: 5 }),
				anchor(3, NOW, { xanax: 100 }),
			],
			estimates: [
				{ tornId: 1, score: 100 },
				{ tornId: 2, score: 50 },
				{ tornId: 3, score: 10 },
			],
		});

		expect(result.rows).toHaveLength(3);
		expect(result.unrankedCount).toBe(0);
		const alice = result.rows.find((row) => row.id === 1);
		expect(alice?.components.xanax).toBe(30);
		expect(alice?.components.activity).toBe(1);
		expect(alice?.components.hits).toBe(30);
		expect(alice?.components.battle).toBe(100);
		expect(alice?.coverage).toBe(1);
		expect(result.rows[0]?.rank).toBe(1);
	});

	test("faction rows use member medians, not sums", () => {
		const result = computeYabaRanking({
			scope: "faction",
			factionType: "combat",
			window: "7d",
			metrics: ["xanax", "activity", "hits", "battle"],
			now: NOW,
			members,
			anchors: [
				anchor(1, NOW - 8 * DAY),
				anchor(1, NOW, { xanax: 100, rankedWarHits: 50 }),
				anchor(2, NOW - 8 * DAY),
				anchor(2, NOW, { xanax: 20, rankedWarHits: 10 }),
				anchor(3, NOW - 8 * DAY),
				anchor(3, NOW, { xanax: 30 }),
			],
			estimates: [{ tornId: 1, score: 10 }],
		});
		const faction = result.rows.find((row) => row.id === 100);
		expect(faction?.components.xanax).toBe(60);
		expect(faction?.components.hits).toBe(30);
		expect(faction?.sampleSize).toBe(2);
		expect(faction?.membersCount).toBe(2);
	});

	test("missing data is never scored as zero", () => {
		const result = computeYabaRanking({
			scope: "member",
			factionType: "revive",
			window: "90d",
			metrics: ["xanax", "activity", "revives", "battle"],
			now: NOW,
			members,
			anchors: [
				anchor(1, NOW - 91 * DAY, { revives: null }),
				anchor(1, NOW, { xanax: 5, revives: null }),
			],
			estimates: [],
		});
		expect(result.rows).toHaveLength(1);
		expect(result.unrankedCount).toBe(2);
		expect(result.rows[0]?.components.revives).toBeNull();
		expect(result.rows[0]?.coverage).toBeLessThan(1);
	});

	test("derived secondary signals are computed from deltas", () => {
		const result = computeYabaRanking({
			scope: "member",
			factionType: "combat",
			window: "1d",
			metrics: ["winRate", "damagePerHit", "critRate", "reviveSkill"],
			now: NOW,
			members: [members[0] as YabaMemberInput],
			anchors: [
				anchor(1, NOW - 2 * DAY),
				anchor(1, NOW, {
					attacksWon: 3,
					attacksLost: 1,
					hitsSuccess: 10,
					hitsCritical: 2,
					damageTotal: 5000,
					reviveSkill: 7,
				}),
			],
			estimates: [],
		});
		const row = result.rows[0];
		expect(row?.components.winRate).toBe(0.75);
		expect(row?.components.damagePerHit).toBe(500);
		expect(row?.components.critRate).toBe(0.2);
		expect(row?.components.reviveSkill).toBe(7);
	});
});
