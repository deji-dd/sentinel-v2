import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../index";

describe("@sentinel/database Integration Tests", () => {
	test("database accepts raw queries", async () => {
		const result = await db.execute<{ status: number }>(
			sql`SELECT 1 as status`,
		);
		expect(result[0]?.status).toBe(1);
	});

	test("migrations create expected schema tables", async () => {
		const tables = await db.execute<{ table_name: string }>(
			sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
		);

		const tableNames = tables.map((t) => t.table_name);
		expect(tableNames.length).toBeGreaterThan(0);
		expect(tableNames).toContain("api_keys");
		expect(tableNames).toContain("system_states");
	});

	test("schema query execution smoke test", async () => {
		const states = await db.query.systemStates.findMany({ limit: 1 });
		expect(Array.isArray(states)).toBe(true);
	});
});
