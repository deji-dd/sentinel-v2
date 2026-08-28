import { db, eq, workerSchedules } from "@sentinel/database";
import { Logger } from "@sentinel/utils";

/**
 * Calculates the next upcoming UTC target epoch timestamp for a given hour and minute (e.g. 3, 0 for 03:00 UTC).
 */
export function getNextUtcTargetTimestamp(hour: number, minute = 0): number {
	const now = new Date();
	const target = new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate(),
			hour,
			minute,
			0,
			0,
		),
	);

	if (now.getTime() >= target.getTime()) {
		target.setUTCDate(target.getUTCDate() + 1);
	}

	return target.getTime();
}

export type EventRunnerConfig = {
	/** Unique string ID / name of the worker job (e.g. 'torn_territory_blueprints_sync') */
	worker: string;
	/** Default execution cadence in seconds */
	defaultCadenceSeconds: number;
	/** Optional initial delay in milliseconds to stagger boot executions */
	initialDelayMs?: number;
	// biome-ignore lint/suspicious/noConfusingVoidType: void is required to support async handlers returning void
	handler: () => Promise<number | boolean | void>;
};

export class ScheduledRunner {
	private config: EventRunnerConfig;
	private logger: Logger;
	private activeTimer: NodeJS.Timeout | null = null;
	private isExecuting = false;
	private isStopped = false;
	/** Set when triggerNow() fires while a cycle is already executing. */
	private forceRunQueued = false;
	private cadenceMs: number;

	private lastPersistedAt = 0;

	constructor(config: EventRunnerConfig) {
		this.config = config;
		this.logger = new Logger(config.worker);
		this.cadenceMs = config.defaultCadenceSeconds * 1000;
	}

	/**
	 * Starts the scheduled execution loop with persistent DB state check.
	 */
	async start(): Promise<void> {
		if (this.isStopped) this.isStopped = false;

		try {
			// 1. Query persistent schedule state from SQLite/Drizzle
			let schedule = await db.query.workerSchedules.findFirst({
				where: eq(workerSchedules.id, this.config.worker),
			});

			const now = Date.now();

			if (!schedule) {
				const [createdSchedule] = await db
					.insert(workerSchedules)
					.values({
						id: this.config.worker,
						cadenceSeconds: this.config.defaultCadenceSeconds,
						nextRunAt: new Date(now),
					})
					.returning();
				schedule = createdSchedule;
			}

			if (!schedule) {
				this.logger.error("Failed to initialize worker schedule state.");
				this.scheduleNext(0);
				return;
			}

			let delayMs = 0;

			// 2. Check if we have a valid future nextRunAt target and no forceRun flag
			if (
				schedule.nextRunAt &&
				schedule.nextRunAt.getTime() > now &&
				!schedule.forceRun
			) {
				delayMs = schedule.nextRunAt.getTime() - now;
			} else if (
				this.config.initialDelayMs &&
				this.config.initialDelayMs > 0 &&
				!schedule.forceRun
			) {
				delayMs = this.config.initialDelayMs;
				this.logger.info(`Staggering boot execution by ${delayMs}ms`);
			}

			this.scheduleNext(delayMs);
		} catch (err) {
			this.logger.error("Failed to load schedule from database:", err);
			// Fallback to immediate execution on DB error
			this.scheduleNext(0);
		}
	}

	private scheduleNext(delayMs: number): void {
		if (this.isStopped) return;
		if (this.activeTimer) clearTimeout(this.activeTimer);

		const safeDelay = Math.max(0, delayMs);
		this.activeTimer = setTimeout(() => this.executeAndReschedule(), safeDelay);
	}

	private async executeAndReschedule(): Promise<void> {
		if (this.isExecuting || this.isStopped) return;
		this.isExecuting = true;

		let customNextRunMs: number | undefined;
		const startTime = Date.now();

		try {
			const result = await this.config.handler();
			if (typeof result === "number") {
				customNextRunMs = result;
			}
		} catch (err) {
			this.logger.error("Worker execution failed:", err);
		} finally {
			this.isExecuting = false;

			if (!this.isStopped) {
				let nextRunTimeMs = customNextRunMs ?? Date.now() + this.cadenceMs;

				// A force-run arrived while this cycle was executing: re-run
				// immediately instead of waiting out the full cadence.
				if (this.forceRunQueued) {
					this.forceRunQueued = false;
					nextRunTimeMs = Date.now();
					this.logger.info(
						"Force-run was queued during execution; re-running immediately.",
					);
				}

				const shouldPersist =
					!this.lastPersistedAt || startTime - this.lastPersistedAt >= 60000;

				if (shouldPersist) {
					this.lastPersistedAt = startTime;
					try {
						await db
							.insert(workerSchedules)
							.values({
								id: this.config.worker,
								cadenceSeconds: this.config.defaultCadenceSeconds,
								lastRunAt: new Date(startTime),
								nextRunAt: new Date(nextRunTimeMs),
								forceRun: false,
								createdAt: new Date(),
								updatedAt: new Date(),
							})
							.onConflictDoUpdate({
								target: workerSchedules.id,
								set: {
									lastRunAt: new Date(startTime),
									nextRunAt: new Date(nextRunTimeMs),
									forceRun: false,
									updatedAt: new Date(),
								},
							});
					} catch (dbErr) {
						this.logger.error("Failed to persist schedule to database:", dbErr);
					}
				}

				const nextDelayMs = Math.max(0, nextRunTimeMs - Date.now());
				this.scheduleNext(nextDelayMs);
			}
		}
	}

	/**
	 * Immediately triggers execution of the worker handler, clearing any pending schedule timer.
	 * If a cycle is already executing, the trigger is queued and consumed right
	 * after the in-flight cycle finishes instead of being silently dropped
	 * (which previously also cancelled the pending schedule timer).
	 */
	triggerNow(): void {
		if (this.isExecuting) {
			this.forceRunQueued = true;
			return;
		}
		this.scheduleNext(0);
	}

	/**
	 * Stops the scheduled runner and clears pending timers.
	 */
	stop(): void {
		this.isStopped = true;
		if (this.activeTimer) {
			clearTimeout(this.activeTimer);
			this.activeTimer = null;
		}
		activeRunners.delete(this.config.worker);
	}
}

const activeRunners = new Map<string, ScheduledRunner>();

/**
 * Helper function to instantiate and start a scheduled runner.
 */
export function startEventDrivenRunner(
	config: EventRunnerConfig,
): ScheduledRunner {
	const runner = new ScheduledRunner(config);
	activeRunners.set(config.worker, runner);
	runner.start();
	return runner;
}

/**
 * Immediately triggers an active in-memory worker runner by its worker name.
 */
export function triggerWorkerByName(workerName: string): boolean {
	const runner = activeRunners.get(workerName);
	if (runner) {
		runner.triggerNow();
		return true;
	}
	return false;
}
