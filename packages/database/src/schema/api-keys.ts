import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const apiKeys = sqliteTable("api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: integer("user_id").notNull(),
	apiKeyEncrypted: text("api_key_encrypted").notNull(),
	apiKeyHash: text("api_key_hash").notNull().unique(),
	keyType: text("key_type").default("personal").notNull(),
	isValid: integer("is_valid", { mode: "boolean" }).default(true).notNull(),
	invalidCount: integer("invalid_count").default(0).notNull(),
	lastInvalidAt: integer("last_invalid_at", { mode: "timestamp" }),
	lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});
