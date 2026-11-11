import {
	and,
	applyCapitalFill,
	capitalBookConfigs,
	capitalBooks,
	capitalFills,
	capitalInvestments,
	capitalInvestorContacts,
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
	db,
	desc,
	eq,
	getCapitalConfig,
	getCapitalState,
	inArray,
	resetCapitalPaperBook,
	sql,
	tornStocks,
	withCapitalTransaction,
} from "@sentinel/database";
import type {
	CapitalAccessRow,
	CapitalAdminOverview,
	CapitalBook,
	CapitalContactView,
	CapitalEngineStatus,
	CapitalFillView,
	CapitalInvestorAdminRow,
	CapitalInvestorPortfolio,
	CapitalInvestorView,
	CapitalLotView,
	CapitalOrderView,
	CapitalPaymentIntentView,
	CapitalPayoutView,
	CapitalPerformancePoint,
	CapitalPublicHolding,
	CapitalPublicOverview,
	CapitalPublicTrade,
	CapitalReconciliationIssueView,
	CapitalSettings,
	CapitalSummary,
	CapitalWithdrawalQuote,
	CapitalWithdrawalView,
} from "@sentinel/schemas";
import { isCapitalSignalMode } from "@sentinel/schemas";
import {
	computeDeposit,
	computeInvestorMetrics,
	computeNav,
	computeWithdrawal,
	daysBetween,
	divideRound,
	formatMoney,
	formatUnits,
	makeReferenceCode,
	maxMoney,
	MONEY_SCALE,
	moneyFromPriceShares,
	moneyToNumber,
	nextAlignedPayoutAt,
	parseMoney,
	parseUnits,
	unitsForRedemption,
} from "@sentinel/utils";

export interface InvestorResolution {
	investorId: string | null;
}

function iso(value: Date | null | undefined): string | null {
	return value ? value.toISOString() : null;
}

function asNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function asString(value: unknown, fallback = "0"): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "bigint") return value.toString();
	return fallback;
}

function safeDate(value: unknown, fallback = new Date()): Date {
	if (value instanceof Date && Number.isFinite(value.getTime())) return value;
	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value);
		if (Number.isFinite(parsed.getTime())) return parsed;
	}
	return fallback;
}

async function loadStockNameMap(): Promise<
	Map<number, { name: string; acronym: string }>
> {
	const rows = await db
		.select({
			id: tornStocks.id,
			name: tornStocks.name,
			acronym: tornStocks.acronym,
		})
		.from(tornStocks);
	const map = new Map<number, { name: string; acronym: string }>();
	for (const row of rows) {
		const id = Number.parseInt(row.id, 10);
		if (Number.isFinite(id)) {
			map.set(id, { name: row.name, acronym: row.acronym });
		}
	}
	return map;
}

async function loadNav(book: CapitalBook) {
	const state = await getCapitalState(book);
	const nav = computeNav({
		cash: state.cash,
		units: state.units,
		positions: state.positions.map((position) => ({
			shares: position.shares,
			price: position.price,
		})),
	});
	return { state, nav };
}

async function sumTransactionTypes(
	book: CapitalBook,
	types: string[],
): Promise<string> {
	const [row] = await db
		.select({
			total: sql<string>`COALESCE(SUM(-${capitalTransactions.amount}), 0)`,
		})
		.from(capitalTransactions)
		.where(
			and(
				eq(capitalTransactions.book, book),
				inArray(capitalTransactions.type, types),
			),
		);
	return asString(row?.total);
}

async function countInvestors(book: CapitalBook): Promise<number> {
	const [row] = await db
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
	return Number(row?.total ?? 0);
}

async function sumActivePrincipal(book: CapitalBook): Promise<string> {
	const [row] = await db
		.select({
			total: sql<string>`COALESCE(SUM(${capitalInvestments.principal}), 0)`,
		})
		.from(capitalInvestments)
		.where(
			and(
				eq(capitalInvestments.book, book),
				eq(capitalInvestments.status, "active"),
			),
		);
	return asString(row?.total);
}

async function firstSnapshot(
	book: CapitalBook,
): Promise<{ navPerUnit: string; capturedAt: Date } | null> {
	const [row] = await db
		.select({
			navPerUnit: capitalNavSnapshots.navPerUnit,
			capturedAt: capitalNavSnapshots.capturedAt,
		})
		.from(capitalNavSnapshots)
		.where(eq(capitalNavSnapshots.book, book))
		.orderBy(capitalNavSnapshots.capturedAt)
		.limit(1);
	return row ?? null;
}

async function loadPerformance(
	book: CapitalBook,
	limit = 365,
): Promise<CapitalPerformancePoint[]> {
	const rows = await db
		.select()
		.from(capitalNavSnapshots)
		.where(
			and(
				eq(capitalNavSnapshots.book, book),
				eq(capitalNavSnapshots.granularity, "daily"),
			),
		)
		.orderBy(desc(capitalNavSnapshots.capturedAt))
		.limit(limit);
	return rows.reverse().map((row) => ({
		capturedAtIso: row.capturedAt.toISOString(),
		navPerUnit: row.navPerUnit,
		returnPct: row.returnPct ?? 0,
		aum: row.totalValue,
		investorCount: row.investorCount,
	}));
}

async function loadHoldings(
	book: CapitalBook,
	stockMap: Map<number, { name: string; acronym: string }>,
): Promise<CapitalPublicHolding[]> {
	const positions = await db
		.select({
			stockId: capitalPositions.stockId,
			shares: capitalPositions.shares,
			price: capitalMarketLatest.price,
		})
		.from(capitalPositions)
		.leftJoin(
			capitalMarketLatest,
			eq(capitalMarketLatest.stockId, capitalPositions.stockId),
		)
		.where(eq(capitalPositions.book, book));

	let total = 0;
	const valued = positions.map((position) => {
		const price = parseMoney(asString(position.price));
		const value = price * BigInt(position.shares);
		total += Number(value);
		return { ...position, price: asString(position.price), value };
	});

	return valued
		.filter((position) => position.shares > 0)
		.map((position) => {
			const stock = stockMap.get(position.stockId);
			return {
				stockId: position.stockId,
				name: stock?.name ?? `Stock #${position.stockId}`,
				acronym: stock?.acronym ?? `#${position.stockId}`,
				shares: position.shares,
				price: position.price,
				value: formatMoney(position.value),
				weightPct: total > 0 ? (Number(position.value) / total) * 100 : 0,
			};
		})
		.sort((a, b) => b.weightPct - a.weightPct);
}

async function loadPublicTrades(
	book: CapitalBook,
	stockMap: Map<number, { name: string; acronym: string }>,
	limit = 50,
): Promise<CapitalPublicTrade[]> {
	const fills = await db
		.select()
		.from(capitalFills)
		.where(eq(capitalFills.book, book))
		.orderBy(desc(capitalFills.occurredAt))
		.limit(limit);
	return fills.map((fill) => {
		const stock = stockMap.get(fill.stockId);
		return {
			id: fill.id,
			stockId: fill.stockId,
			name: stock?.name ?? `Stock #${fill.stockId}`,
			acronym: stock?.acronym ?? `#${fill.stockId}`,
			side: fill.side === "sell" ? "sell" : "buy",
			shares: fill.shares,
			price: fill.price,
			notional: fill.notional,
			fees: fill.fees,
			occurredAtIso: fill.occurredAt.toISOString(),
		};
	});
}

