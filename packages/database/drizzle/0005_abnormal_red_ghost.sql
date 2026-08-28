CREATE TABLE IF NOT EXISTS `user_maps` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`assignments` text DEFAULT '{}' NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX IF EXISTS `guild_api_keys_api_key_hash_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `guild_api_keys_guild_id_api_key_hash_unique` ON `guild_api_keys` (`guild_id`,`api_key_hash`);