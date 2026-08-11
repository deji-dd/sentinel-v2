CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`api_key_hash` text NOT NULL,
	`key_type` text DEFAULT 'personal' NOT NULL,
	`is_valid` integer DEFAULT true NOT NULL,
	`invalid_count` integer DEFAULT 0 NOT NULL,
	`last_invalid_at` integer,
	`last_used_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_api_key_hash_unique` ON `api_keys` (`api_key_hash`);--> statement-breakpoint
CREATE TABLE `guild_configs` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`log_channel_id` text,
	`admin_role_ids` text DEFAULT '[]',
	`enabled_modules` text DEFAULT '[]',
	`verified_role_ids` text DEFAULT '[]',
	`nickname_template` text DEFAULT '[{tag}] {name} [{id}]',
	`verify_on_join` integer DEFAULT false NOT NULL,
	`verify_cron` integer DEFAULT false NOT NULL,
	`verify_cron_interval` integer DEFAULT 24 NOT NULL,
	`last_verify_cron_at` integer,
	`protected_role_ids` text DEFAULT '[]',
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE TABLE `verified_users` (
	`discord_id` text PRIMARY KEY NOT NULL,
	`torn_id` integer NOT NULL,
	`torn_name` text NOT NULL,
	`faction_id` integer,
	`faction_tag` text,
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE TABLE `system_states` (
	`id` text PRIMARY KEY NOT NULL,
	`init` integer DEFAULT false NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
