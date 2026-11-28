import { Logger } from "@sentinel/utils";

import { startEventDrivenRunner } from "../../lib/scheduler";
import {
	dispatchYabaCharts,
	hasAnyYabaAnchor,
	loadLatestYabaRankings,
	runYabaCollection,
} from "../../lib/yaba-collector";
import type { WorkerStartOptions } from "../registry";

const logger = new Logger("Scheduler", "YabaWorkers");

/** Nightly collection at 01:00 UK time; runs once immediately on first boot. */
export function startYabaNightly(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: "yaba:nightly",
		schedule: { type: "cron", pattern: "0 1 * * *", timezone: "Europe/London" },
		bootRun: true,
		initialDelayMs: options?.initialDelayMs,
		timeoutMs: 20 * 60_000,
		handler: async () => {
			logger.info("Starting YABA nightly collection.");
			// On a brand-new database there is no baseline anchor yet, so the
			// immediate first run backfills history before scoring.
			const hasAnchors = await hasAnyYabaAnchor();
			const kind = hasAnchors ? "nightly" : "backfill";
			const result = await runYabaCollection(kind);
			logger.info(
				`YABA ${kind} collection complete (${result.keyCount} key(s)): ${JSON.stringify(result.counters)}`,
			);
		},
	});
}

/** Historical 90/30/7/1-day anchors at 03:00 UK time, never on boot. */
export function startYabaBackfill(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: "yaba:backfill",
		schedule: { type: "cron", pattern: "0 3 * * *", timezone: "Europe/London" },
		skipBootRun: true,
		initialDelayMs: options?.initialDelayMs,
		timeoutMs: 30 * 60_000,
		handler: async () => {
			logger.info("Starting YABA historical backfill.");
			const result = await runYabaCollection("backfill");
			logger.info(`YABA backfill complete: ${JSON.stringify(result.counters)}`);
		},
	});
}

/** Daily top-10 chart posts at 07:00 UK time, never on boot. */
export function startYabaCharts(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: "yaba:charts",
		schedule: { type: "cron", pattern: "0 7 * * *", timezone: "Europe/London" },
		skipBootRun: true,
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			const latest = await loadLatestYabaRankings();
			if (latest.factions.length === 0 || latest.players.length === 0) {
				logger.warn("No YABA ranking snapshot available for chart post.");
				return;
			}
			const delivered = await dispatchYabaCharts(latest);
			logger.info(
				delivered
					? "YABA chart payload dispatched to bot."
					: "YABA chart channels are not configured; skipping post.",
			);
		},
	});
}
