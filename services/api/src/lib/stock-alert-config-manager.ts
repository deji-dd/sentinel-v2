import { db, eq, subversiveStockAlertConfigs } from "@sentinel/database";
import {
	DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG,
	MAX_STOCK_ALERT_CHANGE_RULES,
	MAX_STOCK_ALERT_COOLDOWN_MINUTES,
	MAX_STOCK_ALERT_THRESHOLD_PCT,
	MIN_STOCK_ALERT_THRESHOLD_PCT,
	STOCK_ALERT_CHANGE_WINDOW_MINUTES,
	STOCK_ALERT_WINDOWS,
	type StockAlertChangeRule,
	type StockAlertWindow,
	type SubversiveStockAlertConfig,
} from "@sentinel/schemas";
import {
	Logger,
	resolveSubversiveFactionId,
	SUBVERSIVE_FAMILY_FACTION_IDS,
} from "@sentinel/utils";

const logger = new Logger("API", "SubversiveStockAlertManager");

/** Discord snowflake shape, used to reject hand-typed channel ids. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/**
 * Raised when a patch would store a stock-alert configuration the worker cannot
 * honour — an unknown change window, a malformed channel id, a threshold outside
 * the supported range.
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

/** Validates and normalises the high/low window selection. */
function normaliseHighLowWindows(value: unknown): StockAlertWindow[] {
	if (!Array.isArray(value)) {
		throw new StockAlertConfigError("highLowWindows must be an array.");
	}

	const windows: StockAlertWindow[] = [];
	for (const entry of value) {
		if (
			typeof entry !== "string" ||
			!STOCK_ALERT_WINDOWS.includes(entry as StockAlertWindow)
		) {
			throw new StockAlertConfigError(
				`Invalid high/low window ${String(entry)}: allowed values are ${STOCK_ALERT_WINDOWS.join(", ")}.`,
			);
		}
		if (!windows.includes(entry as StockAlertWindow)) {
			windows.push(entry as StockAlertWindow);
		}
	}

	return windows;
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
 * Wire shape accepted by {@link SubversiveStockAlertConfigManager.updateConfig}.
 *
 * Looser than {@link SubversiveStockAlertConfig} on purpose: the HTTP layer
 * forwards whatever the client sent, and every field is validated here before it
 * is merged or written — the types describe the wire format, not a guarantee.
 */
export interface StockAlertConfigPatch {
	enabled?: boolean;
	channelId?: string | null;
	changeRules?: Array<{ windowMinutes: number; thresholdPct: number }>;
	highLowWindows?: string[];
	cooldownMinutes?: number;
}

/**
 * Reads and writes the stock-alert settings used by the `subversive:stock_alerts`
 * scheduler worker, one row per family faction in
 * `subversive_stock_alert_configs`.
 */
class SubversiveStockAlertConfigManager {
	/** Per-faction cache keyed by resolved faction id. */
	private configs = new Map<number, SubversiveStockAlertConfig>();

	/** Seeds every family faction with the defaults (or a shared override). */
	setConfigForTesting(config?: Partial<SubversiveStockAlertConfig>): void {
		this.configs.clear();
		for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
			this.configs.set(factionId, {
				...DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG,
				...config,
			});
		}
	}

	/** Overrides a single family faction's settings (useful for tests). */
	setFactionConfigForTesting(
		factionId: number,
		config?: Partial<SubversiveStockAlertConfig>,
	): void {
		const resolved = resolveSubversiveFactionId(factionId);
		this.configs.set(resolved, {
			...DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG,
			...config,
		});
	}

	/** Test seam: drops every memoised configuration. */
	clearCacheForTesting(): void {
		this.configs.clear();
	}

	/**
	 * Returns the cached configuration synchronously, so hot paths never block on
	 * database IO. Always returns a value.
	 */
	getCachedConfig(factionId?: number | null): SubversiveStockAlertConfig {
		const resolved = resolveSubversiveFactionId(factionId);
		return (
			this.configs.get(resolved) ?? {
				...DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG,
			}
		);
	}

	/** Maps one table row onto the config shape shared with the HTTP layer. */
	private static toConfig(
		row: typeof subversiveStockAlertConfigs.$inferSelect,
	): SubversiveStockAlertConfig {
		return {
			enabled: row.enabled,
			channelId: row.channelId ?? null,
			changeRules: row.changeRules ?? [],
			highLowWindows: (row.highLowWindows ?? []) as StockAlertWindow[],
			cooldownMinutes: row.cooldownMinutes,
			updatedAt: row.updatedAt.toISOString(),
			updatedBy: row.updatedBy ?? undefined,
		};
	}

	/**
	 * Retrieves the stock-alert settings for one family faction, reading them from
	 * the database on first run and caching them thereafter.
	 *
	 * A missing row is not an error: it means the dashboard has never saved
	 * settings for that faction yet, so the factory defaults (disabled) apply.
	 */
	async getConfig(
		factionId?: number | null,
	): Promise<SubversiveStockAlertConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const cached = this.configs.get(resolved);
		if (cached) return cached;

		let config: SubversiveStockAlertConfig = {
			...DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG,
		};
		try {
			const [row] = await db
				.select()
				.from(subversiveStockAlertConfigs)
				.where(eq(subversiveStockAlertConfigs.factionId, resolved));

			if (row) {
				config = SubversiveStockAlertConfigManager.toConfig(row);
			}
		} catch (err) {
			logger.warn(
				`Failed to load stock alert config for faction ${resolved}:`,
				err,
			);
		}

		this.configs.set(resolved, config);
		return config;
	}

	/**
	 * Merges a patch into one family faction's stock-alert settings, persisting
	 * the row and refreshing the in-memory cache.
	 *
	 * The merged result is validated before any write, so a rejected patch leaves
	 * both the stored row and the worker's view untouched.
	 *
	 * @throws {StockAlertConfigError} when the merged configuration is not one the
	 * worker can honour.
	 */
	async updateConfig(
		patch: StockAlertConfigPatch,
		updatedBy = "admin",
		factionId?: number | null,
	): Promise<SubversiveStockAlertConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const current = await this.getConfig(resolved);

		const merged: SubversiveStockAlertConfig = {
			enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
			channelId:
				patch.channelId !== undefined
					? normaliseChannelId(patch.channelId)
					: current.channelId,
			changeRules:
				patch.changeRules !== undefined
					? normaliseChangeRules(patch.changeRules)
					: current.changeRules,
			highLowWindows:
				patch.highLowWindows !== undefined
					? normaliseHighLowWindows(patch.highLowWindows)
					: current.highLowWindows,
			cooldownMinutes:
				patch.cooldownMinutes !== undefined
					? normaliseCooldownMinutes(patch.cooldownMinutes)
					: current.cooldownMinutes,
		};

		const [row] = await db
			.insert(subversiveStockAlertConfigs)
			.values({
				factionId: resolved,
				enabled: merged.enabled,
				channelId: merged.channelId,
				changeRules: merged.changeRules,
				highLowWindows: merged.highLowWindows,
				cooldownMinutes: merged.cooldownMinutes,
				updatedBy,
			})
			.onConflictDoUpdate({
				target: subversiveStockAlertConfigs.factionId,
				set: {
					enabled: merged.enabled,
					channelId: merged.channelId,
					changeRules: merged.changeRules,
					highLowWindows: merged.highLowWindows,
					cooldownMinutes: merged.cooldownMinutes,
					updatedBy,
					updatedAt: new Date(),
				},
			})
			.returning();

		const updated = row
			? SubversiveStockAlertConfigManager.toConfig(row)
			: { ...current, ...merged, updatedBy };

		this.configs.set(resolved, updated);
		logger.info(
			`Updated Subversive stock alert config for faction ${resolved} (enabled=${updated.enabled}, channel=${updated.channelId ?? "none"}).`,
		);
		return updated;
	}
}

export const subversiveStockAlertManager =
	new SubversiveStockAlertConfigManager();
