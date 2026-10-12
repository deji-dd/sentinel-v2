/**
 * Rebuilds the isolated test database from the development database.
 *
 * `bun test` is pinned to this database by `scripts/test-preload.ts`, so this
 * script is what keeps it realistic: the suites read Torn reference data
 * (`torn_items`, `torn_gyms`, `torn_crimes`, `factions`, …) and there is no seed
 * script to regenerate it, so the schema and reference rows are cloned from the
 * development database instead.
 *
 * The bulk ledger tables are deliberately excluded — `personal_logs` alone is
 * ~300 MB of history no test asserts against, and copying it turns a
 * sub-second setup into a multi-minute one. `crime_logs` is excluded for the
 * same reason. Everything else (reference data, config rows, small ledgers) is
 * copied so tests see a faithful baseline.
 *
 * Usage: bun run test:db:setup
 *
 * Safe to re-run. The service database is only ever read.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Database the running services use. Only ever read, never written. */
const SERVICE_DATABASE = "sentinel_db";

/** Disposable database tests are pinned to. */
const TEST_DATABASE =
	process.env.SENTINEL_TEST_DATABASE?.trim() || "sentinel_test_db";

/** Ledger tables skipped to keep the clone small; no suite asserts on them. */
const EXCLUDED_TABLE_DATA = ["personal_logs", "crime_logs"];

if (TEST_DATABASE === SERVICE_DATABASE) {
	throw new Error(
		`Refusing to rebuild '${SERVICE_DATABASE}' as the test database; it holds live service data.`,
	);
}

/**
 * Resolves a connection setting from the environment, falling back to
 * `.env.development` the same way the services do when they are not running
 * under Docker.
 */
function resolveSetting(key: string, fallback: string): string {
	const fromEnv = process.env[key];
	if (fromEnv && fromEnv.length > 0) return fromEnv;

	const envPath = resolve(process.cwd(), ".env.development");
	if (existsSync(envPath)) {
		const match = readFileSync(envPath, "utf-8").match(
			new RegExp(`^${key}=["']?([^"'\\r\\n]+)["']?`, "m"),
		);
		if (match?.[1]) return match[1].trim();
	}
	return fallback;
}

const host = resolveSetting("POSTGRES_HOST", "/tmp");
const port = resolveSetting("POSTGRES_PORT", "5432");
const user = resolveSetting("POSTGRES_USER", "sentinel_user");
const password = resolveSetting("POSTGRES_PASSWORD", "");

/** Runs a command through psql/pg_dump, surfacing stderr on failure. */
function run(
	command: string,
	args: string[],
	options: { input?: string } = {},
): { stdout: string; stderr: string; status: number } {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		input: options.input,
		maxBuffer: 128 * 1024 * 1024,
		env: { ...process.env, PGPASSWORD: password, PGHOST: host, PGPORT: port },
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? 1,
	};
}

/** Runs psql against a database, throwing on any error. */
function psql(database: string, args: string[], input?: string): string {
	const result = run(
		"psql",
		[
			"-h",
			host,
			"-p",
			port,
			"-U",
			user,
			"-d",
			database,
			"-q",
			// Without this psql keeps going after an error and, under
			// --single-transaction, rolls the whole restore back while still
			// exiting 0 — a silently empty clone.
			"-v",
			"ON_ERROR_STOP=1",
			...args,
		],
		{ input },
	);
	if (result.status !== 0) {
		throw new Error(`psql (${database}) failed:\n${result.stderr}`);
	}
	return result.stdout;
}

console.log(
	`[test-db] Cloning '${SERVICE_DATABASE}' -> '${TEST_DATABASE}' ` +
		`(excluding ${EXCLUDED_TABLE_DATA.join(", ")})`,
);

// The script needs the database to already exist. Creating one requires
// CREATEDB, which the application role deliberately does not have, so this
// fails with an actionable message rather than a raw permission error.
const probe = run("psql", [
	"-h",
	host,
	"-p",
	port,
	"-U",
	user,
	"-d",
	TEST_DATABASE,
	"-q",
	"-c",
	"SELECT 1;",
]);
if (probe.status !== 0) {
	throw new Error(
		`Cannot connect to '${TEST_DATABASE}' as '${user}'.\n` +
			"Create it once as a role that can create databases, e.g.:\n" +
			`  psql -d postgres -c "CREATE DATABASE ${TEST_DATABASE} OWNER ${user};"\n\n` +
			`psql said:\n${probe.stderr}`,
	);
}

// Reset rather than DROP/CREATE the database: the application role owns this
// database but has no CREATEDB, and clearing the schemas gives the same clean
// slate while staying within its privileges.
//
// `public` must be recreated here because pg_dump treats it as a system schema
// and omits its CREATE statement. `drizzle` must NOT be recreated: the dump
// emits `CREATE SCHEMA drizzle` itself, so leaving it in place collides and
// rolls the whole restore back.
psql(TEST_DATABASE, [
	"-c",
	'DROP SCHEMA IF EXISTS "public" CASCADE; ' +
		'DROP SCHEMA IF EXISTS "drizzle" CASCADE; ' +
		'CREATE SCHEMA "public";',
]);

// Dump and restore as the application role so the clone's objects end up owned
// by it. Dumping as a superuser would leave every table owned by that superuser
// and unreadable to the services' role.
const dump = run("pg_dump", [
	"-h",
	host,
	"-p",
	port,
	"-U",
	user,
	"-d",
	SERVICE_DATABASE,
	"--no-owner",
	"--no-privileges",
	...EXCLUDED_TABLE_DATA.flatMap((table) => [`--exclude-table-data=${table}`]),
]);
if (dump.status !== 0) {
	throw new Error(`pg_dump of '${SERVICE_DATABASE}' failed:\n${dump.stderr}`);
}

psql(TEST_DATABASE, ["--single-transaction"], dump.stdout);

const summary = psql(TEST_DATABASE, [
	"-A",
	"-t",
	"-c",
	"SELECT 'tables=' || count(*) FROM information_schema.tables WHERE table_schema='public';",
]).trim();

console.log(`[test-db] Ready: ${TEST_DATABASE} (${summary})`);
console.log(
	"[test-db] `bun test` targets this database via scripts/test-preload.ts",
);
