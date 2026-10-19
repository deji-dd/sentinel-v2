import { db, inArray, subversiveChainConfigs } from "@sentinel/database";
import {
	DEFAULT_SUBVERSIVE_CHAIN_CONFIG,
	MAX_SUBVERSIVE_CHAIN_START,
	MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS,
	MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS,
	MIN_SUBVERSIVE_CHAIN_START,
	MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS,
	type SubversiveChainConfig,
} from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";

const logger = new Logger("Scheduler", "ChainConfig");

/** Discord snowflake shape. Anything else is treated as an unrouted selection. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function clampInteger(
	value: number,
	minimum: number,
	maximum: number,
	fallback: number,
): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function normaliseSnowflake(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed || !SNOWFLAKE_PATTERN.test(trimmed)) return null;
	return trimmed;
}

/**
 * Turns a stored row into the same shape the dashboard reads.
 *
 * A hand-edited or legacy row must never be able to crash the worker or make it
 * fire an alert with an impossible threshold, so every numeric field is clamped
 * and malformed channel/role ids are treated as unrouted.
 */
function normaliseRow(
	row: typeof subversiveChainConfigs.$inferSelect,
): SubversiveChainConfig {
	return {
		enabled: row.enabled,
		channelId: normaliseSnowflake(row.channelId),
		warningRoleId: normaliseSnowflake(row.warningRoleId),
		minimumChainStart: clampInteger(
			row.minimumChainStart,
			MIN_SUBVERSIVE_CHAIN_START,
			MAX_SUBVERSIVE_CHAIN_START,
			DEFAULT_SUBVERSIVE_CHAIN_CONFIG.minimumChainStart,
		),
		chainTimeWarningSeconds: clampInteger(
			row.chainTimeWarningSeconds,
			MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS,
			MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS,
			DEFAULT_SUBVERSIVE_CHAIN_CONFIG.chainTimeWarningSeconds,
		),
		subsequentWarningIntervalSeconds: clampInteger(
			row.subsequentWarningIntervalSeconds,
			0,
			MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS,
			DEFAULT_SUBVERSIVE_CHAIN_CONFIG.subsequentWarningIntervalSeconds,
		),
		updatedAt: row.updatedAt.toISOString(),
		updatedBy: row.updatedBy ?? undefined,
	};
}

/**
 * Reads the chain-monitor settings for every requested family faction.
 *
 * One query per scheduler cycle: the table has at most one row per faction, and
 * the cycle's cadence is at slowest 60s. Deliberately uncached so a dashboard
 * save is visible on the very next poll instead of after a process-local TTL.
 *
 * A database failure resolves every faction to the factory defaults. A default
 * config has no channel, which is the safe direction: it stops the worker from
 * polling or alerting until the next successful read.
 */
export async function resolveChainConfigs(
	factionIds: number[],
): Promise<Map<number, SubversiveChainConfig>> {
	const defaults = new Map<number, SubversiveChainConfig>(
		factionIds.map((factionId) => [
			factionId,
			{ ...DEFAULT_SUBVERSIVE_CHAIN_CONFIG },
		]),
	);
	if (factionIds.length === 0) return defaults;

	try {
		const rows = await db
			.select()
			.from(subversiveChainConfigs)
			.where(inArray(subversiveChainConfigs.factionId, factionIds));

		for (const row of rows) {
			defaults.set(row.factionId, normaliseRow(row));
		}
	} catch (err) {
		logger.warn("Failed to resolve chain monitor configurations:", err);
	}

	return defaults;
}
