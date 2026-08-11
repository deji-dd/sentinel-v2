import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const dbPath = join(import.meta.dir, "../../../../data/sentinel.db");

mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

const migrationsFolder = join(import.meta.dir, "../../drizzle");

try {
	migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
	console.log("Migrations applied successfully.");
} catch (error) {
	console.error("Migration failed:", error);
	process.exit(1);
} finally {
	sqlite.close();
}
