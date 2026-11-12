import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { db, sqlClient } from "../../index";
import {
	capitalAccess,
	capitalAuditLog,
	type CapitalBookConfigRow,
	capitalBookConfigs,
	type CapitalBookRow,
	capitalBooks,
	capitalEngineRuns,
	capitalFills,
	type CapitalInvestmentRow,
	capitalInvestments,
	type CapitalInvestorContactRow,
	capitalInvestorContacts,
	type CapitalInvestorRow,
	capitalInvestors,
	capitalMarketCandles,
	capitalMarketLatest,
	capitalMlPredictions,
	capitalNavSnapshots,
	capitalOrders,
	capitalPaymentIntents,
	capitalPayoutObligations,
	capitalPositions,
	capitalReconciliationIssues,
	capitalSmokeReports,
	capitalTransactions,
	capitalWithdrawalRequests,
	type NewCapitalBookConfigRow,
	type NewCapitalTransactionRow,
} from "../schema/capital";
import { getWorkerState, WORKER_STATE_IDS } from "./worker-state";

/**
 * Sentinel Capital data access.
 *
 * This module owns the read helpers and the atomic primitives every caller
 * shares. Higher-level money maths live in `@sentinel/utils`; this file avoids
 * importing them so `@sentinel/database` stays dependency-free.
 *
 * `withCapitalTransaction` takes a PostgreSQL advisory lock keyed by book. The
 * API and scheduler are separate processes and can both mutate the same book
 * (a deposit vs a paper fill), so a plain transaction is not enough: two
 * concurrent NAV reads could issue units at different valuations. The advisory
 * lock serializes every mutation for one book without locking unrelated books.
 */

export type CapitalBook = "live" | "paper";

export const CAPITAL_BOOK_IDS: readonly CapitalBook[] = ["live", "paper"];

export function isCapitalBook(value: unknown): value is CapitalBook {
	return value === "live" || value === "paper";
}

/** The Drizzle transaction type used by the capital primitives. */
export type CapitalTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type CapitalExecutor = Pick<typeof db, "select" | "execute">;

export interface CapitalPositionState {
	stockId: number;
	shares: number;
	costBasis: string;
	realized: string;
	price: string;
}

export interface CapitalBookState {
	cash: string;
	units: string;
	unpaidPayouts: string;
	positions: CapitalPositionState[];
}

function asString(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "bigint") return value.toString();
	return "0";
}

/**
 * Seeds the two books and their default configs.
 *
 * Called on API/scheduler boot and before any book read, so a fresh database
 * (or a migration that predates the seed) does not require a manual step.
 */
export async function ensureCapitalBooks(): Promise<void> {
	await db
		.insert(capitalBooks)
		.values([
			{ book: "live", displayName: "Blasted Stocks" },
			{ book: "paper", displayName: "Paper Book" },
		])
		.onConflictDoNothing();

	await db
		.insert(capitalBookConfigs)
		.values([{ book: "live" }, { book: "paper" }])
		.onConflictDoNothing();
}

export async function getCapitalBook(
	book: CapitalBook,
): Promise<CapitalBookRow | null> {
	await ensureCapitalBooks();
	const [row] = await db
		.select()
		.from(capitalBooks)
		.where(eq(capitalBooks.book, book))
		.limit(1);
	return row ?? null;
}

export async function getCapitalConfig(
	book: CapitalBook,
): Promise<CapitalBookConfigRow> {
	await ensureCapitalBooks();
	const [row] = await db
		.select()
		.from(capitalBookConfigs)
		.where(eq(capitalBookConfigs.book, book))
		.limit(1);
	if (row) return row;
	await db.insert(capitalBookConfigs).values({ book }).onConflictDoNothing();
	const [created] = await db
		.select()
		.from(capitalBookConfigs)
		.where(eq(capitalBookConfigs.book, book))
		.limit(1);
	if (!created) throw new Error(`Capital config for ${book} is unavailable.`);
	return created;
}

export async function updateCapitalConfig(
	book: CapitalBook,
	patch: Partial<Omit<NewCapitalBookConfigRow, "book">>,
	actor: string | null,
): Promise<CapitalBookConfigRow> {
	await ensureCapitalBooks();
	const set: Record<string, unknown> = {
		updatedAt: new Date(),
		updatedBy: actor,
	};
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) set[key] = value;
	}
	await db
		.update(capitalBookConfigs)
		.set(set as Partial<NewCapitalBookConfigRow>)
		.where(eq(capitalBookConfigs.book, book));
	return getCapitalConfig(book);
}

