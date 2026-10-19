import { db, eq, subversiveChainConfigs } from "@sentinel/database";
import {
	DEFAULT_SUBVERSIVE_CHAIN_CONFIG,
	MAX_SUBVERSIVE_CHAIN_START,
	MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS,
	MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS,
	MIN_SUBVERSIVE_CHAIN_START,
	MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS,
	type SubversiveChainConfig,
} from "@sentinel/schemas";
import {
	isSubversiveFamilyFaction,
	Logger,
	resolveSubversiveFactionId,
} from "@sentinel/utils";

const logger = new Logger("API", "SubversiveChainConfigManager");

/** Discord snowflake shape, used to reject hand-typed ids. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

const INVALID_FACTION_MESSAGE =
	"Invalid factionId: chain monitoring is only available for the Subversive family factions.";

/**
 * Raised when a patch would store a chain configuration the worker cannot
 * honour — a malformed channel or role id, or a numeric setting outside its
 * supported range.
 *
 * A distinct type so the HTTP layer can answer 400 for these client mistakes
 * without also reporting genuine database failures as bad requests.
 */
export class ChainConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChainConfigError";
	}
}

/** Wire shape accepted by {@link SubversiveChainConfigManager.updateConfig}. */
export interface SubversiveChainConfigPatch {
	enabled?: boolean;
	channelId?: string | null;
	warningRoleId?: string | null;
	minimumChainStart?: number;
	chainTimeWarningSeconds?: number;
	subsequentWarningIntervalSeconds?: number;
}

type SubversiveChainConfigValues = Omit<
	SubversiveChainConfig,
	"updatedAt" | "updatedBy"
>;

/** Validates a whole number inside an inclusive range. */
function normaliseInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) {
		throw new ChainConfigError(`${label} must be a whole number.`);
	}
	if (parsed < minimum || parsed > maximum) {
		throw new ChainConfigError(
			`${label} must be between ${minimum} and ${maximum}.`,
		);
	}
	return parsed;
}

/** Validates and normalises a Discord snowflake, or null when unset. */
function normaliseSnowflake(value: unknown, label: string): string | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string" || !SNOWFLAKE_PATTERN.test(value.trim())) {
		throw new ChainConfigError(`${label} must be a Discord snowflake or null.`);
	}
	return value.trim();
}

/**
 * Reads and writes chain-monitoring settings, one row per family faction in
 * `subversive_chain_configs`.
 *
 * Deliberately uncached: reads happen when an admin opens the settings page, and
 * the scheduler reads the table directly on its own cycle. A process-local cache
 * would only add a staleness window between the two services.
 */
class SubversiveChainConfigManager {
	/** Maps one table row onto the config shape shared with the HTTP layer. */
	private static toConfig(
		row: typeof subversiveChainConfigs.$inferSelect,
	): SubversiveChainConfig {
		return {
			enabled: row.enabled,
			channelId: row.channelId ?? null,
			warningRoleId: row.warningRoleId ?? null,
			minimumChainStart: row.minimumChainStart,
			chainTimeWarningSeconds: row.chainTimeWarningSeconds,
			subsequentWarningIntervalSeconds: row.subsequentWarningIntervalSeconds,
			updatedAt: row.updatedAt.toISOString(),
			updatedBy: row.updatedBy ?? undefined,
		};
	}

	/**
	 * Retrieves one family faction's chain settings.
	 *
	 * A missing row is not an error: it means the dashboard has never saved
	 * settings for that faction, so the factory defaults apply.
	 */
	async getConfig(
		factionId: number | null | undefined,
	): Promise<SubversiveChainConfig> {
		const resolved = resolveSubversiveFactionId(factionId);

		try {
			const [row] = await db
				.select()
				.from(subversiveChainConfigs)
				.where(eq(subversiveChainConfigs.factionId, resolved));

			if (row) return SubversiveChainConfigManager.toConfig(row);
		} catch (err) {
			logger.warn(
				`Failed to load chain configuration for faction ${resolved}:`,
				err,
			);
		}

		return { ...DEFAULT_SUBVERSIVE_CHAIN_CONFIG };
	}

	/**
	 * Merges a patch into one faction's chain settings and persists the row.
	 *
	 * The merged result is validated before any write, so a rejected patch
	 * leaves the stored row untouched.
	 */
	async updateConfig(
		patch: SubversiveChainConfigPatch,
		updatedBy: string,
		factionId: number | null | undefined,
	): Promise<SubversiveChainConfig> {
		if (factionId !== undefined && factionId !== null) {
			if (!isSubversiveFamilyFaction(factionId)) {
				throw new ChainConfigError(INVALID_FACTION_MESSAGE);
			}
		}

		const resolved = resolveSubversiveFactionId(factionId);
		const current = await this.getConfig(resolved);

		const merged: SubversiveChainConfigValues = {
			enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
			channelId:
				patch.channelId !== undefined
					? normaliseSnowflake(patch.channelId, "channelId")
					: current.channelId,
			warningRoleId:
				patch.warningRoleId !== undefined
					? normaliseSnowflake(patch.warningRoleId, "warningRoleId")
					: current.warningRoleId,
			minimumChainStart:
				patch.minimumChainStart !== undefined
					? normaliseInteger(
							patch.minimumChainStart,
							"minimumChainStart",
							MIN_SUBVERSIVE_CHAIN_START,
							MAX_SUBVERSIVE_CHAIN_START,
						)
					: current.minimumChainStart,
			chainTimeWarningSeconds:
				patch.chainTimeWarningSeconds !== undefined
					? normaliseInteger(
							patch.chainTimeWarningSeconds,
							"chainTimeWarningSeconds",
							MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS,
							MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS,
						)
					: current.chainTimeWarningSeconds,
			subsequentWarningIntervalSeconds:
				patch.subsequentWarningIntervalSeconds !== undefined
					? normaliseInteger(
							patch.subsequentWarningIntervalSeconds,
							"subsequentWarningIntervalSeconds",
							0,
							MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS,
						)
					: current.subsequentWarningIntervalSeconds,
		};

		const now = new Date();
		const [row] = await db
			.insert(subversiveChainConfigs)
			.values({
				factionId: resolved,
				...merged,
				updatedBy,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: subversiveChainConfigs.factionId,
				set: {
					...merged,
					updatedBy,
					updatedAt: now,
				},
			})
			.returning();

		logger.info(`Updated chain monitor configuration for faction ${resolved}.`);

		return row
			? SubversiveChainConfigManager.toConfig(row)
			: { ...current, ...merged, updatedBy };
	}
}

export const subversiveChainConfigManager = new SubversiveChainConfigManager();
