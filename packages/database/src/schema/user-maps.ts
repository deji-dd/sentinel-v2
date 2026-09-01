import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
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

export const userMaps = pgTable("user_maps", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	userId: integer("user_id")
		.references(() => users.id, { onDelete: "cascade" })
		.notNull(),
	name: text("name").notNull(),
	labels: jsonb("labels").$type<MapLabel[]>().default([]).notNull(),
	assignments: jsonb("assignments")
		.$type<Record<string, string>>()
		.default({})
		.notNull(),
	isPublic: boolean("is_public").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});
