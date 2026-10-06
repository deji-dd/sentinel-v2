import { and, db, eq, tornStocks, userStockAlerts } from "@sentinel/database";
import {
	buildUserStockAlertConditionKey,
	createEmptyUserStockAlertState,
	isStockAlertRange,
	MAX_USER_STOCK_ALERT_PRICE,
	MAX_USER_STOCK_ALERT_THRESHOLD_PCT,
	MAX_USER_STOCK_ALERTS,
	MIN_USER_STOCK_ALERT_PRICE,
	MIN_USER_STOCK_ALERT_THRESHOLD_PCT,
	type StockAlertRange,
	USER_STOCK_ALERT_PRICE_CONDITIONS,
	type UserStockAlertCondition,
	userStockAlertConditionNeedsRange,
	userStockAlertConditionNeedsThreshold,
} from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import { logger } from "./logger";

/**
 * Stock universe and personal-alert persistence for the `/stock-alerts` command.
 *
 * Kept out of the command file so the Torn lookup, the validation rules and the
 * SQL are all reachable from tests without driving a Discord interaction.
 */

/** One row of the `/stock-alerts add` picker. */
export interface StockOption {
	id: number;
	name: string;
	acronym: string;
}

/**
 * How long the in-memory stock list is trusted.
 *
 * The market list changes only when Torn adds or retires a stock, so a long TTL
 * costs nothing and keeps the picker instant; the fallback query is what runs on a
 * cold start.
 */
const STOCK_UNIVERSE_TTL_MS = 10 * 60_000;

let cachedUniverse: { stocks: StockOption[]; expiresAt: number } | null = null;

/** Test seam: forgets the memoised stock universe. */
export function clearStockUniverseCache(): void {
	cachedUniverse = null;
}

/**
 * The Torn stock market, for the picker.
 *
 * `torn_stocks` is the reference table the scheduler refreshes daily, so it is
 * normally the source. It can legitimately be empty — a fresh deployment, or a
 * profile with the reference worker disabled — and an empty picker would make the
 * command unusable, so a live `/torn/stocks` call backs it up. Only when both
 * are unavailable does the caller have to tell the user to try again later.
 */
export async function fetchStockUniverse(): Promise<StockOption[]> {
	if (cachedUniverse && cachedUniverse.expiresAt > Date.now()) {
		return cachedUniverse.stocks;
	}

	let stocks: StockOption[] = [];

	try {
		const rows = await db
			.select({
				id: tornStocks.id,
				name: tornStocks.name,
				acronym: tornStocks.acronym,
			})
			.from(tornStocks)
			.orderBy(tornStocks.id);

		stocks = rows
			.map((row) => ({
				// `torn_stocks.id` is the Torn stock id held as text.
				id: Number(row.id),
				name: row.name,
				acronym: row.acronym,
			}))
			.filter((row) => Number.isInteger(row.id) && row.id > 0);
	} catch (err) {
		logger.warn("Failed to read the Torn stock reference table:", err);
	}

	if (stocks.length === 0) {
		stocks = await fetchStockUniverseFromTorn();
	}

	if (stocks.length > 0) {
		cachedUniverse = { stocks, expiresAt: Date.now() + STOCK_UNIVERSE_TTL_MS };
	}

	return stocks;
}

/** Live `/torn/stocks` lookup used when the reference table has nothing. */
async function fetchStockUniverseFromTorn(): Promise<StockOption[]> {
	const apiKey = process.env.TORN_API_KEY;
	if (!apiKey) {
		logger.warn(
			"The Torn stock reference table is empty and TORN_API_KEY is unset, so the stock picker has no options.",
		);
		return [];
	}

	try {
		const response = await tornApi.get("/torn/stocks", { apiKey });
		return (response.stocks ?? [])
			.map((stock) => ({
				id: stock.id,
				name: stock.name,
				acronym: stock.acronym,
			}))
			.filter((stock) => Number.isInteger(stock.id) && stock.id > 0)
			.sort((a, b) => a.id - b.id);
	} catch (err) {
		logger.warn("Failed to fetch the Torn stock market:", err);
		return [];
	}
}

/** Display name for a stock, e.g. "TSB — Torn & Shanghai Banking". */
export function formatStockOption(option: StockOption): string {
	return `${option.acronym} — ${option.name}`;
}

/** Resolves a chosen stock id against the universe, for the modal title. */
export async function findStockOption(
	stockId: number,
): Promise<StockOption | null> {
	const stocks = await fetchStockUniverse();
	return stocks.find((stock) => stock.id === stockId) ?? null;
}

/** A subscription as the list/remove views need it. */
export interface UserStockAlertView {
	id: string;
	stockId: number;
	condition: UserStockAlertCondition;
	range: StockAlertRange | null;
	threshold: number | null;
	conditionKey: string;
}

/** Maps a table row onto the shape the command renders. */
function toView(row: typeof userStockAlerts.$inferSelect): UserStockAlertView {
	return {
		id: row.id,
		stockId: row.stockId,
		condition: row.condition as UserStockAlertCondition,
		range: isStockAlertRange(row.rangeKey) ? row.rangeKey : null,
		threshold: row.threshold ?? null,
		conditionKey: row.conditionKey,
	};
}

/** Every alert the user owns in this guild, oldest first. */
export async function listUserStockAlerts(
	guildId: string,
	discordUserId: string,
): Promise<UserStockAlertView[]> {
	const rows = await db
		.select()
		.from(userStockAlerts)
		.where(
			and(
				eq(userStockAlerts.discordUserId, discordUserId),
				eq(userStockAlerts.guildId, guildId),
			),
		)
		.orderBy(userStockAlerts.createdAt);

	return rows.map(toView);
}

