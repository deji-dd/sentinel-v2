import { db, eq, personalLogs, sql, systemStates } from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:log_manager";
const STATE_ID = "personal:log_manager";
const RESYNC_STATE_ID = "personal:log_manager_resync";
const CADENCE_SEC = 60;
const ACTIVE_BACKFILL_CADENCE_MS = 10000;
const DEFAULT_BURST_PAGES = 5;
const BURST_PAGE_DELAY_MS = 150;
const RESYNC_BURST_PAGES = 5;
const RESYNC_MAX_CONSECUTIVE_FAILURES = 10;

const logger = new Logger("Scheduler", "LogManager");

type UserLog = TornSchema<"UserLog">;
type UserLogsResponse = TornSchema<"UserLogsResponse">;

export type LogManagerState = {
	status: "idle" | "running" | "paused" | "completed" | "error";
	backfillStatus: "idle" | "in_progress" | "paused" | "completed" | "error";
	forwardStatus: "idle" | "polling" | "error";
	totalLogsRecorded: number;
	backfillLogsCount: number;
	forwardLogsCount: number;
	oldestTimestampReached: number | null;
	newestTimestampReached: number | null;
	lastForwardCheckedAt: number | null;
	lastBackfillCheckedAt: number | null;
	lastError: string | null;
	lastSyncDurationMs: number | null;
	updatedAt: string;
};

const DEFAULT_STATE: LogManagerState = {
	status: "idle",
	backfillStatus: "in_progress",
	forwardStatus: "idle",
	totalLogsRecorded: 0,
	backfillLogsCount: 0,
	forwardLogsCount: 0,
	oldestTimestampReached: null,
	newestTimestampReached: null,
	lastForwardCheckedAt: null,
	lastBackfillCheckedAt: null,
	lastError: null,
	lastSyncDurationMs: null,
	updatedAt: new Date().toISOString(),
};

let inMemoryState: LogManagerState = { ...DEFAULT_STATE };
let isStateLoaded = false;
let isCycleRunning = false;
/** Set via IPC when a state reset is requested; consumed at the start of the next cycle. */
let pendingResetRequest = false;

export type ResyncJob = {
	status: "pending" | "running" | "completed" | "error";
	from: number;
	to: number;
	cursor: number;
	fetched: number;
	pages: number;
	failures: number;
	lastError: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	updatedAt: string;
};

let inMemoryResyncJob: ResyncJob | null = null;

/**
 * Loads the persistent resync job from SQLite system_states.
 * A job found in "running" state (e.g. after a crash) resumes from its saved cursor.
 */
async function loadResyncJobFromDb(): Promise<ResyncJob | null> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, RESYNC_STATE_ID),
		});

		if (record?.data) {
			const saved = record.data as Partial<ResyncJob>;
			if (saved.from !== undefined && saved.to !== undefined) {
				inMemoryResyncJob = {
					status: saved.status ?? "pending",
					from: saved.from,
					to: saved.to,
					cursor: saved.cursor ?? saved.to,
					fetched: saved.fetched ?? 0,
					pages: saved.pages ?? 0,
					failures: saved.failures ?? 0,
					lastError: saved.lastError ?? null,
					startedAt: saved.startedAt ?? null,
					finishedAt: saved.finishedAt ?? null,
					updatedAt: new Date().toISOString(),
				};
				if (inMemoryResyncJob.status === "running") {
					logger.info(
						`Resuming interrupted resync job ${inMemoryResyncJob.from}-${inMemoryResyncJob.to} from cursor ${inMemoryResyncJob.cursor}`,
					);
				}
			} else {
				inMemoryResyncJob = null;
			}
		} else {
			inMemoryResyncJob = null;
		}
	} catch (error) {
		logger.error("Failed to load resync job from database:", error);
		inMemoryResyncJob = null;
	}
	return inMemoryResyncJob;
}

/**
 * Persists the current resync job to SQLite system_states atomically.
 */