export async function getCapitalSummary(book: CapitalBook): Promise<{
	summary: CapitalSummary;
	stockMap: Map<number, { name: string; acronym: string }>;
}> {
	const config = await getCapitalConfig(book);
	const bookRow = await db
		.select()
		.from(capitalBooks)
		.where(eq(capitalBooks.book, book))
		.limit(1);
	const { nav } = await loadNav(book);
	const [payouts, fees, investors, invested, first] = await Promise.all([
		sumTransactionTypes(book, ["payout"]),
		sumTransactionTypes(book, ["fee", "exit_fee"]),
		countInvestors(book),
		sumActivePrincipal(book),
		firstSnapshot(book),
	]);
	const stockMap = await loadStockNameMap();
	const start = bookRow[0]?.startedAt ?? new Date();
	const days = daysBetween(start, new Date());
	const firstNav = first ? parseMoney(first.navPerUnit) : MONEY_SCALE;
	const currentNav = nav.navPerUnit;
	const totalReturnPct =
		firstNav > 0n
			? ((moneyToNumber(currentNav) - moneyToNumber(firstNav)) /
					moneyToNumber(firstNav)) *
				100
			: null;
	const [openIssues] = await db
		.select({ total: sql<number>`COUNT(*)` })
		.from(capitalReconciliationIssues)
		.where(
			and(
				eq(capitalReconciliationIssues.book, book),
				eq(capitalReconciliationIssues.status, "open"),
			),
		);

	return {
		summary: {
			book,
			displayName: bookRow[0]?.displayName ?? "Blasted Stocks",
			asOfIso: new Date().toISOString(),
			inceptionIso: iso(start),
			daysRunning: days,
			aum: config.publicShowAum ? formatMoney(nav.totalValue) : "0",
			navPerUnit: formatMoney(nav.navPerUnit),
			unitsOutstanding: formatUnits(nav.units),
			investedCapital: invested,
			cash: formatMoney(nav.cash),
			totalReturnPct,
			sinceInceptionReturnPct: totalReturnPct,
			cumulativePayouts: payouts,
			cumulativeFees: fees,
			investorCount: investors,
			openIssueCount: Number(openIssues?.total ?? 0),
		},
		stockMap,
	};
}

export async function getCapitalPublicOverview(
	book: CapitalBook = "live",
): Promise<CapitalPublicOverview> {
	const config = await getCapitalConfig(book);
	const { summary, stockMap } = await getCapitalSummary(book);
	const [performance, holdings, trades] = await Promise.all([
		loadPerformance(book),
		config.publicShowHoldings
			? loadHoldings(book, stockMap)
			: Promise.resolve([] as CapitalPublicHolding[]),
		config.publicShowTrades
			? loadPublicTrades(book, stockMap)
			: Promise.resolve([] as CapitalPublicTrade[]),
	]);

	return {
		success: true,
		summary: {
			...summary,
			aum: config.publicShowAum ? summary.aum : "0",
			cumulativeFees: config.publicShowFees ? summary.cumulativeFees : "0",
		},
		flags: {
			showAum: config.publicShowAum,
			showTrades: config.publicShowTrades,
			showHoldings: config.publicShowHoldings,
			showFees: config.publicShowFees,
		},
		performance,
		holdings,
		trades,
		feeSchedule: [
			{ frequency: "daily", label: "Daily", feeBps: config.feeRateDailyBps },
			{ frequency: "weekly", label: "Weekly", feeBps: config.feeRateWeeklyBps },
			{
				frequency: "monthly",
				label: "Monthly",
				feeBps: config.feeRateMonthlyBps,
			},
		],
		warnings:
			book === "paper"
				? ["Simulated paper results — no real funds are managed in this book."]
				: config.liveEnabled
					? []
					: ["The live book is not enabled yet."],
	};
}

function toContactView(
	contact: typeof capitalInvestorContacts.$inferSelect,
): CapitalContactView {
	return {
		id: contact.id,
		tornId: contact.tornId,
		discordId: contact.discordId,
		name: contact.name,
		role: contact.role === "primary" ? "primary" : "viewer",
	};
}

function toInvestorView(
	investor: typeof capitalInvestors.$inferSelect,
	contacts: Array<typeof capitalInvestorContacts.$inferSelect>,
): CapitalInvestorView {
	return {
		id: investor.id,
		book: investor.book as CapitalBook,
		kind:
			investor.kind === "faction" ||
			investor.kind === "operator" ||
			investor.kind === "test"
				? investor.kind
				: "user",
		displayName: investor.displayName,
		frequency:
			investor.frequency === "daily" ||
			investor.frequency === "weekly" ||
			investor.frequency === "monthly"
				? investor.frequency
				: "weekly",
		payoutMode: investor.payoutMode === "reinvest" ? "reinvest" : "cash",
		tornId: investor.tornId,
		factionId: investor.factionId,
		status: investor.status,
		contacts: contacts.map(toContactView),
	};
}