/** Runs a mutation with an advisory lock scoped to one book. */
export async function withCapitalTransaction<T>(
	book: CapitalBook,
	work: (tx: CapitalTx, state: CapitalBookState) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${`capital:${book}`}))`,
		);
		const state = await readCapitalState(tx, book);
		return work(tx, state);
	});
}

/** Reads the signed cash balance, units outstanding, liabilities and positions. */
export async function readCapitalState(
	executor: CapitalExecutor,
	book: CapitalBook,
): Promise<CapitalBookState> {
	const [cashRow] = await executor
		.select({
			cash: sql<string>`COALESCE(SUM(${capitalTransactions.amount}), 0)`,
		})
		.from(capitalTransactions)
		.where(eq(capitalTransactions.book, book));

	const [unitsRow] = await executor
		.select({
			units: sql<string>`COALESCE(SUM(${capitalInvestments.units}), 0)`,
		})
		.from(capitalInvestments)
		.where(eq(capitalInvestments.book, book));

	const [liabilityRow] = await executor
		.select({
			remaining: sql<string>`COALESCE(SUM(${capitalPayoutObligations.remainingAmount}), 0)`,
		})
		.from(capitalPayoutObligations)
		.where(
			and(
				eq(capitalPayoutObligations.book, book),
				inArray(capitalPayoutObligations.status, [
					"due",
					"unfunded",
					"partially_paid",
				]),
			),
		);

	const positions = await executor
		.select({
			stockId: capitalPositions.stockId,
			shares: capitalPositions.shares,
			costBasis: capitalPositions.costBasis,
			realized: capitalPositions.realized,
			price: capitalMarketLatest.price,
		})
		.from(capitalPositions)
		.leftJoin(
			capitalMarketLatest,
			eq(capitalMarketLatest.stockId, capitalPositions.stockId),
		)
		.where(eq(capitalPositions.book, book));

	return {
		cash: asString(cashRow?.cash),
		units: asString(unitsRow?.units),
		unpaidPayouts: asString(liabilityRow?.remaining),
		positions: positions.map((position) => ({
			stockId: position.stockId,
			shares: position.shares,
			costBasis: asString(position.costBasis),
			realized: asString(position.realized),
			price: asString(position.price),
		})),
	};
}

export async function getCapitalState(
	book: CapitalBook,
): Promise<CapitalBookState> {
	return readCapitalState(db, book);
}

export interface CapitalRiskContext {
	/** Highest NAV per unit ever snapshotted for the book. */
	peakNavPerUnit: string | null;
	/** NAV per unit at the last snapshot before the current UTC day started. */
	dayStartNavPerUnit: string | null;
	/** Stocks stopped out inside the cooldown window. */
	stoppedOutStockIds: number[];
}

/**
 * Loads the inputs the risk overlay needs.
 *
 * NAV per unit is used instead of total value because deposits and
 * withdrawals change total value without changing performance; the per-unit
 * number is flow-insensitive.
 */
export async function getCapitalRiskContext(
	book: CapitalBook,
	now: Date,
	cooldownDays: number,
): Promise<CapitalRiskContext> {
	const [peakRow] = await db
		.select({
			peak: sql<string | null>`MAX(${capitalNavSnapshots.navPerUnit})`,
		})
		.from(capitalNavSnapshots)
		.where(eq(capitalNavSnapshots.book, book));

	const dayStart = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	const [dayRow] = await db
		.select({ navPerUnit: capitalNavSnapshots.navPerUnit })
		.from(capitalNavSnapshots)
		.where(
			and(
				eq(capitalNavSnapshots.book, book),
				// Snapshots are upserted into their bucket all day, so the row at
				// exactly 00:00 holds the *current* NAV, not the opening mark.
				// The last row before midnight is the previous day's close.
				lt(capitalNavSnapshots.capturedAt, dayStart),
			),
		)
		.orderBy(desc(capitalNavSnapshots.capturedAt))
		.limit(1);

	let stoppedOutStockIds: number[] = [];
	if (Number.isFinite(cooldownDays) && cooldownDays > 0) {
		const cutoff = new Date(now.getTime() - cooldownDays * 86_400_000);
		const rows = await db
			.selectDistinct({ stockId: capitalFills.stockId })
			.from(capitalFills)
			.where(
				and(
					eq(capitalFills.book, book),
					eq(capitalFills.side, "sell"),
					eq(capitalFills.exitReason, "stop"),
					gte(capitalFills.occurredAt, cutoff),
				),
			);
		stoppedOutStockIds = rows
			.map((row) => row.stockId)
			.filter((stockId): stockId is number => Number.isFinite(stockId));
	}

	return {
		peakNavPerUnit: peakRow?.peak ?? null,
		dayStartNavPerUnit: dayRow?.navPerUnit ?? null,
		stoppedOutStockIds,
	};
}

export async function getCapitalInvestors(
	book: CapitalBook,
): Promise<CapitalInvestorRow[]> {
	return db
		.select()
		.from(capitalInvestors)
		.where(eq(capitalInvestors.book, book))
		.orderBy(capitalInvestors.displayName);
}

export async function getCapitalContacts(
	book: CapitalBook,
): Promise<CapitalInvestorContactRow[]> {
	return db
		.select()
		.from(capitalInvestorContacts)
		.where(eq(capitalInvestorContacts.book, book))
		.orderBy(capitalInvestorContacts.createdAt);
}

export async function getCapitalInvestments(
	book: CapitalBook,
	investorId?: string,
): Promise<CapitalInvestmentRow[]> {
	const filters = [eq(capitalInvestments.book, book)];
	if (investorId) filters.push(eq(capitalInvestments.investorId, investorId));
	return db
		.select()
		.from(capitalInvestments)
		.where(and(...filters))
		.orderBy(desc(capitalInvestments.openedAt));
}

export async function getCapitalPayouts(
	book: CapitalBook,
	statuses?: string[],
) {
	const filters = [eq(capitalPayoutObligations.book, book)];
	if (statuses && statuses.length > 0) {
		filters.push(inArray(capitalPayoutObligations.status, statuses));
	}
	return db
		.select()
		.from(capitalPayoutObligations)
		.where(and(...filters))
		.orderBy(desc(capitalPayoutObligations.dueAt));
}

export async function getCapitalWithdrawals(book: CapitalBook) {
	return db
		.select()
		.from(capitalWithdrawalRequests)
		.where(eq(capitalWithdrawalRequests.book, book))
		.orderBy(desc(capitalWithdrawalRequests.requestedAt));
}

export async function getCapitalIssues(book: CapitalBook, openOnly = true) {
	const filters = [eq(capitalReconciliationIssues.book, book)];
	if (openOnly) filters.push(eq(capitalReconciliationIssues.status, "open"));
	return db
		.select()
		.from(capitalReconciliationIssues)
		.where(and(...filters))
		.orderBy(desc(capitalReconciliationIssues.detectedAt));
}

export async function getCapitalPaymentIntents(book: CapitalBook) {
	return db
		.select()
		.from(capitalPaymentIntents)
		.where(eq(capitalPaymentIntents.book, book))
		.orderBy(desc(capitalPaymentIntents.createdAt));
}

/**
 * Expires open orders past their `expires_at`.
 *
 * The status is what gates re-entry, so an order that is merely old is still
 * treated as "open" by the engine. Without this sweep a recommendation that
 * was never executed blocks that stock forever.
 */
export async function expireCapitalOrders(
	book: CapitalBook,
	now = new Date(),
): Promise<number> {
	const rows = await db
		.update(capitalOrders)
		.set({ status: "expired", updatedAt: now })
		.where(
			and(
				eq(capitalOrders.book, book),
				inArray(capitalOrders.status, [
					"recommended",
					"accepted",
					"partially_filled",
				]),
				lt(capitalOrders.expiresAt, now),
			),
		)
		.returning({ id: capitalOrders.id });
	return rows.length;
}

/**
 * Cross-process mutex for one capital engine cycle.
 *
 * The cron runner is non-reentrant inside its process, but the smoke-test IPC
 * handler calls the cycle directly and can race a cron tick. The lock uses a
 * dedicated reserved connection because PostgreSQL advisory locks are
 * session-scoped, not transaction-scoped.
 */
export async function tryAcquireCapitalEngineLock(): Promise<{
	release: () => Promise<void>;
} | null> {
	const reserved = await sqlClient.reserve();
	try {
		const [row] = await reserved<
			Array<{ locked: boolean }>
		>`SELECT pg_try_advisory_lock(hashtext('capital:engine:cycle')) AS locked`;
		if (!row?.locked) {
			reserved.release();
			return null;
		}
	} catch (error) {
		reserved.release();
		throw error;
	}

	let released = false;
	return {
		release: async () => {
			if (released) return;
			released = true;
			try {
				await reserved`SELECT pg_advisory_unlock(hashtext('capital:engine:cycle'))`;
			} finally {
				reserved.release();
			}
		},
	};
}

/**
 * Deletes minute candles older than the retention window.
 *
 * Daily/hourly bars are kept (the signals and research need them); the 1m
 * table is the one that grows by ~18M rows/year. Returns the number deleted.
 */
export async function pruneCapitalMarketCandles(input: {
	intervalMinutes: number;
	olderThanDays: number;
	now?: Date;
}): Promise<number> {
	const now = input.now ?? new Date();
	const cutoff = new Date(now.getTime() - input.olderThanDays * 86_400_000);
	const rows = await db
		.delete(capitalMarketCandles)
		.where(
			and(
				eq(capitalMarketCandles.intervalMinutes, input.intervalMinutes),
				lt(capitalMarketCandles.bucketStart, cutoff),
			),
		)
		.returning({ stockId: capitalMarketCandles.stockId });
	return rows.length;
}

export async function getCapitalOrders(book: CapitalBook, openOnly = false) {
	const filters = [eq(capitalOrders.book, book)];
	if (openOnly) {
		filters.push(
			inArray(capitalOrders.status, [
				"recommended",
				"accepted",
				"partially_filled",
			]),
		);
	}
	return db
		.select()
		.from(capitalOrders)
		.where(and(...filters))
		.orderBy(desc(capitalOrders.generatedAt));
}

export async function getCapitalFills(book: CapitalBook, limit = 100) {
	return db
		.select()
		.from(capitalFills)
		.where(eq(capitalFills.book, book))
		.orderBy(desc(capitalFills.occurredAt))
		.limit(limit);
}

export async function getCapitalSnapshots(
	book: CapitalBook,
	granularity: "hourly" | "daily",
	limit = 365,
) {
	return db
		.select()
		.from(capitalNavSnapshots)
		.where(
			and(
				eq(capitalNavSnapshots.book, book),
				eq(capitalNavSnapshots.granularity, granularity),
			),
		)
		.orderBy(capitalNavSnapshots.capturedAt)
		.limit(limit);
}

export async function getCapitalMarketLatestMap(): Promise<
	Map<number, typeof capitalMarketLatest.$inferSelect>
> {
	const rows = await db.select().from(capitalMarketLatest);
	return new Map(rows.map((row) => [row.stockId, row]));
}

export async function getCapitalAccess(book: CapitalBook) {
	return db
		.select()
		.from(capitalAccess)
		.where(eq(capitalAccess.book, book))
		.orderBy(desc(capitalAccess.createdAt));
}

export async function getCapitalAudit(book: CapitalBook, limit = 200) {
	return db
		.select()
		.from(capitalAuditLog)
		.where(eq(capitalAuditLog.book, book))
		.orderBy(desc(capitalAuditLog.createdAt))
		.limit(limit);
}

export async function getCapitalEngineRuns(book: CapitalBook, limit = 100) {
	return db
		.select()
		.from(capitalEngineRuns)
		.where(eq(capitalEngineRuns.book, book))
		.orderBy(desc(capitalEngineRuns.startedAt))
		.limit(limit);
}

export async function getCapitalSmokeReports(book: CapitalBook, limit = 25) {
	return db
		.select()
		.from(capitalSmokeReports)
		.where(eq(capitalSmokeReports.book, book))
		.orderBy(desc(capitalSmokeReports.startedAt))
		.limit(limit);
}

export async function getCapitalEngineWorkerState() {
	return getWorkerState(WORKER_STATE_IDS.capitalEngine);
}

export async function getCapitalReconciliationWorkerState() {
	return getWorkerState(WORKER_STATE_IDS.capitalReconciliation);
}

export async function getCapitalPaymentsWorkerState() {
	return getWorkerState(WORKER_STATE_IDS.capitalPayments);
}

/** Audit rows are written by both the API and the scheduler. */
export async function recordCapitalAudit(input: {
	book: CapitalBook;
	actorDiscordId: string | null;
	action: string;
	entityType: string;
	entityId: string;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	note?: string | null;
}): Promise<void> {
	await db.insert(capitalAuditLog).values({
		book: input.book,
		actorDiscordId: input.actorDiscordId,
		action: input.action,
		entityType: input.entityType,
		entityId: input.entityId,
		before: input.before ?? null,
		after: input.after ?? null,
		note: input.note ?? null,
	});
}

export async function createCapitalIssue(input: {
	book: CapitalBook;
	kind: string;
	title: string;
	detail: string;
	stockId?: number | null;
	investorId?: string | null;
	amount?: string | null;
	details?: Record<string, unknown>;
}): Promise<typeof capitalReconciliationIssues.$inferSelect> {
	const [row] = await db
		.insert(capitalReconciliationIssues)
		.values({
			book: input.book,
			kind: input.kind,
			title: input.title,
			detail: input.detail,
			stockId: input.stockId ?? null,
			investorId: input.investorId ?? null,
			amount: input.amount ?? null,
			details: input.details ?? {},
		})
		.returning();
	if (!row) throw new Error("Failed to create capital issue.");
	return row;
}

export async function attachCapitalIssueMessage(
	issueId: string,
	channelId: string | null,
	messageId: string | null,
): Promise<void> {
	await db
		.update(capitalReconciliationIssues)
		.set({
			discordChannelId: channelId,
			discordMessageId: messageId,
			updatedAt: new Date(),
		})
		.where(eq(capitalReconciliationIssues.id, issueId));
}

export async function resolveCapitalIssue(
	issueId: string,
	status: "resolved" | "ignored",
	resolvedBy: string | null,
	note: string | null,
): Promise<void> {
	await db
		.update(capitalReconciliationIssues)
		.set({
			status,
			resolvedAt: new Date(),
			resolvedBy,
			resolutionNote: note,
			updatedAt: new Date(),
		})
		.where(eq(capitalReconciliationIssues.id, issueId));
}

export async function recordCapitalTransaction(
	tx: CapitalTx,
	row: NewCapitalTransactionRow,
): Promise<typeof capitalTransactions.$inferSelect> {
	const [inserted] = await tx
		.insert(capitalTransactions)
		.values(row)
		.returning();
	if (!inserted) throw new Error("Failed to record capital transaction.");
	return inserted;
}

/**
 * Applies a stock fill to the position and cash ledger.
 *
 * Buys add the notional plus fees to cost basis and, on a *new* position,
 * freeze the entry metadata (fill price, hard stop, target, high-water mark).
 * Sells remove the average cost of the shares sold and add realised P&L; a full
 * exit clears the entry metadata so the next entry starts clean. A scale-out
 * marks `scaled_out_at` so the engine does not trim the same position twice.
 * The SQL does the arithmetic in PostgreSQL numeric so no decimal is ever
 * parsed as a float.
 */
export async function applyCapitalFill(
	tx: CapitalTx,
	input: {
		book: CapitalBook;
		stockId: number;
		side: "buy" | "sell";
		shares: number;
		price: string;
		notional: string;
		fees: string;
		/** Signed cash impact of the fill, already computed by the caller. */
		cashDelta: string;
		/** Buy cost basis: notional + fees, already computed by the caller. */
		totalCost: string;
		source: string;
		/** Owner recorded this as an off-recommendation fund error trade. */
		unplanned?: boolean;
		/** Entry plan copied onto a new position. Ignored when one is open. */
		entry?: {
			price: string;
			stopPrice: string | null;
			targetPrice: string | null;
		};
		/** Machine-readable reason for a sell fill. */
		exitReason?: string | null;
		occurredAt: Date;
	},
): Promise<void> {
	if (input.shares <= 0) return;

	if (input.side === "buy") {
		const entryPrice = input.entry?.price ?? input.price;
		const stopPrice = input.entry?.stopPrice ?? null;
		const targetPrice = input.entry?.targetPrice ?? null;
		await tx
			.insert(capitalPositions)
			.values({
				book: input.book,
				stockId: input.stockId,
				shares: input.shares,
				costBasis: input.totalCost,
				realized: "0",
				isUnplanned: input.unplanned ?? false,
				entryPrice,
				stopPrice,
				targetPrice,
				peakPrice: entryPrice,
				openedAt: input.occurredAt,
				lastTradeAt: input.occurredAt,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [capitalPositions.book, capitalPositions.stockId],
				set: {
					shares: sql`${capitalPositions.shares} + ${input.shares}`,
					costBasis: sql`${capitalPositions.costBasis} + ${input.totalCost}::numeric`,
					isUnplanned: input.unplanned
						? true
						: sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN false ELSE ${capitalPositions.isUnplanned} END`,
					// A re-entry after the position was fully closed must not
					// inherit the previous trade's openedAt/stop/target/peak.
					openedAt: sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN ${input.occurredAt.toISOString()}::timestamptz ELSE ${capitalPositions.openedAt} END`,
					entryPrice: sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN ${entryPrice}::numeric ELSE ${capitalPositions.entryPrice} END`,
					stopPrice: sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN ${stopPrice}::numeric ELSE ${capitalPositions.stopPrice} END`,
					targetPrice: sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN ${targetPrice}::numeric ELSE ${capitalPositions.targetPrice} END`,
					peakPrice: sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN ${entryPrice}::numeric ELSE ${capitalPositions.peakPrice} END`,
					scaledOutAt: sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN NULL ELSE ${capitalPositions.scaledOutAt} END`,
					lastTradeAt: input.occurredAt,
					updatedAt: new Date(),
				},
			});
	} else {
		const costRemoved = sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN 0 ELSE ${capitalPositions.costBasis} * ${input.shares}::numeric / ${capitalPositions.shares}::numeric END`;
		const grossProceeds = sql`${input.notional}::numeric - ${input.fees}::numeric`;
		const closesPosition = sql`${capitalPositions.shares} - ${input.shares} <= 0`;
		const isScaleOut = input.exitReason === "scale_out";
		// Build the scale-out flag in SQL: whether the position closes is only
		// known to the database, so a JS ternary on the SQL expression would
		// always be truthy.
		const scaledOutSet = isScaleOut
			? sql`CASE WHEN ${closesPosition} THEN NULL ELSE ${input.occurredAt.toISOString()}::timestamptz END`
			: sql`CASE WHEN ${closesPosition} THEN NULL ELSE ${capitalPositions.scaledOutAt} END`;
		await tx
			.update(capitalPositions)
			.set({
				shares: sql`GREATEST(0, ${capitalPositions.shares} - ${input.shares})`,
				costBasis: sql`CASE WHEN ${closesPosition} THEN 0 ELSE ${capitalPositions.costBasis} - ${costRemoved} END`,
				realized: sql`${capitalPositions.realized} + (${grossProceeds} - ${costRemoved})`,
				entryPrice: sql`CASE WHEN ${closesPosition} THEN NULL ELSE ${capitalPositions.entryPrice} END`,
				stopPrice: sql`CASE WHEN ${closesPosition} THEN NULL ELSE ${capitalPositions.stopPrice} END`,
				targetPrice: sql`CASE WHEN ${closesPosition} THEN NULL ELSE ${capitalPositions.targetPrice} END`,
				peakPrice: sql`CASE WHEN ${closesPosition} THEN NULL ELSE ${capitalPositions.peakPrice} END`,
				scaledOutAt: scaledOutSet,
				lastTradeAt: input.occurredAt,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(capitalPositions.book, input.book),
					eq(capitalPositions.stockId, input.stockId),
				),
			);
	}

	await recordCapitalTransaction(tx, {
		book: input.book,
		type: input.side,
		stockId: input.stockId,
		amount: input.cashDelta,
		shares: input.shares,
		price: input.price,
		fees: input.fees,
		source: input.source,
		occurredAt: input.occurredAt,
		metadata: input.exitReason ? { exitReason: input.exitReason } : {},
	});
}

/**
 * Deletes every paper-book row, preserving the book's configuration.
 *
 * Shared by the blank reset (dashboard button) and the seeded reset (smoke
 * test). The audit row is inserted *after* the wipe so the reset itself is
 * still recorded even though the book is empty.
 */
async function wipePaperBook(
	tx: CapitalTx,
	actor: string | null,
): Promise<void> {
	const now = new Date();
	await tx.delete(capitalFills).where(eq(capitalFills.book, "paper"));
	await tx.delete(capitalOrders).where(eq(capitalOrders.book, "paper"));
	await tx
		.delete(capitalWithdrawalRequests)
		.where(eq(capitalWithdrawalRequests.book, "paper"));
	await tx
		.delete(capitalPayoutObligations)
		.where(eq(capitalPayoutObligations.book, "paper"));
	await tx
		.delete(capitalPaymentIntents)
		.where(eq(capitalPaymentIntents.book, "paper"));
	await tx
		.delete(capitalReconciliationIssues)
		.where(eq(capitalReconciliationIssues.book, "paper"));
	await tx
		.delete(capitalTransactions)
		.where(eq(capitalTransactions.book, "paper"));
	await tx.delete(capitalPositions).where(eq(capitalPositions.book, "paper"));
	await tx
		.delete(capitalInvestments)
		.where(eq(capitalInvestments.book, "paper"));
	await tx.delete(capitalInvestors).where(eq(capitalInvestors.book, "paper"));
	await tx
		.delete(capitalNavSnapshots)
		.where(eq(capitalNavSnapshots.book, "paper"));
	await tx
		.delete(capitalSmokeReports)
		.where(eq(capitalSmokeReports.book, "paper"));
	await tx.delete(capitalAccess).where(eq(capitalAccess.book, "paper"));
	await tx
		.delete(capitalMlPredictions)
		.where(eq(capitalMlPredictions.book, "paper"));
	await tx.delete(capitalEngineRuns).where(eq(capitalEngineRuns.book, "paper"));
	await tx.delete(capitalAuditLog).where(eq(capitalAuditLog.book, "paper"));
	// The book keeps running, but its age starts over: the public page should
	// not claim months of history for a simulation that was just cleared.
	await tx
		.update(capitalBooks)
		.set({ startedAt: now, updatedAt: now })
		.where(eq(capitalBooks.book, "paper"));
	await tx.insert(capitalAuditLog).values({
		book: "paper",
		actorDiscordId: actor,
		action: "paper.reset",
		entityType: "capital_book",
		entityId: "paper",
		after: { resetAt: now.toISOString() },
		note: "Paper simulation cleared.",
	});
}

/**
 * Clears the paper book. No operator/investor is seeded: the owner adds paper
 * investors and records their deposits on the desk.
 */
export async function clearCapitalPaperBook(
	actor: string | null,
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext('capital:paper'))`,
		);
		await wipePaperBook(tx, actor);
	});
}

