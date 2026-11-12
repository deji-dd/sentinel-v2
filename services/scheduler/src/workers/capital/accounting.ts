import {
	and,
	capitalBookConfigs,
	capitalInvestments,
	capitalInvestorContacts,
	capitalInvestors,
	capitalMarketLatest,
	capitalNavSnapshots,
	capitalPaymentIntents,
	capitalPayoutObligations,
	capitalPositions,
	capitalTransactions,
	db,
	desc,
	ensureCapitalBooks,
	eq,
	inArray,
	lt,
	pruneCapitalMarketCandles,
	sql,
	withCapitalTransaction,
} from "@sentinel/database";
import type { CapitalAlertPayload, CapitalBook } from "@sentinel/schemas";
import {
	computeNav,
	computePayout,
	divideRound,
	floorToUtcBucket,
	formatMoney,
	formatUnits,
	Logger,
	makeReferenceCode,
	moneyToNumber,
	nextAlignedPayoutAt,
	parseMoney,
	parseUnits,
	unitsForAmount,
	unitsForRedemption,
} from "@sentinel/utils";

import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";
import { evaluateCapitalOrderOutcomes } from "./outcomes";

const WORKER_NAME = "capital:accounting";
const logger = new Logger("Scheduler", "CapitalAccounting");

function feeBpsFor(
	config: typeof capitalBookConfigs.$inferSelect,
	frequency: string,
): number {
	if (frequency === "daily") return config.feeRateDailyBps;
	if (frequency === "weekly") return config.feeRateWeeklyBps;
	return config.feeRateMonthlyBps;
}

