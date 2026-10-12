import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const workerSchedules = pgTable("worker_schedules", {
	id: text("id").primaryKey(),
	cadenceSeconds: integer("cadence_seconds").default(86400).notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "date" }),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: "date" }),
	forceRun: boolean("force_run").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const systemStates = pgTable("system_states", {
	id: text("id").primaryKey(),
	init: boolean("init").default(false).notNull(),
	data: jsonb("data"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

/**
 * Persisted state for background workers: progress cursors, run status, and
 * first-run flags.
 *
 * This is the sanctioned home for ephemeral worker state (see the persisted-state
 * rules in `.agents/AGENTS.md`). It replaces the remaining `system_states` cursor
 * keys — `personal:log_manager`, `personal:log_manager_resync`,
 * `subversive:recruitment_state`, `tt_init_state` and
 * `war_ledger_init_state` — so that the legacy blob table can eventually be
 * dropped entirely.
 *
 * The columns are the fields workers actually *read*: `init` gates first-run
 * behaviour, `status` and `last_error` are surfaced to the dashboard, and
 * `cursor` is the progress watermark. Everything else a given worker records
 * (batch counters, page counts, per-phase sub-status) goes in `details`.
 *
 * `details` is deliberately the only JSON here, and it is constrained to a JSON
 * *object*. The legacy blob had no such constraint, which is how rows ended up
 * double-encoded — JSON stored as a JSON string — and every reader then silently
 * fell back to a default. **Configuration must never be stored in `details`**;
 * it belongs in a typed table.
 */
export const workerState = pgTable(
	"worker_state",
	{
		/** Stable worker or flag id, e.g. `personal:log_manager`. */
		workerId: text("worker_id").primaryKey(),
		/**
		 * First-run gate. Several workers treat a false value as "never
		 * completed an initial pass" and replay history when it flips, so it is
		 * a typed column rather than something buried in `details`.
		 */
		init: boolean("init").default(false).notNull(),
		/** Worker-specific status string (`idle`, `running`, `completed`, `error`…). */
		status: text("status"),
		lastError: text("last_error"),
		/** Progress watermark: epoch seconds for log workers, a row cursor elsewhere. */
		cursor: bigint("cursor", { mode: "number" }),
		/** When the worker last completed a pass. */
		lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "date" }),
		/** Worker-specific counters and sub-status. Never configuration. */
		details: jsonb("details")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// Rejects the double-encoded payloads the legacy blob accepted silently.
		check(
			"worker_state_details_is_object",
			sql`jsonb_typeof(${table.details}) = 'object'`,
		),
	],
);

export type WorkerStateRow = typeof workerState.$inferSelect;
export type NewWorkerStateRow = typeof workerState.$inferInsert;

export const systemAlerts = pgTable("system_alerts", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	component: text("component").notNull(),
	message: text("message").notNull(),
	isRead: boolean("is_read").default(false).notNull(),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "date",
	}).defaultNow(),
});

export const sensorReadings = pgTable("sensor_readings", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	deviceId: text("device_id").notNull(),
	temperatureC: doublePrecision("temperature_c").notNull(),
	ph: doublePrecision("ph").notNull(),
	turbidityNtu: doublePrecision("turbidity_ntu").notNull(),
	pondLevelPct: integer("pond_level_pct").notNull(),
	pumpInActive: boolean("pump_in_active").notNull(),
	pumpDrainActive: boolean("pump_drain_active").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const deviceControls = pgTable("device_controls", {
	deviceId: text("device_id").primaryKey(),
	manualMode: boolean("manual_mode").default(false).notNull(),
	pumpIn: boolean("pump_in").default(false).notNull(),
	pumpDrain: boolean("pump_drain").default(false).notNull(),
	simulateBreach: boolean("simulate_breach").default(false).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const systemMetrics = pgTable(
	"system_metrics",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		serviceId: text("service_id").notNull(),
		serviceName: text("service_name").notNull(),
		status: text("status").notNull(),
		cpuUsage: doublePrecision("cpu_usage").notNull(),
		memoryRssBytes: doublePrecision("memory_rss_bytes").notNull(),
		memoryHeapUsedBytes: doublePrecision("memory_heap_used_bytes").notNull(),
		memoryHeapTotalBytes: doublePrecision("memory_heap_total_bytes").notNull(),
		latencyMs: integer("latency_ms").notNull(),
		uptimeSeconds: integer("uptime_seconds").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// Retention pruning deletes by created_at in batches.
		index("idx_system_metrics_created_at").on(table.createdAt),
	],
);
