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
import { Logger, tripleBarrierLabel } from "@sentinel/utils";

import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "capital:ml";
const logger = new Logger("Scheduler", "CapitalMlWorker");

/** Tolerates a day of clock skew before a prediction becomes evaluable. */
const MIN_PENDING_AGE_MS = 86_400_000;

async function dailyCloses(
	stockId: number,
	from: Date,
	to: Date,
): Promise<{ at: Date; close: number }[]> {
	const rows = await db
		.select({
			at: capitalMarketCandles.bucketStart,
			close: capitalMarketCandles.close,
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
		.map((row) => ({ at: row.at, close: Number(row.close) }))
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
			if (!modelCache.has(prediction.modelId)) {
				modelCache.set(
					prediction.modelId,
					await getCapitalMlModel(prediction.modelId),
				);
			}
			model = modelCache.get(prediction.modelId) ?? null;
		}
		const artifact = model?.artifact as
			{ targetPct?: number; stopPct?: number } | undefined;
		const targetPct = artifact?.targetPct ?? 2;
		const stopPct = artifact?.stopPct ?? 2;

		const closes = await dailyCloses(
			prediction.stockId,
			prediction.createdAt,
			horizonEnd,
		);
		// Exclude the entry day itself; the prediction price is intraday.
		const forward = closes
			.filter((row) => row.at.getTime() > prediction.createdAt.getTime())
			.slice(0, prediction.horizonDays)
			.map((row) => row.close);
		if (forward.length < prediction.horizonDays) continue;
		const exit = forward[forward.length - 1] ?? entry;
		await completeCapitalMlPrediction(prediction.id, {
			realizedReturnPct: (exit / entry - 1) * 100,
			barrierHit: tripleBarrierLabel(entry, forward, targetPct, stopPct),
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