export async function getInvestorPortfolio(
	book: CapitalBook,
	investorId: string,
): Promise<CapitalInvestorPortfolio> {
	const [investor] = await db
		.select()
		.from(capitalInvestors)
		.where(
			and(eq(capitalInvestors.book, book), eq(capitalInvestors.id, investorId)),
		)
		.limit(1);
	if (!investor) {
		return {
			success: false,
			investor: null,
			totals: null,
			lots: [],
			payouts: [],
			withdrawals: [],
			performance: [],
			warnings: ["Investor not found."],
		};
	}

	const contacts = await db
		.select()
		.from(capitalInvestorContacts)
		.where(eq(capitalInvestorContacts.investorId, investorId));
	const lots = await db
		.select()
		.from(capitalInvestments)
		.where(
			and(
				eq(capitalInvestments.book, book),
				eq(capitalInvestments.investorId, investorId),
			),
		)
		.orderBy(desc(capitalInvestments.openedAt));
	const payoutRows = await db
		.select()
		.from(capitalPayoutObligations)
		.where(
			and(
				eq(capitalPayoutObligations.book, book),
				eq(capitalPayoutObligations.investorId, investorId),
			),
		)
		.orderBy(desc(capitalPayoutObligations.dueAt));
	const withdrawalRows = await db
		.select()
		.from(capitalWithdrawalRequests)
		.where(
			and(
				eq(capitalWithdrawalRequests.book, book),
				eq(capitalWithdrawalRequests.investorId, investorId),
			),
		)
		.orderBy(desc(capitalWithdrawalRequests.requestedAt));

	const { nav } = await loadNav(book);
	const investorView = toInvestorView(investor, contacts);
	const lotViews: CapitalLotView[] = lots.map((lot) => {
		const principal = parseMoney(lot.principal);
		const units = parseUnits(lot.units);
		const metrics = computeInvestorMetrics({
			principal,
			units,
			navPerUnit: nav.navPerUnit,
			cumulativePayouts: parseMoney(lot.cumulativePayouts),
			cumulativeFees: parseMoney(lot.cumulativeFees),
			openedAt: lot.openedAt,
			now: new Date(),
		});
		return {
			id: lot.id,
			book,
			status: lot.status === "closed" ? "closed" : "active",
			frequency:
				lot.frequency === "daily" ||
				lot.frequency === "weekly" ||
				lot.frequency === "monthly"
					? lot.frequency
					: "monthly",
			payoutMode: lot.payoutMode === "reinvest" ? "reinvest" : "cash",
			principal: lot.principal,
			units: lot.units,
			navAtDeposit: lot.navAtDeposit,
			highWaterNav: lot.highWaterNav,
			currentValue: formatMoney(metrics.currentValue),
			profit: formatMoney(metrics.currentValue - principal),
			totalProfit: formatMoney(metrics.totalProfit),
			returnPct: metrics.totalReturnPct,
			aprPct: metrics.aprPct,
			xirrPct: metrics.xirrPct,
			daysInvested: metrics.daysInvested,
			cumulativePayouts: lot.cumulativePayouts,
			cumulativeFees: lot.cumulativeFees,
			openedAtIso: lot.openedAt.toISOString(),
			lastPayoutAtIso: iso(lot.lastPayoutAt),
			nextPayoutAtIso: iso(lot.nextPayoutAt),
		};
	});

	const active = lotViews.filter((lot) => lot.status === "active");
	const principal = active.reduce(
		(total, lot) => total + parseMoney(lot.principal),
		0n,
	);
	const currentValue = active.reduce(
		(total, lot) => total + parseMoney(lot.currentValue),
		0n,
	);
	const payoutsTotal = active.reduce(
		(total, lot) => total + parseMoney(lot.cumulativePayouts),
		0n,
	);
	const feesTotal = active.reduce(
		(total, lot) => total + parseMoney(lot.cumulativeFees),
		0n,
	);
	const totalProfit = currentValue - principal + payoutsTotal;
	const firstOpened = active
		.map((lot) => new Date(lot.openedAtIso).getTime())
		.sort((a, b) => a - b)[0];
	const days = firstOpened
		? daysBetween(new Date(firstOpened), new Date())
		: null;
	const totalReturnPct =
		principal > 0n
			? (moneyToNumber(totalProfit) / moneyToNumber(principal)) * 100
			: null;

	const payoutViews: CapitalPayoutView[] = payoutRows.map((payout) => ({
		id: payout.id,
		book,
		investmentId: payout.investmentId,
		investorId: payout.investorId,
		investorName: investor.displayName,
		frequency:
			payout.frequency === "daily" ||
			payout.frequency === "weekly" ||
			payout.frequency === "monthly"
				? payout.frequency
				: "monthly",
		periodStartIso: payout.periodStart.toISOString(),
		periodEndIso: payout.periodEnd.toISOString(),
		dueAtIso: payout.dueAt.toISOString(),
		grossAmount: payout.grossAmount,
		feeAmount: payout.feeAmount,
		netAmount: payout.netAmount,
		paidAmount: payout.paidAmount,
		remainingAmount: payout.remainingAmount,
		status:
			payout.status === "paid" ||
			payout.status === "partially_paid" ||
			payout.status === "unfunded" ||
			payout.status === "skipped_no_profit" ||
			payout.status === "cancelled" ||
			payout.status === "scheduled"
				? payout.status
				: "due",
		paidAtIso: iso(payout.paidAt),
		paymentReference: payout.paymentReference,
	}));

	const withdrawalViews: CapitalWithdrawalView[] = withdrawalRows.map(
		(request) => ({
			id: request.id,
			book,
			investmentId: request.investmentId,
			investorId: request.investorId,
			investorName: investor.displayName,
			requestedAmount: request.requestedAmount,
			unitsToRedeem: request.unitsToRedeem,
			grossValue: request.grossValue,
			principalBasis: request.principalBasis,
			profitAmount: request.profitAmount,
			lossAmount: request.lossAmount,
			performanceFee: request.performanceFee,
			exitFee: request.exitFee,
			netAmount: request.netAmount,
			liquidityWarning: request.liquidityWarning,
			status:
				request.status === "requested" ||
				request.status === "quoted" ||
				request.status === "approved" ||
				request.status === "queued_liquidity" ||
				request.status === "paid" ||
				request.status === "rejected" ||
				request.status === "cancelled"
					? request.status
					: "requested",
			requestedAtIso: request.requestedAt.toISOString(),
			quotedAtIso: iso(request.quotedAt),
			approvedAtIso: iso(request.approvedAt),
			paidAtIso: iso(request.paidAt),
			referenceCode: request.referenceCode,
			note: request.note,
		}),
	);

	return {
		success: true,
		investor: investorView,
		totals: {
			principal: formatMoney(principal),
			currentValue: formatMoney(currentValue),
			totalProfit: formatMoney(totalProfit),
			totalReturnPct,
			aprPct:
				totalReturnPct !== null && days && days >= 1
					? totalReturnPct * (365 / days)
					: null,
			xirrPct: null,
			daysInvested: days && days > 0 ? days : null,
			cumulativePayouts: formatMoney(payoutsTotal),
			cumulativeFees: formatMoney(feesTotal),
			activeLots: active.length,
		},
		lots: lotViews,
		payouts: payoutViews,
		withdrawals: withdrawalViews,
		performance: await loadPerformance(book, 90),
		warnings: [],
	};
}

export async function findInvestorByTornId(
	book: CapitalBook,
	tornId: number,
): Promise<string | null> {
	const [row] = await db
		.select({ id: capitalInvestors.id })
		.from(capitalInvestors)
		.where(
			and(eq(capitalInvestors.book, book), eq(capitalInvestors.tornId, tornId)),
		)
		.limit(1);
	return row?.id ?? null;
}

export async function createInvestor(input: {
	book: CapitalBook;
	kind: string;
	/** Required for live investors; optional for paper test investors. */
	tornId?: number | null;
	factionId?: number | null;
	displayName: string;
	frequency: "daily" | "weekly" | "monthly";
	payoutMode: "cash" | "reinvest";
	actor: string | null;
}): Promise<CapitalInvestorView> {
	const [investor] = await db
		.insert(capitalInvestors)
		.values({
			book: input.book,
			kind: input.kind,
			tornId: input.tornId ?? null,
			factionId: input.factionId ?? null,
			displayName: input.displayName,
			frequency: input.frequency,
			payoutMode: input.payoutMode,
			createdBy: input.actor,
		})
		.returning();
	if (!investor) throw new Error("Failed to create investor.");
	return toInvestorView(investor, []);
}

export async function updateInvestor(input: {
	book: CapitalBook;
	investorId: string;
	displayName?: string;
	frequency?: "daily" | "weekly" | "monthly";
	payoutMode?: "cash" | "reinvest";
	status?: string;
}): Promise<CapitalInvestorView> {
	return db.transaction(async (tx) => {
		const [investor] = await tx
			.update(capitalInvestors)
			.set({
				...(input.displayName === undefined
					? {}
					: { displayName: input.displayName }),
				...(input.frequency === undefined
					? {}
					: { frequency: input.frequency }),
				...(input.payoutMode === undefined
					? {}
					: { payoutMode: input.payoutMode }),
				...(input.status === undefined ? {} : { status: input.status }),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(capitalInvestors.book, input.book),
					eq(capitalInvestors.id, input.investorId),
				),
			)
			.returning();
		if (!investor) throw new Error("Investor not found.");

		// An investor-level cadence or payout setting is the source of truth for
		// their whole book, so apply it to every active lot as well. A cadence
		// change also realigns the next payout to the new schedule.
		if (input.frequency !== undefined || input.payoutMode !== undefined) {
			await tx
				.update(capitalInvestments)
				.set({
					...(input.frequency === undefined
						? {}
						: {
								frequency: input.frequency,
								nextPayoutAt: nextAlignedPayoutAt(new Date(), input.frequency),
							}),
					...(input.payoutMode === undefined
						? {}
						: { payoutMode: input.payoutMode }),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(capitalInvestments.book, input.book),
						eq(capitalInvestments.investorId, input.investorId),
						eq(capitalInvestments.status, "active"),
					),
				);
		}

		const contacts = await tx
			.select()
			.from(capitalInvestorContacts)
			.where(eq(capitalInvestorContacts.investorId, investor.id));
		return toInvestorView(investor, contacts);
	});
}

