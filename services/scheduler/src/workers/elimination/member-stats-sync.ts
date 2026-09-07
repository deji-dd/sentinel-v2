import { db, elimsMemberStats, eq, systemStates } from "@sentinel/database";
import {
	type FFScouterTargetResult,
	fetchFFScouterStats,
	getElimsKeyPool,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { requestGuildMembersFromBot } from "../../lib/ipc/listener";
import { getActiveIpcServer } from "../../lib/ipc/server";

const logger = new Logger("Scheduler", "MemberStatsSync");

const ELIMS_CONFIG_ID = "elims:guild_config";

export interface SyncMemberStatsOptions {
	guildId?: string;
	roleId?: string;
	forceRefresh?: boolean;
}

export interface SyncMemberStatsResult {
	total: number;
	newProcessed: number;
	resolved: number;
	ffScouterHits: number;
	error?: string;
	message?: string;
}

/**
 * Resolves Discord members for a guild (optionally filtered by role X),
 * resolves their live Torn ID using the API key pool (or reuses existing resolved ID),
 * batches targets to FFScouter using process.env.FF_SCOUTER_KEY,
 * merges all data into a single DB record in `elims_member_stats`,
 * and handles missing stats, new members, and forced refreshes.
 */
export async function syncTeamMemberStats(
	options: SyncMemberStatsOptions = {},
): Promise<SyncMemberStatsResult> {
	let targetGuildId = options.guildId;

	if (!targetGuildId) {
		const [existingConfig] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));
		const data = existingConfig?.data as { guildId?: string } | undefined;
		targetGuildId = data?.guildId;
	}

	if (!targetGuildId) {
		return {
			total: 0,
			newProcessed: 0,
			resolved: 0,
			ffScouterHits: 0,
			error: "No active Elimination guild configured.",
		};
	}

	// 1. Ask Bot for guild members
	const ipcServer = getActiveIpcServer();
	logger.info(
		`Requesting guild members from bot for guild ${targetGuildId}...`,
	);
	const allMembers = await requestGuildMembersFromBot(
		ipcServer,
		targetGuildId,
		{ timeoutMs: 15000 },
	);

	if (!allMembers || allMembers.length === 0) {
		return {
			total: 0,
			newProcessed: 0,
			resolved: 0,
			ffScouterHits: 0,
			error:
				"Could not fetch guild members from Discord bot. Ensure the bot is running and in the server.",
		};
	}

	// 2. Filter by role X if specified
	const targetRole = options.roleId;
	const filteredMembers = targetRole
		? allMembers.filter((m) => m.currentRoleIds.includes(targetRole))
		: allMembers;

	logger.info(
		`Found ${filteredMembers.length} member(s) matching role filter (out of ${allMembers.length} total members).`,
	);

	// 3. Query existing members in DB
	const existingRecords = await db
		.select()
		.from(elimsMemberStats)
		.where(eq(elimsMemberStats.guildId, targetGuildId));

	const existingMap = new Map<string, (typeof existingRecords)[0]>();
	for (const r of existingRecords) {
		existingMap.set(r.discordId, r);
	}

	// Determine which members need processing:
	// - New members not in DB
	// - Existing members with missing stats (ffScouterStats is null or bsEstimate is null)
	// - All members if forceRefresh is requested
	const membersToProcess = filteredMembers.filter((m) => {
		if (options.forceRefresh) return true;
		const existing = existingMap.get(m.discordId);
		if (!existing) return true;
		return existing.ffScouterStats === null || existing.bsEstimate === null;
	});

	if (membersToProcess.length === 0) {
		logger.info(
			"All members for this role already exist in database with stats. No pending syncs.",
		);
		return {
			total: filteredMembers.length,
			newProcessed: 0,
			resolved: 0,
			ffScouterHits: 0,
			message: "All members already synchronized with full stats.",
		};
	}

	logger.info(
		`Processing ${membersToProcess.length} member(s) for stats resolution (out of ${filteredMembers.length} in role)...`,
	);

	// 4. Resolve Torn profile & networth for members needing resolution using key pool into temporary RAM cache
	const ramCache = new Map<
		string,
		{
			discordId: string;
			discordNickname: string | null;
			roles: string[];
			tornId?: number;
			tornName?: string;
			tornLevel?: number;
			networth?: number | null;
			profile?: Record<string, unknown>;
		}
	>();

	const keyPool = await getElimsKeyPool(targetGuildId);
	let keyIndex = 0;

	for (const member of membersToProcess) {
		const existing = existingMap.get(member.discordId);
		const entry: {
			discordId: string;
			discordNickname: string | null;
			roles: string[];
			tornId?: number;
			tornName?: string;
			tornLevel?: number;
			networth?: number | null;
			profile?: Record<string, unknown>;
		} = {
			discordId: member.discordId,
			discordNickname:
				member.currentNickname ?? existing?.discordNickname ?? null,
			roles: member.currentRoleIds,
			tornId: existing?.tornId ?? undefined,
			tornName: existing?.tornName ?? undefined,
			tornLevel: existing?.tornLevel ?? undefined,
			networth: existing?.networth ?? undefined,
			profile:
				(existing?.tornProfile as Record<string, unknown> | null) ?? undefined,
		};

		// If Torn ID is not yet resolved, query Torn profile & networth via key pool
		if (!entry.tornId && keyPool.length > 0) {
			const activeKey = keyPool[keyIndex % keyPool.length];
			keyIndex++;

			try {
				const lookupId = member.discordId;
				const url = `https://api.torn.com/user/${lookupId}?selections=profile,personalstats&cat=networth&key=${activeKey?.apiKey}&comment=Sentinel`;
				const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
				const data = (await res.json()) as {
					player_id?: number;
					name?: string;
					level?: number;
					profile?: { id?: number; name?: string; level?: number };
					personalstats?: { networth?: number | { total?: number } };
					error?: { code: number; error: string };
				};

				if (data && !data.error) {
					const playerId = data.player_id ?? data.profile?.id;
					const name = data.name ?? data.profile?.name;
					const level = data.level ?? data.profile?.level;

					if (playerId) {
						entry.tornId = playerId;
						entry.tornName = name;
						entry.tornLevel = level;
						entry.profile = (data.profile ?? data) as unknown as Record<
							string,
							unknown
						>;
					}

					const nw = data.personalstats?.networth;
					if (typeof nw === "number") {
						entry.networth = nw;
					} else if (
						typeof nw === "object" &&
						nw !== null &&
						typeof (nw as { total?: number }).total === "number"
					) {
						entry.networth = (nw as { total?: number }).total;
					}
				}
			} catch (err) {
				logger.debug(
					`Torn profile/networth lookup failed for Discord ID ${member.discordId}:`,
					err,
				);
			}
		}

		ramCache.set(member.discordId, entry);
	}

	// 5. Collect resolved Torn IDs
	const resolvedTornIds: number[] = [];
	for (const entry of ramCache.values()) {
		if (entry.tornId && entry.tornId > 0) {
			resolvedTornIds.push(entry.tornId);
		}
	}

	logger.info(
		`Resolved ${resolvedTornIds.length} Torn player ID(s) from ${membersToProcess.length} member(s).`,
	);

	// 6. Query FFScouter API using ONLY process.env.FF_SCOUTER_KEY
	const ffMap = new Map<number, FFScouterTargetResult>();
	let ffScouterError: string | undefined;

	if (resolvedTornIds.length > 0) {
		try {
			logger.info(
				`Querying FFScouter for ${resolvedTornIds.length} player(s)...`,
			);
			const ffResults = await fetchFFScouterStats(resolvedTornIds);
			for (const r of ffResults) {
				ffMap.set(r.player_id, r);
			}
			logger.info(
				`Received ${ffResults.length} stat estimate(s) from FFScouter.`,
			);
		} catch (err) {
			logger.error("FFScouter stats query failed:", err);
			ffScouterError =
				err instanceof Error ? err.message : "FFScouter query failed.";
		}
	}

	// 7. Merge all data into a single DB record per member and persist
	const now = new Date();
	let resolvedCount = 0;
	let ffHits = 0;

	for (const [discordId, entry] of ramCache.entries()) {
		const tornId = entry.tornId ?? null;
		const ffStat = tornId ? ffMap.get(tornId) : null;

		if (tornId) resolvedCount++;
		if (ffStat) ffHits++;

		const source = ffStat?.source ?? (tornId ? "none" : "unlinked");

		await db
			.insert(elimsMemberStats)
			.values({
				guildId: targetGuildId,
				discordId,
				discordUsername: null,
				discordNickname: entry.discordNickname,
				roles: entry.roles,
				tornId,
				tornName: entry.tornName ?? null,
				tornLevel: entry.tornLevel ?? null,
				tornProfile: entry.profile ?? null,
				ffScouterStats: (ffStat as unknown as Record<string, unknown>) ?? null,
				bsEstimate: ffStat?.bs_estimate ?? null,
				bsEstimateHuman: ffStat?.bs_estimate_human ?? null,
				fairFight: ffStat?.fair_fight ?? null,
				networth: entry.networth ?? null,
				source,
				lastFetchedAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: elimsMemberStats.discordId,
				set: {
					guildId: targetGuildId,
					discordNickname: entry.discordNickname,
					roles: entry.roles,
					tornId,
					tornName: entry.tornName ?? null,
					tornLevel: entry.tornLevel ?? null,
					tornProfile: entry.profile ?? null,
					ffScouterStats:
						(ffStat as unknown as Record<string, unknown>) ?? null,
					bsEstimate: ffStat?.bs_estimate ?? null,
					bsEstimateHuman: ffStat?.bs_estimate_human ?? null,
					fairFight: ffStat?.fair_fight ?? null,
					networth: entry.networth ?? null,
					source,
					lastFetchedAt: now,
					updatedAt: now,
				},
			});
	}

	return {
		total: filteredMembers.length,
		newProcessed: membersToProcess.length,
		resolved: resolvedCount,
		ffScouterHits: ffHits,
		error: ffScouterError,
		message: ffScouterError
			? `Processed ${membersToProcess.length} member(s), but FFScouter error: ${ffScouterError}`
			: `Successfully synced ${membersToProcess.length} member(s) with ${ffHits} stat estimate(s).`,
	};
}
