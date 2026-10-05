import { Logger } from "./logger";
import type { CapacityRegime } from "./oil-rig";
import type { OilRigAnalysis, OilRigDecisionBasis } from "./oil-rig-analysis";
import type { OilRigInventoryState } from "./oil-rig-policy";

const logger = new Logger("BriefStore");

/**
 * Persistence for issued briefs, and the outcome attribution that closes the
 * prediction loop.
 *
 * Two jobs, and the second is the one that makes the advice improvable.
 *
 * 1. HYSTERESIS STATE. The inventory state and the capacity regime are hysteretic,
 *    so the previous brief's values are read back before the next analysis runs.
 *    Without that read-back the thresholds are stateless and the advice oscillates.
 *
 * 2. OUTCOME ATTRIBUTION. Every brief records the exact figures it decided on.
 *    When the next tick lands, the difference between what was predicted and what
 *    actually happened is written back onto the earlier row. Until now the
 *    briefing never checked whether its own advice had worked, so there was no way
 *    to score it or to tune the policy from evidence rather than intuition.
 */

export interface PreviousBriefState {
	id: string;
	asOf: Date;
	regime?: CapacityRegime;
	inventoryState?: OilRigInventoryState;
	warehouseCritical?: boolean;
	adviceSignature: string;
	/** The decision basis recorded by the previous brief, for outcome attribution. */
	decision?: Record<string, number | string | undefined>;
	outcomeEvaluated: boolean;
}

/** Shape of a stored brief row, as far as this module cares. */
interface BriefRow {
	id: string;
	asOf: Date;
	dataBasis: string;
	tickAgeMinutes: number | null;
	regime: string;
	regimeSince: Date;
	inventoryState: string;
	warehouseCritical: number;
	adviceSignature: string;
	directives: unknown;
	analysis: unknown;
	outcome: unknown;
	outcomeEvaluatedAt: Date | null;
}

function isInventoryState(value: string): value is OilRigInventoryState {
	return value === "deficit" || value === "equilibrium" || value === "surplus";
}

/**
 * Reads the state the next analysis has to be hysteretic against.
 *
 * Returns undefined when no brief has been recorded, in which case the analysis
 * falls back to the raw enter thresholds - correct for a first run, and stated in
 * the brief's provenance rather than silently assumed.
 */
