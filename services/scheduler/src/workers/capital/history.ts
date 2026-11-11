/**
 * Capital history bootstrap.
 *
 * On a fresh deploy the candle store is empty and Torn only exposes the last 60
 * minutes. This worker seeds the store from the public mirror on boot, then goes
 * quiet: once daily/hourly/minute coverage is ready it does nothing but a cheap
 * readiness check each hour. The `stocks:backfill` command remains available for
 * larger manual windows, but it is no longer required.
 *
 * Disable with `CAPITAL_AUTO_BACKFILL=false`.
 */
import { Logger } from "@sentinel/utils";

import {
	capitalHistoryReadiness,
	describeReadiness,
	seedCapitalHistory,
} from "../../lib/capital-history";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "capital:history";
const logger = new Logger("Scheduler", "CapitalHistoryWorker");
const SEED_BUDGET_MS = 8 * 60_000;
const M1_SEED_DAYS = 7;

export function startCapitalHistory(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		// Hourly is enough: readiness is three aggregate queries, and a seed only
		// runs while something is missing. 17 past the hour avoids the top-of-hour
		// burst the other capital workers use.
		schedule: { type: "cron", pattern: "17 * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs ?? 20_000,
		timeoutMs: SEED_BUDGET_MS + 120_000,
		handler: async () => {
			if (process.env.CAPITAL_AUTO_BACKFILL === "false") return;
			const apiKey = process.env.TORN_API_KEY?.trim();
			if (!apiKey) {
				logger.warn(
					"No TORN_API_KEY; skipping the automatic history seed. Set the key or run stocks:backfill manually.",
				);
				return;
			}

			const readiness = await capitalHistoryReadiness();
			if (readiness.ready && readiness.minute.ready) return;

			const intervals: Array<"d1" | "h1" | "m1"> = [];
			if (!readiness.daily.ready) intervals.push("d1");
			if (!readiness.hourly.ready) intervals.push("h1");
			if (!readiness.minute.ready) intervals.push("m1");
			if (intervals.length === 0) return;

			logger.info(
				`Seeding ${intervals.join(",")} (${describeReadiness(readiness)}).`,
			);
			const result = await seedCapitalHistory({
				intervals,
				m1Days: M1_SEED_DAYS,
				tornApiKey: apiKey,
				deadlineMs: Date.now() + SEED_BUDGET_MS,
				onProgress: (line) => logger.info(line),
			});
			logger.info(
				`History seed wrote ${result.inserted.toLocaleString()} rows in ${Math.round(
					result.elapsedMs / 1000,
				)}s${result.partial ? " (partial; resumes next run)" : ""}.`,
			);
		},
	});
}
