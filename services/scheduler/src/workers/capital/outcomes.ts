/**
 * Post-hoc outcome tracking for capital recommendations.
 *
 * The engine records why it traded; this worker records what happened next.
 * One row per filled buy order and horizon (1d/5d/20d) gives the desk an
 * honest measure of recommendation quality instead of only realised P&L.
 *
 * It is deliberately read-only with respect to the book: no orders, fills or
 * cash are touched.
 */
import {
	and,
	capitalMarketCandles,
	capitalOrderOutcomes,
	capitalOrders,
	db,
	eq,
	gt,
	gte,
	lte,
} from "@sentinel/database";
import type { CapitalBook } from "@sentinel/schemas";
const HORIZONS = [1, 5, 20] as const;
const LOOKBACK_DAYS = 60;

export async function evaluateCapitalOrderOutcomes(
	book: CapitalBook,
): Promise<number> {
	const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
	const orders = await db
		.select()
		.from(capitalOrders)
		.where(
			and(
				eq(capitalOrders.book, book),
				eq(capitalOrders.side, "buy"),
				eq(capitalOrders.status, "filled"),
				gt(capitalOrders.filledShares, 0),
				gte(capitalOrders.generatedAt, since),
			),
		);

	let written = 0;
	for (const order of orders) {
		const entryPrice = Number(
			order.averageFillPrice ?? order.priceGuide ?? "0",
		);
		if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
		const entryAt = order.acceptedAt ?? order.generatedAt;
		const candles = await db
			.select()
			.from(capitalMarketCandles)
			.where(
				and(
					eq(capitalMarketCandles.stockId, order.stockId),
					eq(capitalMarketCandles.intervalMinutes, 1_440),
					gte(
						capitalMarketCandles.bucketStart,
						new Date(entryAt.getTime() - 86_400_000),
					),
					lte(
						capitalMarketCandles.bucketStart,
						new Date(
							entryAt.getTime() + (Math.max(...HORIZONS) + 1) * 86_400_000,
						),
					),
				),
			)
			.orderBy(capitalMarketCandles.bucketStart);

		for (const horizon of HORIZONS) {
			const window = candles.slice(0, horizon);
			if (window.length < horizon) continue;
			const last = window[window.length - 1];
			if (!last) continue;
			const close = Number(last.close);
			if (!Number.isFinite(close) || close <= 0) continue;
			const highs = window.map((row) => Number(row.high));
			const lows = window.map((row) => Number(row.low));
			const maxFavorablePct =
				((Math.max(...highs) - entryPrice) / entryPrice) * 100;
			const maxAdversePct =
				((Math.min(...lows) - entryPrice) / entryPrice) * 100;
			const returnPct = ((close - entryPrice) / entryPrice) * 100;
			await db
				.insert(capitalOrderOutcomes)
				.values({
					orderId: order.id,
					book,
					horizon: `${horizon}d`,
					price: last.close,
					returnPct,
					maxAdversePct,
					maxFavorablePct,
					evaluatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: [capitalOrderOutcomes.orderId, capitalOrderOutcomes.horizon],
					set: {
						price: last.close,
						returnPct,
						maxAdversePct,
						maxFavorablePct,
						evaluatedAt: new Date(),
					},
				});
			written += 1;
		}
	}
	return written;
}
