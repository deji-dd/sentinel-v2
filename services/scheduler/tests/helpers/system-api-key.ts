import { apiKeys, db, eq } from "@sentinel/database";
import { clearSystemKeyPoolCache } from "@sentinel/torn-api";

/**
 * A synthetic system API key for scheduler workers under test.
 *
 * Every worker in this service reaches Torn through the shared `tornApi`
 * client, which resolves its credentials from the `api_keys` table: explicitly
 * through the Subversive pool, or — when no Subversive user key is enrolled —
 * through the system key pool. A freshly migrated database, which is what CI
 * runs against, has no rows in that table, so `getSystemKeyPool()` throws
 * `No valid system API keys available in database` and a worker fails before
 * its mocked `fetch` is ever reached.
 *
 * That made the affected tests pass only on a developer machine whose database
 * already held real keys, and fail on every clean checkout. Seeding this row
 * makes them depend on nothing but the schema, and keeps every request mocked.
 *
 * The key is exactly the 16 characters Torn issues on purpose: the key pool
 * hands anything that short back verbatim instead of attempting an AES-GCM
 * decrypt with `ENCRYPTION_KEY`, which is a production secret and is also
 * absent in CI.
 */
export const SYSTEM_TEST_KEY = "sentinel12345678";
export const SYSTEM_TEST_KEY_ID = "test_system_key_scheduler";
export const SYSTEM_TEST_KEY_HASH = "test-system-key-hash-scheduler";
/** Distinct from any other fixture's owner, so rate-limit buckets stay private. */
export const SYSTEM_TEST_KEY_USER_ID = 9_000_009;

/** Arms the key pool with the fixture key, evicting any memoised pool. */
export async function seedSystemApiKey(): Promise<void> {
	await db
		.insert(apiKeys)
		.values({
			id: SYSTEM_TEST_KEY_ID,
			userId: SYSTEM_TEST_KEY_USER_ID,
			apiKeyEncrypted: SYSTEM_TEST_KEY,
			apiKeyHash: SYSTEM_TEST_KEY_HASH,
			keyType: "system",
			isValid: true,
		})
		.onConflictDoUpdate({
			target: apiKeys.id,
			set: {
				userId: SYSTEM_TEST_KEY_USER_ID,
				apiKeyEncrypted: SYSTEM_TEST_KEY,
				apiKeyHash: SYSTEM_TEST_KEY_HASH,
				keyType: "system",
				isValid: true,
			},
		});

	// The pool is memoised for 30s, and these tests freeze the clock, so a pool
	// cached before the seed would outlive it and hide the fixture key.
	clearSystemKeyPoolCache();
}

/** Removes the fixture key so no other suite inherits it. */
export async function removeSystemApiKey(): Promise<void> {
	await db.delete(apiKeys).where(eq(apiKeys.id, SYSTEM_TEST_KEY_ID));
	clearSystemKeyPoolCache();
}
