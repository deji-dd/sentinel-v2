import {
	and,
	db,
	desc,
	eq,
	getAllianceGuildId,
	guildConfigs,
	yabaCollectionRuns,
	yabaFactionDaily,
	yabaFactions,
	yabaMembers,
	yabaPresets,
	yabaRankings,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import {
	defaultYabaMetrics,
	hashYabaPreset,
	isYabaMetric,
	isYabaWindow,
	YABA_METRIC_LABELS,
	YABA_WINDOWS,
} from "@sentinel/utils";
import { Elysia, t } from "elysia";

import {
	requestSchedulerAction,
	syncYabaChannelsViaIpc,
} from "../../lib/bot-ipc";
import { authPlugin } from "../../middleware/auth";
import { verifyGuildAdmin } from "./guilds";

type RankingRow = {
	id: number;
	name: string;
	factionId: number | null;
	score: number;
	rank: number;
	components: Record<string, number | null>;
	sampleSize: number;
	coverage: number;
	membersCount?: number;
};

async function requireAllianceAdmin(
	user: { role?: string; discordId?: string | null } | null | undefined,
	set: { status?: number | string },
): Promise<string | null> {
	const guildId = getAllianceGuildId();
	if (!guildId) {
		set.status = 400;
		return null;
	}
	if (!(await verifyGuildAdmin(user, guildId))) {
		set.status = 403;
		return null;
	}
	return guildId;
}

async function loadLatestRanking(
	scope: string,
	factionType: string,
	window: string,
): Promise<{
	generatedAt: Date | null;
	rows: RankingRow[];
	unrankedCount: number;
}> {
	const rows = await db
		.select()
		.from(yabaRankings)
		.where(
			and(
				eq(yabaRankings.scope, scope),
				eq(yabaRankings.factionType, factionType),
				eq(yabaRankings.window, window),
			),
		)
		.orderBy(desc(yabaRankings.generatedAt))
		.limit(1);
	const snapshot = rows[0];
	const payload = Array.isArray(snapshot?.rows)
		? (snapshot.rows as RankingRow[])
		: [];
	return {
		generatedAt: snapshot?.generatedAt ?? null,
		rows: payload,
		unrankedCount: snapshot?.unrankedCount ?? 0,
	};
}

export const yabaRoutes = new Elysia({ prefix: "/yaba" })
	// ── Public reads ─────────────────────────────────────────────────────────
	.get(
		"/factions",
		async () => {
			const factions = await db
				.select()
				.from(yabaFactions)
				.where(eq(yabaFactions.enabled, true))
				.orderBy(yabaFactions.name);
			const daily = await db.select().from(yabaFactionDaily);
			const latestDaily = new Map<number, number>();
			for (const row of daily) {
				const current = latestDaily.get(row.factionId) ?? 0;
				if (row.day.getTime() >= current) {
					latestDaily.set(row.factionId, row.membersCount);
				}
			}
			return {
				factions: factions.map((faction) => ({
					factionId: faction.factionId,
					name: faction.name,
					tag: faction.tag,
					type: faction.type,
					leaderId: faction.leaderId,
					membersCount: latestDaily.get(faction.factionId) ?? 0,
					source: faction.source,
				})),
			};
		},
		{ detail: { summary: "YABA Factions", description: "Tracked factions." } },
	)
	.get(
		"/members",
		async ({ query }) => {
			const members = await db.select().from(yabaMembers);
			const filtered =
				query.factionId !== undefined
					? members.filter((member) => member.factionId === query.factionId)
					: members;
			return {
				members: filtered.map((member) => ({
					tornId: member.tornId,
					name: member.name,
					factionId: member.factionId,
					level: member.level,
					daysInFaction: member.daysInFaction,
					lastSeenAt: member.lastSeenAt?.toISOString() ?? null,
				})),
			};
		},
		{
			query: t.Object({ factionId: t.Optional(t.Numeric()) }),
			detail: { summary: "YABA Members", description: "Tracked members." },
		},
	)
	.get(
		"/rankings",
		async ({ query }) => {
			const scope = query.scope === "member" ? "member" : "faction";
			const factionType = query.type === "revive" ? "revive" : "combat";
			const window =
				query.window && isYabaWindow(query.window) ? query.window : "90d";
			const snapshot = await loadLatestRanking(scope, factionType, window);
			return {
				scope,
				factionType,
				window,
				generatedAt: snapshot.generatedAt?.toISOString() ?? null,
				unrankedCount: snapshot.unrankedCount,
				rows: snapshot.rows,
			};
		},
		{
			query: t.Object({
				scope: t.Optional(t.String()),
				type: t.Optional(t.String()),
				window: t.Optional(t.String()),
			}),
			detail: {
				summary: "YABA Rankings",
				description: "Latest immutable ranking snapshot.",
			},
		},
	)
	.get(
		"/status",
		async () => {
			const [latest] = await db
				.select()
				.from(yabaCollectionRuns)
				.orderBy(desc(yabaCollectionRuns.startedAt))
				.limit(1);
			const [factionCount] = await db
				.select({ count: db.$count(yabaFactions) })
				.from(yabaFactions);
			const [memberCount] = await db
				.select({ count: db.$count(yabaMembers) })
				.from(yabaMembers);
			return {
				lastRun: latest
					? {
							kind: latest.kind,
							status: latest.status,
							startedAt: latest.startedAt.toISOString(),
							finishedAt: latest.finishedAt?.toISOString() ?? null,
							keyCount: latest.keyCount,
							counters: latest.counters,
							error: latest.error,
						}
					: null,
				factionCount: factionCount?.count ?? 0,
				memberCount: memberCount?.count ?? 0,
				windows: YABA_WINDOWS,
			};
		},
		{ detail: { summary: "YABA Collector Status" } },
	)
	.get(
		"/methodology",
		() => ({
			formula:
				"Each entity receives a 0-100 percentile per selected metric; the score is the weighted average of those percentiles. Rank 1 is the highest score.",
			factionAggregation: "Median of member values per metric.",
			metrics: YABA_METRIC_LABELS,
			windows: YABA_WINDOWS,
			notes: [
				"Battle scores are FFScouter estimates with provider/source metadata.",
				"Activity hours come from Torn's cumulative time-played stat.",
				"Ranked-war hits, revives and Xanax come from public personal-stat deltas.",
				"Missing data is excluded rather than scored as zero.",
			],
		}),
		{ detail: { summary: "YABA Methodology" } },
	)
	.get(
		"/prospective",
		async ({ query, set }) => {
			const factionId = Number(query.factionId);
			if (!Number.isInteger(factionId) || factionId <= 0) {
				set.status = 400;
				return { error: "A valid factionId is required." };
			}
			try {
				const basicResponse = await tornApi.get("/faction/{id}/basic", {
					pathParams: { id: factionId },
					pool: "alliance",
				});
				const root = basicResponse as TornSchema<"FactionBasicResponse">;
				const basic = root.basic;
				const membersResponse = await tornApi.get("/faction/{id}/members", {
					pathParams: { id: factionId },
					pool: "alliance",
				});
				const memberRoot =
					membersResponse as TornSchema<"FactionMembersResponse">;
				const members = memberRoot.members ?? [];
				const tracked = await loadLatestRanking("faction", "combat", "90d");
				const medianScore =
					tracked.rows.length > 0
						? (tracked.rows.map((row) => row.score).sort((a, b) => a - b)[
								Math.floor(tracked.rows.length / 2)
							] ?? null)
						: null;
				return {
					faction: {
						factionId,
						name: basic?.name ?? `Faction ${factionId}`,
						tag: basic?.tag ?? null,
						members: basic?.members ?? members.length,
						respect: basic?.respect ?? null,
						daysOld: basic?.days_old ?? null,
					},
					comparison: {
						trackedFactionCount: tracked.rows.length,
						medianScore,
						note: "Full activity comparison requires the faction's members to be tracked.",
					},
				};
			} catch (error) {
				set.status = 502;
				return {
					error:
						error instanceof Error ? error.message : "Torn API lookup failed.",
				};
			}
		},
		{
			query: t.Object({ factionId: t.String() }),
			detail: { summary: "Analyse Prospective Faction" },
		},
	)

	// ── Admin writes ─────────────────────────────────────────────────────────
	.use(authPlugin)
	.get(
		"/admin/factions",
		async ({ user, set }) => {
			if (!(await requireAllianceAdmin(user, set))) {
				return { error: "Forbidden" };
			}
			return {
				factions: await db
					.select()
					.from(yabaFactions)
					.orderBy(yabaFactions.name),
			};
		},
		{ detail: { summary: "YABA Admin Factions" } },
	)
	.post(
		"/admin/factions",
		async ({ body, user, set }) => {
			if (!(await requireAllianceAdmin(user, set))) {
				return { error: "Forbidden" };
			}
			const type = body.type === "revive" ? "revive" : "combat";
			const [row] = await db
				.insert(yabaFactions)
				.values({
					factionId: body.factionId,
					name: body.name?.trim() || `Faction ${body.factionId}`,
					type,
					source: "manual",
				})
				.onConflictDoUpdate({
					target: yabaFactions.factionId,
					set: {
						name: body.name?.trim() || `Faction ${body.factionId}`,
						type,
						enabled: true,
						updatedAt: new Date(),
					},
				})
				.returning();
			return { success: true, faction: row };
		},
		{
			body: t.Object({
				factionId: t.Integer(),
				name: t.Optional(t.String()),
				type: t.Optional(t.String()),
			}),
			detail: { summary: "Add YABA Faction" },
		},
	)
	.put(
		"/admin/factions/:factionId",
		async ({ params, body, user, set }) => {
			if (!(await requireAllianceAdmin(user, set))) {
				return { error: "Forbidden" };
			}
			const updates: {
				type?: string;
				enabled?: boolean;
				name?: string;
				source?: string;
				updatedAt: Date;
			} = { updatedAt: new Date() };
			if (body.type === "combat" || body.type === "revive")
				updates.type = body.type;
			if (typeof body.enabled === "boolean") {
				updates.enabled = body.enabled;
				// An explicit admin decision takes the faction out of map sync so
				// the nightly refresh cannot silently re-enable or disable it.
				updates.source = "manual";
			}
			if (typeof body.name === "string" && body.name.trim()) {
				updates.name = body.name.trim();
			}
			const [row] = await db
				.update(yabaFactions)
				.set(updates)
				.where(eq(yabaFactions.factionId, params.factionId))
				.returning();
			if (!row) {
				set.status = 404;
				return { error: "Faction not found." };
			}
			return { success: true, faction: row };
		},
		{
			params: t.Object({ factionId: t.Integer() }),
			body: t.Object({
				type: t.Optional(t.String()),
				enabled: t.Optional(t.Boolean()),
				name: t.Optional(t.String()),
			}),
			detail: { summary: "Update YABA Faction" },
		},
	)
	.post(
		"/admin/collect/run",
		async ({ body, user, set }) => {
			if (!(await requireAllianceAdmin(user, set))) {
				return { error: "Forbidden" };
			}
			const workerName =
				body.kind === "backfill" ? "yaba:backfill" : "yaba:nightly";
			const result = await requestSchedulerAction("force_run_worker", {
				workerName,
			});
			return { success: result !== null, workerName };
		},
		{
			body: t.Object({ kind: t.Optional(t.String()) }),
			detail: { summary: "Trigger YABA Collection" },
		},
	)
	.post(
		"/admin/rankings/recompute",
		async ({ user, set }) => {
			if (!(await requireAllianceAdmin(user, set))) {
				return { error: "Forbidden" };
			}
			await requestSchedulerAction("force_run_worker", {
				workerName: "yaba:nightly",
			});
			return { success: true };
		},
		{ detail: { summary: "Recompute YABA Rankings" } },
	)
	.put(
		"/admin/preset",
		async ({ body, user, set }) => {
			if (!(await requireAllianceAdmin(user, set))) {
				return { error: "Forbidden" };
			}
			const metrics = body.metrics.filter(isYabaMetric);
			if (metrics.length === 0) {
				set.status = 400;
				return { error: "Select at least one metric." };
			}
			const weights = Object.fromEntries(
				Object.entries(body.weights ?? {}).filter(
					([key, value]) => isYabaMetric(key) && typeof value === "number",
				),
			) as Record<string, number>;
			const hash = hashYabaPreset(metrics, weights as never);
			const factionType = body.factionType === "revive" ? "revive" : "combat";
			await db
				.update(yabaPresets)
				.set({ isDefault: false })
				.where(eq(yabaPresets.factionType, factionType));
			const [row] = await db
				.insert(yabaPresets)
				.values({
					name: body.name?.trim() || "Custom",
					factionType,
					metrics,
					weights,
					hash,
					isDefault: true,
				})
				.onConflictDoUpdate({
					target: yabaPresets.hash,
					set: {
						factionType,
						metrics,
						weights,
						isDefault: true,
						updatedAt: new Date(),
					},
				})
				.returning();
			return { success: true, preset: row };
		},
		{
			body: t.Object({
				name: t.Optional(t.String()),
				factionType: t.Optional(t.String()),
				metrics: t.Array(t.String()),
				weights: t.Optional(t.Record(t.String(), t.Numeric())),
			}),
			detail: { summary: "Set Default YABA Ranking Preset" },
		},
	)
	.get(
		"/admin/preset",
		async ({ query, user, set }) => {
			if (!(await requireAllianceAdmin(user, set))) {
				return { error: "Forbidden" };
			}
			const factionType = query.factionType === "revive" ? "revive" : "combat";
			const [row] = await db
				.select()
				.from(yabaPresets)
				.where(
					and(
						eq(yabaPresets.isDefault, true),
						eq(yabaPresets.factionType, factionType),
					),
				)
				.limit(1);
			return {
				preset: row
					? {
							name: row.name,
							metrics: row.metrics,
							weights: row.weights,
							hash: row.hash,
						}
					: {
							name: "Sheet default",
							factionType,
							metrics: defaultYabaMetrics(factionType),
							weights: {},
							hash: hashYabaPreset(defaultYabaMetrics(factionType)),
						},
			};
		},
		{
			query: t.Object({ factionType: t.Optional(t.String()) }),
			detail: { summary: "Get YABA Ranking Preset" },
		},
	)
	.get(
		"/admin/channels",
		async ({ user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) return { error: "Forbidden" };
			const [config] = await db
				.select()
				.from(guildConfigs)
				.where(eq(guildConfigs.guildId, guildId))
				.limit(1);
			return {
				factionChannelId: config?.yabaFactionChartChannelId ?? null,
				playerChannelId: config?.yabaPlayerChartChannelId ?? null,
			};
		},
		{ detail: { summary: "Get YABA Chart Channels" } },
	)
	.put(
		"/admin/channels",
		async ({ body, user, set }) => {
			const guildId = await requireAllianceAdmin(user, set);
			if (!guildId) return { error: "Forbidden" };
			await db
				.update(guildConfigs)
				.set({
					yabaFactionChartChannelId: body.factionChannelId?.trim() || null,
					yabaPlayerChartChannelId: body.playerChannelId?.trim() || null,
					yabaFactionChartMessageId: null,
					yabaPlayerChartMessageId: null,
					updatedAt: new Date(),
				})
				.where(eq(guildConfigs.guildId, guildId));
			void syncYabaChannelsViaIpc(guildId);
			return { success: true };
		},
		{
			body: t.Object({
				factionChannelId: t.Nullable(t.String()),
				playerChannelId: t.Nullable(t.String()),
			}),
			detail: { summary: "Set YABA Chart Channels" },
		},
	);
