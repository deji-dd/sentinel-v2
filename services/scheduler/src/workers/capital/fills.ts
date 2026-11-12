import {
	and,
	applyCapitalFill,
	capitalBookConfigs,
	capitalBooks,
	capitalFills,
	capitalOrders,
	capitalPositions,
	capitalReconciliationIssues,
	capitalTransactions,
	createCapitalIssue,
	db,
	eq,
	sql,
	withCapitalTransaction,
} from "@sentinel/database";
import type { CapitalAlertPayload } from "@sentinel/schemas";
import {
	computeFillVariance,
	formatMoney,
	Logger,
	moneyFromPriceShares,
	mulBps,
	parseMoney,
	readCapitalStockFill,
	selectOrderForFill,
} from "@sentinel/utils";

import { type LogIngestSource, schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";

const logger = new Logger("Scheduler", "CapitalFills");

function broadcastAlert(payload: CapitalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_alert", data: payload });
}

function alertTradeIssue(issue: {
	id: string;
	title: string;
	detail: string;
	amount: string | null;
	stockId: number | null;
}): void {
	broadcastAlert({
		kind: "reconciliation",
		book: "live",
		stockId: issue.stockId,
		title: issue.title,
		body: issue.detail,
		fields: issue.amount
			? [{ name: "Notional", value: issue.amount, inline: true }]
			: [],
		link: "https://stocks.blasted-labs.tech/desk",
		decision: {
			type: "unmatched_buy",
			id: issue.id,
			actions: ["personal", "fund"],
		},
	});
}

async function issueExistsForLog(logId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: capitalReconciliationIssues.id })
		.from(capitalReconciliationIssues)
		.where(
			and(
				eq(capitalReconciliationIssues.book, "live"),
				sql`${capitalReconciliationIssues.details}->>'logId' = ${logId}`,
			),
		)
		.limit(1);
	return Boolean(row);
}

async function orderAlreadyFilled(logId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: capitalFills.id })
		.from(capitalFills)
		.where(eq(capitalFills.sourceLogId, logId))
		.limit(1);
	return Boolean(row);
}

async function recordFill(input: {
	stockId: number;
	side: "buy" | "sell";
	shares: number;
	price: number;
	fees: string;
	logId: string;
	orderId: string | null;
	source: "torn_log" | "decision";
	variance: ReturnType<typeof computeFillVariance> | null;
	/** Entry plan from the matched buy order, frozen on the new position. */
	entry?: {
		price: string;
		stopPrice: string | null;
		targetPrice: string | null;
	} | null;
	/** Exit reason from the matched sell order, copied onto the fill. */
	exitReason?: string | null;
}): Promise<void> {
	const notional = moneyFromPriceShares(input.price.toFixed(6), input.shares);
	const fees =
		input.side === "sell" ? parseMoney(input.fees) : parseMoney(input.fees);
	const cashDelta = input.side === "buy" ? -(notional + fees) : notional - fees;
	const now = new Date();

	await withCapitalTransaction("live", async (tx) => {
		await applyCapitalFill(tx, {
			book: "live",
			stockId: input.stockId,
			side: input.side,
			shares: input.shares,
			price: input.price.toFixed(6),
			notional: formatMoney(notional),
			fees: formatMoney(fees),
			cashDelta: formatMoney(cashDelta),
			totalCost: formatMoney(notional + fees),
			source: input.source,
			entry: input.entry ?? undefined,
			exitReason: input.exitReason ?? null,
			occurredAt: now,
		});
		await tx.insert(capitalFills).values({
			book: "live",
			orderId: input.orderId,
			stockId: input.stockId,
			side: input.side,
			shares: input.shares,
			price: input.price.toFixed(6),
			notional: formatMoney(notional),
			fees: formatMoney(fees),
			source: input.source,
			sourceLogId: input.logId,
			occurredAt: now,
			varianceShares: input.variance?.sharesDelta,
			variancePrice: input.variance?.priceDelta,
			slippageBps: input.variance?.slippageBps,
			delaySeconds: input.variance?.delaySeconds,
			notionalDelta: input.variance?.notionalDelta,
			exitReason: input.exitReason ?? null,
		});
	});
}

