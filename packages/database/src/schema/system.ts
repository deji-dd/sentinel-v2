import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workerSchedules = sqliteTable("worker_schedules", {
	id: text("id").primaryKey(),
	cadenceSeconds: integer("cadence_seconds").default(86400).notNull(),
	lastRunAt: integer("last_run_at", { mode: "timestamp" }),
	nextRunAt: integer("next_run_at", { mode: "timestamp" }),
	forceRun: integer("force_run", { mode: "boolean" }).default(false).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const systemStates = sqliteTable("system_states", {
	id: text("id").primaryKey(),
	init: integer("init", { mode: "boolean" }).default(false).notNull(),
	data: text("data", { mode: "json" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const systemAlerts = sqliteTable("system_alerts", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	component: text("component").notNull(),
	message: text("message").notNull(),
	isRead: integer("is_read", { mode: "boolean" }).default(false).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }),
});

export const sensorReadings = sqliteTable("sensor_readings", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	deviceId: text("device_id").notNull(),
	temperatureC: real("temperature_c").notNull(),
	ph: real("ph").notNull(),
	turbidityNtu: real("turbidity_ntu").notNull(),
	pondLevelPct: integer("pond_level_pct").notNull(),
	pumpInActive: integer("pump_in_active", { mode: "boolean" }).notNull(),
	pumpDrainActive: integer("pump_drain_active", { mode: "boolean" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const deviceControls = sqliteTable("device_controls", {
	deviceId: text("device_id").primaryKey(),
	manualMode: integer("manual_mode", { mode: "boolean" })
		.default(false)
		.notNull(),
	pumpIn: integer("pump_in", { mode: "boolean" }).default(false).notNull(),
	pumpDrain: integer("pump_drain", { mode: "boolean" })
		.default(false)
		.notNull(),
	simulateBreach: integer("simulate_breach", { mode: "boolean" })
		.default(false)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const systemMetrics = sqliteTable("system_metrics", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	serviceId: text("service_id").notNull(),
	serviceName: text("service_name").notNull(),
	status: text("status").notNull(),
	cpuUsage: real("cpu_usage").notNull(),
	memoryRssBytes: integer("memory_rss_bytes").notNull(),
	memoryHeapUsedBytes: integer("memory_heap_used_bytes").notNull(),
	memoryHeapTotalBytes: integer("memory_heap_total_bytes").notNull(),
	latencyMs: integer("latency_ms").notNull(),
	uptimeSeconds: integer("uptime_seconds").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});
