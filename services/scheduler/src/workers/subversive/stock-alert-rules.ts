import {
	formatStockAlertWindow,
	type StockAlertEvent,
	type StockAlertMarketContext,
	type StockAlertState,
	type StockAlertWindow,
	type SubversiveStockAlertConfig,
} from "@sentinel/schemas";

/**
 * Pure stock-alert evaluation.
 *
 * Split from the worker so every rule — seeding, thresholds, reference-sample
 * selection, cooldowns, new extremes — is testable without Torn, Discord or the
 * database. The worker's only job is to fetch snapshots, load state, call this,
 * and dispatch whatever comes back.
 */

/** Price tolerance for extreme comparisons: prices carry two decimals. */
const EXTREME_EPSILON = 1e-6;

/**
 * How much of a requested change window the reference sample must actually
 * cover.
 *
 * Torn's history series is 1-minute resolution over roughly the last hour. If it
 * is ever shorter, the oldest available sample can be much newer than the
 * window being measured; accepting it would relabel a two-minute flick as a
 * thirty-minute move. Requiring at least half the window keeps the label honest
 * at the cost of skipping the rule for a cycle.
 */
const MIN_WINDOW_COVERAGE_RATIO = 0.5;

/** One stock's Torn performance figures for a single window. */
export interface StockAlertWindowPerformance {
	/** Percentage change across the window (`change_percentage`). */
	changePct: number;
	/** Price at the start of the window. */
	start: number;
	/** Highest price within the window. */
	high: number;
	/** Lowest price within the window. */
	low: number;
}

/** One history point from `chart.history` (documented as `{ timestamp, price }`). */
export interface StockAlertHistoryPoint {
	/** Unix timestamp in seconds, as returned by Torn. */
	timestamp: number;
	price: number;
}

/** Everything the rules need to know about one stock this cycle. */
export interface StockAlertSnapshot {
	stockId: number;
	name: string;
	acronym: string;
	/** Current market price, from `/torn/stocks`. */
	price: number;
	/**
	 * Torn's own rolling-window figures. `24h` is `chart.performance.last_day`
	 * and `all_time` is `chart.performance.all_time`; either may be absent when
	 * the detailed response was incomplete.
	 */
	performance: Partial<Record<StockAlertWindow, StockAlertWindowPerformance>>;
	/** `chart.history` raw points (order is not trusted). */
	history: StockAlertHistoryPoint[];
}

export interface StockAlertEvaluation {
	events: StockAlertEvent[];
	nextState: StockAlertState;
}

