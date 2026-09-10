import {
	db,
	elimsApiKeys,
	elimsTeamPlayers,
	elimsTeams,
	eq,
} from "@sentinel/database";
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
					cat: "popular",
				},
				apiKey: candidate.apiKey,
				userId: candidate.userId,
			})) as {
				profile?: { id?: number; name?: string; faction_id?: number };
				name?: string;
				score?: number;
				team?: string;
				attacks?: number;
				competition?: {
					name?: string;
					score?: number;
					team?: string;
					attacks?: number;
				};
				personalstats?: {
					networth?: { total?: number } | number;
					attacking?: {
						attacks?: {
							won?: number;
							lost?: number;
							stalemate?: number;
							assist?: number;
						};
					};
					attackswon?: number;
					attackslost?: number;
				};
			};

			const tornId = res?.profile?.id;
			const tornName = res?.profile?.name;

			if (!tornId || !tornName) {
				continue;
			}

			const rawComp =
				res.competition ?? (typeof res.score === "number" ? res : undefined);
			let competition: UserCompetitionElimination | null = null;
			if (
				rawComp &&
				(typeof rawComp.score === "number" ||
					typeof rawComp.attacks === "number")
			) {
				competition = {
					name: rawComp.name ?? "Elimination",
					score: rawComp.score ?? 0,
					team: rawComp.team ?? "Unknown",
					attacks: rawComp.attacks ?? 0,
				};
			}

			// If competition stats not present in main payload, query /user/{id}/competition directly
			if (!competition && tornId) {
				try {
					const compRes = (await tornApi.get("/user/{id}/competition", {
						pathParams: { id: tornId },
						apiKey: candidate.apiKey,
						userId: candidate.userId,
					})) as {
						competition?: {
							name?: string;
							score?: number;
							team?: string;
							attacks?: number;
						};
					};

					if (compRes?.competition) {
						competition = {
							name: compRes.competition.name ?? "Elimination",
							score: compRes.competition.score ?? 0,
							team: compRes.competition.team ?? "Unknown",
							attacks: compRes.competition.attacks ?? 0,
						};
					}
				} catch {
					// Fallback silently if user is not in an active competition
				}
			}

			// Fallback to local DB elimsTeamPlayers if API returned null
			if (!competition && tornId) {
				const dbPlayer = await db.query.elimsTeamPlayers.findFirst({
					where: eq(elimsTeamPlayers.id, tornId),
				});
				if (dbPlayer) {
					const dbTeam = await db.query.elimsTeams.findFirst({
						where: eq(elimsTeams.id, dbPlayer.teamId),
					});
					competition = {
						name: "Elimination",
						score: dbPlayer.score,
						team: dbTeam?.name ?? `Team ${dbPlayer.teamId}`,
						attacks: dbPlayer.attacks,
					};
				}
			}

			let networth: number | null = null;
			let attacksWon: number | null = null;

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

				if (typeof res.personalstats.attackswon === "number") {
					attacksWon = res.personalstats.attackswon;
				} else if (
					typeof res.personalstats.attacking === "object" &&
					res.personalstats.attacking !== null &&
					typeof res.personalstats.attacking.attacks?.won === "number"
				) {
					attacksWon = res.personalstats.attacking.attacks.won;
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
				attacks: competition?.attacks ?? null,
				attacksWon,
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