export async function addInvestorContact(input: {
	book: CapitalBook;
	investorId: string;
	tornId?: number | null;
	discordId?: string | null;
	name?: string | null;
	role: "primary" | "viewer";
}): Promise<CapitalContactView> {
	const [contact] = await db
		.insert(capitalInvestorContacts)
		.values({
			book: input.book,
			investorId: input.investorId,
			tornId: input.tornId ?? null,
			discordId: input.discordId ?? null,
			name: input.name ?? null,
			role: input.role,
		})
		.returning();
	if (!contact) throw new Error("Failed to add contact.");
	return toContactView(contact);
}

export async function createDepositLot(input: {
	book: CapitalBook;
	investorId: string;
	amount: string;
	/** Omit to inherit the investor's saved cadence. */
	frequency?: "daily" | "weekly" | "monthly";
	/** Omit to inherit the investor's saved profit handling. */
	payoutMode?: "cash" | "reinvest";
	occurredAt: Date;
	actor: string | null;
	note?: string | null;
}): Promise<{ investmentId: string; navPerUnit: string }> {
	const amount = parseMoney(input.amount);
	if (amount <= 0n) throw new Error("Deposit amount must be positive.");

	return withCapitalTransaction(input.book, async (tx, state) => {
		const [investor] = await tx
			.select()
			.from(capitalInvestors)
			.where(
				and(
					eq(capitalInvestors.book, input.book),
					eq(capitalInvestors.id, input.investorId),
				),
			)
			.limit(1);
		if (!investor) throw new Error("Investor not found.");
		const frequency =
			input.frequency ??
			(investor.frequency === "daily" ||
			investor.frequency === "weekly" ||
			investor.frequency === "monthly"
				? investor.frequency
				: "weekly");
		const payoutMode =
			input.payoutMode ??
			(investor.payoutMode === "reinvest" ? "reinvest" : "cash");

		const nav = computeNav({
			cash: state.cash,
			units: state.units,
			positions: state.positions.map((position) => ({
				shares: position.shares,
				price: position.price,
			})),
		});
		const deposit = computeDeposit(amount, nav.navPerUnit);
		const nextPayout = nextAlignedPayoutAt(new Date(), frequency);
		const [investment] = await tx
			.insert(capitalInvestments)
			.values({
				book: input.book,
				investorId: input.investorId,
				frequency,
				payoutMode,
				principal: formatMoney(deposit.principal),
				units: formatUnits(deposit.unitsIssued),
				navAtDeposit: formatMoney(deposit.navPerUnit),
				highWaterNav: formatMoney(deposit.highWaterNav),
				openedAt: input.occurredAt,
				nextPayoutAt: nextPayout,
				createdBy: input.actor,
				note: input.note ?? null,
			})
			.returning();
		if (!investment) throw new Error("Failed to create investment lot.");

		await tx.insert(capitalTransactions).values({
			book: input.book,
			type: "deposit",
			investorId: input.investorId,
			investmentId: investment.id,
			amount: formatMoney(deposit.principal),
			units: formatUnits(deposit.unitsIssued),
			navPerUnit: formatMoney(deposit.navPerUnit),
			source: "manual",
			occurredAt: input.occurredAt,
			recordedBy: input.actor,
			note: input.note ?? null,
		});

		return {
			investmentId: investment.id,
			navPerUnit: formatMoney(deposit.navPerUnit),
		};
	});
}

export async function payPayout(input: {
	book: CapitalBook;
	obligationId: string;
	amount?: string | null;
	idempotencyKey: string;
	actor: string | null;
	note?: string | null;
}): Promise<CapitalPayoutView> {
	const result = await withCapitalTransaction(input.book, async (tx, state) => {
		const [obligation] = await tx
			.select()
			.from(capitalPayoutObligations)
			.where(
				and(
					eq(capitalPayoutObligations.id, input.obligationId),
					eq(capitalPayoutObligations.book, input.book),
				),
			)
			.limit(1);
		if (!obligation) throw new Error("Payout obligation not found.");
		if (obligation.status === "paid" || obligation.status === "cancelled") {
			return obligation;
		}
		if (
			input.idempotencyKey &&
			obligation.idempotencyKey === input.idempotencyKey
		) {
			return obligation;
		}

		const [investment] = await tx
			.select()
			.from(capitalInvestments)
			.where(eq(capitalInvestments.id, obligation.investmentId))
			.limit(1);
		if (!investment) throw new Error("Investment lot not found.");

		const gross = parseMoney(obligation.grossAmount);
		const fee = parseMoney(obligation.feeAmount);
		const remaining = parseMoney(obligation.remainingAmount);
		const requested = input.amount ? parseMoney(input.amount) : remaining;
		const payGross = maxMoney(
			0n,
			requested < remaining ? requested : remaining,
		);
		if (payGross <= 0n) throw new Error("Payout amount must be positive.");

		const feePaid =
			remaining === gross
				? divideRound(fee * payGross, gross)
				: divideRound(fee * payGross, gross);
		const netPaid = payGross - feePaid;

		const nav = computeNav({
			cash: state.cash,
			units: state.units,
			positions: state.positions.map((position) => ({
				shares: position.shares,
				price: position.price,
			})),
		});
		const unitsRedeemed = unitsForRedemption(payGross, nav.navPerUnit);
		const units = parseUnits(investment.units);
		const redeemed = unitsRedeemed > units ? units : unitsRedeemed;
		const newUnits = units - redeemed;
		const fullyPaid = payGross >= remaining;
		const now = new Date();

		await tx
			.update(capitalInvestments)
			.set({
				units: formatUnits(newUnits),
				cumulativePayouts: formatMoney(
					parseMoney(investment.cumulativePayouts) + netPaid,
				),
				cumulativeFees: formatMoney(
					parseMoney(investment.cumulativeFees) + feePaid,
				),
				highWaterNav: fullyPaid
					? obligation.navAtCreation
					: investment.highWaterNav,
				lastPayoutAt: fullyPaid ? now : investment.lastPayoutAt,
				nextPayoutAt: fullyPaid
					? nextAlignedPayoutAt(
							now,
							investment.frequency as "daily" | "weekly" | "monthly",
						)
					: investment.nextPayoutAt,
				updatedAt: now,
			})
			.where(eq(capitalInvestments.id, investment.id));

		await tx.insert(capitalTransactions).values({
			book: input.book,
			type: "payout",
			investorId: obligation.investorId,
			investmentId: investment.id,
			payoutId: obligation.id,
			amount: formatMoney(-netPaid),
			units: formatUnits(-redeemed),
			source: "manual",
			occurredAt: now,
			recordedBy: input.actor,
			note: input.note ?? null,
		});
		await tx.insert(capitalTransactions).values({
			book: input.book,
			type: "fee",
			investorId: obligation.investorId,
			investmentId: investment.id,
			payoutId: obligation.id,
			amount: formatMoney(-feePaid),
			source: "manual",
			occurredAt: now,
			recordedBy: input.actor,
			note: "Performance fee.",
		});

		const newPaid = parseMoney(obligation.paidAmount) + payGross;
		const newRemaining = remaining - payGross;
		const [updated] = await tx
			.update(capitalPayoutObligations)
			.set({
				paidAmount: formatMoney(newPaid),
				remainingAmount: formatMoney(newRemaining),
				status: newRemaining <= 0n ? "paid" : "partially_paid",
				paidAt: newRemaining <= 0n ? now : obligation.paidAt,
				paidBy: input.actor,
				idempotencyKey: input.idempotencyKey,
				updatedAt: now,
			})
			.where(eq(capitalPayoutObligations.id, obligation.id))
			.returning();
		if (!updated) throw new Error("Failed to update payout obligation.");
		return updated;
	});

	const investor = await db
		.select()
		.from(capitalInvestors)
		.where(eq(capitalInvestors.id, result.investorId))
		.limit(1);
	return {
		id: result.id,
		book: input.book,
		investmentId: result.investmentId,
		investorId: result.investorId,
		investorName: investor[0]?.displayName ?? "Investor",
		frequency:
			result.frequency === "daily" ||
			result.frequency === "weekly" ||
			result.frequency === "monthly"
				? result.frequency
				: "monthly",
		periodStartIso: result.periodStart.toISOString(),
		periodEndIso: result.periodEnd.toISOString(),
		dueAtIso: result.dueAt.toISOString(),
		grossAmount: result.grossAmount,
		feeAmount: result.feeAmount,
		netAmount: result.netAmount,
		paidAmount: result.paidAmount,
		remainingAmount: result.remainingAmount,
		status:
			result.status === "paid" ||
			result.status === "partially_paid" ||
			result.status === "unfunded" ||
			result.status === "skipped_no_profit" ||
			result.status === "cancelled" ||
			result.status === "scheduled"
				? result.status
				: "due",
		paidAtIso: iso(result.paidAt),
		paymentReference: result.paymentReference,
	};
}

