import {
	db,
	elimsMemberStats,
	eq,
	inArray,
	sql,
	systemStates,
} from "@sentinel/database";
import {
	type FFScouterTargetResult,
	getElimsKeyPool,
	getPlayerStats,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { requestGuildMembersFromBot } from "../../lib/ipc/listener";
import { getActiveIpcServer } from "../../lib/ipc/server";

const logger = new Logger("Scheduler", "MemberStatsSync");

const ELIMS_CONFIG_ID = "elims:guild_config";

/**
 * Maximum number of in-flight Torn profile lookups. The Torn API allows 50
 * requests per 60s per key, so unbounded parallelism only buys rate-limit
 * pauses; a small pool overlaps the lookups without tripping the limiter.
 */
const TORN_LOOKUP_CONCURRENCY = 4;

/**
 * Rows per multi-row upsert statement, keeping each statement far below
 * PostgreSQL's 65535 bind-parameter ceiling (16 parameters per row).
 */
const UPSERT_CHUNK_SIZE = 250;

/** Consecutive rejected lookups before a member's Torn ID lookup is backed off. */
const LOOKUP_FAILURE_THRESHOLD = 3;

/** How long a backed-off member waits before its lookup is attempted again. */
const LOOKUP_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Torn answers a rate-limited request with an error payload, but rate limiting
 * is transient and must never arm the negative cache.
 */
const RATE_LIMIT_PATTERN = /\b(too many requests|rate limit)\b/i;

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
	prunedCount?: number;
	error?: string;
	message?: string;
}

interface RamCacheEntry {
	discordId: string;
	discordNickname: string | null;
	roles: string[];
	tornId?: number;
	tornName?: string;
	tornLevel?: number;
	networth?: number | null;
	profile?: Record<string, unknown>;
}

interface TornUserResponse {
	player_id?: number;
	name?: string;
	level?: number;
	profile?: { id?: number; name?: string; level?: number };
	personalstats?: { networth?: number | { total?: number } };
	error?: { code: number; error: string };
}

/**
 * `resolved` means a Torn player id was obtained, `rejected` means Torn
 * definitively answered without a usable player, and `unavailable` means the
 * request itself failed (transport error, timeout, rate limit) and therefore
 * says nothing about whether the member can ever resolve.
 */
type TornLookupOutcome = "resolved" | "rejected" | "unavailable";

interface LookupBackoffState {
	failures: number;
	retryAt: number;
}

/**
 * Negative cache for Torn ID lookups that Torn definitively rejected.
 *
 * Without it, the completeness predicate re-selects every member whose
 * `ffScouterStats`/`bsEstimate` is null on every single cycle and re-issues a
 * request that can never succeed — forever, with no memory of the failure.
 *
 * This only ever suppresses the outbound request, never the member: a
 * backed-off member is still processed, still merged and still persisted
 * exactly as if its lookup had failed once more, so which members count as
 * complete is unchanged. An entry is dropped as soon as a lookup succeeds, a
 * `forceRefresh` run bypasses the backoff entirely, and the window expires on
 * its own, so no member is permanently hidden.
 */
const lookupBackoff = new Map<string, LookupBackoffState>();

function lookupBackoffKey(guildId: string, discordId: string): string {
	return `${guildId}:${discordId}`;
}

function isLookupBackedOff(key: string): boolean {
	const state = lookupBackoff.get(key);
	if (!state || state.retryAt === 0) return false;
	if (Date.now() >= state.retryAt) {
		// Window elapsed: forget the history so the member gets a fresh set of
		// attempts (and a fresh warning) on this cycle.
		lookupBackoff.delete(key);
		return false;
	}
	return true;
}

function recordLookupRejection(key: string, discordId: string): void {
	const failures = (lookupBackoff.get(key)?.failures ?? 0) + 1;
	if (failures < LOOKUP_FAILURE_THRESHOLD) {
		lookupBackoff.set(key, { failures, retryAt: 0 });
		logger.debug(
			`Torn ID lookup rejected for Discord ID ${discordId} (attempt ${failures}/${LOOKUP_FAILURE_THRESHOLD}).`,
		);
		return;
	}

	lookupBackoff.set(key, {
		failures,
		retryAt: Date.now() + LOOKUP_BACKOFF_MS,
	});
	logger.warn(
		`Torn ID lookup rejected ${failures} time(s) for Discord ID ${discordId}; backing off for ${Math.round(LOOKUP_BACKOFF_MS / 60000)} minute(s). Discord snowflakes are not Torn user ids, so this member cannot resolve while the Discord id is used as the lookup id.`,
	);
}

/**
 * Runs `task(index)` for every index in `[0, count)` with at most `limit`
 * promises in flight. Callers resolve key rotation up front, so the order in
 * which indices are claimed does not affect which key a request uses.
 */