export async function loadPreviousBriefState(
	_companyId: number,
): Promise<PreviousBriefState | undefined> {
	try {
		const { db, desc, oilRigBriefs } = await import("../../database");
		// `asOf` alone is not unique: two briefs can be issued in the same second.
		// Ordering by insertion time as well means the most recently written brief
		// is always the one the next analysis is hysteretic against.
		const rows = await db
			.select()
			.from(oilRigBriefs)
			.orderBy(desc(oilRigBriefs.asOf), desc(oilRigBriefs.createdAt))
			.limit(1);
		const row = rows[0] as BriefRow | undefined;
		if (!row) return undefined;

		const analysis = (row.analysis ?? {}) as {
			decision?: Record<string, number | string | undefined>;
			regime?: {
				dwellDays?: number;
				fillingDays?: number;
				drainingDays?: number;
				reason?: string;
			};
		};

		const regimeName =
			row.regime === "extraction_bound" ? "extraction_bound" : "balanced";

		return {
			id: row.id,
			asOf: row.asOf,
			regime: {
				regime: regimeName,
				held: true,
				dwellDays: analysis.regime?.dwellDays ?? 0,
				fillingDays: analysis.regime?.fillingDays ?? 0,
				drainingDays: analysis.regime?.drainingDays ?? 0,
				since: Math.floor(row.regimeSince.getTime() / 1000),
				reason: analysis.regime?.reason ?? "restored from the previous brief",
			},
			inventoryState: isInventoryState(row.inventoryState)
				? row.inventoryState
				: undefined,
			warehouseCritical: row.warehouseCritical > 0,
			adviceSignature: row.adviceSignature,
			decision: analysis.decision,
			outcomeEvaluated: row.outcomeEvaluatedAt !== null,
		};
	} catch (err) {
		logger.warn(
			`Could not load the previous brief state (advice will be non-hysteretic this run): ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}

/** What actually happened between one brief and the next. */
export interface BriefOutcome {
	evaluatedAtIso: string;
	daysElapsed: number;
	fillPctBefore: number;
	fillPctAfter: number;
	fillPctChange: number;
	inStockBefore: number;
	inStockAfter: number;
	dailySoldBefore: number;
	dailySoldAfter: number;
	dailyRevenueBefore: number;
	dailyRevenueAfter: number;
	dailyProfitBefore: number;
	dailyProfitAfter: number;
	priceBefore: number;
	priceAfter: number;
	adBefore: number;
	adAfter: number;
	/** Whether each issued instruction was actually applied. */
	compliance: {
		priceApplied: boolean;
		adApplied: boolean;
		/** Net change in Sales Executive headcount, the sell-through lever. */
		salesHeadcountChange: number;
	};
	/** Plain-language reading of the outcome, for the next brief to print. */
	summary: string;
}

const num = (
	source:
		| Record<string, number | string | undefined>
		| OilRigDecisionBasis
		| undefined,
	key: string,
): number | undefined => {
	const value = (source as Record<string, unknown> | undefined)?.[key];
	return typeof value === "number" ? value : undefined;
};

/**
 * Compares the previous brief's decision basis with the current one.
 *
 * Deliberately descriptive rather than a score: it records what moved and whether
 * the instruction was applied. Turning that into a verdict on the advice requires
 * several ticks of evidence, and pretending otherwise on one day's data is how
 * confident-sounding but unfounded claims get made.
 */
export function attributeBriefOutcome(
	previous: PreviousBriefState,
	analysis: OilRigAnalysis,
): BriefOutcome {
	const before = previous.decision as
		| Record<string, number | string | undefined>
		| undefined;
	const after = analysis.decision;

	const fillBefore = num(before, "fillPct") ?? 0;
	const fillAfter = after.fillPct;
	const daysElapsed =
		Math.round(
			((after.asOfSeconds - Math.floor(previous.asOf.getTime() / 1000)) /
				86_400) *
				10,
		) / 10;

	const priceBefore = num(before, "currentPrice") ?? 0;
	const adBefore = num(before, "currentAdBudget") ?? 0;
	const salesAfter = analysis.roster.currentCounts["Sales Executive"] ?? 0;
	const salesBefore = num(before, "salesHeadcount") ?? salesAfter;

	const fillPctChange = Number((fillAfter - fillBefore).toFixed(1));
	const sellingFaster =
		(num(after, "dailySold") ?? 0) - (num(before, "dailySold") ?? 0);

	const moved = [
		`storage ${fillBefore}% ➔ ${fillAfter}%`,
		`sales ${(num(before, "dailySold") ?? 0).toLocaleString()} ➔ ${after.dailySold.toLocaleString()} bbl/day`,
		`price $${priceBefore} ➔ $${after.currentPrice}`,
		`ad $${adBefore.toLocaleString()} ➔ $${after.currentAdBudget.toLocaleString()}`,
		`Sales Executive seats ${salesBefore} ➔ ${salesAfter}`,
	].join("; ");

	const summary = `Over ${daysElapsed} day${daysElapsed === 1 ? "" : "s"}: ${moved}. ${
		fillPctChange < 0
			? `Storage drained ${Math.abs(fillPctChange)} points.`
			: fillPctChange > 0
				? `Storage filled a further ${fillPctChange} points, so the surplus is not clearing.`
				: "Storage was unchanged."
	}${sellingFaster > 0 ? ` Sell-through rose ${sellingFaster.toLocaleString()} bbl/day.` : sellingFaster < 0 ? ` Sell-through fell ${Math.abs(sellingFaster).toLocaleString()} bbl/day.` : ""}`;

	return {
		evaluatedAtIso: new Date(after.asOfSeconds * 1000).toISOString(),
		daysElapsed,
		fillPctBefore: fillBefore,
		fillPctAfter: fillAfter,
		fillPctChange,
		inStockBefore: num(before, "inStock") ?? 0,
		inStockAfter: after.inStock,
		dailySoldBefore: num(before, "dailySold") ?? 0,
		dailySoldAfter: after.dailySold,
		dailyRevenueBefore: num(before, "recordedDailyRevenue") ?? 0,
		dailyRevenueAfter: after.recordedDailyRevenue,
		dailyProfitBefore: num(before, "recordedDailyProfit") ?? 0,
		dailyProfitAfter: after.recordedDailyProfit,
		priceBefore,
		priceAfter: after.currentPrice,
		adBefore,
		adAfter: after.currentAdBudget,
		compliance: {
			priceApplied: Math.abs(after.currentPrice - priceBefore) > 0,
			adApplied: Math.abs(after.currentAdBudget - adBefore) > 0,
			salesHeadcountChange: salesAfter - salesBefore,
		},
		summary,
	};
}

/**
 * Writes the outcome onto the previous brief, if it has not been judged yet.
 *
 * Idempotent: a brief that already carries an outcome is left alone, so running
 * two briefs back to back does not overwrite the first measurement with the
 * second.
 */
export async function recordBriefOutcome(
	previous: PreviousBriefState,
	outcome: BriefOutcome,
): Promise<void> {
	if (previous.outcomeEvaluated) return;
	try {
		const { db, eq, oilRigBriefs } = await import("../../database");
		await db
			.update(oilRigBriefs)
			.set({
				outcome: outcome as unknown as Record<string, unknown>,
				outcomeEvaluatedAt: new Date(outcome.evaluatedAtIso),
			})
			.where(eq(oilRigBriefs.id, previous.id));
	} catch (err) {
		logger.warn(
			`Could not record the outcome of brief ${previous.id}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export interface PersistBriefInput {
	companyId: number;
	analysis: OilRigAnalysis;
	signature: string;
	previous?: PreviousBriefState;
}

/** Persists the brief so the next run can be hysteretic and can attribute it. */
export async function persistBrief(
	input: PersistBriefInput,
): Promise<string | undefined> {
	const { analysis } = input;
	// The signature is part of the id so that two briefs issued in the same second
	// with DIFFERENT advice are both recorded, while a pure duplicate collapses to
	// one row. Without it, a re-issued brief could be dropped and the next run
	// would wrongly conclude that nothing had changed.
	const id = `oil_rig_brief_${analysis.decision.asOfSeconds}_${input.companyId}_${input.signature}`;
	try {
		const { db, oilRigBriefs } = await import("../../database");
		await db
			.insert(oilRigBriefs)
			.values({
				id,
				companyId: input.companyId,
				asOf: new Date(analysis.decision.asOfSeconds * 1000),
				dataBasis: analysis.provenance.dataBasis,
				tickAgeMinutes: analysis.provenance.tickAgeMinutes ?? null,
				regime: analysis.regime.regime,
				regimeSince: new Date(analysis.regime.since * 1000),
				inventoryState: analysis.stock.state,
				warehouseCritical: analysis.stock.warehouseCritical ? 1 : 0,
				adviceSignature: input.signature,
				directives: analysis.directives as unknown as Record<string, unknown>,
				analysis: {
					decision: analysis.decision,
					provenance: analysis.provenance,
					warnings: analysis.warnings,
					regime: {
						dwellDays: analysis.regime.dwellDays,
						fillingDays: analysis.regime.fillingDays,
						drainingDays: analysis.regime.drainingDays,
						reason: analysis.regime.reason,
					},
				} as unknown as Record<string, unknown>,
			})
			.onConflictDoNothing();
		return id;
	} catch (err) {
		logger.warn(
			`Could not persist the brief (advice still delivered, next run will be non-hysteretic): ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}

/** The most recent measured top-rig roster baseline, as a plain row. */
export async function loadLatestRosterBaselineRow(): Promise<
	| {
			capturedAt: Date;
			rating: number;
			fieldSize: number;
			sampleSize: number;
			roleShares: Record<string, number>;
			avgWeeklyRevenue?: number;
	  }
	| undefined
> {
	try {
		const { db, desc, oilRigBenchmarks } = await import("../../database");
		const rows = await db
			.select()
			.from(oilRigBenchmarks)
			.orderBy(desc(oilRigBenchmarks.capturedAt))
			.limit(1);
		const row = rows[0];
		if (!row) return undefined;
		return {
			capturedAt: row.capturedAt,
			rating: row.rating,
			fieldSize: row.fieldSize,
			sampleSize: row.sampleSize,
			roleShares: row.roleShares as Record<string, number>,
			avgWeeklyRevenue: row.avgWeeklyRevenue,
		};
	} catch (err) {
		logger.warn(
			`Could not load the roster benchmark baseline: ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}
}
