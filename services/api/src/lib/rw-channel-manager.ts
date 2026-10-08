import { db, eq, subversiveRwChannelConfigs } from "@sentinel/database";
import {
	DEFAULT_SUBVERSIVE_RW_CHANNEL_CONFIG,
	type SubversiveRwChannelConfig,
} from "@sentinel/schemas";
import {
	Logger,
	resolveSubversiveFactionId,
	SUBVERSIVE_FAMILY_FACTION_IDS,
} from "@sentinel/utils";

const logger = new Logger("API", "SubversiveRwChannelManager");

/**
 * Raised when a patch would point two ranked-war displays at the same Discord
 * channel.
 *
 * A distinct type so the HTTP layer can answer 400 for this client mistake
 * without also swallowing genuine database failures as if they were the admin's
 * fault.
 */
export class RwChannelConflictError extends Error {
	constructor() {
		super("Ranked-war displays must each use a different channel.");
		this.name = "RwChannelConflictError";
	}
}

/**
 * Reads and writes the Discord channel selections used by the ranked-war
 * tooling, one row per family faction in `subversive_rw_channel_configs`.
 */
class SubversiveRwChannelManager {
	/** Per-faction cache keyed by resolved faction id. */
	private configs = new Map<number, SubversiveRwChannelConfig>();

	/** Seeds every family faction with the defaults (or a shared override). */
	setConfigForTesting(config?: Partial<SubversiveRwChannelConfig>): void {
		this.configs.clear();
		for (const factionId of SUBVERSIVE_FAMILY_FACTION_IDS) {
			this.configs.set(factionId, {
				...DEFAULT_SUBVERSIVE_RW_CHANNEL_CONFIG,
				...config,
			});
		}
	}

	/** Overrides a single family faction's channels (useful for tests). */
	setFactionConfigForTesting(
		factionId: number,
		config?: Partial<SubversiveRwChannelConfig>,
	): void {
		const resolved = resolveSubversiveFactionId(factionId);
		this.configs.set(resolved, {
			...DEFAULT_SUBVERSIVE_RW_CHANNEL_CONFIG,
			...config,
		});
	}

	/**
	 * Returns the cached configuration synchronously, so hot paths never block
	 * on database IO. Always returns a value.
	 */
	getCachedConfig(factionId?: number | null): SubversiveRwChannelConfig {
		const resolved = resolveSubversiveFactionId(factionId);
		return (
			this.configs.get(resolved) ?? { ...DEFAULT_SUBVERSIVE_RW_CHANNEL_CONFIG }
		);
	}

	/** Maps one table row onto the config shape shared with the HTTP layer. */
	private static toConfig(
		row: typeof subversiveRwChannelConfigs.$inferSelect,
	): SubversiveRwChannelConfig {
		return {
			primaryDisplaysChannelId: row.primaryDisplaysChannelId,
			secondaryDisplaysChannelId: row.secondaryDisplaysChannelId,
			friendlyDisplaysChannelId: row.friendlyDisplaysChannelId,
			updatedAt: row.updatedAt.toISOString(),
			updatedBy: row.updatedBy ?? undefined,
		};
	}

	/**
	 * Retrieves the ranked-war channel selections for one family faction,
	 * reading them from the database on first run and caching them thereafter.
	 *
	 * A missing row is not an error: it means the dashboard has never saved
	 * settings for that faction yet, so the factory defaults apply.
	 */
	async getConfig(
		factionId?: number | null,
	): Promise<SubversiveRwChannelConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const cached = this.configs.get(resolved);
		if (cached) return cached;

		let config: SubversiveRwChannelConfig = {
			...DEFAULT_SUBVERSIVE_RW_CHANNEL_CONFIG,
		};
		try {
			const [row] = await db
				.select()
				.from(subversiveRwChannelConfigs)
				.where(eq(subversiveRwChannelConfigs.factionId, resolved));

			if (row) {
				config = SubversiveRwChannelManager.toConfig(row);
			}
		} catch (err) {
			logger.warn(
				`Failed to load ranked-war channels for faction ${resolved}:`,
				err,
			);
		}

		this.configs.set(resolved, config);
		return config;
	}

	/**
	 * Merges a patch into one family faction's ranked-war channels, persisting
	 * the row and refreshing the in-memory cache.
	 *
	 * @throws {RwChannelConflictError} when the patch would point two displays
	 * at the same channel. Each display channel is swept by its own renderer,
	 * which deletes any bot-authored message it does not recognise, so a shared
	 * channel would have one display destroy the other's embeds as strays.
	 */
	async updateConfig(
		patch: Partial<SubversiveRwChannelConfig>,
		updatedBy = "admin",
		factionId?: number | null,
	): Promise<SubversiveRwChannelConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const current = await this.getConfig(resolved);

		// Resolved once and reused by both the insert and the update branch:
		// duplicating this merge per branch is how the two channels drifted
		// apart in the first place.
		const merged = {
			primaryDisplaysChannelId:
				patch.primaryDisplaysChannelId !== undefined
					? patch.primaryDisplaysChannelId
					: current.primaryDisplaysChannelId,
			secondaryDisplaysChannelId:
				patch.secondaryDisplaysChannelId !== undefined
					? patch.secondaryDisplaysChannelId
					: current.secondaryDisplaysChannelId,
			friendlyDisplaysChannelId:
				patch.friendlyDisplaysChannelId !== undefined
					? patch.friendlyDisplaysChannelId
					: current.friendlyDisplaysChannelId,
		};

		// Every display channel is swept by its own renderer, which deletes any
		// bot-authored message it does not recognise as one of its own. Two
		// selections sharing a channel would therefore have one display destroy
		// the other's embeds, so duplicates are rejected rather than merged.
		const selected = [
			merged.primaryDisplaysChannelId,
			merged.secondaryDisplaysChannelId,
			merged.friendlyDisplaysChannelId,
		].filter((channelId): channelId is string => Boolean(channelId));

		if (new Set(selected).size !== selected.length) {
			throw new RwChannelConflictError();
		}

		const [row] = await db
			.insert(subversiveRwChannelConfigs)
			.values({ factionId: resolved, ...merged, updatedBy })
			.onConflictDoUpdate({
				target: subversiveRwChannelConfigs.factionId,
				set: { ...merged, updatedBy, updatedAt: new Date() },
			})
			.returning();

		const updated = row
			? SubversiveRwChannelManager.toConfig(row)
			: { ...current, ...merged, updatedBy };

		this.configs.set(resolved, updated);
		logger.info(
			`Updated Subversive ranked-war channel selections for faction ${resolved}.`,
		);
		return updated;
	}
}

export const subversiveRwChannelManager = new SubversiveRwChannelManager();