export async function createWithdrawalQuote(input: {
	book: CapitalBook;
	investmentId: string;
	requestedAmount?: string | null;
	now?: Date;
}): Promise<CapitalWithdrawalQuote> {
	const now = input.now ?? new Date();
	const [investment] = await db
		.select()
		.from(capitalInvestments)
		.where(
			and(
				eq(capitalInvestments.book, input.book),
				eq(capitalInvestments.id, input.investmentId),
			),
		)
		.limit(1);
	if (!investment) throw new Error("Investment lot not found.");
	if (investment.status !== "active") throw new Error("Lot is not active.");

	const config = await getCapitalConfig(input.book);
	const { nav } = await loadNav(input.book);
	const units = parseUnits(investment.units);
	const quote = computeWithdrawal({
		navPerUnit: nav.navPerUnit,
		units,
		principal: parseMoney(investment.principal),
		requestedAmount: input.requestedAmount ?? null,
		performanceFeeEnabled: config.withdrawalPerformanceFeeEnabled,
		feeBps:
			investment.frequency === "daily"
				? config.feeRateDailyBps
				: investment.frequency === "weekly"
					? config.feeRateWeeklyBps
					: config.feeRateMonthlyBps,
		exitFeeBps: config.withdrawalExitFeeBps,
	});

	const liquidityWarning =
		quote.grossValue > parseMoney((await getCapitalState(input.book)).cash)
			? "Cash is currently short of this withdrawal; the engine will need to sell positions before payment."
			: null;

	return {
		success: true,
		investmentId: investment.id,
		requestedAmount: formatMoney(
			input.requestedAmount
				? parseMoney(input.requestedAmount)
				: quote.grossValue,
		),
		unitsToRedeem: formatUnits(quote.unitsToRedeem),
		grossValue: formatMoney(quote.grossValue),
		principalBasis: formatMoney(quote.principalBasis),
		profitAmount: formatMoney(quote.profit),
		lossAmount: formatMoney(quote.loss),
		performanceFee: formatMoney(quote.performanceFee),
		exitFee: formatMoney(quote.exitFee),
		netAmount: formatMoney(quote.net),
		liquidityWarning,
		validUntilIso: new Date(now.getTime() + 15 * 60_000).toISOString(),
	};
}

export async function createWithdrawalRequest(input: {
	book: CapitalBook;
	investmentId: string;
	investorId: string;
	requestedAmount: string;
	actor: string | null;
}): Promise<CapitalWithdrawalView> {
	const quote = await createWithdrawalQuote({
		book: input.book,
		investmentId: input.investmentId,
		requestedAmount: input.requestedAmount,
	});
	const [request] = await db
		.insert(capitalWithdrawalRequests)
		.values({
			book: input.book,
			investmentId: input.investmentId,
			investorId: input.investorId,
			requestedAmount: quote.requestedAmount,
			unitsToRedeem: quote.unitsToRedeem,
			grossValue: quote.grossValue,
			principalBasis: quote.principalBasis,
			profitAmount: quote.profitAmount,
			lossAmount: quote.lossAmount,
			performanceFee: quote.performanceFee,
			exitFee: quote.exitFee,
			netAmount: quote.netAmount,
			liquidityWarning: quote.liquidityWarning,
			status: quote.liquidityWarning ? "queued_liquidity" : "quoted",
			referenceCode: makeReferenceCode("WDR"),
			requestedBy: input.actor,
			quotedAt: new Date(),
		})
		.returning();
	if (!request) throw new Error("Failed to create withdrawal request.");
	return {
		id: request.id,
		book: input.book,
		investmentId: request.investmentId,
		investorId: request.investorId,
		investorName: "Investor",
		requestedAmount: request.requestedAmount,
		unitsToRedeem: request.unitsToRedeem,
		grossValue: request.grossValue,
		principalBasis: request.principalBasis,
		profitAmount: request.profitAmount,
		lossAmount: request.lossAmount,
		performanceFee: request.performanceFee,
		exitFee: request.exitFee,
		netAmount: request.netAmount,
		liquidityWarning: request.liquidityWarning,
		status: request.status as CapitalWithdrawalView["status"],
		requestedAtIso: request.requestedAt.toISOString(),
		quotedAtIso: iso(request.quotedAt),
		approvedAtIso: iso(request.approvedAt),
		paidAtIso: iso(request.paidAt),
		referenceCode: request.referenceCode,
		note: request.note,
	};
}

