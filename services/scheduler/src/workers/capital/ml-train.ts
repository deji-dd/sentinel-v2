/**
 * Capital ML auto-retrain.
 *
 * The model is retrained on a fixed cadence, not online. Daily, this worker
 * checks whether an active model exists and is younger than 30 days; if not,
 * and the history store is ready, it trains and activates the result for shadow
 * logging. No operator command is required after a deploy.
 *
 * Training is CPU-bound for ~10 seconds, so it runs at 03:17 UTC. Disable with
 * `CAPITAL_AUTO_ML_TRAIN=false`.
 */
import { getActiveCapitalMlModel } from "@sentinel/database";
import { Logger } from "@sentinel/utils";

import { capitalHistoryReadiness } from "../../lib/capital-history";
import { trainCapitalMlModel } from "../../lib/capital-ml-train";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "capital:ml:train";
const logger = new Logger("Scheduler", "CapitalMlTrainWorker");
const RETRAIN_AFTER_DAYS = 30;

export function startCapitalMlTrain(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "17 3 * * *", timezone: "Etc/UTC" },
		// Give the history seed time to finish on a fresh deploy.
		initialDelayMs: options?.initialDelayMs ?? 10 * 60_000,
		timeoutMs: 20 * 60_000,
		handler: async () => {
			if (process.env.CAPITAL_AUTO_ML_TRAIN === "false") return;
			const readiness = await capitalHistoryReadiness();
			if (!readiness.daily.ready) {
				logger.info("Skipping ML training: daily history is not ready yet.");
				return;
			}
			const active = await getActiveCapitalMlModel();
			if (
				active &&
				Date.now() - active.trainedAt.getTime() <
					RETRAIN_AFTER_DAYS * 86_400_000
			) {
				return;
			}

			logger.info(
				active
					? `Retraining ML model (last trained ${active.trainedAt.toISOString()}).`
					: "No active ML model; training one for shadow logging.",
			);
			try {
				const result = await trainCapitalMlModel({
					activate: true,
					onProgress: (line) => logger.info(line),
				});
				logger.info(
					`ML model ${result.modelId} active (test AUC ${result.metrics.testAuc.toFixed(3)}, calibration ${result.metrics.calibrationError.toFixed(3)}, ${result.gates.calibration ? "calibrated" : "shadow only"}).`,
				);
			} catch (error) {
				// A failed gate or a thin dataset must not take the worker down; the
				// previous model (if any) stays active.
				logger.warn(
					`ML training skipped: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	});
}
