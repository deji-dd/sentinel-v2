import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, db, sqlClient } from "../../index";

const migrationsFolder = join(import.meta.dir, "../../drizzle");

interface JournalEntry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

interface Journal {
	version: string;
	dialect: string;
	entries: JournalEntry[];
}

try {
	console.log(
		`[Database Migration] Applying migrations from ${migrationsFolder}...`,
	);

	// Check if database was already initialized with the baseline schema before migration tracking
	const [tableCheck] = (await sqlClient`
		SELECT EXISTS (
			SELECT FROM information_schema.tables 
			WHERE table_schema = 'public' AND table_name = 'api_keys'
		) as exists
	`) as unknown as [{ exists?: boolean } | undefined];

	if (tableCheck?.exists) {
		await sqlClient`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
		await sqlClient`
			CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)
		`;

		const [migrationRecord] = (await sqlClient`
			SELECT count(*)::int as count FROM "drizzle"."__drizzle_migrations"
		`) as unknown as [{ count?: number } | undefined];

		if ((migrationRecord?.count ?? 0) === 0) {
			console.log(
				"[Database Migration] Existing baseline schema detected without migration tracking. Baselining 0000_nappy_katie_power...",
			);
			const journalPath = join(migrationsFolder, "meta/_journal.json");
			const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as Journal;
			const initialEntry = journal.entries[0];
			if (initialEntry) {
				const initialSql = readFileSync(
					join(migrationsFolder, `${initialEntry.tag}.sql`),
					"utf-8",
				);
				const hash = createHash("sha256").update(initialSql).digest("hex");
				await sqlClient`
					INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
					VALUES (${hash}, ${initialEntry.when})
				`;
				console.log(
					`[Database Migration] Baselined ${initialEntry.tag} (${initialEntry.when}).`,
				);
			}
		}
	}

	await migrate(db, { migrationsFolder });
	console.log("[Database Migration] Migrations applied successfully.");
} catch (error) {
	console.error("[Database Migration] Migration failed:", error);
	process.exit(1);
} finally {
	await closeDatabase();
}
