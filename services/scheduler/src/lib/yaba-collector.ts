import {
	and,
	db,
	desc,
	eq,
	factionRoleMappings,
	getAllianceGuildId,
	guildConfigs,
	upsertWorkerState,
	verifiedUsers,
	WORKER_STATE_IDS,
	yabaBattleEstimates,
	yabaCollectionRuns,
	yabaFactionDaily,
	yabaFactions,
	yabaMembers,
	yabaPresets,
	yabaRankings,
	yabaStatAnchors,
} from "@sentinel/database";
import type { IpcYabaChartsMessage } from "@sentinel/schemas";
import {
	getActiveAllianceKeyPool,
	getPlayerStats,
	ManagedTornApiClient,
} from "@sentinel/torn-api";
import {
	computeYabaRanking,
	defaultYabaMetrics,
	hashYabaPreset,
	isYabaMetric,
	Logger,
	YABA_WINDOWS,
	type YabaAnchor,
	type YabaBattleEstimate,
	type YabaMemberInput,
	type YabaMetric,
	type YabaWindow,
} from "@sentinel/utils";

import { dispatchToBot } from "./ipc/server";

const logger = new Logger("Scheduler", "YabaCollector");

/** 30 req/min/key leaves headroom under Torn's 50/min ceiling. */
const yabaApi = new ManagedTornApiClient({ maxRequestsPerWindow: 30 });

export const YABA_UI_URL = "https://yaba.blasted-labs.tech";

const POPULAR_STAT_PATHS = {
	xanax: ["drugs", "xanax"],
	activitySeconds: ["other", "activity", "time"],
	rankedWarHits: ["attacking", "faction", "ranked_war_hits"],
	factionRespect: ["attacking", "faction", "respect"],
	attacksWon: ["attacking", "attacks", "won"],
	attacksLost: ["attacking", "attacks", "lost"],
	hitsSuccess: ["attacking", "hits", "success"],
	hitsCritical: ["attacking", "hits", "critical"],
	damageTotal: ["attacking", "damage", "total"],
	revives: ["hospital", "reviving", "revives"],
	reviveSkill: ["hospital", "reviving", "skill"],
	rankedWarWins: ["other", "ranked_war_wins"],
} as const;

type PopularStatKey = keyof typeof POPULAR_STAT_PATHS;

