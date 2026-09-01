import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./src/schema";

export function createSqlClient(): postgres.Sql {
	const customUrl = process.env.DATABASE_URL;
	const defaultHost = existsSync("/var/run/postgresql")
		? "/var/run/postgresql"
		: existsSync("/tmp/.s.PGSQL.5432")
			? "/tmp"
			: "localhost";
	const host = process.env.POSTGRES_HOST || defaultHost;
	const database = process.env.POSTGRES_DB || "sentinel_db";
	const username = process.env.POSTGRES_USER || "sentinel_user";
	const password =
		process.env.POSTGRES_PASSWORD ||
		"e63af385d45ae76c4a8b90b995c2cf1d8c0cf6ca444d3985";
	const port = Number(process.env.POSTGRES_PORT || 5432);

	if (customUrl) {
		return postgres(customUrl, { max: 10, idle_timeout: 20 });
	}

	return postgres({
		host,
		port,
		database,
		username,
		password,
		max: 10,
		idle_timeout: 20,
	});
}

export const sqlClient = createSqlClient();
export const db = drizzle(sqlClient, { schema });

/**
 * Gracefully closes the PostgreSQL connection pool.
 */
export async function closeDatabase(): Promise<void> {
	await sqlClient.end({ timeout: 5 });
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
	ilike,
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