async function runBounded(
	count: number,
	limit: number,
	task: (index: number) => Promise<void>,
): Promise<void> {
	if (count <= 0) return;

	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < count) {
			// The read-and-claim below is synchronous, so no two workers can ever
			// claim the same index and no index is skipped.
			const index = cursor;
			cursor += 1;
			await task(index);
		}
	};

	const workers: Array<Promise<void>> = [];
	for (let w = 0; w < Math.min(limit, count); w++) {
		workers.push(worker());
	}

	const results = await Promise.allSettled(workers);
	for (const result of results) {
		if (result.status === "rejected") {
			throw result.reason;
		}
	}
}

/**
 * Resolves a member's Torn identity through one key from the pool.
 *
 * NOTE: `lookupId` is the Discord snowflake. A Discord snowflake is not a Torn
 * user id, so this only resolves for a guild that happens to use the Torn id as
 * the Discord id — and it is then retried forever by the completeness
 * predicate. A real `discordId -> tornId` mapping does exist (`verified_users`
 * and `elims_verified_users` both key `tornId` by `discordId`), but changing the
 * lookup source is a product decision, so it is deliberately left unchanged
 * here; the negative cache above only bounds the wasted requests.
 */
async function resolveTornIdentity(
	entry: RamCacheEntry,
	apiKey: string | undefined,
): Promise<TornLookupOutcome> {
	try {
		const lookupId = entry.discordId;
		const url = `https://api.torn.com/user/${lookupId}?selections=profile,personalstats&cat=networth&key=${apiKey}&comment=Sentinel`;
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		const data = (await res.json()) as TornUserResponse | null;

		if (!data) return "rejected";

		if (data.error) {
			return RATE_LIMIT_PATTERN.test(data.error.error)
				? "unavailable"
				: "rejected";
		}

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

		return playerId ? "resolved" : "rejected";
	} catch (err) {
		logger.debug(
			`Torn profile/networth lookup failed for Discord ID ${entry.discordId}:`,
			err,
		);
		return "unavailable";
	}
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

	// 3. Query existing members in DB.
	//
	// Project only the columns this sync actually reads: `ff_scouter_stats` is
	// consumed solely as a null check, so let Postgres answer that instead of
	// shipping the whole jsonb payload (distribution + spies) per member every
	// cycle. `torn_profile` does have to come back in full because it is merged
	// forward into the upsert below.
	const existingRecords = await db
		.select({
			id: elimsMemberStats.id,
			discordId: elimsMemberStats.discordId,
			discordNickname: elimsMemberStats.discordNickname,
			tornId: elimsMemberStats.tornId,
			tornName: elimsMemberStats.tornName,
			tornLevel: elimsMemberStats.tornLevel,
			tornProfile: elimsMemberStats.tornProfile,
			networth: elimsMemberStats.networth,
			bsEstimate: elimsMemberStats.bsEstimate,
			ffScouterStatsMissing:
				sql<boolean>`${elimsMemberStats.ffScouterStats} is null`.as(
					"ff_scouter_stats_missing",
				),
		})
		.from(elimsMemberStats)
		.where(eq(elimsMemberStats.guildId, targetGuildId));

	const existingMap = new Map<string, (typeof existingRecords)[number]>();
	for (const r of existingRecords) {
		existingMap.set(r.discordId, r);
	}

	// Auto-prune members who no longer possess the target role or left the server
	let prunedCount = 0;
	if (targetRole) {
		const currentRoleDiscordIds = new Set(
			filteredMembers.map((m) => m.discordId),
		);
		const toPrune = existingRecords.filter(
			(r) => !currentRoleDiscordIds.has(r.discordId),
		);
		if (toPrune.length > 0) {
			logger.info(
				`Auto-pruning ${toPrune.length} member(s) who no longer hold target role ${targetRole}...`,
			);
			// One statement for the whole prune set instead of one DELETE per row.
			await db.delete(elimsMemberStats).where(
				inArray(
					elimsMemberStats.id,
					toPrune.map((p) => p.id),
				),
			);
			for (const p of toPrune) {
				existingMap.delete(p.discordId);
			}
			prunedCount = toPrune.length;
		}
	}

	// Determine which members need processing:
	// - New members not in DB
	// - Existing members with missing stats (ffScouterStats is null or bsEstimate is null)
	// - All members if forceRefresh is requested
	const membersToProcess = filteredMembers.filter((m) => {
		if (options.forceRefresh) return true;
		const existing = existingMap.get(m.discordId);
		if (!existing) return true;
		return (
			existing.ffScouterStatsMissing === true || existing.bsEstimate === null
		);
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
			prunedCount,
			message:
				prunedCount > 0
					? `Pruned ${prunedCount} member(s) who no longer hold the role. Remaining members are up to date.`
					: "All members already synchronized with full stats.",
		};
	}

	logger.info(
		`Processing ${membersToProcess.length} member(s) for stats resolution (out of ${filteredMembers.length} in role)...`,
	);

	// 4. Build the per-member RAM entries, then resolve Torn identity for those
	// that still lack a Torn ID using the key pool (bounded concurrency).
	const entries: RamCacheEntry[] = membersToProcess.map((member) => {
		const existing = existingMap.get(member.discordId);
		return {
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
	});

	const keyPool = await getElimsKeyPool(targetGuildId);
	let keyIndex = 0;
	let backedOffCount = 0;

	// Key rotation stays a sequential pre-pass so each lookup uses exactly the
	// same key the previous sequential loop would have picked, regardless of how
	// many lookups end up in flight.
	const lookups: Array<{
		entry: RamCacheEntry;
		apiKey: string | undefined;
		backoffKey: string;
	}> = [];

	for (const entry of entries) {
		if (entry.tornId || keyPool.length === 0) continue;

		const activeKey = keyPool[keyIndex % keyPool.length];
		keyIndex++;

		const backoffKey = lookupBackoffKey(targetGuildId, entry.discordId);
		if (options.forceRefresh !== true && isLookupBackedOff(backoffKey)) {
			backedOffCount++;
			continue;
		}

		lookups.push({ entry, apiKey: activeKey?.apiKey, backoffKey });
	}

	if (backedOffCount > 0) {
		logger.info(
			`Skipping Torn ID lookup for ${backedOffCount} member(s) rejected ${LOOKUP_FAILURE_THRESHOLD}+ time(s); backoff still active.`,
		);
	}

	if (lookups.length > 0) {
		logger.info(
			`Resolving Torn identity for ${lookups.length} member(s) with up to ${TORN_LOOKUP_CONCURRENCY} concurrent request(s)...`,
		);
		await runBounded(lookups.length, TORN_LOOKUP_CONCURRENCY, async (index) => {
			const job = lookups[index];
			if (!job) return;

			const outcome = await resolveTornIdentity(job.entry, job.apiKey);
			if (outcome === "resolved") {
				lookupBackoff.delete(job.backoffKey);
				return;
			}
			if (outcome === "rejected") {
				recordLookupRejection(job.backoffKey, job.entry.discordId);
			}
		});
	}

	// Temporary RAM cache, rebuilt in member order so downstream behaviour is
	// independent of the order in which the concurrent lookups completed.
	const ramCache = new Map<string, RamCacheEntry>();
	for (const entry of entries) {
		ramCache.set(entry.discordId, entry);
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
			const ffResults = await getPlayerStats(resolvedTornIds);
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

	// 7. Merge all data into a single DB record per member and persist in bulk
	const now = new Date();
	let resolvedCount = 0;
	let ffHits = 0;

	const rows: Array<typeof elimsMemberStats.$inferInsert> = [];

	for (const [discordId, entry] of ramCache.entries()) {
		const tornId = entry.tornId ?? null;
		const ffStat = tornId ? ffMap.get(tornId) : null;

		if (tornId) resolvedCount++;
		if (ffStat) ffHits++;

		const source = ffStat?.source ?? (tornId ? "none" : "unlinked");

		rows.push({
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
		});
	}

	// Bulk upsert in chunks: the update set of the previous per-row upsert is
	// expressed against `excluded`, which is identical for every chunked row.
	// `discord_username`, `created_at` and `id` stay out of the update set so
	// conflicts preserve them, exactly as the per-row upsert did.
	for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK_SIZE) {
		const chunk = rows.slice(offset, offset + UPSERT_CHUNK_SIZE);
		await db
			.insert(elimsMemberStats)
			.values(chunk)
			.onConflictDoUpdate({
				target: elimsMemberStats.discordId,
				set: {
					guildId: sql`excluded.guild_id`,
					discordNickname: sql`excluded.discord_nickname`,
					roles: sql`excluded.roles`,
					tornId: sql`excluded.torn_id`,
					tornName: sql`excluded.torn_name`,
					tornLevel: sql`excluded.torn_level`,
					tornProfile: sql`excluded.torn_profile`,
					ffScouterStats: sql`excluded.ff_scouter_stats`,
					bsEstimate: sql`excluded.bs_estimate`,
					bsEstimateHuman: sql`excluded.bs_estimate_human`,
					fairFight: sql`excluded.fair_fight`,
					networth: sql`excluded.networth`,
					source: sql`excluded.source`,
					lastFetchedAt: sql`excluded.last_fetched_at`,
					updatedAt: sql`excluded.updated_at`,
				},
			});
	}

	return {
		total: filteredMembers.length,
		newProcessed: membersToProcess.length,
		resolved: resolvedCount,
		ffScouterHits: ffHits,
		prunedCount,
		error: ffScouterError,
		message: ffScouterError
			? `Processed ${membersToProcess.length} member(s), but FFScouter error: ${ffScouterError}`
			: `Successfully synced ${membersToProcess.length} member(s) with ${ffHits} stat estimate(s).`,
	};
}
