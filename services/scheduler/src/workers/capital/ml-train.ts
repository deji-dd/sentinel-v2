/**
 * Capital ML auto-retrain.
 *
 * The model is retrained on a fixed cadence, not online. Daily, this worker
 * checks whether an active model exists and is younger than 30 days; if not,
 * and the history store is ready, it trains and activates the result for shadow
 * logging. No operator command is required after a deploy.
 *
 * Training is CPU-bound for ~10 seconds, so the recurring run is at 03:17 UTC;
 * on boot it also runs once after the history seed has had time to finish.
 * Disable with `CAPITAL_AUTO_ML_TRAIN=false`.
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
const BOOT_DELAY_MS = 10 * 60_000;

let training = false;

/** Trains only when the store is ready and the active model is missing or old. */
export async function runCapitalMlTraining(): Promise<void> {
	if (training) return;
	if (process.env.CAPITAL_AUTO_ML_TRAIN === "false") return;
	// Give a boot-time history seed time to finish before the first run.
	const readiness = await capitalHistoryReadiness();
	if (!readiness.daily.ready) return;
	const active = await getActiveCapitalMlModel();
	if (
		active &&
		Date.now() - active.trainedAt.getTime() < RETRAIN_AFTER_DAYS * 86_400_000
	) {
		return;
	}

	training = true;
	try {
		logger.info(
			active
				? `Retraining ML model (last trained ${active.trainedAt.toISOString()}).`
				: "No active ML model; training one for shadow logging.",
		);
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
	} finally {
		training = false;
	}
}

export function startCapitalMlTrain(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "17 3 * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs ?? BOOT_DELAY_MS,
		timeoutMs: 20 * 60_000,
		handler: runCapitalMlTraining,
	});
	// The persisted cron schedule wins at boot, so the first model would
	// otherwise wait until 03:17. The guard handles an overlapping cron tick.
	const boot = setTimeout(() => {
		void runCapitalMlTraining().catch((error: unknown) => {
			logger.warn(
				`Boot ML training failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}, BOOT_DELAY_MS);
	boot.unref?.();
}