async function persistResyncJobToDb(): Promise<void> {
	if (!inMemoryResyncJob) return;
	inMemoryResyncJob.updatedAt = new Date().toISOString();
	try {
		await db
			.insert(systemStates)
			.values({
				id: RESYNC_STATE_ID,
				init: false,
				data: inMemoryResyncJob,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					data: inMemoryResyncJob,
					updatedAt: new Date(),
				},
			});
	} catch (error) {
		logger.error("Failed to persist resync job to database:", error);
	}
}

/**
 * Processes a burst of pages for the pending/running resync job.
 * Progress (cursor, fetched, pages) is persisted after every page so the job
 * survives scheduler restarts and crashes.
 */
async function processResyncBurst(
	burstPages = RESYNC_BURST_PAGES,
	pageDelayMs = BURST_PAGE_DELAY_MS,
): Promise<number> {
	// Re-read the persisted job unless one is actively running in memory,
	// so jobs enqueued by the API are picked up without a restart.
	const isActive =
		inMemoryResyncJob?.status === "pending" ||
		inMemoryResyncJob?.status === "running";
	if (!isActive) {
		await loadResyncJobFromDb();
	}

	const job = inMemoryResyncJob;
	if (!job || (job.status !== "pending" && job.status !== "running")) {
		return 0;
	}

	if (job.status === "pending") {
		job.status = "running";
		job.startedAt = new Date().toISOString();
		job.cursor = job.to;
		await persistResyncJobToDb();
		logger.info(`Starting resync job for range ${job.from} to ${job.to}`);
	}

	let fetchedInBurst = 0;

	try {
		for (let page = 0; page < burstPages; page++) {
			if (page > 0 && pageDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
			}

			// NOTE: Torn v2's `to` param is EXCLUSIVE (verified against the live API).
			// If cursor === job.to (first page), request `to: job.to + 1` to include logs stamped exactly at job.to.
			// On subsequent pages, `job.cursor` is already the oldest timestamp from previous page (exclusive upper bound).
			const currentTo = job.cursor === job.to ? job.to + 1 : job.cursor;

			const res = (await tornApi.getPersonal("/user/log", {
				queryParams: { from: job.from, to: currentTo, limit: 100 },
			})) as UserLogsResponse;

			const logs = res.log ?? [];
			if (logs.length === 0) {
				job.status = "completed";
				job.finishedAt = new Date().toISOString();
				await persistResyncJobToDb();
				logger.info(
					`Resync job completed for range ${job.from}-${job.to}. Fetched: ${job.fetched}`,
				);
				schedulerEvents.emit("log_resync_completed");
				break;
			}

			await saveLogsToDatabase(logs);

			let oldestTimestamp = logs[0]?.timestamp ?? currentTo;
			for (const log of logs) {
				if (log.timestamp < oldestTimestamp) {
					oldestTimestamp = log.timestamp;
				}
			}

			job.fetched += logs.length;
			job.pages += 1;
			fetchedInBurst += logs.length;
			job.failures = 0;
			job.lastError = null;
			job.cursor = oldestTimestamp;

			// Persist after every page so progress survives a crash mid-burst
			await persistResyncJobToDb();

			if (oldestTimestamp <= job.from || logs.length < 100) {
				job.status = "completed";
				job.finishedAt = new Date().toISOString();
				await persistResyncJobToDb();
				logger.info(
					`Resync job completed for range ${job.from}-${job.to}. Fetched: ${job.fetched}`,
				);
				schedulerEvents.emit("log_resync_completed");
				break;
			}
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		job.failures += 1;
		job.lastError = errorMessage;
		logger.error("Failed resync burst:", error);

		if (job.failures >= RESYNC_MAX_CONSECUTIVE_FAILURES) {
			job.status = "error";
			job.finishedAt = new Date().toISOString();
			logger.error(
				`Resync job failed after ${job.failures} consecutive failures. Marking as error.`,
			);
		}
		await persistResyncJobToDb();
	}

	return fetchedInBurst;
}

/**
 * Loads the persistent log manager state from SQLite system_states.
 * Falls back to default state if no record exists yet.
 */
export async function loadStateFromDb(): Promise<LogManagerState> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});

		if (record?.data) {
			const saved = record.data as Partial<LogManagerState>;
			inMemoryState = {
				...DEFAULT_STATE,
				...saved,
				updatedAt: new Date().toISOString(),
			};
		} else {
			inMemoryState = { ...DEFAULT_STATE };
		}

		// Sync with existing personal_logs in database if state cursors are empty
		const stats = await db
			.select({
				total: sql<number>`count(${personalLogs.id})`,
				minTs: sql<number>`min(${personalLogs.timestamp})`,
				maxTs: sql<number>`max(${personalLogs.timestamp})`,
			})
			.from(personalLogs)
			.get();

		if (stats?.total) {
			inMemoryState.totalLogsRecorded = stats.total;
		}
		if (!record && stats?.minTs && !inMemoryState.oldestTimestampReached) {
			inMemoryState.oldestTimestampReached = stats.minTs;
		}
		if (!record && stats?.maxTs && !inMemoryState.newestTimestampReached) {
			inMemoryState.newestTimestampReached = stats.maxTs;
		}

		await persistStateToDb();
		isStateLoaded = true;
	} catch (error) {
		logger.error("Failed to load LogManager state from database:", error);
		inMemoryState = { ...DEFAULT_STATE };
	}
	return inMemoryState;
}

