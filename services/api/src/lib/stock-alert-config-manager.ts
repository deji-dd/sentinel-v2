import { db, eq, guildStockAlertConfigs } from "@sentinel/database";
import {
	DEFAULT_GUILD_STOCK_ALERT_CONFIG,
	type GuildStockAlertConfig,
	isStockAlertRange,
	MAX_STOCK_ALERT_CHANGE_RULES,
	MAX_STOCK_ALERT_COOLDOWN_MINUTES,
	MAX_STOCK_ALERT_THRESHOLD_PCT,
	MIN_STOCK_ALERT_THRESHOLD_PCT,
	STOCK_ALERT_CHANGE_WINDOW_MINUTES,
	STOCK_ALERT_RANGES,
	type StockAlertChangeRule,
	type StockAlertRange,
} from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";

const logger = new Logger("API", "StockAlertConfigManager");

/** Discord snowflake shape, used to reject hand-typed channel ids. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/**
 * Raised when a patch would store a stock-alert configuration the worker cannot
 * honour — an unknown range, a malformed channel id, a threshold outside the
 * supported range.
 *
 * A distinct type so the HTTP layer can answer 400 for these client mistakes
 * without also reporting genuine database failures as if they were the admin's
 * fault.
 */
export class StockAlertConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StockAlertConfigError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and normalises the notable-move rules.
 *
 * Duplicate windows are rejected rather than silently merged: the cooldown key
 * is the window, so two rules on one window would share a throttle and the
 * stricter of the two would silently win.
 */
function normaliseChangeRules(value: unknown): StockAlertChangeRule[] {
	if (!Array.isArray(value)) {
		throw new StockAlertConfigError("changeRules must be an array.");
	}
	if (value.length > MAX_STOCK_ALERT_CHANGE_RULES) {
		throw new StockAlertConfigError(
			`changeRules supports at most ${MAX_STOCK_ALERT_CHANGE_RULES} rules.`,
		);
	}

	const seenWindows = new Set<number>();
	const rules: StockAlertChangeRule[] = [];

	for (const entry of value) {
		if (!isRecord(entry)) {
			throw new StockAlertConfigError(
				"Each change rule must be an object with windowMinutes and thresholdPct.",
			);
		}

		const windowMinutes = Number(entry.windowMinutes);
		if (
			!STOCK_ALERT_CHANGE_WINDOW_MINUTES.includes(
				windowMinutes as (typeof STOCK_ALERT_CHANGE_WINDOW_MINUTES)[number],
			)
		) {
			throw new StockAlertConfigError(
				`Invalid change window ${String(entry.windowMinutes)}: allowed values are ${STOCK_ALERT_CHANGE_WINDOW_MINUTES.join(", ")} minutes.`,
			);
		}
		if (seenWindows.has(windowMinutes)) {
			throw new StockAlertConfigError(
				`Duplicate change window ${windowMinutes} minutes: keep one rule per window.`,
			);
		}

		const thresholdPct = Number(entry.thresholdPct);
		if (!Number.isFinite(thresholdPct)) {
			throw new StockAlertConfigError(
				"Each change rule needs a numeric thresholdPct.",
			);
		}
		if (
			thresholdPct < MIN_STOCK_ALERT_THRESHOLD_PCT ||
			thresholdPct > MAX_STOCK_ALERT_THRESHOLD_PCT
		) {
			throw new StockAlertConfigError(
				`Change threshold must be between ${MIN_STOCK_ALERT_THRESHOLD_PCT}% and ${MAX_STOCK_ALERT_THRESHOLD_PCT}%.`,
			);
		}

		seenWindows.add(windowMinutes);
		rules.push({ windowMinutes, thresholdPct });
	}

	return rules;
}

/**
 * Validates and normalises the high/low range selection.
 *
 * Order is forced to `STOCK_ALERT_RANGES` rather than preserved from the request:
 * the selection is a set, and a stable order keeps the stored row — and therefore
 * the embed's field list — identical no matter how the dashboard happened to
 * serialise the checkboxes.
 */
function normaliseHighLowRanges(value: unknown): StockAlertRange[] {
	if (!Array.isArray(value)) {
		throw new StockAlertConfigError("highLowRanges must be an array.");
	}

	const selected = new Set<StockAlertRange>();
	for (const entry of value) {
		if (!isStockAlertRange(entry)) {
			throw new StockAlertConfigError(
				`Invalid high/low range ${String(entry)}: allowed values are ${STOCK_ALERT_RANGES.join(", ")}.`,
			);
		}
		selected.add(entry);
	}

	return STOCK_ALERT_RANGES.filter((range) => selected.has(range));
}

/** Validates and normalises the alert channel selection. */
function normaliseChannelId(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string" || !SNOWFLAKE_PATTERN.test(value.trim())) {
		throw new StockAlertConfigError(
			"channelId must be a Discord channel snowflake or null.",
		);
	}
	return value.trim();
}

/** Validates and normalises the per-alert-kind cooldown. */
function normaliseCooldownMinutes(value: unknown): number {
	const minutes = Number(value);
	if (!Number.isInteger(minutes)) {
		throw new StockAlertConfigError("cooldownMinutes must be a whole number.");
	}
	if (minutes < 0 || minutes > MAX_STOCK_ALERT_COOLDOWN_MINUTES) {
		throw new StockAlertConfigError(
			`cooldownMinutes must be between 0 and ${MAX_STOCK_ALERT_COOLDOWN_MINUTES}.`,
		);
	}
	return minutes;
}

