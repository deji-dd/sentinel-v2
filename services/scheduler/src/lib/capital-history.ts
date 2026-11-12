/**
 * Torn stock history seeding.
 *
 * Shared by the `stocks:backfill` operator command and the `capital:history`
 * scheduler worker. The scheduler calls this on boot when the candle store is
 * short, so a fresh deploy seeds itself; the command remains for larger manual
 * windows (e.g. years of minute bars).
 *
 * The one-time source is the public tornsy.com mirror. After the seed the
 * scheduler owns collection — nothing at runtime depends on the mirror.
 */
import { and, capitalMarketCandles, db, eq, sql } from "@sentinel/database";
import { Logger } from "@sentinel/utils";

const TORNSY_BASE = "https://tornsy.com/api";
const TORN_BASE = "https://api.torn.com/v2";
const REQUEST_DELAY_MS = 120;
const PAGE_LIMIT = 2_000;
const INSERT_CHUNK = 500;
export const MARKET_LAUNCH_SECONDS = Date.UTC(2021, 3, 15) / 1000;

const logger = new Logger("Scheduler", "CapitalHistory");

export type BackfillInterval = "d1" | "h1" | "m1";

export const INTERVAL_MINUTES: Record<BackfillInterval, number> = {
	d1: 1_440,
	h1: 60,
	m1: 1,
};

export interface StockRef {
	id: number;
	acronym: string;
	name: string;
}

export interface SeedOptions {
	intervals: BackfillInterval[];
	m1Days?: number;
	stocks?: string[] | null;
	fromTs?: number;
	dryRun?: boolean;
	strict?: boolean;
	/** Stop paging at this epoch ms so a scheduled run can resume next cycle. */
	deadlineMs?: number;
	tornApiKey: string;
	onProgress?: (message: string) => void;
}

export interface IntervalStat {
	fetched: number;
	inserted: number;
	skippedExisting: boolean;
	firstTs: number;
	lastTs: number;
}

export interface StockSeedResult {
	stock: StockRef;
	intervals: Map<BackfillInterval, IntervalStat>;
	validation?: { ok: boolean; detail: string };
}

export interface SeedResult {
	stocks: StockSeedResult[];
	inserted: number;
	partial: boolean;
	elapsedMs: number;
}

export interface ReadinessInterval {
	stocks: number;
	days: number;
	lastAgeHours: number | null;
	ready: boolean;
}

