import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./src/schema";

/**
 * Connection pool options.
 *
 * `idle_timeout` is deliberately 0 (never close an idle connection). postgres.js
 * keeps its prepared-statement cache per connection and wipes it on every
 * reconnect, so a short idle timeout made every worker on a 30s/60s/5min cadence
 * reconnect into an empty cache and re-pay a Parse+Describe round trip per
 * distinct query shape, on every cycle.
 *
 * `statement_timeout` bounds a pathological query so it can never pin one of the
 * pool slots indefinitely.
 */
const POOL_OPTIONS = {
	max: 10,
	idle_timeout: 0,
	connection: { statement_timeout: 30_000 },
} as const;

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
		const socketMatch = customUrl.match(/@(%2[fF][^/]+)/);
		const socketHost = socketMatch
			? decodeURIComponent(socketMatch[1] ?? "")
			: undefined;
		return postgres(customUrl, {
			...(socketHost ? { host: socketHost } : {}),
			...POOL_OPTIONS,
		});
	}

	return postgres({
		host,
		port,
		database,
		username,
		password,
		...POOL_OPTIONS,
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
	ne,
	or,
	type SQL,
	sql,
} from "drizzle-orm";

// Table/column type helpers for generic helpers (e.g. batched retention deletes)
export type { PgColumn, PgTable } from "drizzle-orm/pg-core";

// Export schema for queries and types
export * from "./src/lib/alerts";
export * from "./src/lib/elims-stock";
export * from "./src/lib/ffscouter-cache";
export * from "./src/lib/guilds";
export * from "./src/schema";
