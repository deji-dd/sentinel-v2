/**
 * Capital reconciliation: turning Torn logs into fills and payments.
 *
 * This module is pure; the scheduler supplies open orders/intents and applies
 * the returned decision in one transaction. The rules are deliberately narrow:
 *
 * - A stock buy is recorded only when it matches an open buy order for the same
 *   stock, regardless of share amount. A different stock is not a fill.
 * - A stock sell is recorded when it matches an open sell order, or when it is
 *   a fund-held stock being exited without a recommendation (the book must not
 *   keep claiming shares that are gone).
 * - Money logs match a payment intent by reference code first, then by
 *   counterparty and amount tolerance. No match means an issue, never a silent
 *   ledger write.
 */

import { formatMoney, type Money, parseMoney } from "./capital-money";
import { normalizeStockLog, type StockEvent } from "./stock-portfolio";

export type CapitalStockSide = "buy" | "sell";

export interface CapitalStockLogRow {
	id: string;
	log: number;
	/** Unix seconds, as stored in `personal_logs`. */
	timestamp: number;
	data: unknown;
}

export interface CapitalStockFillEvent {
	logId: string;
	stockId: number;
	side: CapitalStockSide;
	shares: number;
	price: number;
	fees: number;
	worth: number;
	timestamp: number;
}

/** Narrows a personal log row to a buy/sell stock event. */
export function readCapitalStockFill(
	row: CapitalStockLogRow,
): CapitalStockFillEvent | null {
	const event: StockEvent | null = normalizeStockLog({
		id: row.id,
		log: row.log,
		timestamp: row.timestamp,
		data: row.data,
	});
	if (!event) return null;
	if (event.kind !== "buy" && event.kind !== "sell") return null;
	return {
		logId: event.logId,
		stockId: event.stockId,
		side: event.kind,
		shares: event.shares,
		price:
			event.kind === "sell" && event.price > 0
				? event.price
				: event.price > 0
					? event.price
					: event.worth / event.shares,
		fees: event.kind === "sell" ? event.fees : 0,
		worth: event.worth,
		timestamp: event.timestamp,
	};
}

export interface CapitalMatchableOrder {
	id: string;
	stockId: number;
	side: CapitalStockSide;
	status: string;
	recommendedShares: number;
	filledShares: number;
	priceGuide: string;
	generatedAt: Date;
	expiresAt: Date;
}

const MATCHABLE_STATUSES = new Set([
	"recommended",
	"accepted",
	"partially_filled",
]);

/** Grace after expiry for a log that was written just before the order lapsed. */
const MATCH_GRACE_SECONDS = 10 * 60;

/**
 * Picks the order a fill belongs to.
 *
 * The newest eligible order wins because the engine never opens a second order
 * for the same stock while one is live. Expired orders are still matchable for
 * a short grace period: Torn logs can arrive after the order's display expiry,
 * and refusing them would make a real fill disappear from the book.
 */
export function selectOrderForFill(
	event: CapitalStockFillEvent,
	orders: CapitalMatchableOrder[],
): CapitalMatchableOrder | null {
	const eventSeconds = event.timestamp;
	const candidates = orders.filter((order) => {
		if (order.stockId !== event.stockId) return false;
		if (order.side !== event.side) return false;
		if (!MATCHABLE_STATUSES.has(order.status)) return false;
		if (order.filledShares >= order.recommendedShares) return false;
		const startsAt = order.generatedAt.getTime() / 1000;
		const expiresAt = order.expiresAt.getTime() / 1000;
		return (
			eventSeconds >= startsAt - 60 &&
			eventSeconds <= expiresAt + MATCH_GRACE_SECONDS
		);
	});

	if (candidates.length === 0) return null;
	return candidates.reduce((newest, current) =>
		current.generatedAt.getTime() > newest.generatedAt.getTime()
			? current
			: newest,
	);
}

export interface FillVariance {
	sharesDelta: number;
	priceDelta: string;
	slippageBps: number;
	delaySeconds: number;
	notionalDelta: string;
}

