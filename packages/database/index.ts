import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./src/schema";

const dbPath = join(import.meta.dir, "../../data/sentinel.db");

mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);

sqlite.run("PRAGMA journal_mode = WAL;");
sqlite.run("PRAGMA synchronous = NORMAL;");
sqlite.run("PRAGMA cache_size = -8000;");
sqlite.run("PRAGMA temp_store = MEMORY;");
sqlite.run("PRAGMA mmap_size = 33554432;");
sqlite.run("PRAGMA busy_timeout = 5000;");
sqlite.run("PRAGMA foreign_keys = ON;");

// Safe migrations / table creations if not present
try {
	sqlite.run("ALTER TABLE users ADD COLUMN avatar TEXT;");
} catch {
	// Column already exists
}

try {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS system_metrics (
			id TEXT PRIMARY KEY,
			service_id TEXT NOT NULL,
			service_name TEXT NOT NULL,
			status TEXT NOT NULL,
			cpu_usage REAL NOT NULL,
			memory_rss_bytes INTEGER NOT NULL,
			memory_heap_used_bytes INTEGER NOT NULL,
			memory_heap_total_bytes INTEGER NOT NULL,
			latency_ms INTEGER NOT NULL,
			uptime_seconds INTEGER NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
		);
	`);
	sqlite.run(
		"CREATE INDEX IF NOT EXISTS idx_system_metrics_created_at ON system_metrics (created_at);",
	);
	sqlite.run(
		"CREATE INDEX IF NOT EXISTS idx_system_metrics_service_created ON system_metrics (service_id, created_at);",
	);
} catch {
	// Table/indexes already exist
}

// Export active drizzle client

export const db = drizzle(sqlite, { schema });

/**
 * Explicitly flushes WAL logs and closes the SQLite database connection.
 */
export function closeDatabase(): void {
	sqlite.close();
}

// Re-export common Drizzle query operators to ensure single-version type compatibility
export {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
// Export schema for queries and types
export * from "./src/lib/alerts";
export * from "./src/lib/guilds";
export * from "./src/schema";
