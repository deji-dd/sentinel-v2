/**
 * Capital ML outcome scorer.
 *
 * Shadow predictions are only useful if their outcomes are measured. Hourly,
 * this fills `realized_return_pct` and the triple-barrier outcome for any
 * prediction whose horizon has elapsed, using the stored daily candles. It
 * never trains and never touches orders.
 */
import {
	and,
	capitalMarketCandles,
	type CapitalMlModelRow,
	completeCapitalMlPrediction,
	db,
	eq,
	getCapitalMlModel,
	getPendingCapitalMlPredictions,
	gte,
	lte,
} from "@sentinel/database";
import {
	adjustForCorporateActions,
	CAPITAL_ML_LABEL_SPEC,
	CAPITAL_ML_STOP_PCT,
	CAPITAL_ML_TARGET_PCT,
	CAPITAL_SALE_FEE_PCT,
	type CapitalCandle,
	evaluateTripleBarrier,
	Logger,
} from "@sentinel/utils";

import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "capital:ml";
const logger = new Logger("Scheduler", "CapitalMlWorker");

/** Tolerates a day of clock skew before a prediction becomes evaluable. */
const MIN_PENDING_AGE_MS = 86_400_000;

interface DailyCandle extends CapitalCandle {
	at: Date;
}

async function dailyCandles(
	stockId: number,
	from: Date,
	to: Date,
): Promise<DailyCandle[]> {
	const rows = await db
		.select({
			at: capitalMarketCandles.bucketStart,
			open: capitalMarketCandles.open,
			high: capitalMarketCandles.high,
			low: capitalMarketCandles.low,
			close: capitalMarketCandles.close,
			shares: capitalMarketCandles.shares,
		})
		.from(capitalMarketCandles)
		.where(
			and(
				eq(capitalMarketCandles.stockId, stockId),
				eq(capitalMarketCandles.intervalMinutes, 1_440),
				gte(capitalMarketCandles.bucketStart, from),
				lte(capitalMarketCandles.bucketStart, to),
			),
		)
		.orderBy(capitalMarketCandles.bucketStart);
	return rows
		.map((row) => ({
			at: row.at,
			timestamp: row.at.getTime() / 1000,
			open: Number(row.open),
			high: Number(row.high),
			low: Number(row.low),
			close: Number(row.close),
			shares: row.shares ?? null,
		}))
		.filter((row) => Number.isFinite(row.close) && row.close > 0);
}

export async function runCapitalMlCycle(): Promise<{
	evaluated: number;
	pending: number;
}> {
	const pending = await getPendingCapitalMlPredictions(
		new Date(Date.now() - MIN_PENDING_AGE_MS),
		500,
	);
	const modelCache = new Map<string, CapitalMlModelRow | null>();
	const rejectedModels = new Set<string>();
	let evaluated = 0;
	for (const prediction of pending) {
		const horizonEnd = new Date(
			prediction.createdAt.getTime() + prediction.horizonDays * 86_400_000,
		);
		if (horizonEnd.getTime() > Date.now()) continue;
		const entry = prediction.entryPrice;
		if (!entry || entry <= 0) continue;

		let model: CapitalMlModelRow | null = null;
		if (prediction.modelId) {
			if (rejectedModels.has(prediction.modelId)) continue;
			if (!modelCache.has(prediction.modelId)) {
				modelCache.set(
					prediction.modelId,
					await getCapitalMlModel(prediction.modelId),
				);
			}
			model = modelCache.get(prediction.modelId) ?? null;
		}
		const artifact = model?.artifact as
			| {
					targetPct?: number;
					stopPct?: number;
					labelSpec?: string;
			  }
			| undefined;
		// Outcomes must be measured under exactly the label the model was
		// trained on. Anything else (legacy v1 or a future spec) is left
		// pending rather than written into the same column.
		if (artifact?.labelSpec !== CAPITAL_ML_LABEL_SPEC) {
			const key = prediction.modelId ?? "unknown";
			if (!rejectedModels.has(key)) {
				rejectedModels.add(key);
				logger.warn(
					`Skipping outcome scoring for model ${key}: label spec '${artifact?.labelSpec ?? "missing"}' is not '${CAPITAL_ML_LABEL_SPEC}'.`,
				);
			}
			continue;
		}
		const targetPct = artifact.targetPct ?? CAPITAL_ML_TARGET_PCT;
		const stopPct = artifact.stopPct ?? CAPITAL_ML_STOP_PCT;

		// Include the entry day so a split/merge boundary is visible to the
		// adjuster; the forward window itself still starts after the entry.
		const candles = await dailyCandles(
			prediction.stockId,
			new Date(prediction.createdAt.getTime() - 86_400_000),
			horizonEnd,
		);
		const adjusted = adjustForCorporateActions(candles).candles;
		const forward = adjusted
			.filter((row) => row.at.getTime() > prediction.createdAt.getTime())
			.slice(0, prediction.horizonDays);
		if (forward.length < prediction.horizonDays) continue;
		const outcome = evaluateTripleBarrier(
			entry,
			forward,
			targetPct,
			stopPct,
			CAPITAL_SALE_FEE_PCT,
		);
		await completeCapitalMlPrediction(prediction.id, {
			realizedReturnPct: outcome.returnPct,
			barrierHit:
				outcome.outcome === "target" ? 1 : outcome.outcome === "stop" ? 0 : -1,
		});
		evaluated++;
	}
	if (evaluated > 0) {
		logger.info(`Scored ${evaluated} ML predictions.`);
	}
	return { evaluated, pending: pending.length - evaluated };
}

export function startCapitalMl(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "23 * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await runCapitalMlCycle();
		},
	});
}