/** Clean slate for a stock that has never been evaluated. */
export function createEmptyStockAlertState(): StockAlertState {
	return {
		seeded: false,
		lastPrice: null,
		extremes: {},
		lastAlertAt: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerces a stored `state` JSON blob into a usable shape.
 *
 * Rows are written by this worker, but a JSON column is still untrusted input:
 * a half-written or hand-edited row must not crash the cycle or, worse, be
 * mistaken for "seeded" and skip the baseline capture.
 */
export function normaliseStockAlertState(raw: unknown): StockAlertState {
	if (!isRecord(raw)) return createEmptyStockAlertState();

	const extremes: StockAlertState["extremes"] = {};
	const rawExtremes = raw.extremes;
	if (isRecord(rawExtremes)) {
		for (const window of ["24h", "all_time"] as const) {
			const entry = rawExtremes[window];
			if (
				isRecord(entry) &&
				typeof entry.high === "number" &&
				typeof entry.low === "number"
			) {
				extremes[window] = { high: entry.high, low: entry.low };
			}
		}
	}

	const lastAlertAt: Record<string, number> = {};
	const rawLastAlertAt = raw.lastAlertAt;
	if (isRecord(rawLastAlertAt)) {
		for (const [key, value] of Object.entries(rawLastAlertAt)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				lastAlertAt[key] = value;
			}
		}
	}

	return {
		seeded: raw.seeded === true,
		lastPrice:
			typeof raw.lastPrice === "number" && Number.isFinite(raw.lastPrice)
				? raw.lastPrice
				: null,
		extremes,
		lastAlertAt,
	};
}

/**
 * Picks the reference price a change rule measures against.
 *
 * Returns the **oldest** point that is not older than the target instant, which
 * measures at most — never more than — the requested window. Points older than
 * the target are ignored rather than used, because falling back to the oldest
 * available point would silently widen the window and could report a move the
 * rule never asked about.
 *
 * Returns null when no point reaches back at least half the window, so a rule is
 * skipped instead of being mislabelled.
 */
export function findReferenceSample(
	history: readonly StockAlertHistoryPoint[],
	nowMs: number,
	windowMinutes: number,
): StockAlertHistoryPoint | null {
	let memo = referenceSampleMemo.get(history);
	if (!memo) {
		memo = new Map<string, StockAlertHistoryPoint | null>();
		referenceSampleMemo.set(history, memo);
	}

	const memoKey = `${windowMinutes}|${nowMs}`;
	if (memo.has(memoKey)) {
		return memo.get(memoKey) ?? null;
	}

	const result = computeReferenceSample(history, nowMs, windowMinutes);
	memo.set(memoKey, result);
	return result;
}

/**
 * Memo for `findReferenceSample`.
 *
 * The stock snapshot is shared by every faction evaluated in a sweep and `nowMs`
 * is fixed for that sweep, so the filter/map/sort over the price history was
 * recomputed to an identical answer once per (faction x stock x rule). Keying on
 * the history array identity means the memo dies with the snapshot, so it can
 * never serve a sample computed for a different point in time.
 */
const referenceSampleMemo = new WeakMap<
	readonly StockAlertHistoryPoint[],
	Map<string, StockAlertHistoryPoint | null>
>();

function computeReferenceSample(
	history: readonly StockAlertHistoryPoint[],
	nowMs: number,
	windowMinutes: number,
): StockAlertHistoryPoint | null {
	const targetMs = nowMs - windowMinutes * 60_000;
	const minimumAgeMs = windowMinutes * 60_000 * MIN_WINDOW_COVERAGE_RATIO;

	const points = history
		.filter(
			(point) =>
				Number.isFinite(point.timestamp) &&
				Number.isFinite(point.price) &&
				point.price > 0,
		)
		.map((point) => ({ timestamp: point.timestamp, price: point.price }))
		.sort((a, b) => a.timestamp - b.timestamp);

	let candidate: StockAlertHistoryPoint | null = null;
	for (const point of points) {
		if (point.timestamp * 1000 >= targetMs) {
			candidate = point;
			break;
		}
	}

	if (!candidate) return null;
	if (nowMs - candidate.timestamp * 1000 < minimumAgeMs) return null;
	return candidate;
}

/**
 * Resolves the signed percentage move a rule measures, or null when the window
 * cannot be measured honestly this cycle.
 */
export function resolveChange(
	snapshot: StockAlertSnapshot,
	windowMinutes: number,
	nowMs: number,
): {
	changePct: number;
	referencePrice: number;
	referenceAt: number;
} | null {
	// Torn publishes a rolling 24-hour change directly, so the one-day rule does
	// not depend on the hour-long history series at all.
	if (windowMinutes >= 1440) {
		const dayPerformance = snapshot.performance["24h"];
		if (!dayPerformance) return null;
		if (
			!Number.isFinite(dayPerformance.changePct) ||
			!Number.isFinite(dayPerformance.start) ||
			dayPerformance.start <= 0
		) {
			return null;
		}
		return {
			changePct: dayPerformance.changePct,
			referencePrice: dayPerformance.start,
			referenceAt: nowMs - windowMinutes * 60_000,
		};
	}

	const reference = findReferenceSample(snapshot.history, nowMs, windowMinutes);
	if (!reference) return null;

	return {
		changePct: ((snapshot.price - reference.price) / reference.price) * 100,
		referencePrice: reference.price,
		referenceAt: reference.timestamp * 1000,
	};
}

/** Whether an alert key is still inside its cooldown. */
export function isCoolingDown(
	lastAlertAtMs: number | undefined,
	nowMs: number,
	cooldownMinutes: number,
): boolean {
	if (lastAlertAtMs === undefined) return false;
	if (cooldownMinutes <= 0) return false;
	return nowMs - lastAlertAtMs < cooldownMinutes * 60_000;
}

function buildContext(snapshot: StockAlertSnapshot): StockAlertMarketContext {
	const day = snapshot.performance["24h"];
	const allTime = snapshot.performance.all_time;
	return {
		dayHigh: day?.high ?? snapshot.price,
		dayLow: day?.low ?? snapshot.price,
		allTimeHigh: allTime?.high ?? snapshot.price,
		allTimeLow: allTime?.low ?? snapshot.price,
	};
}

function windowLabel(window: StockAlertWindow): string {
	return window === "all_time" ? "all time" : "24 hours";
}

/**
 * Evaluates one stock against one faction's configuration.
 *
 * Ordering and suppression rules, all of which the tests pin down:
 *
 * - The first evaluation is a **seeding** cycle: it records Torn's own 24h and
 *   all-time extremes as baselines and emits nothing, so switching the feature
 *   on cannot produce an instant alert burst.
 * - A change rule fires when the absolute move is at or above its threshold; the
 *   comparison uses the signed percentage so gains and drops share one rule.
 * - An extreme fires only on a **strictly new** high/low, so a price that merely
 *   sits at its window high does not re-alert every cycle.
 * - A suppressed alert still records its baseline and still starts a fresh
 *   cooldown: alerts are per episode, so a move that keeps holding is reported
 *   once rather than every cycle the threshold happens to remain crossed.
 */
export function evaluateStockAlerts(params: {
	snapshot: StockAlertSnapshot;
	config: SubversiveStockAlertConfig;
	state: StockAlertState | null;
	nowMs: number;
}): StockAlertEvaluation {
	const { snapshot, config, nowMs } = params;
	const current = params.state ?? createEmptyStockAlertState();

	const nextState: StockAlertState = {
		seeded: current.seeded,
		lastPrice: snapshot.price,
		extremes: { ...current.extremes },
		lastAlertAt: { ...current.lastAlertAt },
	};

	// ── Seeding ───────────────────────────────────────────────────────────────
	// Baselines are Torn's own figures, so the very first cycle is already
	// accurate instead of treating "first price we happened to see" as a high.
	if (!current.seeded) {
		let haveBaseline = false;
		for (const window of ["24h", "all_time"] as const) {
			const performance = snapshot.performance[window];
			if (performance) {
				nextState.extremes[window] = {
					high: performance.high,
					low: performance.low,
				};
				haveBaseline = true;
			}
		}
		// Stays unseeded when the detailed response carried no window figures, so
		// the next cycle with real data performs the baseline capture instead of
		// comparing against nothing.
		nextState.seeded = haveBaseline;
		return { events: [], nextState };
	}

	const events: StockAlertEvent[] = [];
	const context = buildContext(snapshot);

	// ── Notable moves ─────────────────────────────────────────────────────────
	for (const rule of config.changeRules) {
		const move = resolveChange(snapshot, rule.windowMinutes, nowMs);
		if (!move) continue;
		if (!Number.isFinite(move.changePct)) continue;
		if (Math.abs(move.changePct) < rule.thresholdPct) continue;

		const alertKey = `change:${rule.windowMinutes}`;
		const suppressed = isCoolingDown(
			current.lastAlertAt[alertKey],
			nowMs,
			config.cooldownMinutes,
		);
		// Refreshed either way: an episode that stays above the threshold starts a
		// new cooldown here, so it is reported once rather than on a timer.
		nextState.lastAlertAt[alertKey] = nowMs;
		if (suppressed) continue;

		events.push({
			type: "change",
			alertKey,
			stockId: snapshot.stockId,
			name: snapshot.name,
			acronym: snapshot.acronym,
			price: snapshot.price,
			windowLabel: formatStockAlertWindow(rule.windowMinutes),
			changePct: move.changePct,
			referencePrice: move.referencePrice,
			referenceAt: move.referenceAt,
			thresholdPct: rule.thresholdPct,
			context,
		});
	}

	// ── Window highs and lows ─────────────────────────────────────────────────
	for (const window of config.highLowWindows) {
		const performance = snapshot.performance[window];
		if (!performance) continue;

		const recorded = nextState.extremes[window];
		if (!recorded) {
			nextState.extremes[window] = {
				high: performance.high,
				low: performance.low,
			};
			continue;
		}

		if (performance.high > recorded.high + EXTREME_EPSILON) {
			const alertKey = `high:${window}`;
			const suppressed = isCoolingDown(
				current.lastAlertAt[alertKey],
				nowMs,
				config.cooldownMinutes,
			);
			nextState.lastAlertAt[alertKey] = nowMs;
			nextState.extremes[window] = {
				high: performance.high,
				low: Math.min(recorded.low, performance.low),
			};
			if (!suppressed) {
				events.push({
					type: "high",
					alertKey,
					stockId: snapshot.stockId,
					name: snapshot.name,
					acronym: snapshot.acronym,
					price: snapshot.price,
					windowLabel: windowLabel(window),
					extreme: performance.high,
					previousExtreme: recorded.high,
					context,
				});
			}
		} else if (performance.low < recorded.low - EXTREME_EPSILON) {
			const alertKey = `low:${window}`;
			const suppressed = isCoolingDown(
				current.lastAlertAt[alertKey],
				nowMs,
				config.cooldownMinutes,
			);
			nextState.lastAlertAt[alertKey] = nowMs;
			nextState.extremes[window] = {
				high: Math.max(recorded.high, performance.high),
				low: performance.low,
			};
			if (!suppressed) {
				events.push({
					type: "low",
					alertKey,
					stockId: snapshot.stockId,
					name: snapshot.name,
					acronym: snapshot.acronym,
					price: snapshot.price,
					windowLabel: windowLabel(window),
					extreme: performance.low,
					previousExtreme: recorded.low,
					context,
				});
			}
		}
	}

	return { events, nextState };
}