export async function payWithdrawal(input: {
	book: CapitalBook;
	requestId: string;
	actor: string | null;
}): Promise<CapitalWithdrawalView> {
	const request = await withCapitalTransaction(
		input.book,
		async (tx, state) => {
			const [row] = await tx
				.select()
				.from(capitalWithdrawalRequests)
				.where(
					and(
						eq(capitalWithdrawalRequests.id, input.requestId),
						eq(capitalWithdrawalRequests.book, input.book),
					),
				)
				.limit(1);
			if (!row) throw new Error("Withdrawal request not found.");
			if (row.status === "paid") return row;
			if (row.status !== "approved" && row.status !== "queued_liquidity") {
				throw new Error("Withdrawal is not approved.");
			}
			const gross = parseMoney(row.grossValue);
			if (parseMoney(state.cash) < gross) {
				throw new Error("Insufficient cash to pay this withdrawal.");
			}
			const [investment] = await tx
				.select()
				.from(capitalInvestments)
				.where(eq(capitalInvestments.id, row.investmentId))
				.limit(1);
			if (!investment) throw new Error("Investment lot not found.");
			const units = parseUnits(investment.units);
			const redeemed = parseUnits(row.unitsToRedeem);
			const newUnits = units > redeemed ? units - redeemed : 0n;
			const newPrincipal =
				parseMoney(investment.principal) - parseMoney(row.principalBasis);
			const now = new Date();
			await tx
				.update(capitalInvestments)
				.set({
					units: formatUnits(newUnits > 0n ? newUnits : 0n),
					principal: formatMoney(newPrincipal > 0n ? newPrincipal : 0n),
					status: newUnits > 0n ? "active" : "closed",
					closedAt: newUnits > 0n ? null : now,
					updatedAt: now,
				})
				.where(eq(capitalInvestments.id, investment.id));

			await tx.insert(capitalTransactions).values({
				book: input.book,
				type: "withdrawal",
				investorId: row.investorId,
				investmentId: row.investmentId,
				withdrawalId: row.id,
				amount: formatMoney(-parseMoney(row.netAmount)),
				units: formatUnits(-redeemed),
				source: "manual",
				occurredAt: now,
				recordedBy: input.actor,
			});
			const performanceFee = parseMoney(row.performanceFee);
			if (performanceFee > 0n) {
				await tx.insert(capitalTransactions).values({
					book: input.book,
					type: "fee",
					investorId: row.investorId,
					investmentId: row.investmentId,
					withdrawalId: row.id,
					amount: formatMoney(-performanceFee),
					source: "manual",
					occurredAt: now,
					recordedBy: input.actor,
					note: "Withdrawal performance fee.",
				});
			}
			const exitFee = parseMoney(row.exitFee);
			if (exitFee > 0n) {
				await tx.insert(capitalTransactions).values({
					book: input.book,
					type: "exit_fee",
					investorId: row.investorId,
					investmentId: row.investmentId,
					withdrawalId: row.id,
					amount: formatMoney(-exitFee),
					source: "manual",
					occurredAt: now,
					recordedBy: input.actor,
					note: "Withdrawal exit fee.",
				});
			}
			const [updated] = await tx
				.update(capitalWithdrawalRequests)
				.set({
					status: "paid",
					paidAt: now,
					updatedAt: now,
				})
				.where(eq(capitalWithdrawalRequests.id, row.id))
				.returning();
			if (!updated) throw new Error("Failed to update withdrawal.");
			return updated;
		},
	);

	const investor = await db
		.select()
		.from(capitalInvestors)
		.where(eq(capitalInvestors.id, request.investorId))
		.limit(1);
	return {
		id: request.id,
		book: input.book,
		investmentId: request.investmentId,
		investorId: request.investorId,
		investorName: investor[0]?.displayName ?? "Investor",
		requestedAmount: request.requestedAmount,
		unitsToRedeem: request.unitsToRedeem,
		grossValue: request.grossValue,
		principalBasis: request.principalBasis,
		profitAmount: request.profitAmount,
		lossAmount: request.lossAmount,
		performanceFee: request.performanceFee,
		exitFee: request.exitFee,
		netAmount: request.netAmount,
		liquidityWarning: request.liquidityWarning,
		status: "paid",
		requestedAtIso: request.requestedAt.toISOString(),
		quotedAtIso: iso(request.quotedAt),
		approvedAtIso: iso(request.approvedAt),
		paidAtIso: iso(request.paidAt),
		referenceCode: request.referenceCode,
		note: request.note,
	};
}

export function toCapitalSettings(
	config: typeof capitalBookConfigs.$inferSelect,
): CapitalSettings {
	return {
		book: config.book as CapitalBook,
		publicShowAum: config.publicShowAum,
		publicShowTrades: config.publicShowTrades,
		publicShowHoldings: config.publicShowHoldings,
		publicShowFees: config.publicShowFees,
		feeRateDailyBps: config.feeRateDailyBps,
		feeRateWeeklyBps: config.feeRateWeeklyBps,
		feeRateMonthlyBps: config.feeRateMonthlyBps,
		minCashReservePct: config.minCashReservePct,
		maxEquityPct: config.maxEquityPct,
		maxStockWeightPct: config.maxStockWeightPct,
		maxPositions: config.maxPositions,
		riskPerTradePct: config.riskPerTradePct,
		stopAtrMultiplier: config.stopAtrMultiplier,
		stopMinPct: config.stopMinPct,
		trailingTriggerR: config.trailingTriggerR,
		trailingAtrMultiplier: config.trailingAtrMultiplier,
		trailingPct: config.trailingPct,
		tightenTrailPct: config.tightenTrailPct,
		scaleOutR: config.scaleOutR,
		scaleOutFraction: config.scaleOutFraction,
		timeStopDays: config.timeStopDays,
		minEntryScore: config.minEntryScore,
		maxRsi: config.maxRsi,
		overboughtSigma: config.overboughtSigma,
		signalMode: isCapitalSignalMode(config.signalMode)
			? config.signalMode
			: "reversal",
		reversalEntrySigma: config.reversalEntrySigma,
		reversalExitSigma: config.reversalExitSigma,
		maxVolatilityPct: config.maxVolatilityPct,
		mlEnabled: config.mlEnabled,
		mlWeight: config.mlWeight,
		mlMinConfidence: config.mlMinConfidence,
		mlMaxModelAgeDays: config.mlMaxModelAgeDays,
		regimeSmaDays: config.regimeSmaDays,
		drawdownHaltPct: config.drawdownHaltPct,
		drawdownDeriskPct: config.drawdownDeriskPct,
		dailyLossHaltPct: config.dailyLossHaltPct,
		stopCooldownDays: config.stopCooldownDays,
		maxNewPositionsPerWeek: config.maxNewPositionsPerWeek,
		orderValidityMinutes: config.orderValidityMinutes,
		staleDataSeconds: config.staleDataSeconds,
		saleFeeBps: config.saleFeeBps,
		withdrawalPerformanceFeeEnabled: config.withdrawalPerformanceFeeEnabled,
		withdrawalExitFeeBps: config.withdrawalExitFeeBps,
		withdrawalMinAmount: config.withdrawalMinAmount,
		withdrawalNoticeDays: config.withdrawalNoticeDays,
		paymentMatchTolerancePct: config.paymentMatchTolerancePct,
		notifyUnmatchedBuys: config.notifyUnmatchedBuys,
		paperStartingCash: config.paperStartingCash,
		paperSlippageBps: config.paperSlippageBps,
		paperAutoFill: config.paperAutoFill,
		engineEnabled: config.engineEnabled,
		liveEnabled: config.liveEnabled,
		updatedAtIso: config.updatedAt.toISOString(),
		updatedBy: config.updatedBy,
	};
}

