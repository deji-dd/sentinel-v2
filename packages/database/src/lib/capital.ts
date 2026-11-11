import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../index";
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
	capitalMarketLatest,
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
 * Buys add the notional plus fees to cost basis. Sells remove the average cost
 * of the shares sold and add realised P&L. The SQL does the arithmetic in
 * PostgreSQL numeric so no decimal is ever parsed as a float.
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
		occurredAt: Date;
	},
): Promise<void> {
	if (input.shares <= 0) return;

	if (input.side === "buy") {
		await tx
			.insert(capitalPositions)
			.values({
				book: input.book,
				stockId: input.stockId,
				shares: input.shares,
				costBasis: input.totalCost,
				realized: "0",
				isUnplanned: input.unplanned ?? false,
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
					lastTradeAt: input.occurredAt,
					updatedAt: new Date(),
				},
			});
	} else {
		const costRemoved = sql`CASE WHEN ${capitalPositions.shares} <= 0 THEN 0 ELSE ${capitalPositions.costBasis} * ${input.shares}::numeric / ${capitalPositions.shares}::numeric END`;
		const grossProceeds = sql`${input.notional}::numeric - ${input.fees}::numeric`;
		await tx
			.update(capitalPositions)
			.set({
				shares: sql`GREATEST(0, ${capitalPositions.shares} - ${input.shares})`,
				costBasis: sql`CASE WHEN ${capitalPositions.shares} - ${input.shares} <= 0 THEN 0 ELSE ${capitalPositions.costBasis} - ${costRemoved} END`,
				realized: sql`${capitalPositions.realized} + (${grossProceeds} - ${costRemoved})`,
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
	});
}

/**
 * Wipes and reseeds the paper book.
 *
 * Used by the admin reset and the smoke-test handler. The book's configuration
 * is preserved; only paper rows are deleted. The seeded operator lot issues
 * `startingCash` units at $1, so the book starts with a well-defined NAV and a
 * payout path that can be exercised immediately.
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
