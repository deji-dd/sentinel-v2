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
	 */
	async updateConfig(
		patch: Partial<SubversiveRwChannelConfig>,
		updatedBy = "admin",
		factionId?: number | null,
	): Promise<SubversiveRwChannelConfig> {
		const resolved = resolveSubversiveFactionId(factionId);
		const current = await this.getConfig(resolved);

		const [row] = await db
			.insert(subversiveRwChannelConfigs)
			.values({
				factionId: resolved,
				primaryDisplaysChannelId:
					patch.primaryDisplaysChannelId !== undefined
						? patch.primaryDisplaysChannelId
						: current.primaryDisplaysChannelId,
				updatedBy,
			})
			.onConflictDoUpdate({
				target: subversiveRwChannelConfigs.factionId,
				set: {
					primaryDisplaysChannelId:
						patch.primaryDisplaysChannelId !== undefined
							? patch.primaryDisplaysChannelId
							: current.primaryDisplaysChannelId,
					updatedBy,
					updatedAt: new Date(),
				},
			})
			.returning();

		const updated = row
			? SubversiveRwChannelManager.toConfig(row)
			: {
					...current,
					primaryDisplaysChannelId:
						patch.primaryDisplaysChannelId ?? current.primaryDisplaysChannelId,
					updatedBy,
				};

		this.configs.set(resolved, updated);
		logger.info(
			`Updated Subversive ranked-war channel selections for faction ${resolved}.`,
		);
		return updated;
	}
}

export const subversiveRwChannelManager = new SubversiveRwChannelManager();
