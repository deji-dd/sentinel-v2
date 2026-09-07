import { db, elimsApiKeys, eq } from "@sentinel/database";
import type {
	ResolvedElimsUser,
	UserCompetitionElimination,
} from "@sentinel/schemas";
import {
	getGuildKeyPool,
	getNextGuildKey,
	TornError,
	tornApi,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

const logger = new Logger("Scheduler", "ElimsUserResolver");

/**
 * Resolves a Discord user's live Torn identity, competition stats, and networth
 * using the centralized ManagedTornApiClient key manager with tournament guild keys.
 * Automatically rotates, rate-limits, and fails over across available guild keys.
 */
export async function resolveElimsUser(
	discordId: string,
	guildId: string,
): Promise<ResolvedElimsUser | null> {
	const pool = await getGuildKeyPool(guildId);
	if (pool.length === 0) {
		logger.warn(`No valid guild API keys configured for guild ${guildId}.`);
		return null;
	}

	const maxAttempts = Math.min(pool.length, 3);
	const triedKeys = new Set<string>();

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const candidate = await getNextGuildKey(guildId, triedKeys);
		if (!candidate) break;

		triedKeys.add(candidate.apiKey);

		try {
			const res = (await tornApi.get("/user", {
				queryParams: {
					id: discordId,
					selections: ["profile", "competition", "personalstats"],
					cat: "networth",
				},
				apiKey: candidate.apiKey,
				userId: candidate.userId,
			})) as {
				profile?: { id?: number; name?: string; faction_id?: number };
				name?: string;
				score?: number;
				team?: string;
				attacks?: number;
				personalstats?: {
					networth?: { total?: number } | number;
				};
			};

			const tornId = res?.profile?.id;
			const tornName = res?.profile?.name;

			if (!tornId || !tornName) {
				continue;
			}

			let competition: UserCompetitionElimination | null = null;
			if (typeof res.score === "number") {
				competition = {
					name: res.name ?? "Elimination",
					score: res.score,
					team: res.team ?? "Unknown",
					attacks: res.attacks ?? 0,
				};
			}

			let networth: number | null = null;
			if (res.personalstats) {
				if (typeof res.personalstats.networth === "number") {
					networth = res.personalstats.networth;
				} else if (
					typeof res.personalstats.networth === "object" &&
					res.personalstats.networth !== null &&
					typeof res.personalstats.networth.total === "number"
				) {
					networth = res.personalstats.networth.total;
				}
			}

			// Update lastUsedAt timestamp for the used guild key
			await db
				.update(elimsApiKeys)
				.set({ lastUsedAt: new Date() })
				.where(eq(elimsApiKeys.tornId, candidate.userId))
				.catch(() => {});

			return {
				tornId,
				tornName,
				competition,
				networth,
			};
		} catch (err) {
			logger.warn(
				`Live Torn user lookup failed for ${discordId} with guild key ending in '...${candidate.apiKey.slice(-4)}':`,
				err,
			);

			const isKeyError =
				err instanceof TornError &&
				(err.code === 2 ||
					err.code === 10 ||
					err.code === 13 ||
					err.code === 18);

			if (!isKeyError || attempt === maxAttempts) {
				break;
			}
		}
	}

	return null;
}
