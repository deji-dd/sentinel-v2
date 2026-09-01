import { join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDatabase, db } from "../../index";

const migrationsFolder = join(import.meta.dir, "../../drizzle");

try {
	console.log(
		`[Database Migration] Applying migrations from ${migrationsFolder}...`,
	);
	await migrate(db, { migrationsFolder });
	console.log("[Database Migration] Migrations applied successfully.");
} catch (error) {
	console.error("[Database Migration] Migration failed:", error);
	process.exit(1);
} finally {
	await closeDatabase();
}
