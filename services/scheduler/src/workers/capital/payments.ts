import {
	and,
	capitalInvestments,
	capitalInvestorContacts,
	capitalInvestors,
	capitalPaymentIntents,
	capitalReconciliationIssues,
	capitalTransactions,
	createCapitalIssue,
	db,
	desc,
	eq,
	inArray,
	personalLogs,
	sql,
	upsertWorkerState,
	withCapitalTransaction,
	WORKER_STATE_IDS,
} from "@sentinel/database";
import type { CapitalAlertPayload, CapitalBook } from "@sentinel/schemas";
import {
	type CapitalMoneyLogEvent,
	computeDeposit,
	computeNav,
	formatMoney,
	formatUnits,
	Logger,
	matchPaymentIntent,
	nextAlignedPayoutAt,
	parseMoney,
	readCapitalMoneyLog,
	readCapitalTradeCompleted,
} from "@sentinel/utils";

import { type LogIngestSource, schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";

const logger = new Logger("Scheduler", "CapitalPayments");
const LOG_IDS = new Set([4800, 4810, 4430]);

function broadcastAlert(payload: CapitalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_alert", data: payload });
}

async function depositFromIntent(input: {
	logId: string;
	amount: string;
	investorId: string;
	frequency: "daily" | "weekly" | "monthly";
	payoutMode: "cash" | "reinvest";
	occurredAt: Date;
}): Promise<void> {
	await withCapitalTransaction("live", async (tx, state) => {
		const existing = await tx
			.select({ id: capitalTransactions.id })
			.from(capitalTransactions)
			.where(eq(capitalTransactions.sourceLogId, input.logId))
			.limit(1);
		if (existing.length > 0) return;

		const nav = computeNav({
			cash: state.cash,
			units: state.units,
			positions: state.positions.map((position) => ({
				shares: position.shares,
				price: position.price,
			})),
		});
		const amount = parseMoney(input.amount);
		const deposit = computeDeposit(amount, nav.navPerUnit);
		const [investment] = await tx
			.insert(capitalInvestments)
			.values({
				book: "live",
				investorId: input.investorId,
				frequency: input.frequency,
				payoutMode: input.payoutMode,
				principal: formatMoney(deposit.principal),
				units: formatUnits(deposit.unitsIssued),
				navAtDeposit: formatMoney(deposit.navPerUnit),
				highWaterNav: formatMoney(deposit.highWaterNav),
				openedAt: input.occurredAt,
				nextPayoutAt: nextAlignedPayoutAt(new Date(), input.frequency),
			})
			.returning();
		if (!investment) throw new Error("Failed to create deposit lot.");

		await tx.insert(capitalTransactions).values({
			book: "live",
			type: "deposit",
			investorId: input.investorId,
			investmentId: investment.id,
			amount: formatMoney(deposit.principal),
			units: formatUnits(deposit.unitsIssued),
			navPerUnit: formatMoney(deposit.navPerUnit),
			source: "torn_log",
			sourceLogId: input.logId,
			occurredAt: input.occurredAt,
			note: "Deposit verified from Torn money log.",
		});
	});
}

async function createUnmatchedPaymentIssue(input: {
	kind: "unmatched_deposit" | "unmatched_payout";
	logId: string;
	amount: string;
	counterpartyTornId: number | null;
	message: string | null;
	direction: "send" | "receive";
}): Promise<void> {
	const existing = await db
		.select({ id: capitalReconciliationIssues.id })
		.from(capitalReconciliationIssues)
		.where(
			and(
				eq(capitalReconciliationIssues.book, "live"),
				sql`${capitalReconciliationIssues.details}->>'logId' = ${input.logId}`,
			),
		)
		.limit(1);
	if (existing.length > 0) return;

	const issue = await createCapitalIssue({
		book: "live",
		kind: input.kind,
		title:
			input.kind === "unmatched_deposit"
				? "Unmatched incoming payment"
				: "Unmatched outgoing payment",
		detail:
			`${input.direction === "receive" ? "Received" : "Sent"} ${input.amount} ${
				input.counterpartyTornId
					? `with Torn #${input.counterpartyTornId}`
					: "with an unknown counterparty"
			}. ${input.message ?? ""}`.trim(),
		amount: input.amount,
		details: {
			logId: input.logId,
			counterpartyTornId: input.counterpartyTornId,
			message: input.message,
		},
	});
	broadcastAlert({
		kind: "payment",
		book: "live",
		title: issue.title,
		body: issue.detail,
		fields: [
			{ name: "Amount", value: input.amount, inline: true },
			{
				name: "Counterparty",
				value: input.counterpartyTornId
					? `#${input.counterpartyTornId}`
					: "Unknown",
				inline: true,
			},
		],
		link: "https://stocks.blasted-labs.tech/desk",
		decision: { type: "payment", id: issue.id, actions: ["assign", "ignore"] },
	});
}

async function findTradeMoneyEvents(
	tradeId: string,
): Promise<CapitalMoneyLogEvent[]> {
	const rows = await db
		.select()
		.from(personalLogs)
		.where(
			and(
				inArray(personalLogs.log, [4440, 4441]),
				sql`${personalLogs.data}::text LIKE ${`%${tradeId}%`}`,
			),
		)
		.orderBy(desc(personalLogs.timestamp))
		.limit(50);
	const events: CapitalMoneyLogEvent[] = [];
	for (const row of rows) {
		const event = readCapitalMoneyLog({
			id: row.id,
			log: row.log,
			timestamp: Math.floor(row.timestamp.getTime() / 1000),
			data: row.data,
		});
		if (event?.tradeId === tradeId) events.push(event);
	}
	return events;
}

