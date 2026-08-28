import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth";

export interface MapLabel {
	id: string;
	text: string;
	color: string;
	enabled: boolean;
	territories: string[];
	respect: number;
	sectors: number;
	rackets: number;
}

export const userMaps = sqliteTable("user_maps", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: integer("user_id")
		.references(() => users.id, { onDelete: "cascade" })
		.notNull(),
	name: text("name").notNull(),
	labels: text("labels", { mode: "json" })
		.$type<MapLabel[]>()
		.default([])
		.notNull(),
	assignments: text("assignments", { mode: "json" })
		.$type<Record<string, string>>()
		.default({})
		.notNull(),
	isPublic: integer("is_public", { mode: "boolean" }).default(false).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});