/** Measures actual execution against the recommendation. */
export function computeFillVariance(input: {
	order: {
		recommendedShares: number;
		filledShares: number;
		priceGuide: string;
		generatedAt: Date;
	};
	fill: {
		shares: number;
		price: number;
		timestamp: number;
	};
}): FillVariance {
	const guide = Number.parseFloat(input.order.priceGuide);
	const priceDelta = input.fill.price - guide;
	const slippageBps = guide > 0 ? (priceDelta / guide) * 10_000 : 0;
	const recommendedRemaining = Math.max(
		0,
		input.order.recommendedShares - input.order.filledShares,
	);
	const sharesDelta = input.fill.shares - recommendedRemaining;
	const notionalDelta =
		parseMoney(input.fill.price) * BigInt(input.fill.shares) -
		parseMoney(input.order.priceGuide) * BigInt(recommendedRemaining);

	return {
		sharesDelta,
		priceDelta: priceDelta.toFixed(6),
		slippageBps,
		delaySeconds: Math.max(
			0,
			input.fill.timestamp -
				Math.floor(input.order.generatedAt.getTime() / 1000),
		),
		notionalDelta: formatMoney(notionalDelta),
	};
}

// ─── Money transfer logs ────────────────────────────────────────────────────

export type CapitalMoneyDirection = "send" | "receive";

export interface CapitalMoneyLogEvent {
	logId: string;
	direction: CapitalMoneyDirection;
	amount: Money;
	amountRaw: string;
	counterpartyTornId: number | null;
	message: string | null;
	/** Torn trade id when the transfer happened through a trade. */
	tradeId: string | null;
	timestamp: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	return null;
}

function readNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/**
 * Parses a `4800` (money send) or `4810` (money receive) personal log.
 *
 * The log manager stores structured API payloads, but some historical rows are
 * double-encoded JSON strings; both shapes are accepted. A money log with no
 * numeric amount is ignored rather than booked as zero.
 */
export function readCapitalMoneyLog(
	row: CapitalStockLogRow,
): CapitalMoneyLogEvent | null {
	if (
		row.log !== 4800 &&
		row.log !== 4810 &&
		row.log !== 4440 &&
		row.log !== 4441
	) {
		return null;
	}
	const outer = asRecord(row.data);
	if (!outer) return null;
	const inner = asRecord(outer.data) ?? outer;

	const moneyRaw = inner.money ?? outer.money;
	const moneyString =
		typeof moneyRaw === "number"
			? moneyRaw.toFixed(0)
			: typeof moneyRaw === "string"
				? moneyRaw
				: null;
	if (!moneyString) return null;
	const amount = parseMoney(moneyString);
	if (amount <= 0n) return null;

	const isTrade = row.log === 4440 || row.log === 4441;
	const direction: CapitalMoneyDirection =
		row.log === 4800 || row.log === 4440 ? "send" : "receive";
	const counterparty =
		readNumber(
			isTrade
				? (inner.user ?? outer.user)
				: direction === "send"
					? (inner.receiver ?? outer.receiver)
					: (inner.sender ?? outer.sender),
		) ?? null;
	const tradeId = isTrade
		? (readNumber(inner.parsed_trade_id ?? outer.parsed_trade_id)?.toString() ??
			null)
		: null;
	const message = readString(inner.message ?? outer.message) ?? null;

	return {
		logId: row.id,
		direction,
		amount,
		amountRaw: moneyString,
		counterpartyTornId:
			counterparty !== null && Number.isInteger(counterparty)
				? counterparty
				: null,
		message,
		tradeId,
		timestamp: row.timestamp,
	};
}

export interface CapitalCompletedTrade {
	logId: string;
	tradeId: string;
	counterpartyTornId: number | null;
	timestamp: number;
}

/**
 * Reads a completed trade (`4430`).
 *
 * Torn's completed-trade log does not repeat the money amount, so the payment
 * worker pairs it with the matching `4440`/`4441` money-add logs for the same
 * trade id. The completed log is the authoritative trigger: a money add that
 * was later cancelled never reaches this point.
 */
