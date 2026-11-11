/**
 * Sentinel Capital ML data audit.
 *
 * Read-only. Reports whether the candle store has enough history for the
 * research plan in `docs/capital-ml.md`, and how many forward-return labels
 * are currently constructible. Run with:
 *
 *   bun run scripts/capital-ml-audit.ts
 */
import {
	capitalEngineRuns,
	capitalMarketCandles,
	capitalMarketLatest,
	capitalNavSnapshots,
	db,
} from "../packages/database";

const HORIZONS = [
	{ label: "1h", seconds: 3_600 },
	{ label: "4h", seconds: 14_400 },
	{ label: "1d", seconds: 86_400 },
	{ label: "7d", seconds: 604_800 },
] as const;

async function main(): Promise<void> {
	const rows = await db.select().from(capitalMarketCandles);
	const latest = await db.select().from(capitalMarketLatest);
	const runs = await db.select().from(capitalEngineRuns);
	const snaps = await db.select().from(capitalNavSnapshots);

	const byInterval = new Map<number, typeof rows>();
	for (const row of rows) {
		const list = byInterval.get(row.intervalMinutes) ?? [];
		list.push(row);
		byInterval.set(row.intervalMinutes, list);
	}

	console.log("# Capital ML data audit\n");
	console.log(`Generated: ${new Date().toISOString()}\n`);

	console.log("## Store coverage\n");
	console.log("| Interval | Rows | Stocks | First | Last | Days |");
	console.log("| --- | ---: | ---: | --- | --- | ---: |");
	for (const [interval, list] of [...byInterval.entries()].sort(
		(a, b) => a[0] - b[0],
	)) {
		const stocks = new Set(list.map((row) => row.stockId)).size;
		const first = list.reduce(
			(min, row) => (row.bucketStart < min ? row.bucketStart : min),
			list[0]?.bucketStart ?? new Date(),
		);
		const last = list.reduce(
			(max, row) => (row.bucketStart > max ? row.bucketStart : max),
			list[0]?.bucketStart ?? new Date(),
		);
		const days = (last.getTime() - first.getTime()) / 86_400_000;
		console.log(
			`| ${interval}m | ${list.length} | ${stocks} | ${first.toISOString()} | ${last.toISOString()} | ${days.toFixed(0)} |`,
		);
	}
	console.log(
		`\nLatest price rows: ${latest.length}; detail performance seeded: ${latest.filter((row) => row.detailUpdatedAt).length}.`,
	);
	console.log(`Engine runs: ${runs.length}; NAV snapshots: ${snaps.length}.`);

	const series = new Map<number, number[]>();
	for (const row of byInterval.get(5) ?? []) {
		const list = series.get(row.stockId) ?? [];
		list.push(Math.floor(row.bucketStart.getTime() / 1000));
		series.set(row.stockId, list);
	}
	for (const list of series.values()) list.sort((a, b) => a - b);
	const counts = [...series.values()]
		.map((list) => list.length)
		.sort((a, b) => a - b);
	const median = counts[Math.floor(counts.length / 2)] ?? 0;

	console.log("\n## 5m per-stock coverage\n");
	console.log(
		`Stocks: ${series.size}; min ${counts[0] ?? 0}, median ${median}, max ${counts[counts.length - 1] ?? 0} candles.`,
	);

	let maxGap = 0;
	for (const list of series.values()) {
		for (let i = 1; i < list.length; i++) {
			const gap = (list[i] ?? 0) - (list[i - 1] ?? 0);
			if (gap > maxGap) maxGap = gap;
		}
	}
	console.log(
		`Largest gap between consecutive 5m candles: ${(maxGap / 60).toFixed(1)} minutes.`,
	);

	console.log("\n## Constructible labels (5m store)\n");
	console.log("| Horizon | Labeled rows | Stocks with labels |");
	console.log("| --- | ---: | ---: |");
	for (const horizon of HORIZONS) {
		let labeled = 0;
		let stocksWithLabels = 0;
		for (const list of series.values()) {
			let count = 0;
			for (let i = 0; i < list.length; i++) {
				const target = (list[i] ?? 0) + horizon.seconds;
				if ((list[list.length - 1] ?? 0) >= target) count += 1;
			}
			labeled += count;
			if (count > 0) stocksWithLabels += 1;
		}
		console.log(`| ${horizon.label} | ${labeled} | ${stocksWithLabels} |`);
	}

	const first = rows.reduce(
		(min, row) => (row.bucketStart < min ? row.bucketStart : min),
		rows[0]?.bucketStart ?? new Date(),
	);
	const last = rows.reduce(
		(max, row) => (row.bucketStart > max ? row.bucketStart : max),
		rows[0]?.bucketStart ?? new Date(),
	);
	const observedHours = Math.max(
		0,
		(last.getTime() - first.getTime()) / 3_600_000,
	);
	console.log(
		`\nObserved span: ${observedHours.toFixed(2)} hours. Five-minute samples per stock per day at full coverage: 288.`,
	);
	console.log(
		`For a 180-day study: ~${(180 * 288 * 35).toLocaleString()} 5m rows across 35 stocks.`,
	);

	// Readiness is per interval: the research plan needs a long daily/hourly
	// series and only a recent minute series for execution modelling.
	console.log("\n## ML readiness\n");
	console.log("| Interval | Days | Threshold | Ready |");
	console.log("| --- | ---: | ---: | :---: |");
	const thresholds: Array<[number, number]> = [
		[1, 30],
		[5, 30],
		[60, 180],
		[1_440, 365],
	];
	for (const [interval, needed] of thresholds) {
		const list = byInterval.get(interval) ?? [];
		const spanDays =
			list.length === 0
				? 0
				: (list
						.reduce(
							(max, row) => (row.bucketStart > max ? row.bucketStart : max),
							list[0]?.bucketStart ?? new Date(),
						)
						.getTime() -
						list
							.reduce(
								(min, row) => (row.bucketStart < min ? row.bucketStart : min),
								list[0]?.bucketStart ?? new Date(),
							)
							.getTime()) /
					86_400_000;
		console.log(
			`| ${interval}m | ${spanDays.toFixed(0)} | ${needed} | ${spanDays >= needed ? "yes" : "no"} |`,
		);
	}

	console.log(
		"\nVerdict: " +
			(observedHours < 24
				? "not trainable yet. Run `bun run stocks:backfill` to seed the history store."
				: observedHours < 24 * 30
					? "still too short for daily/weekly ML. Useful only for plumbing and volatility checks."
					: "long enough for a first walk-forward baseline. See docs/capital-ml-research.md for the reversal findings and the meta-label plan."),
	);
}

main()
	.catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => process.exit(0));