export interface Readiness {
	daily: ReadinessInterval;
	hourly: ReadinessInterval;
	minute: ReadinessInterval;
	ready: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/** Sleep, but never past the caller's deadline. */
async function budgetedSleep(ms: number, deadlineMs?: number): Promise<void> {
	if (!deadlineMs) return sleep(ms);
	const remaining = deadlineMs - Date.now();
	if (remaining <= 0) return;
	await sleep(Math.min(ms, remaining));
}

export function pastDeadline(deadlineMs?: number): boolean {
	return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

async function fetchJson<T>(url: string, attempts = 4): Promise<T> {
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(30_000),
			});
			if (response.ok) return (await response.json()) as T;
			if (response.status === 429 || response.status >= 500) {
				lastError = new Error(`${url} -> HTTP ${response.status}`);
				await sleep(1_000 * 2 ** (attempt - 1));
				continue;
			}
			throw new Error(`${url} -> HTTP ${response.status}`);
		} catch (error) {
			lastError = error;
			if (attempt === attempts) break;
			await sleep(1_000 * 2 ** (attempt - 1));
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchTornStocks(apiKey: string): Promise<StockRef[]> {
	const payload = await fetchJson<{
		stocks?: Array<{ id: number; acronym: string; name: string }>;
		error?: { error: string };
	}>(
		`${TORN_BASE}/torn/stocks?key=${encodeURIComponent(apiKey)}&comment=SentinelBackfill`,
	);
	if (payload.error) throw new Error(`Torn: ${payload.error.error}`);
	const stocks = payload.stocks ?? [];
	if (stocks.length === 0) throw new Error("Torn returned no stocks.");
	return stocks.map((stock) => ({
		id: stock.id,
		acronym: stock.acronym,
		name: stock.name,
	}));
}

async function fetchPerformance(
	apiKey: string,
	stockId: number,
): Promise<{ high: number; low: number; start: number; price: number } | null> {
	const payload = await fetchJson<{
		stocks?: {
			market?: { price: number };
			chart?: {
				performance?: Record<
					string,
					{ high: number; low: number; start: number }
				>;
			};
		};
		error?: { error: string };
	}>(
		`${TORN_BASE}/torn/${stockId}/stocks?key=${encodeURIComponent(apiKey)}&comment=SentinelBackfill`,
	);
	const performance = payload.stocks?.chart?.performance?.all_time;
	if (!performance) return null;
	return {
		high: performance.high,
		low: performance.low,
		start: performance.start,
		price: payload.stocks?.market?.price ?? 0,
	};
}

/** Oldest stored bucket for a stock/interval, in epoch seconds. */
async function minBucket(
	stockId: number,
	intervalMinutes: number,
): Promise<number | null> {
	const [row] = await db
		.select({
			min: sql<
				number | null
			>`(EXTRACT(EPOCH FROM MIN(${capitalMarketCandles.bucketStart})))::double precision`,
		})
		.from(capitalMarketCandles)
		.where(
			and(
				eq(capitalMarketCandles.stockId, stockId),
				eq(capitalMarketCandles.intervalMinutes, intervalMinutes),
			),
		);
	return row?.min ?? null;
}

type TornsyRow = [number, ...(string | number)[]];

async function fetchPage(
	ticker: string,
	interval: BackfillInterval,
	to?: number,
): Promise<TornsyRow[]> {
	const url = `${TORNSY_BASE}/${encodeURIComponent(ticker)}?interval=${interval}&limit=${PAGE_LIMIT}${
		to ? `&to=${to}` : ""
	}`;
	const payload = await fetchJson<{ data?: TornsyRow[] }>(url);
	await sleep(REQUEST_DELAY_MS);
	return payload.data ?? [];
}

function toCandles(
	stockId: number,
	interval: BackfillInterval,
	rows: TornsyRow[],
	floorTs: number,
	ceilingTs: number | null,
): Array<typeof capitalMarketCandles.$inferInsert> {
	const values: Array<typeof capitalMarketCandles.$inferInsert> = [];
	const sorted = [...rows].sort((a, b) => Number(a[0]) - Number(b[0]));
	for (const row of sorted) {
		const timestamp = Number(row[0]);
		if (!Number.isFinite(timestamp)) continue;
		if (timestamp < floorTs) continue;
		if (ceilingTs !== null && timestamp >= ceilingTs) continue;
		const bucketStart = new Date(timestamp * 1000);
		if (interval === "m1") {
			const price = Number(row[1]);
			const shares = Number(row[2]);
			if (!(price > 0)) continue;
			values.push({
				stockId,
				intervalMinutes: 1,
				bucketStart,
				open: String(price),
				high: String(price),
				low: String(price),
				close: String(price),
				shares: Number.isFinite(shares) ? Math.trunc(shares) : null,
				investors: null,
				samples: 1,
			});
			continue;
		}
		const open = Number(row[1]);
		const high = Number(row[2]);
		const low = Number(row[3]);
		const close = Number(row[4]);
		const shares = Number(row[5]);
		if (
			![open, high, low, close].every(
				(value) => Number.isFinite(value) && value > 0,
			)
		) {
			continue;
		}
		values.push({
			stockId,
			intervalMinutes: INTERVAL_MINUTES[interval],
			bucketStart,
			open: String(open),
			high: String(high),
			low: String(low),
			close: String(close),
			shares: Number.isFinite(shares) ? Math.trunc(shares) : null,
			investors: null,
			samples: 1,
		});
	}
	return values;
}

async function insertCandles(
	values: Array<typeof capitalMarketCandles.$inferInsert>,
	dryRun: boolean,
): Promise<number> {
	if (dryRun || values.length === 0) return values.length;
	let inserted = 0;
	for (let i = 0; i < values.length; i += INSERT_CHUNK) {
		const chunk = values.slice(i, i + INSERT_CHUNK);
		const result = await db
			.insert(capitalMarketCandles)
			.values(chunk)
			.onConflictDoNothing()
			.returning({ id: capitalMarketCandles.stockId });
		inserted += result.length;
	}
	return inserted;
}

async function backfillInterval(
	stock: StockRef,
	interval: BackfillInterval,
	options: SeedOptions,
): Promise<IntervalStat> {
	const intervalMinutes = INTERVAL_MINUTES[interval];
	const stepSeconds = intervalMinutes * 60;
	const launch = options.fromTs ?? MARKET_LAUNCH_SECONDS;
	const desiredStart =
		interval === "m1"
			? Math.floor(Date.now() / 1000) - (options.m1Days ?? 7) * 86_400
			: launch;
	const existingMin = await minBucket(stock.id, intervalMinutes);
	const stat: IntervalStat = {
		fetched: 0,
		inserted: 0,
		skippedExisting: false,
		firstTs: 0,
		lastTs: 0,
	};

	if (existingMin !== null && existingMin <= desiredStart + stepSeconds) {
		stat.skippedExisting = true;
		return stat;
	}

	// `to` is exclusive, so continuing from the stored minimum never refetches
	// the rows the scheduler already owns.
	let cursor: number | undefined = existingMin ?? undefined;
	const ceiling = cursor ?? null;

	for (let page = 0; page < 20_000; page++) {
		if (pastDeadline(options.deadlineMs)) break;
		const rows = await fetchPage(stock.acronym, interval, cursor);
		if (rows.length === 0) break;
		const values = toCandles(stock.id, interval, rows, desiredStart, ceiling);
		if (values.length > 0) {
			stat.fetched += values.length;
			stat.inserted += await insertCandles(values, options.dryRun ?? false);
			const first = values[0]?.bucketStart.getTime() ?? 0;
			const last = values[values.length - 1]?.bucketStart.getTime() ?? 0;
			if (stat.firstTs === 0 || first / 1000 < stat.firstTs) {
				stat.firstTs = first / 1000;
			}
			if (last / 1000 > stat.lastTs) stat.lastTs = last / 1000;
		}
		const oldest = Math.min(...rows.map((row) => Number(row[0])));
		if (!Number.isFinite(oldest) || oldest <= desiredStart) break;
		cursor = oldest;
		if (rows.length < PAGE_LIMIT) break;
	}

	return stat;
}

/**
 * Compares stored daily extremes with Torn's all-time anchors. The high must
 * match. The low may sit above Torn's low because the mirror starts a few hours
 * after launch; a stored low below Torn's is impossible.
 */
export function compareAnchors(
	tornHigh: number,
	tornLow: number,
	storedHigh: number,
	storedLow: number,
): { ok: boolean; detail: string } {
	const highPct = ((storedHigh - tornHigh) / tornHigh) * 100;
	const lowPct = ((storedLow - tornLow) / tornLow) * 100;
	const highOk = Math.abs(highPct) <= 0.5;
	const lowOk = lowPct >= -0.5 && lowPct <= 10;
	const detail = `high ${storedHigh.toFixed(2)} vs ${tornHigh.toFixed(2)} (${highPct.toFixed(2)}%); low ${storedLow.toFixed(2)} vs ${tornLow.toFixed(2)} (${lowPct.toFixed(2)}%)`;
	return { ok: highOk && lowOk, detail };
}

export async function storedDailyExtremes(
	stockId: number,
): Promise<{ rows: number; minLow: number; maxHigh: number } | null> {
	const [row] = await db
		.select({
			minLow: sql<string | null>`MIN(${capitalMarketCandles.low})`,
			maxHigh: sql<string | null>`MAX(${capitalMarketCandles.high})`,
			rows: sql<string>`COUNT(*)`,
		})
		.from(capitalMarketCandles)
		.where(
			and(
				eq(capitalMarketCandles.stockId, stockId),
				eq(capitalMarketCandles.intervalMinutes, 1_440),
			),
		);
	if (!row?.minLow || !row.maxHigh) return null;
	return {
		rows: Number(row.rows),
		minLow: Number(row.minLow),
		maxHigh: Number(row.maxHigh),
	};
}

export async function validateStockAnchors(
	apiKey: string,
	stock: StockRef,
	strict: boolean,
): Promise<string> {
	const performance = await fetchPerformance(apiKey, stock.id);
	if (!performance) return "no torn performance";
	const stored = await storedDailyExtremes(stock.id);
	if (!stored) return "no stored d1 data";
	const { ok, detail } = compareAnchors(
		performance.high,
		performance.low,
		stored.maxHigh,
		stored.minLow,
	);
	if (!ok) {
		if (strict)
			throw new Error(`${stock.acronym} validation failed: ${detail}`);
		return `MISMATCH ${detail}`;
	}
	return `ok (${detail})`;
}

export async function seedCapitalHistory(
	options: SeedOptions,
): Promise<SeedResult> {
	const startedAt = Date.now();
	const allStocks = await fetchTornStocks(options.tornApiKey);
	const stocks = options.stocks
		? allStocks.filter((stock) => options.stocks?.includes(stock.acronym))
		: allStocks;
	if (stocks.length === 0) throw new Error("No matching stocks.");

	const results: StockSeedResult[] = [];
	let partial = false;
	for (const stock of stocks) {
		if (pastDeadline(options.deadlineMs)) {
			partial = true;
			break;
		}
		const result: StockSeedResult = { stock, intervals: new Map() };
		for (const interval of options.intervals) {
			try {
				const stat = await backfillInterval(stock, interval, options);
				result.intervals.set(interval, stat);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				options.onProgress?.(`${stock.acronym} ${interval} failed: ${message}`);
			}
		}
		if (options.intervals.includes("d1") && !options.dryRun) {
			const performance = await fetchPerformance(options.tornApiKey, stock.id);
			const stored = await storedDailyExtremes(stock.id);
			if (performance && stored) {
				result.validation = compareAnchors(
					performance.high,
					performance.low,
					stored.maxHigh,
					stored.minLow,
				);
				if (!result.validation.ok && options.strict) {
					throw new Error(
						`${stock.acronym} validation failed: ${result.validation.detail}`,
					);
				}
			}
		}
		results.push(result);
		const cells = [...result.intervals.entries()].map(([interval, stat]) =>
			stat.skippedExisting
				? `${interval} ok`
				: stat.fetched > 0
					? `${interval} ${stat.inserted.toLocaleString()} rows`
					: `${interval} none`,
		);
		options.onProgress?.(
			`${stock.acronym.padEnd(4)} ${cells.join(" | ")}${
				result.validation
					? ` | ${result.validation.ok ? "ok" : "MISMATCH"} ${result.validation.detail}`
					: ""
			}`,
		);
		await budgetedSleep(0, options.deadlineMs);
	}

	const inserted = results.reduce((sum, result) => {
		for (const stat of result.intervals.values()) sum += stat.inserted;
		return sum;
	}, 0);
	return {
		stocks: results,
		inserted,
		partial,
		elapsedMs: Date.now() - startedAt,
	};
}

async function intervalCoverage(
	intervalMinutes: number,
): Promise<ReadinessInterval> {
	const [row] = await db
		.select({
			stocks: sql<string>`COUNT(DISTINCT ${capitalMarketCandles.stockId})`,
			min: sql<
				number | null
			>`(EXTRACT(EPOCH FROM MIN(${capitalMarketCandles.bucketStart})))::double precision`,
			max: sql<
				number | null
			>`(EXTRACT(EPOCH FROM MAX(${capitalMarketCandles.bucketStart})))::double precision`,
		})
		.from(capitalMarketCandles)
		.where(eq(capitalMarketCandles.intervalMinutes, intervalMinutes));
	const stocks = Number(row?.stocks ?? 0);
	const min = row?.min ?? null;
	const max = row?.max ?? null;
	const days = min && max ? (max - min) / 86_400 : 0;
	const lastAgeHours = max ? (Date.now() / 1000 - max) / 3_600 : null;
	return {
		stocks,
		days,
		lastAgeHours,
		ready: stocks >= 30 && days >= 0,
	};
}

/**
 * Whether the store has enough history for the engine's daily signals and for
 * the research dataset. Readiness is intentionally about *span*, not row count:
 * a freshly seeded store is dense.
 */
export async function capitalHistoryReadiness(): Promise<Readiness> {
	const [daily, hourly, minute] = await Promise.all([
		intervalCoverage(1_440),
		intervalCoverage(60),
		intervalCoverage(1),
	]);
	// Daily bars are written by every market poll now, so a stale high-water
	// mark means the store stopped updating (a long outage, or the old engine
	// that only wrote 1m/5m/60m). Treat it as not ready so the seed refills the
	// gap instead of leaving the reversal SMA/z-score frozen at the last seed.
	const dailyFresh = (daily.lastAgeHours ?? Infinity) <= 48;
	const dailyReady = daily.stocks >= 30 && daily.days >= 365 && dailyFresh;
	const hourlyReady = hourly.stocks >= 30 && hourly.days >= 60;
	const minuteReady =
		minute.stocks >= 30 &&
		minute.days >= 1 &&
		(minute.lastAgeHours ?? Infinity) <= 48;
	return {
		daily: { ...daily, ready: dailyReady },
		hourly: { ...hourly, ready: hourlyReady },
		minute: { ...minute, ready: minuteReady },
		ready: dailyReady && hourlyReady,
	};
}

/** Logs one line per missing interval for the scheduler worker. */
export function describeReadiness(readiness: Readiness): string {
	const parts: string[] = [];
	for (const [name, value] of Object.entries({
		daily: readiness.daily,
		hourly: readiness.hourly,
		minute: readiness.minute,
	})) {
		if (!value.ready) {
			parts.push(`${name}: ${value.stocks} stocks / ${value.days.toFixed(0)}d`);
		}
	}
	return parts.length === 0 ? "ready" : `missing ${parts.join(", ")}`;
}

export { logger as capitalHistoryLogger };
