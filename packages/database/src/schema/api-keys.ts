import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const apiKeys = pgTable("api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: integer("user_id").notNull(),
	apiKeyEncrypted: text("api_key_encrypted").notNull(),
	apiKeyHash: text("api_key_hash").notNull().unique(),
	keyType: text("key_type").default("personal").notNull(),
	isValid: boolean("is_valid").default(true).notNull(),
	invalidCount: integer("invalid_count").default(0).notNull(),
	lastInvalidAt: timestamp("last_invalid_at", {
		withTimezone: true,
		mode: "date",
	}),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});