/**
 * Wipes and reseeds the paper book with one operator lot.
 *
 * Used by the smoke test, which needs a funded book to exercise a full cycle.
 * The dashboard reset uses `clearCapitalPaperBook` instead.
 */
export async function resetCapitalPaperBook(
	startingCash: string,
	actor: string | null,
): Promise<void> {
	if (!/^\d+(\.\d+)?$/.test(startingCash) || Number(startingCash) <= 0) {
		throw new Error("Paper starting cash must be a positive decimal.");
	}

	await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext('capital:paper'))`,
		);
		await wipePaperBook(tx, actor);

		const [operator] = await tx
			.insert(capitalInvestors)
			.values({
				book: "paper",
				kind: "operator",
				displayName: "Paper Operator",
				createdBy: actor,
			})
			.returning();
		if (!operator) throw new Error("Failed to seed paper operator.");

		const now = new Date();
		const [lot] = await tx
			.insert(capitalInvestments)
			.values({
				book: "paper",
				investorId: operator.id,
				frequency: "monthly",
				principal: startingCash,
				units: startingCash,
				navAtDeposit: "1",
				highWaterNav: "1",
				openedAt: now,
				nextPayoutAt: new Date(
					Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
				),
				createdBy: actor,
			})
			.returning();
		if (!lot) throw new Error("Failed to seed paper lot.");

		await tx.insert(capitalTransactions).values({
			book: "paper",
			type: "seed",
			investorId: operator.id,
			investmentId: lot.id,
			amount: startingCash,
			units: startingCash,
			navPerUnit: "1",
			source: "manual",
			occurredAt: now,
			recordedBy: actor,
			note: "Paper book reset.",
		});
	});
}
