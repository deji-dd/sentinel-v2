CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`asset_id` text NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`moving_average_cost` real DEFAULT 0 NOT NULL,
	`total_cost_basis` real DEFAULT 0 NOT NULL,
	`location` text NOT NULL,
	`owner` text DEFAULT 'personal' NOT NULL,
	`origin` text,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`last_updated` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_daily_profits` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`inflow` real NOT NULL,
	`outflow` real NOT NULL,
	`profit` real NOT NULL,
	`profile` text NOT NULL,
	`employees` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crime_action_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`crime_id` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `crime_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`crime_id` integer NOT NULL,
	`action` text NOT NULL,
	`nerve` integer DEFAULT 0 NOT NULL,
	`value` real DEFAULT 0 NOT NULL,
	`timestamp` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gym_ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`stat_type` text NOT NULL,
	`source` text NOT NULL,
	`trains` integer,
	`energy_used` integer,
	`stat_gained` real NOT NULL,
	`stat_before` real,
	`stat_after` real,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ledger_events` (
	`id` text PRIMARY KEY NOT NULL,
	`log_id` text,
	`timestamp` integer NOT NULL,
	`type` text NOT NULL,
	`category_id` integer NOT NULL,
	`transaction_name` text NOT NULL,
	`assets_affected` text NOT NULL,
	`cash_flow` real DEFAULT 0 NOT NULL,
	`realized_pnl` real DEFAULT 0 NOT NULL,
	`raw_log` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `personal_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`log` integer NOT NULL,
	`title` text,
	`timestamp` integer NOT NULL,
	`category` text,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`stock_id` integer NOT NULL,
	`log_type` integer NOT NULL,
	`value` real NOT NULL,
	`item_id` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `travel_purchase_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`destination` integer NOT NULL,
	`item_id` integer NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`cost_total` real DEFAULT 0 NOT NULL,
	`market_value` real DEFAULT 0 NOT NULL,
	`profit` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_stocks` (
	`id` text PRIMARY KEY NOT NULL,
	`shares` integer DEFAULT 0 NOT NULL,
	`transactions` text,
	`bonus` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `factions` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tag` text,
	`tag_image` text,
	`leader_id` integer,
	`co_leader_id` integer,
	`respect` integer DEFAULT 0 NOT NULL,
	`capacity` integer DEFAULT 0 NOT NULL,
	`members_count` integer DEFAULT 0 NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `territory_blueprints` (
	`id` text PRIMARY KEY NOT NULL,
	`sector` integer,
	`size` integer,
	`density` integer,
	`slots` integer,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `territory_states` (
	`id` text PRIMARY KEY NOT NULL,
	`faction_id` integer,
	`racket` text,
	`is_warring` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `torn_crimes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `torn_gyms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`stage` integer NOT NULL,
	`cost` integer NOT NULL,
	`energy` integer NOT NULL,
	`strength` real NOT NULL,
	`speed` real NOT NULL,
	`defense` real NOT NULL,
	`dexterity` real NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `torn_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `torn_properties` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `torn_stocks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`acronym` text NOT NULL,
	`market` text,
	`bonus` text,
	`images` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `travel_area_mappings` (
	`id` integer PRIMARY KEY NOT NULL,
	`country_code` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `travel_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`stocks` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `war_ledgers` (
	`id` text PRIMARY KEY NOT NULL,
	`tt` text NOT NULL,
	`assaulting_faction` integer NOT NULL,
	`defending_faction` integer NOT NULL,
	`victor_faction` integer,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
