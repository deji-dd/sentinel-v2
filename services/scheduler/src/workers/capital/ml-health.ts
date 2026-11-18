/**
 * Capital ML health monitor and auto-disable guard.
 *
 * Hourly, scores the active shadow model on its own evaluated predictions over a
 * trailing window. If ranking IC, calibration, shadow drawdown or live-vs-trained
 * hit-rate drift breach their limits, the worker switches `ml_enabled` off for
 * that book, writes an audit row and alerts the owner. It never trains and never
 * enables ML by itself.
 */
import {
	getActiveCapitalMlModel,
	getCapitalConfig,
	getEvaluatedCapitalMlPredictions,
	insertCapitalMlHealth,
	recordCapitalAudit,
	updateCapitalConfig,
} from "@sentinel/database";
import type { CapitalAlertPayload, CapitalBook } from "@sentinel/schemas";
import {
	calibrationBuckets,
	Logger,
	pearsonCorrelation,
} from "@sentinel/utils";

import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "capital:ml:health";
const logger = new Logger("Scheduler", "CapitalMlHealth");

/** 30 days of 20-day outcomes is roughly 20–30 independent decisions. */
const WINDOW_DAYS = 30;
const MIN_EVALUATIONS = 20;
const MIN_IC = -0.01;
const MAX_CALIBRATION_ERROR = 0.08;
const MAX_SHADOW_DRAWDOWN_PCT = 5;
const MAX_LIVE_VS_BACKTEST_PCT = 15;

function broadcastAlert(payload: CapitalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_alert", data: payload });
}

export function weightedCalibrationError(
	probabilities: number[],
	labels: number[],
): number {
	const buckets = calibrationBuckets(probabilities, labels, 5);
	let weighted = 0;
	let total = 0;
	for (const bucket of buckets) {
		weighted +=
			Math.abs(bucket.meanProbability - bucket.observedRate) * bucket.count;
		total += bucket.count;
	}
	return total ? weighted / total : 0;
}

export function shadowDrawdownPct(returnsPct: number[]): number {
	let equity = 1;
	let peak = 1;
	let worst = 0;
	for (const value of returnsPct) {
		equity *= 1 + value / 100;
		peak = Math.max(peak, equity);
		worst = Math.max(worst, 1 - equity / peak);
	}
	return worst * 100;
}

export interface MlHealthResult {
	book: CapitalBook;
	evaluated: number;
	ic: number | null;
	calibrationError: number | null;
	drawdownPct: number | null;
	hitRate: number | null;
	breached: boolean;
	reasons: string[];
	disabled: boolean;
}

export async function runCapitalMlHealthCycle(
	book: CapitalBook,
): Promise<MlHealthResult> {
	const config = await getCapitalConfig(book);
	const model = await getActiveCapitalMlModel();
	const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
	const predictions = await getEvaluatedCapitalMlPredictions(book, since);
	const modelMetrics = (model?.metrics ?? {}) as {
		testBaseRate?: number;
	};

	let ic: number | null = null;
	let calibrationError: number | null = null;
	let drawdownPct: number | null = null;
	let hitRate: number | null = null;
	let liveVsBacktestPct: number | null = null;
	const reasons: string[] = [];

	if (predictions.length < MIN_EVALUATIONS) {
		reasons.push(
			`only ${predictions.length} evaluated predictions (need ${MIN_EVALUATIONS})`,
		);
	} else {
		const probabilities = predictions.map((row) => row.probability);
		const labels = predictions.map((row) => (row.barrierHit === 1 ? 1 : 0));
		const returns = predictions.map((row) => row.realizedReturnPct ?? 0);
		ic = pearsonCorrelation(probabilities, returns);
		calibrationError = weightedCalibrationError(probabilities, labels);
		drawdownPct = shadowDrawdownPct(returns);
		hitRate =
			labels.reduce<number>((sum, value) => sum + value, 0) / labels.length;
		const trained = modelMetrics.testBaseRate;
		if (typeof trained === "number") {
			liveVsBacktestPct = (hitRate - trained) * 100;
		}
		if (ic < MIN_IC)
			reasons.push(`rolling IC ${ic.toFixed(3)} below ${MIN_IC}`);
		if (calibrationError > MAX_CALIBRATION_ERROR) {
			reasons.push(
				`calibration error ${calibrationError.toFixed(3)} above ${MAX_CALIBRATION_ERROR}`,
			);
		}
		if (drawdownPct > MAX_SHADOW_DRAWDOWN_PCT) {
			reasons.push(
				`shadow drawdown ${drawdownPct.toFixed(1)}% above ${MAX_SHADOW_DRAWDOWN_PCT}%`,
			);
		}
		if (
			liveVsBacktestPct !== null &&
			Math.abs(liveVsBacktestPct) > MAX_LIVE_VS_BACKTEST_PCT
		) {
			reasons.push(
				`live vs backtest hit rate ${liveVsBacktestPct.toFixed(1)}pp outside ±${MAX_LIVE_VS_BACKTEST_PCT}pp`,
			);
		}
	}

	const hasGuardData = predictions.length >= MIN_EVALUATIONS;
	const breached = hasGuardData && reasons.length > 0;
	const shouldDisable =
		breached && config.mlEnabled && config.mlKillSwitchEnabled;
	const action = shouldDisable ? "disabled" : "none";

	await insertCapitalMlHealth({
		book,
		modelId: model?.id ?? null,
		windowDays: WINDOW_DAYS,
		evaluatedCount: predictions.length,
		ic,
		hitRate,
		calibrationError,
		drawdownPct,
		trainingBaseRate:
			typeof modelMetrics.testBaseRate === "number"
				? modelMetrics.testBaseRate
				: null,
		liveVsBacktestPct,
		breached,
		reasons,
		action,
	});

	if (shouldDisable) {
		const reason = reasons.join("; ");
		await updateCapitalConfig(
			book,
			{
				mlEnabled: false,
				mlDisabledAt: new Date(),
				mlDisabledReason: reason,
			},
			null,
		);
		await recordCapitalAudit({
			book,
			actorDiscordId: null,
			action: "capital.ml.kill_switch",
			entityType: "capital_book_config",
			entityId: book,
			before: { mlEnabled: true },
			after: { mlEnabled: false, reason },
			note: "Automatic ML disable on health drift.",
		});
		broadcastAlert({
			kind: "risk",
			book,
			title: `ML auto-disabled on ${book}`,
			body: `The ML overlay was switched off automatically: ${reason}. It will not re-enable itself.`,
			fields: [
				{ name: "Rolling IC", value: ic?.toFixed(3) ?? "n/a" },
				{
					name: "Calibration error",
					value: calibrationError?.toFixed(3) ?? "n/a",
				},
				{
					name: "Shadow drawdown",
					value: drawdownPct === null ? "n/a" : `${drawdownPct.toFixed(1)}%`,
				},
			],
			link: "/desk",
		});
		logger.warn(`ML auto-disabled on ${book}: ${reason}`);
	} else if (breached) {
		logger.warn(
			`ML health breached on ${book}, but ML is ${config.mlEnabled ? "guarded by a disabled kill switch" : "not enabled"}: ${reasons.join("; ")}`,
		);
	}

	return {
		book,
		evaluated: predictions.length,
		ic,
		calibrationError,
		drawdownPct,
		hitRate,
		breached,
		reasons,
		disabled: shouldDisable,
	};
}

export function startCapitalMlHealth(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "37 * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			for (const book of ["paper", "live"] as const) {
				try {
					await runCapitalMlHealthCycle(book);
				} catch (error) {
					logger.error(
						`ML health check failed for ${book}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		},
	});
}
