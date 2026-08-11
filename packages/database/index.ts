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
sqlite.run("PRAGMA cache_size = -64000;");
sqlite.run("PRAGMA temp_store = MEMORY;");
sqlite.run("PRAGMA mmap_size = 268435456;");
sqlite.run("PRAGMA busy_timeout = 5000;");
sqlite.run("PRAGMA foreign_keys = ON;");

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
	sql,
} from "drizzle-orm";
// Export schema for queries and types
export * from "./src/lib/alerts";
export * from "./src/schema";
