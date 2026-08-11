CREATE TABLE `system_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`component` text NOT NULL,
	`message` text NOT NULL,
	`is_read` integer DEFAULT false NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_verified_users` (
	`discord_id` text PRIMARY KEY NOT NULL,
	`torn_id` integer NOT NULL,
	`torn_name` text NOT NULL,
	`faction_id` integer,
	`faction_tag` text,
	`last_checked_at` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_verified_users`("discord_id", "torn_id", "torn_name", "faction_id", "faction_tag", "last_checked_at", "created_at", "updated_at") SELECT "discord_id", "torn_id", "torn_name", "faction_id", "faction_tag", "last_checked_at", "created_at", "updated_at" FROM `verified_users`;--> statement-breakpoint
DROP TABLE `verified_users`;--> statement-breakpoint
ALTER TABLE `__new_verified_users` RENAME TO `verified_users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;