export async function getCapitalAdminOverview(
	book: CapitalBook,
): Promise<CapitalAdminOverview> {
	const { summary, stockMap } = await getCapitalSummary(book);
	const config = await getCapitalConfig(book);
	const state = await getCapitalState(book);
	const investors = await db
		.select()
		.from(capitalInvestors)
		.where(eq(capitalInvestors.book, book));
	const contacts = await db
		.select()
		.from(capitalInvestorContacts)
		.where(eq(capitalInvestorContacts.book, book));
	const lots = await db
		.select()
		.from(capitalInvestments)
		.where(eq(capitalInvestments.book, book));
	const payouts = await db
		.select()
		.from(capitalPayoutObligations)
		.where(eq(capitalPayoutObligations.book, book))
		.orderBy(desc(capitalPayoutObligations.dueAt));
	const withdrawals = await db
		.select()
		.from(capitalWithdrawalRequests)
		.where(eq(capitalWithdrawalRequests.book, book))
		.orderBy(desc(capitalWithdrawalRequests.requestedAt));
	const issues = await db
		.select()
		.from(capitalReconciliationIssues)
		.where(
			and(
				eq(capitalReconciliationIssues.book, book),
				eq(capitalReconciliationIssues.status, "open"),
			),
		);
	const intents = await db
		.select()
		.from(capitalPaymentIntents)
		.where(
			and(
				eq(capitalPaymentIntents.book, book),
				eq(capitalPaymentIntents.status, "pending"),
			),
		);
	const orders = await db
		.select()
		.from(capitalOrders)
		.where(eq(capitalOrders.book, book))
		.orderBy(desc(capitalOrders.generatedAt))
		.limit(50);
	const fills = await db
		.select()
		.from(capitalFills)
		.where(eq(capitalFills.book, book))
		.orderBy(desc(capitalFills.occurredAt))
		.limit(50);
	const workerState = await db.query.workerState.findFirst({
		where: (table, { eq: eqFn }) => eqFn(table.workerId, "capital:engine"),
	});
	const engineDetails =
		(workerState?.details as Record<string, unknown> | undefined) ?? {};

	const { nav } = await loadNav(book);
	const investorRows: CapitalInvestorAdminRow[] = investors.map((investor) => {
		const investorLots = lots.filter((lot) => lot.investorId === investor.id);
		const investorContacts = contacts.filter(
			(contact) => contact.investorId === investor.id,
		);
		let principal = 0n;
		let currentValue = 0n;
		let payouts = 0n;
		let fees = 0n;
		let activeLots = 0;
		let earliest: Date | null = null;
		for (const lot of investorLots) {
			if (lot.status !== "active") continue;
			activeLots += 1;
			principal += parseMoney(lot.principal);
			const metrics = computeInvestorMetrics({
				principal: parseMoney(lot.principal),
				units: parseUnits(lot.units),
				navPerUnit: nav.navPerUnit,
				cumulativePayouts: parseMoney(lot.cumulativePayouts),
				cumulativeFees: parseMoney(lot.cumulativeFees),
				openedAt: lot.openedAt,
				now: new Date(),
			});
			currentValue += metrics.currentValue;
			payouts += parseMoney(lot.cumulativePayouts);
			fees += parseMoney(lot.cumulativeFees);
			if (!earliest || lot.openedAt < earliest) earliest = lot.openedAt;
		}
		const totalProfit = currentValue - principal + payouts;
		const totalReturnPct =
			principal > 0n
				? (moneyToNumber(totalProfit) / moneyToNumber(principal)) * 100
				: null;
		const days = earliest ? daysBetween(earliest, new Date()) : null;
		return {
			investor: toInvestorView(investor, investorContacts),
			principal: formatMoney(principal),
			currentValue: formatMoney(currentValue),
			totalProfit: formatMoney(totalProfit),
			totalReturnPct,
			aprPct:
				totalReturnPct !== null && days && days >= 1
					? totalReturnPct * (365 / days)
					: null,
			daysInvested: days,
			cumulativePayouts: formatMoney(payouts),
			cumulativeFees: formatMoney(fees),
			activeLots,
			nextPayoutAtIso:
				investorLots
					.map((lot) => lot.nextPayoutAt)
					.filter((value): value is Date => value !== null)
					.sort((a, b) => a.getTime() - b.getTime())[0]
					?.toISOString() ?? null,
		};
	});

	const payoutViews: CapitalPayoutView[] = payouts.map((payout) => ({
		id: payout.id,
		book,
		investmentId: payout.investmentId,
		investorId: payout.investorId,
		investorName:
			investors.find((investor) => investor.id === payout.investorId)
				?.displayName ?? "Investor",
		frequency:
			payout.frequency === "daily" ||
			payout.frequency === "weekly" ||
			payout.frequency === "monthly"
				? payout.frequency
				: "monthly",
		periodStartIso: payout.periodStart.toISOString(),
		periodEndIso: payout.periodEnd.toISOString(),
		dueAtIso: payout.dueAt.toISOString(),
		grossAmount: payout.grossAmount,
		feeAmount: payout.feeAmount,
		netAmount: payout.netAmount,
		paidAmount: payout.paidAmount,
		remainingAmount: payout.remainingAmount,
		status:
			payout.status === "paid" ||
			payout.status === "partially_paid" ||
			payout.status === "unfunded" ||
			payout.status === "skipped_no_profit" ||
			payout.status === "cancelled" ||
			payout.status === "scheduled"
				? payout.status
				: "due",
		paidAtIso: iso(payout.paidAt),
		paymentReference: payout.paymentReference,
	}));

	const withdrawalViews: CapitalWithdrawalView[] = withdrawals.map(
		(request) => ({
			id: request.id,
			book,
			investmentId: request.investmentId,
			investorId: request.investorId,
			investorName:
				investors.find((investor) => investor.id === request.investorId)
					?.displayName ?? "Investor",
			requestedAmount: request.requestedAmount,
			unitsToRedeem: request.unitsToRedeem,
			grossValue: request.grossValue,
			principalBasis: request.principalBasis,
			profitAmount: request.profitAmount,
			lossAmount: request.lossAmount,
			performanceFee: request.performanceFee,
			exitFee: request.exitFee,
			netAmount: request.netAmount,
			liquidityWarning: request.liquidityWarning,
			status:
				request.status === "requested" ||
				request.status === "quoted" ||
				request.status === "approved" ||
				request.status === "queued_liquidity" ||
				request.status === "paid" ||
				request.status === "rejected" ||
				request.status === "cancelled"
					? request.status
					: "requested",
			requestedAtIso: request.requestedAt.toISOString(),
			quotedAtIso: iso(request.quotedAt),
			approvedAtIso: iso(request.approvedAt),
			paidAtIso: iso(request.paidAt),
			referenceCode: request.referenceCode,
			note: request.note,
		}),
	);

	const issueViews: CapitalReconciliationIssueView[] = issues.map((issue) => ({
		id: issue.id,
		book,
		kind: issue.kind as CapitalReconciliationIssueView["kind"],
		status:
			issue.status === "resolved" || issue.status === "ignored"
				? issue.status
				: "open",
		stockId: issue.stockId,
		investorId: issue.investorId,
		title: issue.title,
		detail: issue.detail,
		amount: issue.amount,
		details: issue.details,
		discordMessageId: issue.discordMessageId,
		discordChannelId: issue.discordChannelId,
		detectedAtIso: issue.detectedAt.toISOString(),
		resolvedAtIso: iso(issue.resolvedAt),
		resolvedBy: issue.resolvedBy,
		resolutionNote: issue.resolutionNote,
	}));

	const intentViews: CapitalPaymentIntentView[] = intents.map((intent) => ({
		id: intent.id,
		book,
		kind:
			intent.kind === "payout" || intent.kind === "withdrawal"
				? intent.kind
				: "deposit",
		status:
			intent.status === "matched" ||
			intent.status === "paid" ||
			intent.status === "ignored" ||
			intent.status === "expired" ||
			intent.status === "variance"
				? intent.status
				: "pending",
		investorId: intent.investorId,
		investorName:
			investors.find((investor) => investor.id === intent.investorId)
				?.displayName ?? null,
		investmentId: intent.investmentId,
		frequency:
			intent.frequency === "daily" ||
			intent.frequency === "weekly" ||
			intent.frequency === "monthly"
				? intent.frequency
				: null,
		payoutMode: intent.payoutMode === "reinvest" ? "reinvest" : "cash",
		payoutIds: intent.payoutIds,
		counterpartyTornId: intent.counterpartyTornId,
		expectedAmount: intent.expectedAmount,
		matchedAmount: intent.matchedAmount,
		tolerancePct: intent.tolerancePct,
		referenceCode: intent.referenceCode,
		expiresAtIso: intent.expiresAt.toISOString(),
		matchedLogId: intent.matchedLogId,
		createdAtIso: intent.createdAt.toISOString(),
		note: intent.note,
	}));

	const orderViews: CapitalOrderView[] = orders.map((order) => {
		const stock = stockMap.get(order.stockId);
		return {
			id: order.id,
			book,
			stockId: order.stockId,
			stockName: stock?.name ?? `Stock #${order.stockId}`,
			acronym: stock?.acronym ?? `#${order.stockId}`,
			side: order.side === "sell" ? "sell" : "buy",
			status:
				order.status === "accepted" ||
				order.status === "partially_filled" ||
				order.status === "filled" ||
				order.status === "expired" ||
				order.status === "cancelled"
					? order.status
					: "recommended",
			recommendedShares: order.recommendedShares,
			filledShares: order.filledShares,
			averageFillPrice: order.averageFillPrice,
			priceGuide: order.priceGuide,
			minPrice: order.minPrice,
			maxPrice: order.maxPrice,
			score: order.score,
			rationale: order.rationale,
			stopPrice: order.stopPrice,
			targetPrice: order.targetPrice,
			expectedAnnualIncome: order.expectedAnnualIncome,
			riskFlags: order.riskFlags,
			generatedAtIso: order.generatedAt.toISOString(),
			expiresAtIso: order.expiresAt.toISOString(),
			fill: null,
		};
	});

	const fillViews: CapitalFillView[] = fills.map((fill) => {
		const stock = stockMap.get(fill.stockId);
		return {
			id: fill.id,
			book,
			orderId: fill.orderId,
			stockId: fill.stockId,
			stockName: stock?.name ?? `Stock #${fill.stockId}`,
			side: fill.side === "sell" ? "sell" : "buy",
			shares: fill.shares,
			price: fill.price,
			notional: fill.notional,
			fees: fill.fees,
			source:
				fill.source === "torn_log" ||
				fill.source === "paper" ||
				fill.source === "decision"
					? fill.source
					: "manual",
			occurredAtIso: fill.occurredAt.toISOString(),
			variance:
				fill.varianceShares !== null ||
				fill.variancePrice !== null ||
				fill.slippageBps !== null
					? {
							sharesDelta: fill.varianceShares ?? 0,
							priceDelta: fill.variancePrice ?? "0",
							slippageBps: fill.slippageBps ?? 0,
							delaySeconds: fill.delaySeconds ?? 0,
							notionalDelta: fill.notionalDelta ?? "0",
						}
					: null,
			note: fill.note,
		};
	});

	const engine: CapitalEngineStatus = {
		book,
		enabled: config.engineEnabled,
		liveEnabled: config.liveEnabled,
		status: workerState?.status ?? null,
		lastRunAtIso: iso(workerState?.lastRunAt),
		lastSuccessAtIso:
			typeof engineDetails.lastSuccessAt === "string"
				? engineDetails.lastSuccessAt
				: null,
		dataAgeSeconds:
			typeof engineDetails.dataAgeSeconds === "number"
				? engineDetails.dataAgeSeconds
				: null,
		stocksScored:
			typeof engineDetails.stocksScored === "number"
				? engineDetails.stocksScored
				: 0,
		recommendations:
			typeof engineDetails.recommendations === "number"
				? engineDetails.recommendations
				: 0,
		paperFills:
			typeof engineDetails.paperFills === "number"
				? engineDetails.paperFills
				: 0,
		lastError: workerState?.lastError ?? null,
	};

	return {
		success: true,
		summary: {
			...summary,
			aum: formatMoney(nav.totalValue),
			cash: formatMoney(parseMoney(state.cash)),
		},
		settings: toCapitalSettings(config),
		engine,
		investors: investorRows,
		payoutsDue: payoutViews.filter(
			(payout) =>
				payout.status === "due" ||
				payout.status === "unfunded" ||
				payout.status === "partially_paid",
		),
		withdrawalsPending: withdrawalViews.filter(
			(request) =>
				request.status === "requested" ||
				request.status === "quoted" ||
				request.status === "approved" ||
				request.status === "queued_liquidity",
		),
		openIssues: issueViews,
		paymentIntentsPending: intentViews,
		orders: orderViews,
		recentFills: fillViews,
		performance: await loadPerformance(book),
		holdings: await loadHoldings(book, stockMap),
		notifications: {
			unfundedPayouts: payoutViews.filter(
				(payout) => payout.status === "unfunded",
			).length,
			openIssues: issueViews.length,
			pendingWithdrawals: withdrawalViews.filter(
				(request) =>
					request.status === "requested" ||
					request.status === "quoted" ||
					request.status === "queued_liquidity",
			).length,
			pendingPayments: intentViews.filter(
				(intent) => intent.status === "pending",
			).length,
		},
	};
}