async function processMoneyEvent(
	event: CapitalMoneyLogEvent,
	sourceLogId: string,
): Promise<void> {
	const directionKinds =
		event.direction === "receive" ? ["deposit"] : ["payout", "withdrawal"];
	const intents = await db
		.select()
		.from(capitalPaymentIntents)
		.where(
			and(
				eq(capitalPaymentIntents.book, "live"),
				eq(capitalPaymentIntents.status, "pending"),
				inArray(capitalPaymentIntents.kind, directionKinds),
			),
		);
	const match = matchPaymentIntent(
		event,
		intents.map((intent) => ({
			id: intent.id,
			kind: intent.kind,
			status: intent.status,
			counterpartyTornId: intent.counterpartyTornId,
			expectedAmount: intent.expectedAmount,
			tolerancePct: intent.tolerancePct,
			referenceCode: intent.referenceCode,
			expiresAt: intent.expiresAt,
		})),
	);
	if (match) {
		const intent = intents.find((row) => row.id === match.intent.id);
		if (!intent) return;
		if (event.direction === "receive" && intent.kind === "deposit") {
			if (!intent.investorId) {
				await createUnmatchedPaymentIssue({
					kind: "unmatched_deposit",
					logId: sourceLogId,
					amount: event.amountRaw,
					counterpartyTornId: event.counterpartyTornId,
					message: event.message,
					direction: event.direction,
				});
				return;
			}
			const frequency =
				intent.frequency === "daily" ||
				intent.frequency === "weekly" ||
				intent.frequency === "monthly"
					? intent.frequency
					: "monthly";
			await depositFromIntent({
				logId: sourceLogId,
				amount: event.amountRaw,
				investorId: intent.investorId,
				frequency,
				payoutMode: intent.payoutMode === "reinvest" ? "reinvest" : "cash",
				occurredAt: new Date(event.timestamp * 1000),
			});
		}
		await db
			.update(capitalPaymentIntents)
			.set({
				status: "paid",
				matchedLogId: sourceLogId,
				matchedAmount: event.amountRaw,
				updatedAt: new Date(),
			})
			.where(eq(capitalPaymentIntents.id, intent.id));
		if (event.direction === "send") {
			broadcastAlert({
				kind: "payment",
				book: "live",
				title: "Payment verified from the log",
				body: `Torn #${event.counterpartyTornId ?? "unknown"} received ${event.amountRaw}. Confirm the matching payout/withdrawal in the desk.`,
				fields: [
					{ name: "Reference", value: intent.referenceCode, inline: true },
					{ name: "Intent", value: intent.kind, inline: true },
				],
				link: "https://stocks.blasted-labs.tech/desk",
				decision: { type: "payment", id: intent.id, actions: ["assign"] },
			});
		}
		return;
	}

	// No intent: only bother the owner when the counterparty is already known
	// to the fund. Personal transfers to strangers are not the fund's business.
	const knownInvestor = event.counterpartyTornId
		? await db
				.select({ id: capitalInvestors.id })
				.from(capitalInvestors)
				.where(
					and(
						eq(capitalInvestors.book, "live"),
						eq(capitalInvestors.tornId, event.counterpartyTornId),
					),
				)
				.limit(1)
		: [];
	const knownContact = event.counterpartyTornId
		? await db
				.select({ id: capitalInvestorContacts.id })
				.from(capitalInvestorContacts)
				.where(
					and(
						eq(capitalInvestorContacts.book, "live"),
						eq(capitalInvestorContacts.tornId, event.counterpartyTornId),
					),
				)
				.limit(1)
		: [];
	if (knownInvestor.length === 0 && knownContact.length === 0) return;

	await createUnmatchedPaymentIssue({
		kind:
			event.direction === "receive" ? "unmatched_deposit" : "unmatched_payout",
		logId: sourceLogId,
		amount: event.amountRaw,
		counterpartyTornId: event.counterpartyTornId,
		message: event.message,
		direction: event.direction,
	});
}

export function startCapitalPayments(): void {
	schedulerEvents.on(
		"logs_inserted",
		(logs, meta: { source: LogIngestSource }) => {
			if (meta.source !== "forward") return;
			const relevant = logs.filter((log) => LOG_IDS.has(log.details.id));
			if (relevant.length === 0) return;
			for (const log of relevant) {
				void (async () => {
					try {
						if (log.details.id === 4430) {
							const completed = readCapitalTradeCompleted({
								id: log.id,
								log: log.details.id,
								timestamp: log.timestamp,
								data: log.data,
							});
							if (!completed) return;
							const moneyEvents = await findTradeMoneyEvents(completed.tradeId);
							for (const money of moneyEvents) {
								await processMoneyEvent(
									{
										...money,
										counterpartyTornId:
											money.counterpartyTornId ?? completed.counterpartyTornId,
									},
									`${completed.logId}:${money.logId}`,
								);
							}
							return;
						}
						const event = readCapitalMoneyLog({
							id: log.id,
							log: log.details.id,
							timestamp: log.timestamp,
							data: log.data,
						});
						if (!event) return;
						await processMoneyEvent(event, event.logId);
					} catch (error) {
						logger.error(
							`Capital payment log ${log.id} failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				})();
			}
			upsertWorkerState({
				workerId: WORKER_STATE_IDS.capitalPayments,
				status: "idle",
				lastRunAt: new Date(),
				details: { lastLogAt: new Date().toISOString() },
			}).catch(() => {});
		},
	);
	logger.info("Sentinel Capital money-log listener registered.");
}