/**
 * Persists the current in-memory state to SQLite system_states atomically.
 */
async function persistStateToDb(): Promise<void> {
	inMemoryState.updatedAt = new Date().toISOString();
	try {
		await db
			.insert(systemStates)
			.values({
				id: STATE_ID,
				init: inMemoryState.backfillStatus === "completed",
				data: inMemoryState,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					init: inMemoryState.backfillStatus === "completed",
					data: inMemoryState,
					updatedAt: new Date(),
				},
			});
	} catch (error) {
		logger.error("Failed to persist LogManager state to database:", error);
	}
}

/**
 * Inserts or updates an array of raw user logs into the SQLite personal_logs table.
 */
async function saveLogsToDatabase(logs: UserLog[]): Promise<void> {
	if (logs.length === 0) return;

	const now = new Date();
	const rows = logs.map((log) => {
		const logDetails = log.details ?? {};
		const logTypeCode = (logDetails as { id?: number }).id ?? 0;
		const titleStr = (logDetails as { title?: string }).title ?? null;
		const categoryStr = (logDetails as { category?: string }).category ?? null;

		return {
			id: String(log.id),
			log: logTypeCode,
			title: titleStr,
			timestamp: new Date(log.timestamp * 1000),
			category: categoryStr,
			data: log,
			createdAt: now,
			updatedAt: now,
		};
	});

	await db.transaction(
		async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
			for (const row of rows) {
				await tx
					.insert(personalLogs)
					.values(row)
					.onConflictDoUpdate({
						target: personalLogs.id,
						set: {
							log: row.log,
							title: row.title,
							timestamp: row.timestamp,
							category: row.category,
							data: row.data,
							updatedAt: row.updatedAt,
						},
					});
			}
		},
	);

	const stats = db
		.select({ count: sql<number>`count(${personalLogs.id})` })
		.from(personalLogs)
		.get();
	if (stats?.count !== undefined) {
		inMemoryState.totalLogsRecorded = stats.count;
	}

	schedulerEvents.emit("logs_inserted", logs);
}

/**
 * Real-time Forward Log Polling.
 * Paginates forward starting from newestTimestampReached up to current time.
 */
