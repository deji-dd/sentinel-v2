/**
 * Exact decimal arithmetic for Sentinel Capital.
 *
 * PostgreSQL stores money and units as `numeric`, which arrives in TypeScript
 * as a decimal string. Converting those strings to `number` loses cents (and,
 * at fund scale, dollars), so every monetary path parses to a scaled `bigint`
 * first. Two scales are used:
 *
 * - Money: 4 decimal places. Torn prices have 2, fees and NAV splits need more,
 *   and the range (~$920T) is far beyond any plausible fund.
 * - Units: 6 decimal places. Unit balances are ownership fractions, not cash.
 *
 * The scale is part of the value's type contract: a `Money` is always scaled by
 * `MONEY_SCALE`, a `Units` by `UNIT_SCALE`. Mixing them is a bug, and the
 * helpers below are the only intended bridge.
 */

export type Money = bigint;
export type Units = bigint;

/** 4 decimal places. */
export const MONEY_SCALE = 10_000n;
/** 6 decimal places. */
export const UNIT_SCALE = 1_000_000n;

const MONEY_DECIMALS = 4;
const UNIT_DECIMALS = 6;

function pow10(exponent: number): bigint {
	return 10n ** BigInt(exponent);
}

/**
 * Parses a decimal string to a scaled integer, rounding half-up on the last
 * retained digit. Accepts a leading sign, integer-only values and values with
 * fewer fractional digits than the scale. Rejects exponent notation rather than
 * guessing what `1e21` means.
 */
export function parseDecimal(value: string | number, scale: bigint): bigint {
	const raw = typeof value === "number" ? String(value) : value.trim();
	if (!raw) return 0n;

	if (raw.includes("e") || raw.includes("E")) {
		throw new Error(`Unsupported decimal notation: ${raw}`);
	}

	const negative = raw.startsWith("-");
	const unsigned = negative
		? raw.slice(1)
		: raw.startsWith("+")
			? raw.slice(1)
			: raw;
	if (!/^\d*(\.\d*)?$/.test(unsigned) || unsigned === ".") {
		return 0n;
	}

	const [integerPart = "0", fractionPart = ""] = unsigned.split(".");
	const decimals = scale === MONEY_SCALE ? MONEY_DECIMALS : UNIT_DECIMALS;
	const fraction = (fractionPart + "0".repeat(decimals + 1)).slice(
		0,
		decimals + 1,
	);

	let scaled = BigInt(integerPart || "0") * scale;
	const kept = fraction.slice(0, decimals);
	if (kept) scaled += BigInt(kept);

	const next = fraction[decimals];
	if (next && Number.parseInt(next, 10) >= 5) {
		scaled += 1n;
	}

	return negative ? -scaled : scaled;
}

/** Formats a scaled integer as a plain decimal string with no exponent. */
export function formatScaledDecimal(value: bigint, scale: bigint): string {
	const negative = value < 0n;
	const absolute = negative ? -value : value;
	const integer = absolute / scale;
	const fraction = absolute % scale;
	const decimals = scale === MONEY_SCALE ? MONEY_DECIMALS : UNIT_DECIMALS;
	const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
	const body = padded.length > 0 ? `${integer}.${padded}` : integer.toString();
	return negative ? `-${body}` : body;
}

export function parseMoney(value: string | number): Money {
	return parseDecimal(value, MONEY_SCALE);
}

export function formatMoney(value: Money): string {
	return formatScaledDecimal(value, MONEY_SCALE);
}

export function parseUnits(value: string | number): Units {
	return parseDecimal(value, UNIT_SCALE);
}

export function formatUnits(value: Units): string {
	return formatScaledDecimal(value, UNIT_SCALE);
}

/** `toNumber` is for display and rates only; never for ledger arithmetic. */
export function toNumber(value: bigint, scale: bigint): number {
	return Number(value) / Number(scale);
}

export function moneyToNumber(value: Money): number {
	return toNumber(value, MONEY_SCALE);
}