export async function resetPaperBook(
	startingCash: string,
	actor: string | null,
): Promise<void> {
	await resetCapitalPaperBook(startingCash, actor);
}

/** Records a fill the owner executed but whose Torn log has not arrived yet. */
export async function recordManualFill(input: {
	book: CapitalBook;
	stockId: number;
	side: "buy" | "sell";
	shares: number;
	price: string;
	fees: string;
	orderId?: string | null;
	actor: string | null;
	note?: string | null;
}): Promise<CapitalFillView> {
	const notional = moneyFromPriceShares(input.price, input.shares);
	const fees = parseMoney(input.fees);
	const cashDelta = input.side === "buy" ? -(notional + fees) : notional - fees;
	const now = new Date();
	const fill = await withCapitalTransaction(input.book, async (tx) => {
		await applyCapitalFill(tx, {
			book: input.book,
			stockId: input.stockId,
			side: input.side,
			shares: input.shares,
			price: input.price,
			notional: formatMoney(notional),
			fees: formatMoney(fees),
			cashDelta: formatMoney(cashDelta),
			totalCost: formatMoney(notional + fees),
			source: "manual",
			occurredAt: now,
		});
		const [row] = await tx
			.insert(capitalFills)
			.values({
				book: input.book,
				orderId: input.orderId ?? null,
				stockId: input.stockId,
				side: input.side,
				shares: input.shares,
				price: input.price,
				notional: formatMoney(notional),
				fees: formatMoney(fees),
				source: "manual",
				occurredAt: now,
				note: input.note ?? null,
			})
			.returning();
		if (!row) throw new Error("Failed to record manual fill.");
		if (input.orderId) {
			const [order] = await tx
				.select()
				.from(capitalOrders)
				.where(eq(capitalOrders.id, input.orderId))
				.limit(1);
			if (order) {
				const filled = order.filledShares + input.shares;
				await tx
					.update(capitalOrders)
					.set({
						filledShares: filled,
						status:
							filled >= order.recommendedShares ? "filled" : "partially_filled",
						averageFillPrice: input.price,
						acceptedAt: order.acceptedAt ?? now,
						updatedAt: now,
					})
					.where(eq(capitalOrders.id, order.id));
			}
		}
		return row;
	});
	return {
		id: fill.id,
		book: input.book,
		orderId: fill.orderId,
		stockId: fill.stockId,
		stockName: `Stock #${fill.stockId}`,
		side: input.side,
		shares: Number(fill.shares),
		price: fill.price,
		notional: fill.notional,
		fees: fill.fees,
		source: "manual",
		occurredAtIso: fill.occurredAt.toISOString(),
		variance: null,
		note: fill.note,
	};
}
