import {
	boolean,
	doublePrecision,
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

export const systemMetrics = pgTable("system_metrics", {
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
});