/** Raised when a requested subscription cannot be stored as asked. */
export class UserStockAlertError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UserStockAlertError";
	}
}

export interface NewUserStockAlert {
	guildId: string;
	discordUserId: string;
	stockId: number;
	condition: UserStockAlertCondition;
	range: StockAlertRange | null;
	threshold: number | null;
}

/**
 * Validates a subscription request against the same limits the worker assumes.
 *
 * Thresholds are bounded rather than merely finite: an unbounded price or
 * percentage is either a typo or an attempt to make an alert that can never be
 * evaluated, and catching it here means the user gets a specific message instead
 * of silence.
 */
export function validateUserStockAlert(input: {
	condition: UserStockAlertCondition;
	range: StockAlertRange | null;
	threshold: number | null;
}): { range: StockAlertRange | null; threshold: number | null } {
	const { condition } = input;
	let { range, threshold } = input;

	if (userStockAlertConditionNeedsRange(condition)) {
		if (!range) {
			throw new UserStockAlertError(
				"This condition needs a range — pick one (1 hour, 24 hours, 7 days, 30 days, 1 year or all time).",
			);
		}
	} else {
		// A price condition has no range; dropping it keeps the uniqueness key
		// canonical instead of storing a meaningless value.
		range = null;
	}

	if (userStockAlertConditionNeedsThreshold(condition)) {
		if (threshold === null || !Number.isFinite(threshold)) {
			throw new UserStockAlertError(
				"This condition needs an amount — enter a value in the Amount field.",
			);
		}

		const isPrice = (
			USER_STOCK_ALERT_PRICE_CONDITIONS as readonly string[]
		).includes(condition);
		if (isPrice) {
			if (
				threshold < MIN_USER_STOCK_ALERT_PRICE ||
				threshold > MAX_USER_STOCK_ALERT_PRICE
			) {
				throw new UserStockAlertError(
					`A price alert must be between $${MIN_USER_STOCK_ALERT_PRICE.toLocaleString("en-US")} and $${MAX_USER_STOCK_ALERT_PRICE.toLocaleString("en-US")}.`,
				);
			}
		} else if (
			threshold < MIN_USER_STOCK_ALERT_THRESHOLD_PCT ||
			threshold > MAX_USER_STOCK_ALERT_THRESHOLD_PCT
		) {
			throw new UserStockAlertError(
				`A percentage alert must be between ${MIN_USER_STOCK_ALERT_THRESHOLD_PCT}% and ${MAX_USER_STOCK_ALERT_THRESHOLD_PCT}%.`,
			);
		}
	} else {
		threshold = null;
	}

	return { range, threshold };
}

/**
 * Creates a subscription, or reports that this exact alert already exists.
 *
 * Uniqueness is enforced by the database rather than by a read-then-write, so two
 * rapid submissions of the same form cannot both succeed.
 */
export async function createUserStockAlert(
	input: NewUserStockAlert,
): Promise<UserStockAlertView> {
	const { range, threshold } = validateUserStockAlert(input);

	const existing = await listUserStockAlerts(
		input.guildId,
		input.discordUserId,
	);
	if (existing.length >= MAX_USER_STOCK_ALERTS) {
		throw new UserStockAlertError(
			`You already have ${MAX_USER_STOCK_ALERTS} stock alerts, which is the maximum. Remove one with \`/stock-alerts remove\` before adding another.`,
		);
	}

	const conditionKey = buildUserStockAlertConditionKey({
		stockId: input.stockId,
		condition: input.condition,
		range,
		threshold,
	});

	const duplicate = existing.some(
		(alert) => alert.conditionKey === conditionKey,
	);
	if (duplicate) {
		throw new UserStockAlertError(
			"You already have that exact alert. Use `/stock-alerts list` to see it.",
		);
	}

	const [row] = await db
		.insert(userStockAlerts)
		.values({
			guildId: input.guildId,
			discordUserId: input.discordUserId,
			stockId: input.stockId,
			condition: input.condition,
			rangeKey: range,
			threshold,
			conditionKey,
			enabled: true,
			state: createEmptyUserStockAlertState(),
		})
		.onConflictDoNothing({
			target: [userStockAlerts.discordUserId, userStockAlerts.conditionKey],
		})
		.returning();

	if (!row) {
		throw new UserStockAlertError(
			"You already have that exact alert. Use `/stock-alerts list` to see it.",
		);
	}

	return toView(row);
}

/**
 * Deletes one of the user's alerts.
 *
 * Scoped by `discordUserId` in the `WHERE` clause as well as by id, so a stale or
 * forged id from another member's menu cannot remove their alert.
 */
export async function deleteUserStockAlert(
	id: string,
	discordUserId: string,
): Promise<boolean> {
	const deleted = await db
		.delete(userStockAlerts)
		.where(
			and(
				eq(userStockAlerts.id, id),
				eq(userStockAlerts.discordUserId, discordUserId),
			),
		)
		.returning({ id: userStockAlerts.id });

	return deleted.length > 0;
}

/** Deletes every alert the user owns in this guild. Returns the number removed. */
export async function deleteAllUserStockAlerts(
	guildId: string,
	discordUserId: string,
): Promise<number> {
	const rows = await listUserStockAlerts(guildId, discordUserId);
	let removed = 0;

	for (const row of rows) {
		if (await deleteUserStockAlert(row.id, discordUserId)) removed++;
	}

	return removed;
}