/** Torn's historical stat names. `ranked_war_wins` has no historical name. */
const HISTORICAL_STAT_NAMES: Partial<Record<PopularStatKey, string>> = {
	xanax: "xantaken",
	activitySeconds: "timeplayed",
	rankedWarHits: "rankedwarhits",
	factionRespect: "respectforfaction",
	attacksWon: "attackswon",
	attacksLost: "attackslost",
	hitsSuccess: "attackhits",
	hitsCritical: "attackcriticalhits",
	damageTotal: "attackdamage",
	revives: "revives",
	reviveSkill: "reviveskill",
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function numberAt(root: unknown, path: readonly string[]): number | null {
	let cursor: unknown = root;
	for (const segment of path) {
		const record = asRecord(cursor);
		if (!record) return null;
		cursor = record[segment];
	}
	return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : null;
}

function parsePopularStats(
	payload: unknown,
): Record<PopularStatKey, number | null> {
	const personalstats = asRecord(payload)?.personalstats ?? payload;
	const result = {} as Record<PopularStatKey, number | null>;
	for (const [key, path] of Object.entries(POPULAR_STAT_PATHS)) {
		result[key as PopularStatKey] = numberAt(personalstats, path);
	}
	return result;
}

function parseHistoricalStats(
	payload: unknown,
): Record<PopularStatKey, number | null> {
	const list = Array.isArray(asRecord(payload)?.personalstats)
		? (asRecord(payload)?.personalstats as Array<unknown>)
		: Array.isArray(payload)
			? payload
			: [];
	const values = new Map<string, number>();
	for (const entry of list) {
		const record = asRecord(entry);
		const name = record?.name;
		const value = record?.value;
		if (typeof name === "string" && typeof value === "number") {
			values.set(name, value);
		}
	}
	const result = {} as Record<PopularStatKey, number | null>;
	for (const [key, statName] of Object.entries(HISTORICAL_STAT_NAMES)) {
		result[key as PopularStatKey] = statName
			? (values.get(statName) ?? null)
			: null;
	}
	return result;
}

async function fetchPopularStats(tornId: number) {
	const response = await yabaApi.get("/user/{id}/personalstats", {
		pathParams: { id: tornId },
		queryParams: { cat: "popular" },
		pool: "alliance",
	});
	return parsePopularStats(response);
}

async function fetchHistoricalStats(
	tornId: number,
	at: number,
): Promise<Record<PopularStatKey, number | null>> {
	const statNames = Object.values(HISTORICAL_STAT_NAMES).filter(
		(value): value is string => Boolean(value),
	);
	const merged = {} as Record<PopularStatKey, number | null>;
	// Torn trims after 10 historical stats per call, so chunk explicitly.
	for (let index = 0; index < statNames.length; index += 10) {
		const chunk = statNames.slice(index, index + 10);
		const response = await yabaApi.get("/user/{id}/personalstats", {
			pathParams: { id: tornId },
			queryParams: {
				stat: chunk as never,
				timestamp: Math.floor(at / 1000),
			},
			pool: "alliance",
		});
		const parsed = parseHistoricalStats(response);
		for (const [key, value] of Object.entries(parsed)) {
			if (value !== null) merged[key as PopularStatKey] = value;
		}
	}
	return merged;
}

/** Keeps the tracked faction list in sync with the alliance verification map. */
export async function syncYabaFactions(): Promise<number> {
	const guildId = getAllianceGuildId();
	if (!guildId) {
		throw new Error("Alliance guild is not configured (ALLIANCE_GUILD_ID).");
	}

	const mappings = await db
		.select({
			factionId: factionRoleMappings.factionId,
			name: factionRoleMappings.factionName,
		})
		.from(factionRoleMappings)
		.where(
			and(
				eq(factionRoleMappings.guildId, guildId),
				eq(factionRoleMappings.enabled, true),
			),
		);

	const seenIds: number[] = [];
	for (const mapping of mappings) {
		seenIds.push(mapping.factionId);
		await db
			.insert(yabaFactions)
			.values({
				factionId: mapping.factionId,
				name: mapping.name?.trim() || `Faction ${mapping.factionId}`,
				type: "combat",
				source: "verification",
				enabled: true,
			})
			.onConflictDoUpdate({
				target: yabaFactions.factionId,
				set: {
					// Admin overrides to type/enabled are never overwritten.
					name: mapping.name?.trim() || `Faction ${mapping.factionId}`,
					updatedAt: new Date(),
				},
			});
	}

	const verificationIds = mappings.map((mapping) => mapping.factionId);
	if (verificationIds.length > 0) {
		await db
			.update(yabaFactions)
			.set({ enabled: false, updatedAt: new Date() })
			.where(
				and(
					eq(yabaFactions.source, "verification"),
					eq(yabaFactions.enabled, true),
				),
			);
		// Re-enable the ids still present in the map. One statement per id keeps
		// admin overrides on manual rows untouched.
		for (const factionId of verificationIds) {
			await db
				.update(yabaFactions)
				.set({ enabled: true, updatedAt: new Date() })
				.where(eq(yabaFactions.factionId, factionId));
		}
	}
	return seenIds.length;
}

/** Refreshes the roster from /faction/{id}/basic and /faction/{id}/members. */
export async function refreshYabaRoster(): Promise<{
	factions: number;
	members: number;
}> {
	const factions = await db
		.select()
		.from(yabaFactions)
		.where(eq(yabaFactions.enabled, true));
	let memberCount = 0;

	for (const faction of factions) {
		let leaderId: number | null = null;
		let memberTotal = 0;
		let respect: number | null = null;
		let daysOld: number | null = null;

		try {
			const basic = await yabaApi.get("/faction/{id}/basic", {
				pathParams: { id: faction.factionId },
				pool: "alliance",
			});
			const record = asRecord(basic);
			const basicData = asRecord(record?.basic) ?? record;
			const leader = numberAt(basicData, ["leader_id"]);
			leaderId = leader;
			memberTotal = numberAt(basicData, ["members"]) ?? 0;
			respect = numberAt(basicData, ["respect"]);
			daysOld = numberAt(basicData, ["days_old"]);
			await db
				.update(yabaFactions)
				.set({
					leaderId,
					tag: typeof basicData?.tag === "string" ? basicData.tag : null,
					updatedAt: new Date(),
				})
				.where(eq(yabaFactions.factionId, faction.factionId));
		} catch (error) {
			logger.warn(
				`YABA faction ${faction.factionId} basic lookup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		try {
			const membersResponse = await yabaApi.get("/faction/{id}/members", {
				pathParams: { id: faction.factionId },
				pool: "alliance",
			});
			const root = asRecord(membersResponse);
			const members = Array.isArray(root?.members)
				? (root.members as Array<unknown>)
				: [];
			if (members.length > 0) memberTotal = members.length;
			for (const entry of members) {
				const member = asRecord(entry);
				const tornId = member?.id;
				if (typeof tornId !== "number" || !Number.isFinite(tornId)) continue;
				const name =
					typeof member?.name === "string" ? member.name : `Player ${tornId}`;
				const level = typeof member?.level === "number" ? member.level : null;
				const days = numberAt(member, ["days_in_faction"]);
				await db
					.insert(yabaMembers)
					.values({
						tornId,
						factionId: faction.factionId,
						name,
						level,
						daysInFaction: days,
						lastSeenAt: new Date(),
					})
					.onConflictDoUpdate({
						target: yabaMembers.tornId,
						set: {
							factionId: faction.factionId,
							name,
							level,
							daysInFaction: days,
							lastSeenAt: new Date(),
							updatedAt: new Date(),
						},
					});
				memberCount++;
			}
		} catch (error) {
			logger.warn(
				`YABA faction ${faction.factionId} roster lookup failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// Seed from verified users when the roster call was unavailable.
		if (memberTotal === 0) {
			const verified = await db
				.select({ tornId: verifiedUsers.tornId, name: verifiedUsers.tornName })
				.from(verifiedUsers)
				.where(eq(verifiedUsers.factionId, faction.factionId))
				.limit(1000);
			for (const user of verified) {
				await db
					.insert(yabaMembers)
					.values({
						tornId: user.tornId,
						factionId: faction.factionId,
						name: user.name,
					})
					.onConflictDoUpdate({
						target: yabaMembers.tornId,
						set: {
							factionId: faction.factionId,
							name: user.name,
							updatedAt: new Date(),
						},
					});
				memberCount++;
			}
			memberTotal = verified.length;
		}

		const day = new Date();
		day.setUTCHours(0, 0, 0, 0);
		await db
			.insert(yabaFactionDaily)
			.values({
				factionId: faction.factionId,
				day,
				membersCount: memberTotal,
				respect,
				daysOld,
			})
			.onConflictDoUpdate({
				target: [yabaFactionDaily.factionId, yabaFactionDaily.day],
				set: {
					membersCount: memberTotal,
					respect,
					daysOld,
				},
			});
	}

	return { factions: factions.length, members: memberCount };
}

function anchorValues(
	values: Record<PopularStatKey, number | null>,
): Record<string, number | null> {
	return {
		xanax: values.xanax,
		activitySeconds: values.activitySeconds,
		rankedWarHits: values.rankedWarHits,
		revives: values.revives,
		factionRespect: values.factionRespect,
		attacksWon: values.attacksWon,
		attacksLost: values.attacksLost,
		hitsSuccess: values.hitsSuccess,
		hitsCritical: values.hitsCritical,
		damageTotal: values.damageTotal,
		reviveSkill: values.reviveSkill,
		rankedWarWins: values.rankedWarWins,
	};
}

/** Nightly cumulative personal-stat snapshot for every tracked member. */
export async function collectMemberAnchors(): Promise<number> {
	const members = await db
		.select({ tornId: yabaMembers.tornId })
		.from(yabaMembers);
	const now = new Date();
	let stored = 0;
	for (const member of members) {
		try {
			const values = await fetchPopularStats(member.tornId);
			await db
				.insert(yabaStatAnchors)
				.values({
					tornId: member.tornId,
					at: now,
					source: "popular",
					partial: false,
					...anchorValues(values),
				})
				.onConflictDoNothing({
					target: [yabaStatAnchors.tornId, yabaStatAnchors.at],
				});
			stored++;
		} catch (error) {
			logger.warn(
				`YABA personalstats failed for ${member.tornId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return stored;
}

/** One-off backfill of 90/30/7/1-day anchors using historical stat values. */
export async function backfillMemberAnchors(): Promise<number> {
	const members = await db
		.select({ tornId: yabaMembers.tornId })
		.from(yabaMembers);
	const now = Date.now();
	const offsets = [
		{ window: "90d" as const, ms: 90 * 24 * 60 * 60 * 1000 },
		{ window: "30d" as const, ms: 30 * 24 * 60 * 60 * 1000 },
		{ window: "7d" as const, ms: 7 * 24 * 60 * 60 * 1000 },
		{ window: "1d" as const, ms: 24 * 60 * 60 * 1000 },
	];
	let stored = 0;
	for (const member of members) {
		for (const offset of offsets) {
			const at = new Date(now - offset.ms);
			try {
				const values = await fetchHistoricalStats(member.tornId, at.getTime());
				if (Object.values(values).every((value) => value === null)) continue;
				await db
					.insert(yabaStatAnchors)
					.values({
						tornId: member.tornId,
						at,
						source: "historical",
						partial: true,
						...anchorValues(values),
					})
					.onConflictDoNothing({
						target: [yabaStatAnchors.tornId, yabaStatAnchors.at],
					});
				stored++;
			} catch (error) {
				logger.warn(
					`YABA historical stats failed for ${member.tornId} at ${offset.window}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	return stored;
}

/** Refreshes FFScouter battle-score estimates (batched by the shared client). */
export async function refreshBattleEstimates(): Promise<number> {
	const members = await db
		.select({ tornId: yabaMembers.tornId })
		.from(yabaMembers);
	if (members.length === 0) return 0;
	const ids = members.map((member) => member.tornId);
	try {
		const results = await getPlayerStats(ids);
		const now = new Date();
		for (const result of results) {
			const source =
				result.source ?? result.available_estimates?.bss?.source ?? null;
			await db
				.insert(yabaBattleEstimates)
				.values({
					tornId: result.player_id,
					provider: "ffscouter",
					score:
						result.bs_estimate ??
						result.available_estimates?.bss?.bs_estimate ??
						null,
					fairFight: result.fair_fight ?? null,
					source,
					capturedAt: now,
				})
				.onConflictDoUpdate({
					target: [yabaBattleEstimates.tornId, yabaBattleEstimates.provider],
					set: {
						score:
							result.bs_estimate ??
							result.available_estimates?.bss?.bs_estimate ??
							null,
						fairFight: result.fair_fight ?? null,
						source,
						capturedAt: now,
					},
				});
		}
		return results.length;
	} catch (error) {
		logger.warn(
			`YABA battle estimate refresh failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 0;
	}
}

async function resolvePreset(type: "combat" | "revive"): Promise<{
	metrics: YabaMetric[];
	weights: Partial<Record<YabaMetric, number>>;
	hash: string;
}> {
	const [row] = await db
		.select()
		.from(yabaPresets)
		.where(
			and(eq(yabaPresets.isDefault, true), eq(yabaPresets.factionType, type)),
		)
		.limit(1);
	const metrics = row?.metrics.filter(isYabaMetric) ?? [];
	return {
		metrics: metrics.length > 0 ? metrics : defaultYabaMetrics(type),
		weights: row?.weights ?? {},
		hash: row?.hash ?? hashYabaPreset(defaultYabaMetrics(type)),
	};
}

/** Computes and persists every scope/type/window ranking snapshot. */
export async function computeAndStoreRankings(): Promise<{
	snapshots: number;
	latest: {
		factions: Awaited<ReturnType<typeof computeYabaRanking>>["rows"];
		players: Awaited<ReturnType<typeof computeYabaRanking>>["rows"];
	};
}> {
	const [memberRows, anchors, estimates] = await Promise.all([
		db.select().from(yabaMembers),
		db.select().from(yabaStatAnchors),
		db.select().from(yabaBattleEstimates),
	]);
	const factions = await db
		.select()
		.from(yabaFactions)
		.where(eq(yabaFactions.enabled, true));
	const enabledIds = new Set(factions.map((faction) => faction.factionId));
	const members: YabaMemberInput[] = memberRows
		.filter((member) => enabledIds.has(member.factionId))
		.map((member) => ({
			tornId: member.tornId,
			name: member.name,
			factionId: member.factionId,
			level: member.level,
			daysInFaction: member.daysInFaction,
		}));
	const anchorInputs: YabaAnchor[] = anchors.map((anchor) => ({
		tornId: anchor.tornId,
		at: anchor.at.getTime(),
		xanax: anchor.xanax,
		activitySeconds: anchor.activitySeconds,
		rankedWarHits: anchor.rankedWarHits,
		revives: anchor.revives,
		factionRespect: anchor.factionRespect,
		attacksWon: anchor.attacksWon,
		attacksLost: anchor.attacksLost,
		hitsSuccess: anchor.hitsSuccess,
		hitsCritical: anchor.hitsCritical,
		damageTotal: anchor.damageTotal,
		reviveSkill: anchor.reviveSkill,
	}));
	const estimateInputs: YabaBattleEstimate[] = estimates.map((estimate) => ({
		tornId: estimate.tornId,
		score: estimate.score,
		capturedAt: estimate.capturedAt.getTime(),
	}));

	const factionNameById = new Map(
		factions.map((faction) => [faction.factionId, faction.name]),
	);
	const now = Date.now();
	const generatedAt = new Date(now);
	let snapshots = 0;
	let latestFactions: ReturnType<typeof computeYabaRanking>["rows"] = [];
	let latestPlayers: ReturnType<typeof computeYabaRanking>["rows"] = [];

	for (const type of ["combat", "revive"] as const) {
		const preset = await resolvePreset(type);
		const typeMemberIds = new Set(
			members
				.filter(
					(member) =>
						factions.find((faction) => faction.factionId === member.factionId)
							?.type === type,
				)
				.map((member) => member.tornId),
		);
		const typeMembers = members.filter((member) =>
			typeMemberIds.has(member.tornId),
		);
		const metrics =
			preset.metrics.length > 0 ? preset.metrics : defaultYabaMetrics(type);

		for (const window of YABA_WINDOWS as readonly YabaWindow[]) {
			for (const scope of ["faction", "member"] as const) {
				const result = computeYabaRanking({
					scope,
					factionType: type,
					window,
					metrics,
					weights: preset.weights,
					now,
					members: typeMembers,
					anchors: anchorInputs.filter((anchor) =>
						typeMemberIds.has(anchor.tornId),
					),
					estimates: estimateInputs.filter((estimate) =>
						typeMemberIds.has(estimate.tornId),
					),
				});
				const rows = result.rows.map((row) => ({
					...row,
					name:
						scope === "faction" && row.id !== undefined
							? (factionNameById.get(row.id) ?? row.name)
							: row.name,
				}));
				await db.insert(yabaRankings).values({
					scope,
					factionType: type,
					window,
					presetHash: preset.hash,
					generatedAt,
					rows,
					unrankedCount: result.unrankedCount,
				});
				snapshots++;
				if (window === "90d" && type === "combat") {
					if (scope === "faction") latestFactions = rows;
					else latestPlayers = rows;
				}
			}
		}
	}

	return {
		snapshots,
		latest: { factions: latestFactions, players: latestPlayers },
	};
}

/** Latest combat/90d snapshot rows, used by the daily chart worker. */
export async function loadLatestYabaRankings(): Promise<{
	factions: Awaited<ReturnType<typeof computeYabaRanking>>["rows"];
	players: Awaited<ReturnType<typeof computeYabaRanking>>["rows"];
}> {
	const rows = await db
		.select()
		.from(yabaRankings)
		.where(
			and(
				eq(yabaRankings.factionType, "combat"),
				eq(yabaRankings.window, "90d"),
			),
		)
		.orderBy(desc(yabaRankings.generatedAt))
		.limit(2);
	const toRows = (value: unknown) =>
		Array.isArray(value)
			? (value as Awaited<ReturnType<typeof computeYabaRanking>>["rows"])
			: [];
	return {
		factions: toRows(rows.find((row) => row.scope === "faction")?.rows),
		players: toRows(rows.find((row) => row.scope === "member")?.rows),
	};
}

/** Sends the daily top-10 payload to the bot when both channels are configured. */
export async function dispatchYabaCharts(latest: {
	factions: Awaited<ReturnType<typeof computeYabaRanking>>["rows"];
	players: Awaited<ReturnType<typeof computeYabaRanking>>["rows"];
}): Promise<boolean> {
	const guildId = getAllianceGuildId();
	if (!guildId) return false;
	const [config] = await db
		.select()
		.from(guildConfigs)
		.where(eq(guildConfigs.guildId, guildId))
		.limit(1);
	if (!config?.yabaFactionChartChannelId || !config?.yabaPlayerChartChannelId) {
		return false;
	}
	const payload: IpcYabaChartsMessage = {
		action: "yaba_charts",
		data: {
			guildId,
			generatedAt: new Date().toISOString(),
			window: "90d",
			uiUrl: YABA_UI_URL,
			factions: latest.factions.slice(0, 10).map((row) => ({
				rank: row.rank,
				name: row.name,
				score: row.score,
				type: "combat",
			})),
			players: latest.players.slice(0, 10).map((row) => ({
				rank: row.rank,
				name: row.name,
				score: row.score,
				factionName:
					typeof row.factionId === "number"
						? (latest.factions.find((faction) => faction.id === row.factionId)
								?.name ?? null)
						: null,
			})),
		},
	};
	dispatchToBot(payload);
	return true;
}

/** Shared orchestration used by both the nightly worker and manual triggers. */
export async function runYabaCollection(kind: "nightly" | "backfill"): Promise<{
	counters: Record<string, number>;
	keyCount: number;
}> {
	const [run] = await db
		.insert(yabaCollectionRuns)
		.values({ kind, status: "running" })
		.returning({ id: yabaCollectionRuns.id });
	const counters: Record<string, number> = {};
	const keyCount = (await getActiveAllianceKeyPool()).length;
	try {
		counters.factionsSynced = await syncYabaFactions();
		const roster = await refreshYabaRoster();
		counters.factions = roster.factions;
		counters.members = roster.members;

		if (kind === "backfill") {
			counters.historicalAnchors = await backfillMemberAnchors();
		}
		counters.anchors = await collectMemberAnchors();
		counters.estimates = await refreshBattleEstimates();
		const { snapshots, latest } = await computeAndStoreRankings();
		counters.snapshots = snapshots;
		counters.chartsDispatched = (await dispatchYabaCharts(latest)) ? 1 : 0;

		await db
			.update(yabaCollectionRuns)
			.set({
				status: "completed",
				finishedAt: new Date(),
				keyCount,
				counters,
			})
			.where(eq(yabaCollectionRuns.id, run?.id ?? ""));
		await upsertWorkerState({
			workerId: WORKER_STATE_IDS.yabaCollector,
			status: "completed",
			lastRunAt: new Date(),
			details: { counters },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(yabaCollectionRuns)
			.set({
				status: "failed",
				finishedAt: new Date(),
				keyCount,
				error: message,
				counters,
			})
			.where(eq(yabaCollectionRuns.id, run?.id ?? ""));
		await upsertWorkerState({
			workerId: WORKER_STATE_IDS.yabaCollector,
			status: "failed",
			lastError: message,
		});
		throw error;
	}
	return { counters, keyCount };
}

/** True once at least one personal-stat anchor has been collected. */
export async function hasAnyYabaAnchor(): Promise<boolean> {
	const [row] = await db
		.select({ id: yabaStatAnchors.id })
		.from(yabaStatAnchors)
		.limit(1);
	return Boolean(row);
}

/** Oldest/newest anchor times, used for collector status reporting. */
export async function getYabaAnchorRange(): Promise<{
	oldestAt: number | null;
	newestAt: number | null;
}> {
	const [oldest] = await db
		.select({ at: yabaStatAnchors.at })
		.from(yabaStatAnchors)
		.orderBy(yabaStatAnchors.at)
		.limit(1);
	const [newest] = await db
		.select({ at: yabaStatAnchors.at })
		.from(yabaStatAnchors)
		.orderBy(desc(yabaStatAnchors.at))
		.limit(1);
	return {
		oldestAt: oldest?.at.getTime() ?? null,
		newestAt: newest?.at.getTime() ?? null,
	};
}
