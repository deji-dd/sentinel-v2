import {
	and,
	apiKeys,
	asc,
	db,
	desc,
	eq,
	gte,
	like,
	lte,
	or,
	personalLogs,
	type SQL,
	sql,
	systemStates,
	userSessions,
	users,
} from "@sentinel/database";
import { encryptApiKey, hashApiKey, TornApiClient } from "@sentinel/torn-api";
import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import {
	requestLogManagerReset,
	triggerLogManagerSync,
} from "../../lib/scheduler-ipc";
import { battlestatsLedgerRoutes } from "./battlestats-ledger";
import { crimeLedgerRoutes } from "./crime-ledger";
import { gymLedgerRoutes } from "./gym-ledger";
import { stockLedgerRoutes } from "./stock-ledger";
import { wealthRoutes } from "./wealth";

export interface AuthUser {
	id: number;
	discordId: string | null;
	tornId: number | null;
	username: string | null;
	avatar: string | null;
	role: string;
}

const RESYNC_STATE_ID = "personal:log_manager:resync_job";

export const systemRoutes = new Elysia({ prefix: "/system" })
	.use(crimeLedgerRoutes)
	.use(battlestatsLedgerRoutes)
	.use(gymLedgerRoutes)
	.use(stockLedgerRoutes)
	.use(wealthRoutes)
	.derive(async ({ cookie }) => {
		const sessionToken = cookie.sentinel_session?.value;
		if (typeof sessionToken !== "string" || !sessionToken) {
			return {
				user: null as AuthUser | null,
			};
		}

		try {
			const [result] = await db
				.select({
					id: users.id,
					discordId: users.discordId,
					tornId: users.tornId,
					username: users.username,
					avatar: users.avatar,
					role: users.role,
				})
				.from(userSessions)
				.innerJoin(users, eq(userSessions.userId, users.id))
				.where(eq(userSessions.id, sessionToken));

			return {
				user: (result ?? null) as AuthUser | null,
			};
		} catch {
			return {
				user: null as AuthUser | null,
			};
		}
	})
	.onBeforeHandle(({ user, set }) => {
		const isDev =
			process.env.NODE_ENV === "development" || env.NODE_ENV === "development";
		if (isDev) return;

		const isAdmin =
			user?.role === "admin" ||
			user?.role === "owner" ||
			(Boolean(env.DISCORD_USER_ID) && user?.discordId === env.DISCORD_USER_ID);

		if (!isAdmin) {
			set.status = 403;
			return {
				error: "Forbidden: Admin access required for system management.",
			};
		}
	})
	// GET /api/v1/system/keys — list all system & registered API keys
	.get(
		"/keys",
		async () => {
			const keys = await db
				.select({
					id: apiKeys.id,
					userId: apiKeys.userId,
					keyType: apiKeys.keyType,
					isValid: apiKeys.isValid,
					invalidCount: apiKeys.invalidCount,
					lastInvalidAt: apiKeys.lastInvalidAt,
					lastUsedAt: apiKeys.lastUsedAt,
					createdAt: apiKeys.createdAt,
				})
				.from(apiKeys)
				.orderBy(desc(apiKeys.createdAt));

			return { keys };
		},
		{
			detail: {
				summary: "List System API Keys",
				description: "Returns all registered API keys in the system key pool.",
			},
		},
	)
	// POST /api/v1/system/keys — register a new API key to the system pool
	.post(
		"/keys",
		async ({ body, set }) => {
			const trimmedKey = body.apiKey.trim();
			if (trimmedKey.length !== 16) {
				set.status = 400;
				return {
					error:
						"Invalid Torn API key format. Key must be a 16-character string.",
				};
			}

			const keyHash = hashApiKey(
				trimmedKey,
				process.env.API_KEY_HASH_PEPPER ?? "",
			);

			// Check duplicate key
			const [existingKey] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.apiKeyHash, keyHash));

			if (existingKey) {
				set.status = 400;
				return {
					error: "This API key has already been added to the system.",
				};
			}

			// Verify key against Torn API first
			let tornUserId: number | null = null;
			let playerName = "Unknown";
			try {
				const client = new TornApiClient();
				const profile = await client.getRaw<{
					player_id?: number;
					name?: string;
				}>("user/", {
					apiKey: trimmedKey,
					queryParams: { selections: "profile" },
				});
				tornUserId = profile?.player_id ?? null;
				playerName = profile?.name ?? `Player ${tornUserId}`;
				if (!tornUserId) {
					set.status = 400;
					return {
						error: "Failed to extract valid Torn Player ID from Torn API key.",
					};
				}
			} catch (err) {
				const errorMessage =
					err instanceof Error ? err.message : "Torn API verification failed.";
				set.status = 400;
				return {
					error: `Torn API Verification Failed: ${errorMessage}`,
				};
			}

			const keyEncrypted = encryptApiKey(
				trimmedKey,
				process.env.ENCRYPTION_KEY ?? "",
			);
			const keyType = body.keyType ?? "system";

			const [inserted] = await db
				.insert(apiKeys)
				.values({
					userId: tornUserId,
					apiKeyEncrypted: keyEncrypted,
					apiKeyHash: keyHash,
					keyType,
					isValid: true,
					invalidCount: 0,
				})
				.returning({
					id: apiKeys.id,
					userId: apiKeys.userId,
					keyType: apiKeys.keyType,
					isValid: apiKeys.isValid,
					createdAt: apiKeys.createdAt,
				});

			return {
				success: true,
				key: inserted,
				playerName,
			};
		},
		{
			body: t.Object({
				apiKey: t.String(),
				keyType: t.Optional(
					t.Union([t.Literal("system"), t.Literal("personal")]),
				),
			}),
			detail: {
				summary: "Register System API Key",
				description:
					"Verifies with Torn API, encrypts, and stores a new API key in the system pool.",
			},
		},
	)
	// DELETE /api/v1/system/keys/:keyId — remove an API key from system
	.delete(
		"/keys/:keyId",
		async ({ params, set }) => {
			const [existing] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.id, params.keyId));

			if (!existing) {
				set.status = 404;
				return { error: "API key not found." };
			}

			await db.delete(apiKeys).where(eq(apiKeys.id, params.keyId));

			return { success: true };
		},
		{
			params: t.Object({
				keyId: t.String(),
			}),
			detail: {
				summary: "Delete System API Key",
				description: "Removes an API key from the central system pool.",
			},
		},
	)
	// PATCH /api/v1/system/keys/:keyId — toggle validity or reset errors
	.patch(
		"/keys/:keyId",
		async ({ params, body, set }) => {
			const [existing] = await db
				.select()
				.from(apiKeys)
				.where(eq(apiKeys.id, params.keyId));

			if (!existing) {
				set.status = 404;
				return { error: "API key not found." };
			}

			await db
				.update(apiKeys)
				.set({
					...(body.isValid !== undefined ? { isValid: body.isValid } : {}),
					...(body.resetErrors ? { invalidCount: 0, lastInvalidAt: null } : {}),
					updatedAt: new Date(),
				})
				.where(eq(apiKeys.id, params.keyId));

			return { success: true };
		},
		{
			params: t.Object({
				keyId: t.String(),
			}),
			body: t.Object({
				isValid: t.Optional(t.Boolean()),
				resetErrors: t.Optional(t.Boolean()),
			}),
			detail: {
				summary: "Update System API Key",
				description: "Updates API key validity or resets error counter.",
			},
		},
	)
	// GET /api/v1/system/log-manager/state — get log manager live progress state
	.get(
		"/log-manager/state",
		async () => {
			const [stateRecord] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:log_manager"));

			const [stats] = await db
				.select({
					totalInDb: sql<number>`count(${personalLogs.id})`,
					oldestTimestamp: sql<number>`min(${personalLogs.timestamp})`,
					newestTimestamp: sql<number>`max(${personalLogs.timestamp})`,
				})
				.from(personalLogs);

			const defaultState = {
				status: "idle",
				backfillStatus: "in_progress",
				forwardStatus: "idle",
				totalLogsRecorded: stats?.totalInDb ?? 0,
				backfillLogsCount: 0,
				forwardLogsCount: 0,
				oldestTimestampReached: stats?.oldestTimestamp ?? null,
				newestTimestampReached: stats?.newestTimestamp ?? null,
				lastForwardCheckedAt: null,
				lastBackfillCheckedAt: null,
				lastError: null,
				lastSyncDurationMs: null,
				updatedAt: new Date().toISOString(),
			};

			const state = stateRecord?.data
				? { ...defaultState, ...(stateRecord.data as Record<string, unknown>) }
				: defaultState;

			return {
				state: {
					...state,
					totalInDb: stats?.totalInDb ?? 0,
					dbOldestDate: stats?.oldestTimestamp
						? new Date(
								typeof stats.oldestTimestamp === "number" &&
									stats.oldestTimestamp < 1e11
									? stats.oldestTimestamp * 1000
									: stats.oldestTimestamp,
							).toISOString()
						: null,
					dbNewestDate: stats?.newestTimestamp
						? new Date(
								typeof stats.newestTimestamp === "number" &&
									stats.newestTimestamp < 1e11
									? stats.newestTimestamp * 1000
									: stats.newestTimestamp,
							).toISOString()
						: null,
				},
			};
		},
		{
			detail: {
				summary: "Get Log Manager State",
				description:
					"Returns live state, backfill progress, and log count metrics.",
			},
		},
	)
	// POST /api/v1/system/log-manager/pause — toggle pause/resume backfill
	.post(
		"/log-manager/pause",
		async ({ body }) => {
			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:log_manager"));

			const currentData = (existing?.data as Record<string, unknown>) ?? {};
			const nextBackfillStatus = body.paused ? "paused" : "in_progress";

			const updatedData = {
				...currentData,
				backfillStatus: nextBackfillStatus,
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: "personal:log_manager",
					init: false,
					data: updatedData,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						data: updatedData,
						updatedAt: new Date(),
					},
				});

			// Nudge the scheduler so it picks up the pause/resume immediately.
			void triggerLogManagerSync();

			return { success: true, backfillStatus: nextBackfillStatus };
		},
		{
			body: t.Object({
				paused: t.Boolean(),
			}),
			detail: {
				summary: "Toggle Log Manager Backfill Pause",
				description: "Pauses or resumes the historical backfill worker loop.",
			},
		},
	)
	// POST /api/v1/system/log-manager/reset — reset log manager state
	.post(
		"/log-manager/reset",
		async ({ body, set }) => {
			if (!body.confirm) {
				set.status = 400;
				return {
					success: false,
					error:
						"Confirmation required: pass { confirm: true } to reset the log manager state.",
				};
			}

			const [resyncRecord] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, RESYNC_STATE_ID));
			const resyncJob = (resyncRecord?.data as Record<string, unknown>) ?? {};
			if (resyncJob.status === "pending" || resyncJob.status === "running") {
				set.status = 409;
				return {
					success: false,
					error: "Cannot reset while a resync job is queued or running.",
					job: resyncJob,
				};
			}

			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "personal:log_manager"));
			const currentData =
				(existing?.data as Record<string, unknown> | undefined) ?? {};

			const resetData = {
				status: "idle",
				backfillStatus: "in_progress",
				forwardStatus: "idle",
				totalLogsRecorded:
					typeof currentData.totalLogsRecorded === "number"
						? currentData.totalLogsRecorded
						: 0,
				backfillLogsCount: 0,
				forwardLogsCount: 0,
				oldestTimestampReached: null,
				newestTimestampReached: currentData.newestTimestampReached ?? null,
				lastForwardCheckedAt: null,
				lastBackfillCheckedAt: null,
				lastError: null,
				lastSyncDurationMs: null,
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: "personal:log_manager",
					init: false,
					data: resetData,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: false,
						data: resetData,
						updatedAt: new Date(),
					},
				});

			const schedulerTriggered = await requestLogManagerReset();

			return { success: true, schedulerTriggered, state: resetData };
		},
		{
			body: t.Object({
				confirm: t.Boolean(),
			}),
			detail: {
				summary: "Reset Log Manager State",
				description:
					"Resets the log manager backfill progress state (requires confirm: true). Sets cursor back to now so the worker re-scans and parses backward from the present to capture any missed logs into the database without deleting existing records. Refused while a resync job is queued or running.",
			},
		},
	)
	// GET /api/v1/system/log-manager/logs — query paginated personal logs with search & filters
	.get(
		"/log-manager/logs",
		async ({ query }) => {
			const page = Number(query.page ?? 1) || 1;
			const limit = Math.min(Number(query.limit ?? 50) || 50, 100);
			const offset = (page - 1) * limit;

			const conditions: SQL[] = [];

			if (query.date) {
				const dayStart = new Date(`${query.date}T00:00:00Z`);
				const dayEnd = new Date(`${query.date}T23:59:59Z`);
				if (
					!Number.isNaN(dayStart.getTime()) &&
					!Number.isNaN(dayEnd.getTime())
				) {
					conditions.push(
						and(
							gte(personalLogs.timestamp, dayStart),
							lte(personalLogs.timestamp, dayEnd),
						) as SQL,
					);
				}
			} else if (query.from || query.to) {
				if (query.from) {
					const fromDate = new Date(
						query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
					);
					if (!Number.isNaN(fromDate.getTime())) {
						conditions.push(gte(personalLogs.timestamp, fromDate) as SQL);
					}
				}
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						conditions.push(lte(personalLogs.timestamp, toDate) as SQL);
					}
				}
			} else if (query.days && query.days !== "all") {
				const numDays = Math.max(1, Number(query.days) || 30);
				const now = new Date();
				const todayUtcStart = new Date(
					Date.UTC(
						now.getUTCFullYear(),
						now.getUTCMonth(),
						now.getUTCDate(),
						0,
						0,
						0,
					),
				);
				const cutoff = new Date(
					todayUtcStart.getTime() - (numDays - 1) * 86400 * 1000,
				);
				conditions.push(gte(personalLogs.timestamp, cutoff) as SQL);
			}

			if (query.category && query.category !== "ALL") {
				conditions.push(eq(personalLogs.category, query.category));
			}

			if (query.logType) {
				const logNum = Number(query.logType);
				if (!Number.isNaN(logNum)) {
					conditions.push(eq(personalLogs.log, logNum));
				}
			}

			if (query.search) {
				const searchPattern = `%${query.search.trim()}%`;
				conditions.push(
					or(
						like(personalLogs.title, searchPattern),
						like(personalLogs.category, searchPattern),
						like(personalLogs.id, searchPattern),
					) as SQL,
				);
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			const [totalResult] = await db
				.select({ count: sql<number>`count(${personalLogs.id})` })
				.from(personalLogs)
				.where(whereClause);

			const total = totalResult?.count ?? 0;

			const logs = await db
				.select()
				.from(personalLogs)
				.where(whereClause)
				.orderBy(desc(personalLogs.timestamp))
				.limit(limit)
				.offset(offset);

			return {
				logs,
				total,
				page,
				limit,
				totalPages: Math.ceil(total / limit),
			};
		},
		{
			query: t.Object({
				page: t.Optional(t.String()),
				limit: t.Optional(t.String()),
				date: t.Optional(t.String()),
				days: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				category: t.Optional(t.String()),
				search: t.Optional(t.String()),
				logType: t.Optional(t.String()),
			}),
			detail: {
				summary: "List Personal Logs",
				description:
					"Returns paginated user logs with search and category filtering.",
			},
		},
	)
	// GET /api/v1/system/log-manager/activity — daily aggregated log counts for bar graph visualizer
	.get(
		"/log-manager/activity",
		async ({ query }) => {
			const conditions: SQL[] = [];

			if (query.category && query.category !== "ALL") {
				conditions.push(eq(personalLogs.category, query.category));
			}

			if (query.from) {
				const fromDate = new Date(
					query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
				);
				if (!Number.isNaN(fromDate.getTime())) {
					conditions.push(gte(personalLogs.timestamp, fromDate));
				}
			}

			if (query.to) {
				const toDate = new Date(
					query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
				);
				if (!Number.isNaN(toDate.getTime())) {
					conditions.push(lte(personalLogs.timestamp, toDate));
				}
			} else if (query.days && query.days !== "all") {
				const numDays = Math.max(1, Number(query.days) || 30);
				const now = new Date();
				const todayUtcStart = new Date(
					Date.UTC(
						now.getUTCFullYear(),
						now.getUTCMonth(),
						now.getUTCDate(),
						0,
						0,
						0,
					),
				);
				const cutoff = new Date(
					todayUtcStart.getTime() - (numDays - 1) * 86400 * 1000,
				);
				conditions.push(gte(personalLogs.timestamp, cutoff));
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			const dayExpr = sql<string>`to_char(${personalLogs.timestamp}, 'YYYY-MM-DD')`;

			const days = await db
				.select({
					date: dayExpr,
					count: sql<number>`count(${personalLogs.id})`,
				})
				.from(personalLogs)
				.where(whereClause)
				.groupBy(dayExpr)
				.orderBy(asc(dayExpr));

			// Zero-fill the requested range
			const now = new Date();
			const todayUtcStart = new Date(
				Date.UTC(
					now.getUTCFullYear(),
					now.getUTCMonth(),
					now.getUTCDate(),
					0,
					0,
					0,
				),
			);

			let fillStartMs: number | null = null;
			if (query.from) {
				const fromDate = new Date(
					query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
				);
				if (!Number.isNaN(fromDate.getTime())) fillStartMs = fromDate.getTime();
			} else if (query.days && query.days !== "all") {
				const numDays = Math.max(1, Number(query.days) || 30);
				fillStartMs = todayUtcStart.getTime() - (numDays - 1) * 86400 * 1000;
			} else if (days.length > 0 && days[0]?.date) {
				const first = new Date(`${days[0].date}T00:00:00Z`);
				if (!Number.isNaN(first.getTime())) fillStartMs = first.getTime();
			}

			let filled = days;
			if (fillStartMs !== null) {
				const countByDate = new Map(days.map((d) => [d.date, Number(d.count)]));
				filled = [];
				let fillEndMs = todayUtcStart.getTime();
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T00:00:00Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						fillEndMs = Math.min(todayUtcStart.getTime(), toDate.getTime());
					}
				}
				for (let t = fillStartMs; t <= fillEndMs; t += 86400 * 1000) {
					const dateKey = new Date(t).toISOString().slice(0, 10);
					filled.push({ date: dateKey, count: countByDate.get(dateKey) ?? 0 });
				}
			}

			const totalLogs = filled.reduce((acc, d) => acc + Number(d.count), 0);

			return {
				days: filled,
				totalDays: filled.length,
				totalLogs,
			};
		},
		{
			query: t.Object({
				days: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
				category: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Daily Log Activity",
				description:
					"Returns aggregated log counts per day for bar graph visualizer.",
			},
		},
	)
	// GET /api/v1/system/log-manager/categories — get distinct categories
	.get(
		"/log-manager/categories",
		async ({ query }) => {
			const conditions: SQL[] = [];

			if (query.date) {
				const dayStart = new Date(`${query.date}T00:00:00Z`);
				const dayEnd = new Date(`${query.date}T23:59:59Z`);
				if (
					!Number.isNaN(dayStart.getTime()) &&
					!Number.isNaN(dayEnd.getTime())
				) {
					conditions.push(
						and(
							gte(personalLogs.timestamp, dayStart),
							lte(personalLogs.timestamp, dayEnd),
						) as SQL,
					);
				}
			} else if (query.from || query.to) {
				if (query.from) {
					const fromDate = new Date(
						query.from.includes("T") ? query.from : `${query.from}T00:00:00Z`,
					);
					if (!Number.isNaN(fromDate.getTime())) {
						conditions.push(gte(personalLogs.timestamp, fromDate) as SQL);
					}
				}
				if (query.to) {
					const toDate = new Date(
						query.to.includes("T") ? query.to : `${query.to}T23:59:59Z`,
					);
					if (!Number.isNaN(toDate.getTime())) {
						conditions.push(lte(personalLogs.timestamp, toDate) as SQL);
					}
				}
			} else if (query.days && query.days !== "all") {
				const numDays = Math.max(1, Number.parseInt(query.days, 10) || 30);
				const now = new Date();
				const todayUtcStart = new Date(
					Date.UTC(
						now.getUTCFullYear(),
						now.getUTCMonth(),
						now.getUTCDate(),
						0,
						0,
						0,
					),
				);
				const cutoff = new Date(
					todayUtcStart.getTime() - (numDays - 1) * 86400 * 1000,
				);
				conditions.push(gte(personalLogs.timestamp, cutoff) as SQL);
			}

			const whereClause =
				conditions.length > 0 ? and(...conditions) : undefined;

			const categories = await db
				.select({
					category: personalLogs.category,
					count: sql<number>`count(${personalLogs.id})`,
				})
				.from(personalLogs)
				.where(whereClause)
				.groupBy(personalLogs.category)
				.orderBy(desc(sql`count(${personalLogs.id})`));

			return { categories };
		},
		{
			query: t.Object({
				days: t.Optional(t.String()),
				date: t.Optional(t.String()),
				from: t.Optional(t.String()),
				to: t.Optional(t.String()),
			}),
			detail: {
				summary: "Get Log Categories",
				description:
					"Returns distinct categories of recorded logs with counts, optionally filtered by range or date.",
			},
		},
	)
	// POST /api/v1/system/log-manager/resync — enqueue a range resync job for the scheduler
	.post(
		"/log-manager/resync",
		async ({ body, set }) => {
			const [existing] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, RESYNC_STATE_ID));

			const currentJob = (existing?.data as Record<string, unknown>) ?? {};
			if (currentJob.status === "pending" || currentJob.status === "running") {
				set.status = 409;
				return {
					success: false,
					error: "A resync job is already queued or running.",
					job: currentJob,
				};
			}

			if (body.from >= body.to) {
				set.status = 400;
				return {
					success: false,
					error: "'from' must be earlier than 'to'.",
				};
			}

			const job = {
				status: "pending",
				from: body.from,
				to: body.to,
				cursor: body.to,
				fetched: 0,
				pages: 0,
				lastError: null,
				startedAt: null,
				finishedAt: null,
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: RESYNC_STATE_ID,
					init: false,
					data: job,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						data: job,
						updatedAt: new Date(),
					},
				});

			const triggered = await triggerLogManagerSync();

			return {
				success: true,
				enqueued: true,
				schedulerTriggered: triggered,
				job,
			};
		},
		{
			body: t.Object({
				from: t.Number(),
				to: t.Number(),
			}),
			detail: {
				summary: "Manual Log Range Resync",
				description:
					"Enqueues a personal log resync job for the given UTC timestamp range (unix seconds). The scheduler worker processes it in bursts; poll GET /log-manager/resync for progress.",
			},
		},
	)
	// GET /api/v1/system/log-manager/resync — progress of the latest resync job
	.get("/log-manager/resync", async () => {
		const [record] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, RESYNC_STATE_ID));

		return { success: true, job: record?.data ?? null };
	});