async function processStockLog(log: {
	id: string;
	log: number;
	timestamp: number;
	data: unknown;
}): Promise<void> {
	const event = readCapitalStockFill({
		id: log.id,
		log: log.log,
		timestamp: log.timestamp,
		data: log.data,
	});
	if (!event) return;
	if (await orderAlreadyFilled(event.logId)) return;

	const [book] = await db
		.select({ startedAt: capitalBooks.startedAt })
		.from(capitalBooks)
		.where(eq(capitalBooks.book, "live"))
		.limit(1);
	if (
		book?.startedAt &&
		event.timestamp < Math.floor(book.startedAt.getTime() / 1000)
	) {
		return;
	}

	const config = await db
		.select()
		.from(capitalBookConfigs)
		.where(eq(capitalBookConfigs.book, "live"))
		.limit(1);
	const cfg = config[0];

	const openOrders = await db
		.select()
		.from(capitalOrders)
		.where(eq(capitalOrders.book, "live"));
	const match = selectOrderForFill(
		event,
		openOrders.map((order) => ({
			id: order.id,
			stockId: order.stockId,
			side: order.side === "sell" ? "sell" : "buy",
			status: order.status,
			recommendedShares: order.recommendedShares,
			filledShares: order.filledShares,
			priceGuide: order.priceGuide,
			generatedAt: order.generatedAt,
			expiresAt: order.expiresAt,
		})),
	);

	if (match) {
		const order = openOrders.find((row) => row.id === match.id);
		if (!order) return;
		let fillShares = event.shares;
		if (event.side === "sell") {
			const [position] = await db
				.select()
				.from(capitalPositions)
				.where(
					and(
						eq(capitalPositions.book, "live"),
						eq(capitalPositions.stockId, event.stockId),
					),
				)
				.limit(1);
			fillShares = Math.min(fillShares, position?.shares ?? 0);
			if (fillShares <= 0) return;
		}
		const variance = computeFillVariance({
			order: {
				recommendedShares: order.recommendedShares,
				filledShares: order.filledShares,
				priceGuide: order.priceGuide,
				generatedAt: order.generatedAt,
			},
			fill: {
				shares: fillShares,
				price: event.price,
				timestamp: event.timestamp,
			},
		});
		await recordFill({
			stockId: event.stockId,
			side: event.side,
			shares: fillShares,
			price: event.price,
			fees: String(event.fees),
			logId: event.logId,
			orderId: order.id,
			source: "torn_log",
			variance,
			entry:
				event.side === "buy"
					? {
							price: event.price.toFixed(6),
							stopPrice: order.stopPrice,
							targetPrice: order.targetPrice,
						}
					: null,
			exitReason: event.side === "sell" ? order.exitReason : null,
		});
		const nextFilled = order.filledShares + fillShares;
		await db
			.update(capitalOrders)
			.set({
				filledShares: nextFilled,
				status:
					nextFilled >= order.recommendedShares ? "filled" : "partially_filled",
				averageFillPrice: String(event.price),
				acceptedAt: order.acceptedAt ?? new Date(),
				updatedAt: new Date(),
			})
			.where(eq(capitalOrders.id, order.id));
		return;
	}

	if (event.side === "buy") {
		if (cfg && !cfg.notifyUnmatchedBuys) return;
		if (await issueExistsForLog(event.logId)) return;
		const issue = await createCapitalIssue({
			book: "live",
			kind: "unmatched_buy",
			title: `Unmatched buy: stock #${event.stockId}`,
			detail: `The Torn log records a buy of ${event.shares.toLocaleString()} shares at ${event.price.toFixed(2)} with no open recommendation. Is this a personal trade or a fund trade?`,
			stockId: event.stockId,
			amount: event.worth.toFixed(2),
			details: {
				logId: event.logId,
				stockId: event.stockId,
				side: "buy",
				shares: event.shares,
				price: event.price,
				fees: event.fees,
			},
		});
		alertTradeIssue({ ...issue, stockId: issue.stockId });
		return;
	}

	// A sell of a fund-held stock must reduce the fund position even without a
	// recommendation; otherwise the book claims shares that are gone.
	const [position] = await db
		.select()
		.from(capitalPositions)
		.where(
			and(
				eq(capitalPositions.book, "live"),
				eq(capitalPositions.stockId, event.stockId),
			),
		)
		.limit(1);
	if (position && position.shares > 0) {
		const shares = Math.min(position.shares, event.shares);
		await recordFill({
			stockId: event.stockId,
			side: "sell",
			shares,
			price: event.price,
			fees: String(event.fees),
			logId: event.logId,
			orderId: null,
			source: "torn_log",
			variance: null,
		});
		broadcastAlert({
			kind: "reconciliation",
			book: "live",
			stockId: event.stockId,
			title: `Unsolicited fund sale: stock #${event.stockId}`,
			body: `Recorded a ${shares.toLocaleString()}-share sale with no open recommendation so the book matches the account.`,
			fields: [{ name: "Price", value: event.price.toFixed(2), inline: true }],
			link: "https://stocks.blasted-labs.tech/desk",
		});
	}
}

async function processLogs(
	logs: Array<{ id: string; log: number; timestamp: number; data: unknown }>,
): Promise<void> {
	for (const log of logs) {
		try {
			await processStockLog(log);
		} catch (error) {
			logger.error(
				`Capital fill log ${log.id} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

export function startCapitalFills(): void {
	schedulerEvents.on(
		"logs_inserted",
		(logs, meta: { source: LogIngestSource }) => {
			if (meta.source !== "forward") return;
			const relevant = logs
				.filter((log) => log.details.id === 5510 || log.details.id === 5511)
				.map((log) => ({
					id: log.id,
					log: log.details.id,
					timestamp: log.timestamp,
					data: log.data,
				}));
			if (relevant.length === 0) return;
			processLogs(relevant).catch((error) => {
				logger.error(
					`Capital fill batch failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		},
	);
	logger.info("Sentinel Capital stock-log listener registered.");
}
