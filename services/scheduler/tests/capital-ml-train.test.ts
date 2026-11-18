import { describe, expect, test } from "bun:test";

import {
	type DatasetRow,
	EMBARGO_DAYS,
	walkForwardSplit,
} from "../src/lib/capital-ml-train";

function rows(count: number): DatasetRow[] {
	const day = 86_400_000;
	return Array.from({ length: count }, (_, index) => ({
		stockId: index % 30,
		date: index * day,
		vector: [index % 7, index % 5],
		researchVector: [index % 4, index % 6, index % 3, index % 9],
		label: (index % 3 === 0 ? 1 : 0) as 0 | 1,
		outcome: index % 3 === 0 ? ("target" as const) : ("stop" as const),
		forwardReturnPct: 0.01,
		zscore20: -1,
		ruleScore: 70,
		eligible: true,
	}));
}

describe("capital ML walk-forward split", () => {
	test("created expanding folds with a purged gap and an untouched holdout", () => {
		const split = walkForwardSplit(rows(1000));
		expect(split.folds).toHaveLength(5);

		for (const fold of split.folds) {
			expect(fold.train.length).toBeGreaterThan(0);
			expect(fold.test.length).toBeGreaterThan(0);
			expect(fold.testStart - fold.trainEnd).toBe(EMBARGO_DAYS * 86_400_000);
			expect(fold.test[0]?.date ?? 0).toBeGreaterThanOrEqual(fold.testStart);
			expect(fold.test.at(-1)?.date ?? 0).toBeLessThan(fold.testEnd);
			const trainDates = new Set(fold.train.map((row) => row.date));
			for (const row of fold.test) {
				expect(trainDates.has(row.date)).toBe(false);
			}
		}

		// Expanding training windows.
		for (let i = 1; i < split.folds.length; i++) {
			expect(split.folds[i]?.train.length).toBeGreaterThan(
				split.folds[i - 1]?.train.length ?? 0,
			);
		}

		const holdoutDates = new Set(split.holdout.map((row) => row.date));
		const oosDates = new Set(split.oos.map((row) => row.date));
		for (const date of holdoutDates) expect(oosDates.has(date)).toBe(false);
		expect(split.holdout.length).toBeGreaterThan(0);
		expect(split.boundaries.at(-1)).toBe(Math.min(...holdoutDates));
	});

	test("keeps a larger holdout than any single fold", () => {
		const split = walkForwardSplit(rows(2000));
		expect(split.holdout.length).toBeGreaterThan(
			Math.max(...split.folds.map((fold) => fold.test.length)),
		);
	});
});
