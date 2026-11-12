/**
 * Trading policy for the Sentinel Capital book.
 *
 * These are code-level invariants, not dashboard settings. They used to live
 * in `capital_book_configs` and could be edited independently, which let the
 * desk drift into incoherent combinations (12 positions × 12.5% of NAV while
 * `max_equity_pct` capped the book at 85%). Keeping the sizing and exit
 * geometry here means the engine, the API and the UI describe the same book.
 *
 * The dashboards still show the operational switches (engine on/off, public
 * visibility, fees) and the *risk overlay* thresholds. They no longer expose
 * position count, per-position weight, max equity or risk-per-trade.
 *
 * Rationale for the numbers (Torn daily ATR is ~0.5–0.7% of price):
 *
 * - stop = clamp(2.5 × ATR, 2%, 2.5%). Torn daily ATR is ~0.55%, so the 2%
 *   floor binds for most names and volatility only widens it slightly. The old
 *   4% floor risked 4% to chase a 0.3–1.4% reversion.
 * - backtest (2021-2026 daily bars, exact ladder): 15.6% CAGR, Sharpe 4.9,
 *   max drawdown 1.1%, 70% win rate, +0.59R average, versus 14.9% / 3.7 /
 *   1.9% / 58% / +0.21R for the old 4%-stop/mean-exit ladder. See
 *   `scripts/capital-ladder-backtest.ts`.
 * - 1/3 off at +1R, full exit at +2R: a 1:1 trim and a 2:1 rest, instead of a
 *   stored +2R target the ladder never used.
 * - 7 positions × 12% max = 84% ≤ 85% max equity, so every slot can fill.
 * - Confidence sizing uses an 8% base and a 0.5–1.5× multiplier, i.e. 4–12%,
 *   so it never breaches the per-name cap.
 */
export const CAPITAL_SIZING = {
	maxPositions: 7,
	maxEquityPct: 85,
	maxStockWeightPct: 12,
	minCashReservePct: 15,
	riskPerTradePct: 0.5,
	minNotional: "10000000",
} as const;

export const CAPITAL_ENTRY_STOP = {
	/** Stop distance in ATRs at entry. */
	atrMultiplier: 2.5,
	/** Never tighter than this percentage of price (noise guard). */
	minPct: 2,
	/** Never wider than this percentage of price (risk-budget guard). */
	maxPct: 2.5,
	/** Full take-profit distance in initial-risk units (R). */
	targetR: 2,
} as const;

export const CAPITAL_EXIT = {
	trailingTriggerR: 1,
	trailingAtrMultiplier: 2,
	trailingPct: 2,
	tightenTrailPct: 1.5,
	scaleOutR: 1,
	scaleOutFraction: 0.3333,
	timeStopDays: 20,
} as const;

export const CAPITAL_CONFIDENCE = {
	minMultiplier: 0.5,
	maxMultiplier: 1.5,
	/** Confidence multiplier applied to new entries while in drawdown. */
	deriskMultiplier: 0.5,
} as const;

/** Base weight before the confidence multiplier; 8% × 1.5 = 12%. */
export const CAPITAL_BASE_WEIGHT_PCT =
	CAPITAL_SIZING.maxStockWeightPct / CAPITAL_CONFIDENCE.maxMultiplier;

/**
 * Maps a 0–100 signal score to a 0.5–1.5 position-size multiplier.
 *
 * Deliberately simple so a score change is auditable: `0.5 + score/100`.
 * A score of 65 (the entry floor) sizes at ~1.15×, 82 at ~1.32×, 100 at 1.5×.
 */
export function confidenceMultiplier(score: number): number {
	if (!Number.isFinite(score)) return CAPITAL_CONFIDENCE.minMultiplier;
	const normalized = Math.min(1, Math.max(0, score / 100));
	return (
		CAPITAL_CONFIDENCE.minMultiplier +
		normalized *
			(CAPITAL_CONFIDENCE.maxMultiplier - CAPITAL_CONFIDENCE.minMultiplier)
	);
}

