import {
	and,
	capitalPositions,
	capitalReconciliationIssues,
	capitalTransactions,
	createCapitalIssue,
	db,
	eq,
	sql,
	upsertWorkerState,
	userStocks,
	WORKER_STATE_IDS,
} from "@sentinel/database";
import type { CapitalAlertPayload } from "@sentinel/schemas";
import { formatMoney, Logger, parseMoney } from "@sentinel/utils";

import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import { syncUserStocks } from "../personal/stocks";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "capital:reconcile";
const logger = new Logger("Scheduler", "CapitalReconcile");

function broadcastAlert(payload: CapitalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_alert", data: payload });
}

async function hasOpenIssue(
	kind: string,
	stockId: number | null,
): Promise<boolean> {
	const filters = [
		eq(capitalReconciliationIssues.book, "live"),
		eq(capitalReconciliationIssues.status, "open"),
		eq(capitalReconciliationIssues.kind, kind),
	];
	if (stockId !== null) {
		filters.push(eq(capitalReconciliationIssues.stockId, stockId));
	}
	const [existing] = await db
		.select({ id: capitalReconciliationIssues.id })
		.from(capitalReconciliationIssues)
		.where(and(...filters))
		.limit(1);
	return Boolean(existing);
}

async function createIssue(input: {
	kind: string;
	title: string;
	detail: string;
	stockId?: number | null;
	amount?: string | null;
	details?: Record<string, unknown>;
}): Promise<void> {
	const issue = await createCapitalIssue({
		book: "live",
		kind: input.kind,
		title: input.title,
		detail: input.detail,
		stockId: input.stockId ?? null,
		amount: input.amount ?? null,
		details: input.details ?? {},
	});
	broadcastAlert({
		kind: "reconciliation",
		book: "live",
		title: issue.title,
		body: issue.detail,
		fields: [{ name: "Kind", value: issue.kind, inline: true }],
		link: "https://stocks.blasted-labs.tech/desk",
	});
}

/**
 * Live-only sanity check.
 *
 * The fund keeps its own virtual sub-position; the account is the custody
 * location. If Torn reports fewer shares than the fund believes it owns, a sell
 * went unrecorded (or shares moved), and the only safe response is an issue for
 * the owner. An excess is personal stock and is deliberately ignored.
 */
export async function runCapitalReconcileCycle(): Promise<void> {
	try {
		await syncUserStocks();

		const fundPositions = await db
			.select()
			.from(capitalPositions)
			.where(eq(capitalPositions.book, "live"));
		const account = await db.select().from(userStocks);
		const accountByStock = new Map(
			account.map((row) => [Number.parseInt(row.id, 10), row.shares]),
		);

		for (const position of fundPositions) {
			if (position.shares <= 0) continue;
			const accountShares = accountByStock.get(position.stockId) ?? 0;
			if (accountShares >= position.shares) continue;
			if (await hasOpenIssue("share_shortfall", position.stockId)) continue;
			await createIssue({
				kind: "share_shortfall",
				title: `Fund position exceeds the account: stock #${position.stockId}`,
				detail: `Fund holds ${position.shares.toLocaleString()} shares but Torn reports ${accountShares.toLocaleString()}. A sale may be unrecorded.`,
				stockId: position.stockId,
				details: {
					fundShares: position.shares,
					accountShares,
				},
			});
		}

		const [cashRow] = await db
			.select({
				cash: sql<string>`COALESCE(SUM(${capitalTransactions.amount}), 0)`,
			})
			.from(capitalTransactions)
			.where(eq(capitalTransactions.book, "live"));
		const cash = parseMoney(String(cashRow?.cash ?? "0"));
		if (cash < 0n && !(await hasOpenIssue("cash_overdraft", null))) {
			await createIssue({
				kind: "cash_overdraft",
				title: "The live book is overdrawn",
				detail: `Recorded cash is ${formatMoney(cash)}. A deposit or correction is required before new buys.`,
				amount: formatMoney(cash),
			});
		}

		await upsertWorkerState({
			workerId: WORKER_STATE_IDS.capitalReconciliation,
			status: "idle",
			lastError: null,
			lastRunAt: new Date(),
			details: {
				lastSuccessAt: new Date().toISOString(),
				fundPositions: fundPositions.length,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("Capital reconciliation failed:", error);
		await upsertWorkerState({
			workerId: WORKER_STATE_IDS.capitalReconciliation,
			status: "error",
			lastError: message,
			lastRunAt: new Date(),
		});
	}
}

export function startCapitalReconcile(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "*/5 * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await runCapitalReconcileCycle();
		},
	});
}