export function readCapitalTradeCompleted(
	row: CapitalStockLogRow,
): CapitalCompletedTrade | null {
	if (row.log !== 4430) return null;
	const outer = asRecord(row.data);
	if (!outer) return null;
	const inner = asRecord(outer.data) ?? outer;
	const tradeId = readNumber(inner.parsed_trade_id ?? outer.parsed_trade_id);
	if (tradeId === null || !Number.isInteger(tradeId)) return null;
	return {
		logId: row.id,
		tradeId: tradeId.toString(),
		counterpartyTornId: readNumber(inner.user ?? outer.user) ?? null,
		timestamp: row.timestamp,
	};
}

export function extractReferenceCode(
	message: string | null,
	prefixes: readonly string[] = ["DEP", "PAY", "WDR"],
): string | null {
	if (!message) return null;
	for (const prefix of prefixes) {
		const match = message.match(
			new RegExp(`\\b(${prefix}-[A-Z0-9]{4,12})\\b`, "i"),
		);
		if (match?.[1]) return match[1].toUpperCase();
	}
	return null;
}

/** Short, human-copyable reference code for a transfer message. */
export function makeReferenceCode(prefix: string): string {
	const body = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
	return `${prefix.toUpperCase()}-${body}`;
}

export interface CapitalMatchablePaymentIntent {
	id: string;
	kind: string;
	status: string;
	counterpartyTornId: number | null;
	expectedAmount: string;
	tolerancePct: number;
	referenceCode: string;
	expiresAt: Date;
}

export interface CapitalPaymentMatch {
	intent: CapitalMatchablePaymentIntent;
	matchType: "reference" | "counterparty";
}

function amountWithinTolerance(
	expected: Money,
	actual: Money,
	tolerancePct: number,
): boolean {
	if (expected === actual) return true;
	if (expected <= 0n) return false;
	const difference = actual > expected ? actual - expected : expected - actual;
	const tolerance =
		(expected * BigInt(Math.max(0, Math.round(tolerancePct * 100)))) / 10_000n;
	return difference <= tolerance;
}

/**
 * Matches a money log to an open intent.
 *
 * The caller is responsible for filtering to the right book and to intents
 * whose kind matches the direction: receive→deposit, send→payout/withdrawal.
 * Reference-code matches beat amount matches, so two same-amount deposits from
 * the same investor can still be distinguished.
 */
export function matchPaymentIntent(
	log: CapitalMoneyLogEvent,
	intents: CapitalMatchablePaymentIntent[],
	now: Date = new Date(),
): CapitalPaymentMatch | null {
	const candidates = intents.filter((intent) => {
		if (intent.status !== "pending") return false;
		if (intent.expiresAt.getTime() < now.getTime()) return false;
		if (
			intent.counterpartyTornId !== null &&
			log.counterpartyTornId !== null &&
			intent.counterpartyTornId !== log.counterpartyTornId
		) {
			return false;
		}
		return true;
	});
	if (candidates.length === 0) return null;

	const logCode = extractReferenceCode(log.message);
	if (logCode) {
		const byCode = candidates.find(
			(intent) => intent.referenceCode.toUpperCase() === logCode,
		);
		if (byCode) return { intent: byCode, matchType: "reference" };
	}

	const byCounterparty = candidates
		.filter(
			(intent) =>
				intent.counterpartyTornId !== null &&
				intent.counterpartyTornId === log.counterpartyTornId &&
				amountWithinTolerance(
					parseMoney(intent.expectedAmount),
					log.amount,
					intent.tolerancePct,
				),
		)
		.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());

	const first = byCounterparty[0];
	return first ? { intent: first, matchType: "counterparty" } : null;
}

/** A compact summary for Discord/dashboard copy. */
export function describeMoneyLog(log: CapitalMoneyLogEvent): string {
	const direction = log.direction === "send" ? "sent" : "received";
	return `${direction} ${formatMoney(log.amount)} ${
		log.counterpartyTornId ? `with Torn #${log.counterpartyTornId}` : ""
	}`.trim();
}
