import { describe, expect, test } from "bun:test";
import { startRegisteredWorkers } from "../src/workers/registry";

describe("Worker Registry", () => {
	test("starts all registered background workers with staggered boot delays", async () => {
		const count = await startRegisteredWorkers({ staggerMs: 1 });
		expect(count).toBeGreaterThanOrEqual(6);
	});
});