export async function syncForwardLogs(options?: {
	maxPages?: number;
}): Promise<{ fetched: number; newLogs: number }> {
	if (!isStateLoaded) await loadStateFromDb();

	inMemoryState.forwardStatus = "polling";
	let totalFetched = 0;
	let totalNew = 0;
	const maxPages = options?.maxPages ?? 5;

	try {
		const nowTimestamp = Math.floor(Date.now() / 1000);
		let currentFrom = inMemoryState.newestTimestampReached
			? inMemoryState.newestTimestampReached + 1
			: nowTimestamp - 3600;

		for (let page = 0; page < maxPages; page++) {
			const res = (await tornApi.getPersonal("/user/log", {
				queryParams: { from: currentFrom, limit: 100 },
			})) as UserLogsResponse;

			const logs = res.log ?? [];
			if (logs.length === 0) break;

			totalFetched += logs.length;
			await saveLogsToDatabase(logs);

			let pageMaxTimestamp = currentFrom;
			for (const log of logs) {
				if (log.timestamp > pageMaxTimestamp) {
					pageMaxTimestamp = log.timestamp;
				}
				totalNew++;
			}

			inMemoryState.forwardLogsCount += logs.length;

			if (
				!inMemoryState.newestTimestampReached ||
				pageMaxTimestamp > inMemoryState.newestTimestampReached
			) {
				inMemoryState.newestTimestampReached = pageMaxTimestamp;
			}

			if (
				!inMemoryState.oldestTimestampReached ||
				(logs[logs.length - 1]?.timestamp &&
					(logs[logs.length - 1]?.timestamp ?? 0) <
						inMemoryState.oldestTimestampReached)
			) {
				const minLogTs = Math.min(...logs.map((l) => l.timestamp));
				if (
					!inMemoryState.oldestTimestampReached ||
					minLogTs < inMemoryState.oldestTimestampReached
				) {
					inMemoryState.oldestTimestampReached = minLogTs;
				}
			}

			// If fewer logs returned than standard page size or timestamp did not advance, break early
			if (logs.length < 80 || pageMaxTimestamp < currentFrom) break;
			currentFrom = pageMaxTimestamp + 1;
		}

		inMemoryState.lastForwardCheckedAt = Math.floor(Date.now() / 1000);
		inMemoryState.forwardStatus = "idle";
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		inMemoryState.forwardStatus = "error";
		inMemoryState.lastError = `Forward sync error: ${errorMessage}`;
		logger.error("Failed forward log sync:", error);
	}

	return { fetched: totalFetched, newLogs: totalNew };
}

/**
 * Historical Backward Backfill.
 * Paginates backward in time using the `to` cursor until reaching the beginning of logs history.
 * Fetches in bursts of up to `burstPages` (e.g. 5 pages = 500 logs) per cycle.
 */
export async function syncHistoricalBackfill(
	burstPages = DEFAULT_BURST_PAGES,
	pageDelayMs = BURST_PAGE_DELAY_MS,
): Promise<{ fetched: number; completed: boolean }> {
	if (!isStateLoaded) await loadStateFromDb();

	if (
		inMemoryState.backfillStatus === "completed" ||
		inMemoryState.backfillStatus === "paused"
	) {
		return {
			fetched: 0,
			completed: inMemoryState.backfillStatus === "completed",
		};
	}

	inMemoryState.backfillStatus = "in_progress";
	let totalFetched = 0;

	try {
		let currentTo = inMemoryState.oldestTimestampReached ?? undefined;

		for (let page = 0; page < burstPages; page++) {
			if (page > 0 && pageDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
			}

			const queryParams: { limit: number; to?: number } = { limit: 100 };
			if (currentTo !== undefined) queryParams.to = currentTo;

			const res = (await tornApi.getPersonal("/user/log", {
				queryParams,
			})) as UserLogsResponse;

			const logs = res.log ?? [];
			if (logs.length === 0) {
				logger.info(
					"Reached the beginning of personal log history. Backfill completed!",
				);
				inMemoryState.backfillStatus = "completed";
				inMemoryState.lastBackfillCheckedAt = Math.floor(Date.now() / 1000);
				await persistStateToDb();
				schedulerEvents.emit("log_backfill_completed");
				return { fetched: totalFetched, completed: true };
			}

			totalFetched += logs.length;
			await saveLogsToDatabase(logs);

			let oldestInBatch = currentTo ?? Math.floor(Date.now() / 1000);
			let newestInBatch = 0;

			for (const log of logs) {
				if (log.timestamp < oldestInBatch) {
					oldestInBatch = log.timestamp;
				}
				if (log.timestamp > newestInBatch) {
					newestInBatch = log.timestamp;
				}
			}

			inMemoryState.backfillLogsCount += logs.length;
			inMemoryState.oldestTimestampReached = oldestInBatch;

			if (
				!inMemoryState.newestTimestampReached ||
				newestInBatch > inMemoryState.newestTimestampReached
			) {
				inMemoryState.newestTimestampReached = newestInBatch;
			}

			currentTo = oldestInBatch - 1;
		}

		inMemoryState.lastBackfillCheckedAt = Math.floor(Date.now() / 1000);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		inMemoryState.backfillStatus = "error";
		inMemoryState.lastError = `Backfill error: ${errorMessage}`;
		logger.error("Failed historical backfill sync:", error);
	}

	return { fetched: totalFetched, completed: false };
}