function iso(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

function broadcastAlert(payload: CapitalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_alert", data: payload });
}

async function loadNav(book: CapitalBook) {
	const cashRow = await db
		.select({
			cash: sql<string>`COALESCE(SUM(${capitalTransactions.amount}), 0)`,
		})
		.from(capitalTransactions)
		.where(eq(capitalTransactions.book, book));
	const unitsRow = await db
		.select({
			units: sql<string>`COALESCE(SUM(${capitalInvestments.units}), 0)`,
		})
		.from(capitalInvestments)
		.where(eq(capitalInvestments.book, book));
	const priced = await db
		.select({
			shares: capitalPositions.shares,
			price: sql<string>`COALESCE(${capitalMarketLatest.price}, 0)`,
		})
		.from(capitalPositions)
		.leftJoin(
			capitalMarketLatest,
			eq(capitalMarketLatest.stockId, capitalPositions.stockId),
		)
		.where(eq(capitalPositions.book, book));

	return computeNav({
		cash: String(cashRow[0]?.cash ?? "0"),
		units: String(unitsRow[0]?.units ?? "0"),
		positions: priced.map((row) => ({
			shares: row.shares,
			price: String(row.price ?? "0"),
		})),
	});
}

async function payPaperObligation(
	obligationId: string,
	actor: string | null,
): Promise<void> {
	await withCapitalTransaction("paper", async (tx, state) => {
		const [obligation] = await tx
			.select()
			.from(capitalPayoutObligations)
			.where(
				and(
					eq(capitalPayoutObligations.id, obligationId),
					eq(capitalPayoutObligations.book, "paper"),
				),
			)
			.limit(1);
		if (!obligation) return;
		if (obligation.status === "paid" || obligation.status === "cancelled") {
			return;
		}
		const gross = parseMoney(obligation.grossAmount);
		if (parseMoney(state.cash) < gross) {
			await tx
				.update(capitalPayoutObligations)
				.set({ status: "unfunded", updatedAt: new Date() })
				.where(eq(capitalPayoutObligations.id, obligation.id));
			return;
		}
		const [investment] = await tx
			.select()
			.from(capitalInvestments)
			.where(eq(capitalInvestments.id, obligation.investmentId))
			.limit(1);
		if (!investment) return;

		const fee = parseMoney(obligation.feeAmount);
		const net = parseMoney(obligation.netAmount);
		const nav = await loadNav("paper");
		const unitsRedeemed = unitsForRedemption(gross, nav.navPerUnit);
		const units = parseUnits(investment.units);
		const redeemed = unitsRedeemed > units ? units : unitsRedeemed;
		const now = new Date();

		await tx
			.update(capitalInvestments)
			.set({
				units: formatUnits(units - redeemed),
				cumulativePayouts: formatMoney(
					parseMoney(investment.cumulativePayouts) + net,
				),
				cumulativeFees: formatMoney(
					parseMoney(investment.cumulativeFees) + fee,
				),
				highWaterNav: obligation.navAtCreation,
				lastPayoutAt: now,
				nextPayoutAt: nextAlignedPayoutAt(
					now,
					investment.frequency as "daily" | "weekly" | "monthly",
				),
				updatedAt: now,
			})
			.where(eq(capitalInvestments.id, investment.id));

		await tx.insert(capitalTransactions).values([
			{
				book: "paper",
				type: "payout",
				investorId: obligation.investorId,
				investmentId: obligation.investmentId,
				payoutId: obligation.id,
				amount: formatMoney(-net),
				units: formatUnits(-redeemed),
				source: "paper",
				occurredAt: now,
				recordedBy: actor,
			},
			{
				book: "paper",
				type: "fee",
				investorId: obligation.investorId,
				investmentId: obligation.investmentId,
				payoutId: obligation.id,
				amount: formatMoney(-fee),
				source: "paper",
				occurredAt: now,
				recordedBy: actor,
			},
		]);

		await tx
			.update(capitalPayoutObligations)
			.set({
				status: "paid",
				paidAmount: obligation.grossAmount,
				remainingAmount: "0",
				paidAt: now,
				paidBy: actor,
				updatedAt: now,
			})
			.where(eq(capitalPayoutObligations.id, obligation.id));
	});
}

/**
 * Compounds a profit payout back into the lot instead of paying cash.
 *
 * The gross profit is not distributed: the fee is booked as owner revenue, the
 * net profit increases the lot's principal and units at the current NAV, and
 * the high-water mark advances. No in-game transfer is required.
 */
async function reinvestPayout(input: {
	book: CapitalBook;
	lot: typeof capitalInvestments.$inferSelect;
	config: typeof capitalBookConfigs.$inferSelect;
}): Promise<boolean> {
	return withCapitalTransaction(input.book, async (tx, state) => {
		const nav = computeNav({
			cash: state.cash,
			units: state.units,
			positions: state.positions.map((position) => ({
				shares: position.shares,
				price: position.price,
			})),
		});
		const [lot] = await tx
			.select()
			.from(capitalInvestments)
			.where(eq(capitalInvestments.id, input.lot.id))
			.limit(1);
		if (!lot || lot.status !== "active") return false;

		const units = parseUnits(lot.units);
		const payout = computePayout({
			navPerUnit: nav.navPerUnit,
			units,
			highWaterNav: parseMoney(lot.highWaterNav),
			feeBps: feeBpsFor(input.config, lot.frequency),
		});
		if (!payout.shouldPay) return false;

		const unitsIssued = unitsForAmount(payout.net, nav.navPerUnit);
		const newUnits = units - payout.unitsRedeemed + unitsIssued;
		const now = new Date();
		const next = nextAlignedPayoutAt(
			now,
			lot.frequency as "daily" | "weekly" | "monthly",
		);

		await tx
			.update(capitalInvestments)
			.set({
				units: formatUnits(newUnits > 0n ? newUnits : 0n),
				principal: formatMoney(parseMoney(lot.principal) + payout.net),
				cumulativeFees: formatMoney(
					parseMoney(lot.cumulativeFees) + payout.fee,
				),
				highWaterNav: formatMoney(nav.navPerUnit),
				lastPayoutAt: now,
				nextPayoutAt: next,
				updatedAt: now,
			})
			.where(eq(capitalInvestments.id, lot.id));

		await tx.insert(capitalTransactions).values([
			{
				book: input.book,
				type: "reinvest",
				investorId: lot.investorId,
				investmentId: lot.id,
				amount: "0",
				units: formatUnits(unitsIssued - payout.unitsRedeemed),
				navPerUnit: formatMoney(nav.navPerUnit),
				source: "system",
				occurredAt: now,
				recordedBy: "system:reinvest",
				note: "Net payout compounded into the lot.",
				metadata: {
					gross: formatMoney(payout.available),
					fee: formatMoney(payout.fee),
					net: formatMoney(payout.net),
					unitsRedeemed: formatUnits(payout.unitsRedeemed),
					unitsIssued: formatUnits(unitsIssued),
				},
			},
			{
				book: input.book,
				type: "fee",
				investorId: lot.investorId,
				investmentId: lot.id,
				amount: formatMoney(-payout.fee),
				source: "system",
				occurredAt: now,
				recordedBy: "system:reinvest",
				note: "Performance fee on a reinvested payout.",
			},
		]);

		await tx.insert(capitalPayoutObligations).values({
			book: input.book,
			investmentId: lot.id,
			investorId: lot.investorId,
			frequency: lot.frequency,
			periodStart: lot.lastPayoutAt ?? lot.openedAt,
			periodEnd: now,
			dueAt: now,
			grossAmount: formatMoney(payout.available),
			feeAmount: formatMoney(payout.fee),
			netAmount: formatMoney(payout.net),
			paidAmount: formatMoney(payout.available),
			remainingAmount: "0",
			status: "paid",
			highWaterNav: lot.highWaterNav,
			navAtCreation: formatMoney(nav.navPerUnit),
			paidAt: now,
			paidBy: "system:reinvest",
			note: "Reinvested into the lot; no cash transfer.",
		});

		return true;
	});
}

async function generatePayouts(book: CapitalBook): Promise<number> {
	const config = await db
		.select()
		.from(capitalBookConfigs)
		.where(eq(capitalBookConfigs.book, book))
		.limit(1);
	if (!config[0]) return 0;
	const cfg = config[0];
	const dueLots = await db
		.select()
		.from(capitalInvestments)
		.where(
			and(
				eq(capitalInvestments.book, book),
				eq(capitalInvestments.status, "active"),
				sql`${capitalInvestments.nextPayoutAt} IS NOT NULL AND ${capitalInvestments.nextPayoutAt} <= now()`,
			),
		);
	if (dueLots.length === 0) return 0;

	const nav = await loadNav(book);
	const cash = parseMoney(
		(
			await db
				.select({
					cash: sql<string>`COALESCE(SUM(${capitalTransactions.amount}), 0)`,
				})
				.from(capitalTransactions)
				.where(eq(capitalTransactions.book, book))
		)[0]?.cash ?? "0",
	);

	let created = 0;
	for (const lot of dueLots) {
		const open = await db
			.select({ id: capitalPayoutObligations.id })
			.from(capitalPayoutObligations)
			.where(
				and(
					eq(capitalPayoutObligations.investmentId, lot.id),
					inArray(capitalPayoutObligations.status, [
						"due",
						"unfunded",
						"partially_paid",
						"scheduled",
					]),
				),
			)
			.limit(1);
		if (open.length > 0) continue;

		const payout = computePayout({
			navPerUnit: nav.navPerUnit,
			units: parseUnits(lot.units),
			highWaterNav: parseMoney(lot.highWaterNav),
			feeBps: feeBpsFor(cfg, lot.frequency),
		});
		const now = new Date();
		const next = nextAlignedPayoutAt(
			now,
			lot.frequency as "daily" | "weekly" | "monthly",
		);

		if (lot.payoutMode === "reinvest") {
			if (!payout.shouldPay) continue;
			await db
				.update(capitalInvestments)
				.set({ nextPayoutAt: next, updatedAt: now })
				.where(eq(capitalInvestments.id, lot.id));
			await reinvestPayout({ book, lot, config: cfg });
			created += 1;
			continue;
		}

		if (!payout.shouldPay) {
			await db.insert(capitalPayoutObligations).values({
				book,
				investmentId: lot.id,
				investorId: lot.investorId,
				frequency: lot.frequency,
				periodStart: lot.lastPayoutAt ?? lot.openedAt,
				periodEnd: now,
				dueAt: now,
				grossAmount: "0",
				feeAmount: "0",
				netAmount: "0",
				paidAmount: "0",
				remainingAmount: "0",
				status: "skipped_no_profit",
				highWaterNav: lot.highWaterNav,
				navAtCreation: formatMoney(nav.navPerUnit),
				paidAt: now,
			});
			await db
				.update(capitalInvestments)
				.set({ nextPayoutAt: next, updatedAt: now })
				.where(eq(capitalInvestments.id, lot.id));
			continue;
		}

		const status = cash >= payout.available ? "due" : "unfunded";
		const [obligation] = await db
			.insert(capitalPayoutObligations)
			.values({
				book,
				investmentId: lot.id,
				investorId: lot.investorId,
				frequency: lot.frequency,
				periodStart: lot.lastPayoutAt ?? lot.openedAt,
				periodEnd: now,
				dueAt: now,
				grossAmount: formatMoney(payout.available),
				feeAmount: formatMoney(payout.fee),
				netAmount: formatMoney(payout.net),
				paidAmount: "0",
				remainingAmount: formatMoney(payout.available),
				status,
				highWaterNav: lot.highWaterNav,
				navAtCreation: formatMoney(nav.navPerUnit),
			})
			.returning();
		await db
			.update(capitalInvestments)
			.set({ nextPayoutAt: next, updatedAt: now })
			.where(eq(capitalInvestments.id, lot.id));
		created += 1;

		if (book === "paper") {
			if (obligation) await payPaperObligation(obligation.id, null);
		} else {
			const investor = await db
				.select()
				.from(capitalInvestors)
				.where(eq(capitalInvestors.id, lot.investorId))
				.limit(1);
			const contacts = await db
				.select()
				.from(capitalInvestorContacts)
				.where(eq(capitalInvestorContacts.investorId, lot.investorId));
			if (obligation && investor[0]?.tornId) {
				await db
					.insert(capitalPaymentIntents)
					.values({
						book,
						kind: "payout",
						investorId: lot.investorId,
						investmentId: lot.id,
						payoutIds: [obligation.id],
						counterpartyTornId: investor[0].tornId,
						expectedAmount: formatMoney(payout.net),
						tolerancePct: cfg.paymentMatchTolerancePct,
						referenceCode: makeReferenceCode("PAY"),
						expiresAt: new Date(Date.now() + 7 * 86_400_000),
						note: "Payout verification code; include this in the Torn transfer message.",
					})
					.onConflictDoNothing();
			}
			broadcastAlert({
				kind: "payout_due",
				book,
				title: `Payout ${status === "unfunded" ? "unfunded" : "due"}: ${investor[0]?.displayName ?? "Investor"}`,
				body: `Gross ${formatMoney(payout.available)} · fee ${formatMoney(payout.fee)} · net ${formatMoney(payout.net)}.`,
				fields: [
					{ name: "Cadence", value: lot.frequency, inline: true },
					{ name: "Due", value: now.toISOString(), inline: true },
					{
						name: "Contacts",
						value:
							contacts
								.map(
									(contact) =>
										contact.name ?? contact.discordId ?? contact.tornId,
								)
								.filter(Boolean)
								.join(", ") || "—",
					},
				],
				link: "https://stocks.blasted-labs.tech/desk",
			});
		}
	}

	return created;
}

async function recordSnapshots(book: CapitalBook): Promise<void> {
	const nav = await loadNav(book);
	const now = new Date();
	const cash = nav.cash;
	const units = nav.units;
	const investorRow = await db
		.select({
			total: sql<number>`COUNT(DISTINCT ${capitalInvestments.investorId})`,
		})
		.from(capitalInvestments)
		.where(
			and(
				eq(capitalInvestments.book, book),
				eq(capitalInvestments.status, "active"),
			),
		);
	const investedRow = await db
		.select({
			principal: sql<string>`COALESCE(SUM(${capitalInvestments.principal}), 0)`,
		})
		.from(capitalInvestments)
		.where(eq(capitalInvestments.book, book));
	const payoutsRow = await db
		.select({
			total: sql<string>`COALESCE(SUM(-${capitalTransactions.amount}), 0)`,
		})
		.from(capitalTransactions)
		.where(
			and(
				eq(capitalTransactions.book, book),
				eq(capitalTransactions.type, "payout"),
			),
		);
	const feesRow = await db
		.select({
			total: sql<string>`COALESCE(SUM(-${capitalTransactions.amount}), 0)`,
		})
		.from(capitalTransactions)
		.where(
			and(
				eq(capitalTransactions.book, book),
				inArray(capitalTransactions.type, ["fee", "exit_fee"]),
			),
		);

	for (const granularity of ["hourly", "daily"] as const) {
		const bucket = floorToUtcBucket(now, granularity === "hourly" ? 60 : 1440);
		const [previous] = await db
			.select({ navPerUnit: capitalNavSnapshots.navPerUnit })
			.from(capitalNavSnapshots)
			.where(
				and(
					eq(capitalNavSnapshots.book, book),
					eq(capitalNavSnapshots.granularity, granularity),
					lt(capitalNavSnapshots.capturedAt, bucket),
				),
			)
			.orderBy(desc(capitalNavSnapshots.capturedAt))
			.limit(1);
		const previousNav = previous ? parseMoney(previous.navPerUnit) : null;
		const returnPct =
			previousNav && previousNav > 0n
				? ((moneyToNumber(nav.navPerUnit) - moneyToNumber(previousNav)) /
						moneyToNumber(previousNav)) *
					100
				: 0;

		await db
			.insert(capitalNavSnapshots)
			.values({
				book,
				capturedAt: bucket,
				granularity,
				cash: formatMoney(cash),
				positionsValue: formatMoney(nav.positionsValue),
				totalValue: formatMoney(nav.totalValue),
				unitsOutstanding: formatUnits(units),
				navPerUnit: formatMoney(nav.navPerUnit),
				investedCapital: String(investedRow[0]?.principal ?? "0"),
				cumulativePayouts: String(payoutsRow[0]?.total ?? "0"),
				cumulativeFees: String(feesRow[0]?.total ?? "0"),
				investorCount: Number(investorRow[0]?.total ?? 0),
				returnPct,
			})
			.onConflictDoUpdate({
				target: [
					capitalNavSnapshots.book,
					capitalNavSnapshots.granularity,
					capitalNavSnapshots.capturedAt,
				],
				set: {
					cash: formatMoney(cash),
					positionsValue: formatMoney(nav.positionsValue),
					totalValue: formatMoney(nav.totalValue),
					unitsOutstanding: formatUnits(units),
					navPerUnit: formatMoney(nav.navPerUnit),
					investedCapital: String(investedRow[0]?.principal ?? "0"),
					cumulativePayouts: String(payoutsRow[0]?.total ?? "0"),
					cumulativeFees: String(feesRow[0]?.total ?? "0"),
					investorCount: Number(investorRow[0]?.total ?? 0),
					returnPct,
				},
			});
	}
}

let lastMinuteRetentionAt = 0;
const MINUTE_RETENTION_DAYS = 180;
const MINUTE_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;

export async function runCapitalAccountingCycle(): Promise<void> {
	try {
		await ensureCapitalBooks();
		await generatePayouts("live");
		await generatePayouts("paper");
		await recordSnapshots("live");
		await recordSnapshots("paper");
		for (const book of ["live", "paper"] as const) {
			try {
				await evaluateCapitalOrderOutcomes(book);
			} catch (error) {
				logger.error(
					`Capital order outcomes failed for ${book}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (Date.now() - lastMinuteRetentionAt >= MINUTE_RETENTION_INTERVAL_MS) {
			lastMinuteRetentionAt = Date.now();
			try {
				const deleted = await pruneCapitalMarketCandles({
					intervalMinutes: 1,
					olderThanDays: MINUTE_RETENTION_DAYS,
				});
				if (deleted > 0) {
					logger.info(
						`Pruned ${deleted.toLocaleString()} minute candle(s) older than ${MINUTE_RETENTION_DAYS}d.`,
					);
				}
			} catch (error) {
				logger.error(
					`Capital candle retention failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} catch (error) {
		logger.error("Capital accounting cycle failed:", error);
	}
}

export function startCapitalAccounting(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "*/5 * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await runCapitalAccountingCycle();
		},
	});
}
