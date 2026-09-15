import { describe, expect, test } from "bun:test";
import {
	REGISTERED_WORKERS,
	startRegisteredWorkers,
} from "../src/workers/registry";

describe("Worker Registry", () => {
	test("starts all registered background workers with staggered boot delays", async () => {
		const count = await startRegisteredWorkers({ staggerMs: 1 });
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test("respects DISABLED_WORKERS environment variable", async () => {
		const orig = process.env.DISABLED_WORKERS;
		try {
			process.env.DISABLED_WORKERS = "system:maintenance,torn:territory_data";
			const count = await startRegisteredWorkers({ staggerMs: 1 });
			const expectedCount =
				REGISTERED_WORKERS.filter((w) => w.enabled !== false).length - 2;
			expect(count).toBe(expectedCount);
		} finally {
			process.env.DISABLED_WORKERS = orig;
		}
	});
});