/**
 * Wire shape accepted by {@link GuildStockAlertConfigManager.updateConfig}.
 *
 * Looser than {@link GuildStockAlertConfig} on purpose: the HTTP layer forwards
 * whatever the client sent, and every field is validated here before it is merged
 * or written — the types describe the wire format, not a guarantee.
 */
export interface StockAlertConfigPatch {
	enabled?: boolean;
	channelId?: string | null;
	changeRules?: Array<{ windowMinutes: number; thresholdPct: number }>;
	highLowRanges?: string[];
	cooldownMinutes?: number;
}

/**
 * Reads and writes the stock-alert settings used by the `subversive:stock_alerts`
 * scheduler worker, one row per Discord guild in `guild_stock_alert_configs`.
 *
 * Deliberately **uncached**. The previous per-faction version memoised rows in a
 * process-local map with no TTL, so a save made by one API replica left every
 * other replica — and the scheduler's own view — stale until restart. Reads here
 * happen only when an admin opens the page or saves it, so going back to the
 * database every time costs nothing and removes the whole class of staleness.
 */
class GuildStockAlertConfigManager {
	/** Maps one table row onto the config shape shared with the HTTP layer. */
	private static toConfig(
		row: typeof guildStockAlertConfigs.$inferSelect,
	): GuildStockAlertConfig {
		return {
			enabled: row.enabled,
			channelId: row.channelId ?? null,
			changeRules: row.changeRules ?? [],
			highLowRanges: (row.highLowRanges ?? []).filter(isStockAlertRange),
			cooldownMinutes: row.cooldownMinutes,
			updatedAt: row.updatedAt.toISOString(),
			updatedBy: row.updatedBy ?? undefined,
		};
	}

	/**
	 * Retrieves the stock-alert settings for one guild.
	 *
	 * A missing row is not an error: it means the dashboard has never saved
	 * settings for that guild yet, so the factory defaults (disabled) apply.
	 */
	async getConfig(guildId: string): Promise<GuildStockAlertConfig> {
		let config: GuildStockAlertConfig = {
			...DEFAULT_GUILD_STOCK_ALERT_CONFIG,
		};

		try {
			const [row] = await db
				.select()
				.from(guildStockAlertConfigs)
				.where(eq(guildStockAlertConfigs.guildId, guildId));

			if (row) {
				config = GuildStockAlertConfigManager.toConfig(row);
			}
		} catch (err) {
			logger.warn(
				`Failed to load stock alert config for guild ${guildId}:`,
				err,
			);
		}

		return config;
	}

	/**
	 * Merges a patch into one guild's stock-alert settings and persists the row.
	 *
	 * The merged result is validated before any write, so a rejected patch leaves
	 * both the stored row and the worker's view untouched.
	 *
	 * Upserts rather than requiring the row to pre-exist, because a guild that has
	 * never been configured has no row to update — and unlike verification there
	 * is no "guild config must exist first" precondition worth imposing here.
	 *
	 * @throws {StockAlertConfigError} when the merged configuration is not one the
	 * worker can honour.
	 */
	async updateConfig(
		patch: StockAlertConfigPatch,
		updatedBy: string,
		guildId: string,
	): Promise<GuildStockAlertConfig> {
		const current = await this.getConfig(guildId);

		const merged: GuildStockAlertConfig = {
			enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
			channelId:
				patch.channelId !== undefined
					? normaliseChannelId(patch.channelId)
					: current.channelId,
			changeRules:
				patch.changeRules !== undefined
					? normaliseChangeRules(patch.changeRules)
					: current.changeRules,
			highLowRanges:
				patch.highLowRanges !== undefined
					? normaliseHighLowRanges(patch.highLowRanges)
					: current.highLowRanges,
			cooldownMinutes:
				patch.cooldownMinutes !== undefined
					? normaliseCooldownMinutes(patch.cooldownMinutes)
					: current.cooldownMinutes,
		};

		const [row] = await db
			.insert(guildStockAlertConfigs)
			.values({
				guildId,
				enabled: merged.enabled,
				channelId: merged.channelId,
				changeRules: merged.changeRules,
				highLowRanges: merged.highLowRanges,
				cooldownMinutes: merged.cooldownMinutes,
				updatedBy,
			})
			.onConflictDoUpdate({
				target: guildStockAlertConfigs.guildId,
				set: {
					enabled: merged.enabled,
					channelId: merged.channelId,
					changeRules: merged.changeRules,
					highLowRanges: merged.highLowRanges,
					cooldownMinutes: merged.cooldownMinutes,
					updatedBy,
					updatedAt: new Date(),
				},
			})
			.returning();

		const updated = row
			? GuildStockAlertConfigManager.toConfig(row)
			: { ...current, ...merged, updatedBy };

		logger.info(
			`Updated stock alert config for guild ${guildId} (enabled=${updated.enabled}, channel=${updated.channelId ?? "none"}, ranges=${updated.highLowRanges.join("/") || "none"}).`,
		);
		return updated;
	}
}

export const guildStockAlertManager = new GuildStockAlertConfigManager();
