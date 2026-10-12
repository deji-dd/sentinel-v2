/**
 * Test-run preload: pins every `bun test` process to the isolated test database.
 *
 * Why this exists
 * ---------------
 * `bun test` used to connect to whatever database the ambient environment
 * pointed at, which in development is the same `sentinel_db` the running
 * services use. Several suites mutate configuration rows in place rather than
 * creating their own fixtures, so a test run could destroy live config:
 *
 *   - `services/bot/tests/live-data.test.ts` deleted the real
 *     `elims:guild_config` row before and after its run.
 *   - `services/bot/tests/assigned-stock.test.ts` overwrote the real
 *     `elims:item_requests_config` row with `{managerRoleIds:[...]}` and never
 *     restored it.
 *
 * The live row for `elims:item_requests_config` was found matching that test's
 * payload exactly, and `elims:guild_config` was missing entirely.
 *
 * This preload runs before any test module (and therefore before
 * `@sentinel/database` builds its connection pool at import time), so the
 * redirect is in place before a single query is issued.
 *
 * Creating/refreshing the test database
 * -------------------------------------
 * `bun run test:db:setup` clones the development database's schema and
 * reference data into `sentinel_test_db`, excluding the bulk ledger tables
 * (`personal_logs`, `crime_logs`) that tests do not need.
 *
 * Overriding
 * ----------
 * Set `SENTINEL_TEST_DATABASE` to target a different database. Pointing tests at
 * the service database is refused outright rather than silently allowed,
 * because that is the failure this file exists to prevent.
 */

/** Database the running services use. Tests must never write here. */
const SERVICE_DATABASE = "sentinel_db";

/** Isolated database that tests are pinned to. */
const DEFAULT_TEST_DATABASE = "sentinel_test_db";

const requested = process.env.SENTINEL_TEST_DATABASE?.trim();
const testDatabase =
	requested && requested.length > 0 ? requested : DEFAULT_TEST_DATABASE;

if (testDatabase === SERVICE_DATABASE) {
	throw new Error(
		`Refusing to run tests against '${SERVICE_DATABASE}': it is the database the ` +
			"running services use, and several suites overwrite configuration rows " +
			"in place. Set SENTINEL_TEST_DATABASE to a disposable database instead.",
	);
}

// `createSqlClient` prefers DATABASE_URL over POSTGRES_*, so an explicit URL
// would silently win and defeat the redirect. Fail loudly instead of testing
// against an unknown target.
if (process.env.DATABASE_URL) {
	const target = process.env.DATABASE_URL.split("?")[0] ?? "";
	if (target.endsWith(`/${SERVICE_DATABASE}`)) {
		throw new Error(
			`DATABASE_URL points at '${SERVICE_DATABASE}', the service database. ` +
				"Unset it or point it at a disposable database before running tests.",
		);
	}
} else {
	process.env.POSTGRES_DB = testDatabase;
}

if (process.env.NODE_ENV !== "test") {
	process.env.NODE_ENV = "test";
}