/**
 * Main Log Manager Cycle.
 * Runs Real-time Forward Polling and Historical Backfill concurrently within each scheduled interval.
 * Returns a fast next-run timestamp (5s) while backfill is actively in progress.
 */
export async function runLogSyncCycle(): Promise<number | undefined> {
	if (isCycleRunning) {
		logger.warn(
			"Log sync cycle is already executing. Skipping concurrent tick.",
		);
		return;
	}

	isCycleRunning = true;
	const startTime = Date.now();

	try {
		if (!isStateLoaded) await loadStateFromDb();

		// Apply any IPC-requested reset before running syncs. Consuming it here
		// (under the isCycleRunning lock) guarantees the reset never mutates
		// state mid-cycle, and that a forced re-run right after picks it up.
		if (pendingResetRequest) {
			pendingResetRequest = false;
			logger.info("Applying requested Log Manager state reset.");
			await resetLogManagerState();
		}

		const personalKey = await getPersonalKey();
		if (!personalKey) {
			logger.warn(
				"No personal API key available for personal log manager. Skipping.",
			);
			inMemoryState.status = "idle";
			return;
		}

		inMemoryState.status = "running";
		// 1. Run Real-time Forward Sync (New events) only if CADENCE_SEC (60s) has elapsed
		const nowSec = Math.floor(Date.now() / 1000);
		const shouldPollForward =
			!inMemoryState.lastForwardCheckedAt ||
			nowSec - inMemoryState.lastForwardCheckedAt >= CADENCE_SEC;

		const forwardPromise = shouldPollForward
			? syncForwardLogs({ maxPages: 3 })
			: Promise.resolve({ fetched: 0, newLogs: 0 });

		// 2. Run Historical Backfill (Burst of older historical events) if not yet completed
		const backfillPromise =
			inMemoryState.backfillStatus !== "completed" &&
			inMemoryState.backfillStatus !== "paused"
				? syncHistoricalBackfill(DEFAULT_BURST_PAGES)
				: Promise.resolve({
						fetched: 0,
						completed: inMemoryState.backfillStatus === "completed",
					});

		// 3. Process any pending/running manual range resync job
		const resyncPromise = processResyncBurst(RESYNC_BURST_PAGES);

		// Execute both alongside each other
		const [forwardResult, backfillResult, resyncFetched] = await Promise.all([
			forwardPromise,
			backfillPromise,
			resyncPromise,
		]);

		const elapsedMs = Date.now() - startTime;
		inMemoryState.lastSyncDurationMs = elapsedMs;
		inMemoryState.status =
			backfillResult.completed && inMemoryState.forwardStatus !== "error"
				? "completed"
				: "idle";

		if (
			forwardResult.fetched > 0 ||
			backfillResult.fetched > 0 ||
			resyncFetched > 0
		) {
			logger.info(
				`Log sync cycle complete (${elapsedMs}ms): +${forwardResult.fetched} forward logs, +${backfillResult.fetched} backfill logs, +${resyncFetched} resync logs.`,
			);
		}

		await persistStateToDb();

		const isResyncActive = inMemoryResyncJob?.status === "running";

		// Accelerate cadence while historical backfill or a resync job is actively in progress
		if (
			(inMemoryState.backfillStatus === "in_progress" &&
				!backfillResult.completed) ||
			isResyncActive
		) {
			return Date.now() + ACTIVE_BACKFILL_CADENCE_MS;
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		inMemoryState.status = "error";
		inMemoryState.lastError = errorMessage;
		logger.error("Failed log sync cycle execution:", error);
		await persistStateToDb();
	} finally {
		isCycleRunning = false;
	}
}

/**
 * Returns the current live in-memory state of the Log Manager.
 */
export function getLogManagerState(): LogManagerState {
	return { ...inMemoryState };
}

/**
 * Returns the current in-memory resync job (if any).
 */
export function getResyncJob(): ResyncJob | null {
	return inMemoryResyncJob ? { ...inMemoryResyncJob } : null;
}

/**
 * Pauses or resumes the historical backfill process.
 */
export async function setBackfillPaused(
	paused: boolean,
): Promise<LogManagerState> {
	if (!isStateLoaded) await loadStateFromDb();

	if (paused) {
		if (inMemoryState.backfillStatus !== "completed") {
			inMemoryState.backfillStatus = "paused";
		}
	} else {
		if (inMemoryState.backfillStatus === "paused") {
			inMemoryState.backfillStatus = "in_progress";
		}
	}

	await persistStateToDb();
	return getLogManagerState();
}

/**
 * Queues a Log Manager state reset request. The reset is applied atomically at
 * the start of the next sync cycle (see runLogSyncCycle) so it can never mutate
 * state mid-cycle while forward/backfill/resync bursts are in flight.
 */
export function requestResetLogManager(): void {
	pendingResetRequest = true;
}

/**
 * Resets the Log Manager state to defaults and restarts historical backfill from the present (now).
 * Sets `oldestTimestampReached` to null so the backfill begins from `now` and paginates backward
 * across all log history, re-parsing and inserting any missed records into SQLite via upsert without wiping the DB.
 */
export async function resetLogManagerState(): Promise<LogManagerState> {
	const previous = inMemoryState;

	const nextState: LogManagerState = {
		...DEFAULT_STATE,
		backfillStatus: "in_progress",
		oldestTimestampReached: null,
		newestTimestampReached: previous.newestTimestampReached ?? null,
		updatedAt: new Date().toISOString(),
	};

	try {
		const stats = await db
			.select({
				count: sql<number>`count(${personalLogs.id})`,
				maxTs: sql<number>`max(${personalLogs.timestamp})`,
			})
			.from(personalLogs)
			.get();

		if (stats?.count) {
			nextState.totalLogsRecorded = stats.count;
		}
		if (!nextState.newestTimestampReached && stats?.maxTs) {
			nextState.newestTimestampReached = stats.maxTs;
		}
	} catch (error) {
		logger.error("Failed to read log stats during reset:", error);
	}

	inMemoryState = nextState;
	await persistStateToDb();
	return getLogManagerState();
}

/**
 * Manual range re-sync utility for manual data repair or diagnostics.
 */
export async function resyncLogsRange(
	from: number,
	to: number,
): Promise<{ fetched: number; newLogs: number }> {
	const personalKey = await getPersonalKey();
	if (!personalKey) throw new Error("No personal API key available.");

	logger.info(`Manual log resync requested for range: ${from} to ${to}`);
	let currentTo = to + 1; // Torn v2's `to` is exclusive
	let totalFetched = 0;
	let totalNew = 0;

	while (currentTo > from) {
		const res = (await tornApi.getPersonal("/user/log", {
			queryParams: { from, to: currentTo, limit: 100 },
		})) as UserLogsResponse;

		const logs = res.log ?? [];
		if (logs.length === 0) break;

		totalFetched += logs.length;
		await saveLogsToDatabase(logs);

		let minTimestamp = logs[0]?.timestamp ?? currentTo;
		for (const log of logs) {
			if (log.timestamp < minTimestamp) {
				minTimestamp = log.timestamp;
			}
			totalNew++;
		}

		if (minTimestamp <= from || logs.length < 100) break;
		if (minTimestamp >= currentTo) break;
		currentTo = minTimestamp;
	}

	logger.info(
		`Manual resync complete for range ${from}-${to}. Fetched: ${totalFetched}, Parsed: ${totalNew}`,
	);
	return { fetched: totalFetched, newLogs: totalNew };
}

/**
 * Initializes and registers the personal log manager worker.
 */
export function startLogManager(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: runLogSyncCycle,
	});
}