/** Machine-readable exit reasons, persisted on orders/fills and shown in the UI. */
export const CAPITAL_EXIT_REASONS = [
	"stop",
	"trail",
	"scale_out",
	"target",
	"tighten_trail",
	"reversal",
	"thesis",
	"time",
	"error_review",
	"manual",
	"none",
	"unknown",
] as const;
export type CapitalExitReason = (typeof CAPITAL_EXIT_REASONS)[number];

export const CAPITAL_EXIT_REASON_LABELS: Record<CapitalExitReason, string> = {
	stop: "Hard stop",
	trail: "Trailing stop",
	scale_out: "Scale out",
	target: "Target hit",
	tighten_trail: "Tightened trail",
	reversal: "Mean reversion",
	thesis: "Thesis broke",
	time: "Time stop",
	error_review: "Error-trade review",
	manual: "Manual",
	none: "—",
	unknown: "Unknown",
};

export function capitalExitReasonLabel(
	reason: string | null | undefined,
): string | null {
	if (!reason) return null;
	return isCapitalExitReason(reason)
		? CAPITAL_EXIT_REASON_LABELS[reason]
		: reason;
}

export function isCapitalExitReason(
	value: unknown,
): value is CapitalExitReason {
	return (
		typeof value === "string" &&
		(CAPITAL_EXIT_REASONS as readonly string[]).includes(value)
	);
}

/**
 * True when a stop-out is recent enough to keep the name out of the book.
 *
 * After a stop-out the same oversold stock often still screens; without this
 * gate the engine can re-buy it on the next cycle and pay the spread twice.
 */
export function isStopCooldownActive(
	lastStopOutAt: Date | null | undefined,
	now: Date,
	cooldownDays: number,
): boolean {
	if (!lastStopOutAt || !Number.isFinite(cooldownDays) || cooldownDays <= 0) {
		return false;
	}
	const elapsedMs = now.getTime() - lastStopOutAt.getTime();
	return elapsedMs >= 0 && elapsedMs < cooldownDays * 86_400_000;
}

/** Percentage drawdown from a per-unit NAV peak (flow-insensitive). */
export function drawdownPctFromPeak(
	currentNavPerUnit: number,
	peakNavPerUnit: number,
): number | null {
	if (
		!Number.isFinite(currentNavPerUnit) ||
		!Number.isFinite(peakNavPerUnit) ||
		peakNavPerUnit <= 0
	) {
		return null;
	}
	return ((currentNavPerUnit - peakNavPerUnit) / peakNavPerUnit) * 100;
}

/** Percentage return since the start of the current UTC day. */
export function dailyReturnPct(
	currentNavPerUnit: number,
	dayStartNavPerUnit: number,
): number | null {
	if (
		!Number.isFinite(currentNavPerUnit) ||
		!Number.isFinite(dayStartNavPerUnit) ||
		dayStartNavPerUnit <= 0
	) {
		return null;
	}
	return ((currentNavPerUnit - dayStartNavPerUnit) / dayStartNavPerUnit) * 100;
}

/**
 * A single market poll that moves more than this percentage is treated as a
 * bad print and skipped for the cycle. Torn stocks can gap on news, so the
 * band is deliberately wide; the point is to catch obviously corrupt ticks,
 * not to smooth normal volatility.
 */
export const CAPITAL_PRICE_GUARD_PCT = 25;

export function isPriceOutlier(
	previous: number,
	next: number,
	maxPct = CAPITAL_PRICE_GUARD_PCT,
): boolean {
	if (
		!Number.isFinite(previous) ||
		!Number.isFinite(next) ||
		previous <= 0 ||
		next <= 0
	) {
		return true;
	}
	return Math.abs(next / previous - 1) * 100 > maxPct;
}
