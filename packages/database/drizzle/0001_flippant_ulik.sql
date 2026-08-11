CREATE TABLE `faction_role_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`faction_id` integer NOT NULL,
	`faction_name` text,
	`member_role_ids` text DEFAULT '[]' NOT NULL,
	`leader_role_ids` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `guild_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` integer,
	`api_key_encrypted` text NOT NULL,
	`api_key_hash` text NOT NULL,
	`provided_by` text,
	`is_valid` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guild_api_keys_api_key_hash_unique` ON `guild_api_keys` (`api_key_hash`);--> statement-breakpoint
CREATE TABLE `reaction_role_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`emoji` text NOT NULL,
	`role_id` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reaction_role_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`title` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`required_role_id` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reaction_role_messages_message_id_unique` ON `reaction_role_messages` (`message_id`);--> statement-breakpoint
CREATE TABLE `verification_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`discord_id` text NOT NULL,
	`status` text NOT NULL,
	`triggered_by` text DEFAULT 'user' NOT NULL,
	`roles_added` text DEFAULT '[]' NOT NULL,
	`roles_removed` text DEFAULT '[]' NOT NULL,
	`old_nickname` text,
	`new_nickname` text,
	`error` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_controls` (
	`device_id` text PRIMARY KEY NOT NULL,
	`manual_mode` integer DEFAULT false NOT NULL,
	`pump_in` integer DEFAULT false NOT NULL,
	`pump_drain` integer DEFAULT false NOT NULL,
	`simulate_breach` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sensor_readings` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`temperature_c` real NOT NULL,
	`ph` real NOT NULL,
	`turbidity_ntu` real NOT NULL,
	`pond_level_pct` integer NOT NULL,
	`pump_in_active` integer NOT NULL,
	`pump_drain_active` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`cadence_seconds` integer DEFAULT 86400 NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`force_run` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_guild_configs` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`log_channel_id` text,
	`admin_role_ids` text DEFAULT '[]' NOT NULL,
	`enabled_modules` text DEFAULT '[]' NOT NULL,
	`verified_role_ids` text DEFAULT '[]' NOT NULL,
	`nickname_template` text DEFAULT '[{tag}] {name} [{id}]',
	`verify_on_join` integer DEFAULT false NOT NULL,
	`verify_cron` integer DEFAULT false NOT NULL,
	`verify_cron_interval` integer DEFAULT 24 NOT NULL,
	`last_verify_cron_at` integer,
	`protected_role_ids` text DEFAULT '[]' NOT NULL,
	`faction_list_channel_id` text,
	`faction_list_message_ids` text DEFAULT '[]' NOT NULL,
	`tt_full_channel_id` text,
	`tt_filtered_channel_id` text,
	`tt_territory_ids` text DEFAULT '[]' NOT NULL,
	`tt_faction_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_guild_configs`("guild_id", "log_channel_id", "admin_role_ids", "enabled_modules", "verified_role_ids", "nickname_template", "verify_on_join", "verify_cron", "verify_cron_interval", "last_verify_cron_at", "protected_role_ids", "faction_list_channel_id", "faction_list_message_ids", "tt_full_channel_id", "tt_filtered_channel_id", "tt_territory_ids", "tt_faction_ids", "created_at", "updated_at") SELECT "guild_id", "log_channel_id", "admin_role_ids", "enabled_modules", "verified_role_ids", "nickname_template", "verify_on_join", "verify_cron", "verify_cron_interval", "last_verify_cron_at", "protected_role_ids", "faction_list_channel_id", "faction_list_message_ids", "tt_full_channel_id", "tt_filtered_channel_id", "tt_territory_ids", "tt_faction_ids", "created_at", "updated_at" FROM `guild_configs`;--> statement-breakpoint
DROP TABLE `guild_configs`;--> statement-breakpoint
ALTER TABLE `__new_guild_configs` RENAME TO `guild_configs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_verified_users` (
	`discord_id` text PRIMARY KEY NOT NULL,
	`torn_id` integer NOT NULL,
	`torn_name` text NOT NULL,
	`faction_id` integer,
	`faction_tag` text,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_verified_users`("discord_id", "torn_id", "torn_name", "faction_id", "faction_tag", "updated_at") SELECT "discord_id", "torn_id", "torn_name", "faction_id", "faction_tag", "updated_at" FROM `verified_users`;--> statement-breakpoint
DROP TABLE `verified_users`;--> statement-breakpoint
ALTER TABLE `__new_verified_users` RENAME TO `verified_users`;--> statement-breakpoint
CREATE TABLE `__new_system_states` (
	`id` text PRIMARY KEY NOT NULL,
	`init` integer DEFAULT false NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_system_states`("id", "init", "data", "created_at", "updated_at") SELECT "id", "init", "data", "created_at", "updated_at" FROM `system_states`;--> statement-breakpoint
DROP TABLE `system_states`;--> statement-breakpoint
ALTER TABLE `__new_system_states` RENAME TO `system_states`;