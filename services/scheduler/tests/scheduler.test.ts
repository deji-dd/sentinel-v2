import { describe, expect, test } from "bun:test";
import { ScheduledRunner } from "../src/lib/scheduler";

describe("ScheduledRunner Engine", () => {
	test("initializes with interval schedule", () => {
		const runner = new ScheduledRunner({
			worker: "test:interval",
			schedule: { type: "interval", seconds: 60 },
			handler: async () => {},
		});

		expect(runner).toBeDefined();
	});

	test("initializes with cron schedule and calculates next tick", () => {
		const runner = new ScheduledRunner({
			worker: "test:cron",
			schedule: { type: "cron", pattern: "0 3 * * *", timezone: "Etc/UTC" },
			handler: async () => {},
		});

		expect(runner).toBeDefined();
	});

	test("executes handler on triggerNow()", async () => {
		let executed = false;
		const runner = new ScheduledRunner({
			worker: "test:trigger",
			schedule: { type: "interval", seconds: 3600 },
			handler: async () => {
				executed = true;
			},
		});

		runner.triggerNow();
		// Wait for next tick
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(executed).toBe(true);
		runner.stop();
	});

	test("tracks consecutive failures and backs off retry timing on error", async () => {
		let callCount = 0;
		const runner = new ScheduledRunner({
			worker: "test:retry",
			schedule: { type: "cron", pattern: "0 3 * * *", timezone: "Etc/UTC" },
			retryPolicy: {
				maxRetries: 3,
				initialBackoffMs: 200,
				maxBackoffMs: 1000,
			},
			handler: async () => {
				callCount++;
				throw new Error("Simulated transient failure");
			},
		});

		runner.triggerNow();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const status = runner.getStatus();
		expect(callCount).toBe(1);
		expect(status.consecutiveFailures).toBe(1);
		expect(status.lastError).toBe("Simulated transient failure");
		// nextRunAt should be ~200ms from now, not tomorrow 03:00 UTC!
		expect(status.nextRunAt).toBeDefined();
		if (status.nextRunAt) {
			const diff = status.nextRunAt - Date.now();
			expect(diff).toBeLessThan(1000); // Backoff was applied instead of 24h jump!
		}
		runner.stop();
	});

	test("returns runner status and reports executing state", () => {
		const runner = new ScheduledRunner({
			worker: "test:status",
			schedule: { type: "interval", seconds: 120 },
			handler: async () => {},
		});

		const status = runner.getStatus();
		expect(status.worker).toBe("test:status");
		expect(status.isExecuting).toBe(false);
		expect(status.isStopped).toBe(false);
		expect(status.consecutiveFailures).toBe(0);
	});

	test("aborts hanging worker execution via AbortSignal when timeoutMs is exceeded", async () => {
		let aborted = false;
		const runner = new ScheduledRunner({
			worker: "test:timeout",
			schedule: { type: "interval", seconds: 300 },
			timeoutMs: 50,
			handler: async (signal) => {
				await new Promise((resolve) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
						resolve(true);
					});
					setTimeout(resolve, 500);
				});
			},
		});

		runner.triggerNow();
		await new Promise((resolve) => setTimeout(resolve, 150));

		const status = runner.getStatus();
		expect(aborted).toBe(true);
		expect(status.consecutiveFailures).toBe(1);
		expect(status.lastError).toContain("timed out after 50ms");
		runner.stop();
	});

	test("applies quick retry backoff for interval workers instead of waiting full cadence", async () => {
		let callCount = 0;
		const runner = new ScheduledRunner({
			worker: "test:interval-retry",
			schedule: { type: "interval", seconds: 60 },
			retryPolicy: {
				maxRetries: 3,
				initialBackoffMs: 200,
				maxBackoffMs: 1000,
			},
			handler: async () => {
				callCount++;
				throw new Error("Simulated transient failure");
			},
		});

		runner.triggerNow();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const status = runner.getStatus();
		expect(callCount).toBe(1);
		expect(status.consecutiveFailures).toBe(1);
		expect(status.nextRunAt).toBeDefined();
		if (status.nextRunAt) {
			const diff = status.nextRunAt - Date.now();
			// Should retry in ~200ms, definitely not waiting the full 60s!
			expect(diff).toBeLessThan(1000);
		}
		runner.stop();
	});
});