export function unitsToNumber(value: Units): number {
	return toNumber(value, UNIT_SCALE);
}

export function addMoney(...values: Money[]): Money {
	return values.reduce((total, value) => total + value, 0n);
}

export function addUnits(...values: Units[]): Units {
	return values.reduce((total, value) => total + value, 0n);
}

export function absMoney(value: Money): Money {
	return value < 0n ? -value : value;
}

export function maxMoney(a: Money, b: Money): Money {
	return a > b ? a : b;
}

export function minMoney(a: Money, b: Money): Money {
	return a < b ? a : b;
}

/** Integer division with half-up rounding; returns 0 for a zero denominator. */
export function divideRound(numerator: bigint, denominator: bigint): bigint {
	if (denominator === 0n) return 0n;
	const negative = numerator < 0n !== denominator < 0n;
	const absNumerator = numerator < 0n ? -numerator : numerator;
	const absDenominator = denominator < 0n ? -denominator : denominator;
	const quotient = absNumerator / absDenominator;
	const remainder = absNumerator % absDenominator;
	const rounded = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
	return negative ? -rounded : rounded;
}

/** Multiplies a scaled amount by basis points, rounding half-up. */
export function mulBps(amount: bigint, bps: number): bigint {
	if (!Number.isFinite(bps) || bps === 0) return 0n;
	return divideRound(amount * BigInt(Math.trunc(bps)), 10_000n);
}

/**
 * Multiplies a scaled amount by a percentage (e.g. 0.5 for 0.5%). The
 * percentage is converted to basis points with rounding, which is appropriate
 * for the risk/fee settings this fund uses.
 */
export function mulPct(amount: bigint, pct: number): bigint {
	return mulBps(amount, Math.round(pct * 100));
}

/** Notional money for an integer share quantity at a quoted price. */
export function moneyFromPriceShares(
	price: string | number,
	shares: number,
): Money {
	if (!Number.isFinite(shares) || shares <= 0) return 0n;
	return parseMoney(price) * BigInt(Math.trunc(shares));
}

/** Market value of a unit balance at a NAV per unit. */
export function valueOfUnits(navPerUnit: Money, units: Units): Money {
	return divideRound(navPerUnit * units, UNIT_SCALE);
}

/** Units to issue for a cash amount at the given NAV per unit. */
export function unitsForAmount(amount: Money, navPerUnit: Money): Units {
	if (navPerUnit <= 0n) return 0n;
	return divideRound(amount * UNIT_SCALE, navPerUnit);
}

/** Units to redeem for a cash amount at the given NAV per unit. */
export function unitsForRedemption(amount: Money, navPerUnit: Money): Units {
	return unitsForAmount(amount, navPerUnit);
}

/** NAV per unit from total fund value and outstanding units. */
export function navFromValueUnits(totalValue: Money, units: Units): Money {
	if (units <= 0n) return MONEY_SCALE;
	return divideRound(totalValue * UNIT_SCALE, units);
}

/** Clamps a value into `[0, max]`; useful for partial payments. */
export function clampMoney(value: Money, max: Money): Money {
	if (value <= 0n) return 0n;
	if (value > max) return max;
	return value;
}

/** Formats a percentage for Discord/dashboard copy. */
export function formatPct(value: number | null, digits = 2): string {
	if (value === null || !Number.isFinite(value)) return "—";
	return `${value.toFixed(digits)}%`;
}

/** Formats a money string for compact display (used by Discord embeds). */
export function formatCompactMoney(value: Money): string {
	const amount = moneyToNumber(value);
	const abs = Math.abs(amount);
	if (abs >= 1_000_000_000_000)
		return `$${(amount / 1_000_000_000_000).toFixed(2)}T`;
	if (abs >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}B`;
	if (abs >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
	if (abs >= 1_000) return `$${(amount / 1_000).toFixed(2)}K`;
	return `$${amount.toFixed(2)}`;
}
