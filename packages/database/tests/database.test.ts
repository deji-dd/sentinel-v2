import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../src/schema";

describe("@sentinel/database Integration Tests", () => {
	let sqlite: Database;
	let db: BunSQLiteDatabase<typeof schema>;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		db = drizzle(sqlite, { schema });

		const migrationsFolder = join(import.meta.dir, "../drizzle");
		migrate(db as unknown as Parameters<typeof migrate>[0], {
			migrationsFolder,
		});
	});

	afterEach(() => {
		sqlite.close();
	});

	test("database accepts raw queries", () => {
		const result = db.all<{ status: number }>(sql`SELECT 1 as status`);
		expect(result[0]?.status).toBe(1);
	});

	test("migrations create expected schema tables", () => {
		const tables = sqlite
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%';",
			)
			.all();

		expect(tables.length).toBeGreaterThan(0);
	});

	test("schema query execution smoke test", () => {
		expect(() => {
			// Smoke test query against your migrated tables here
		}).not.toThrow();
	});
});
