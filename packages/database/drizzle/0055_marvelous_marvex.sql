CREATE TABLE "battlestats_preferences" (
	"id" text PRIMARY KEY DEFAULT 'personal:battlestats_preferences' NOT NULL,
	"main_stat" text DEFAULT 'dexterity' NOT NULL,
	"ratio_type" text DEFAULT 'baldr' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merc_master_keys" (
	"guild_id" text NOT NULL,
	"faction_id" integer NOT NULL,
	"key_id" text NOT NULL,
	"faction_name" text,
	"torn_id" integer,
	"torn_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merc_master_keys_guild_id_faction_id_pk" PRIMARY KEY("guild_id","faction_id")
);
--> statement-breakpoint
CREATE TABLE "subversive_guild_configs" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"guild_name" text,
	"guild_icon" text,
	"admin_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"configured_at" timestamp with time zone,
	"configured_by_discord_id" text,
	"configured_by_username" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subversive_recruitment_configs" (
	"id" text PRIMARY KEY DEFAULT 'subversive:recruitment_config' NOT NULL,
	"min_stats" bigint DEFAULT 100000000 NOT NULL,
	"min_attacks" integer DEFAULT 25 NOT NULL,
	"min_attack_percentage" double precision DEFAULT 8 NOT NULL,
	"termed_cluster_percentage" integer DEFAULT 60 NOT NULL,
	"auto_scan_enabled" boolean DEFAULT false NOT NULL,
	"excluded_faction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notifications_enabled" boolean DEFAULT false NOT NULL,
	"notification_channel_id" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_merc_master_keys_key_id" ON "merc_master_keys" USING btree ("key_id");--> statement-breakpoint
-- Backfill the typed configuration tables out of the legacy `system_states`
-- JSON blob, which is being retired.
--
-- Every value is regex-guarded before casting, so a hand-edited or partially
-- written blob degrades to the column default instead of aborting the deploy.
-- This mirrors the approach taken in 0041_sour_doctor_spectrum.sql.
--
-- Unlike 0041, the source rows are intentionally NOT deleted here. They stay for
-- one release as a read-only fallback so a rollback is possible, and a follow-up
-- migration removes them once this one is confirmed in production. The
-- application reads the new tables only; nothing writes the old keys any more.
--> statement-breakpoint
-- `subversive:guild_config` -> subversive_guild_configs (one row per guild).
INSERT INTO "subversive_guild_configs" (
	"guild_id",
	"guild_name",
	"guild_icon",
	"admin_role_ids",
	"configured_at",
	"configured_by_discord_id",
	"configured_by_username",
	"created_at",
	"updated_at"
)
SELECT
	s."data"->>'guildId',
	NULLIF(s."data"->>'guildName', ''),
	NULLIF(s."data"->>'guildIcon', ''),
	CASE
		WHEN jsonb_typeof(s."data"->'adminRoleIds') = 'array' THEN s."data"->'adminRoleIds'
		ELSE '[]'::jsonb
	END,
	CASE
		WHEN COALESCE(s."data"->>'configuredAt', '') ~ '^\d{4}-\d{2}-\d{2}' THEN (s."data"->>'configuredAt')::timestamptz
	END,
	NULLIF(s."data"->'configuredBy'->>'discordId', ''),
	NULLIF(s."data"->'configuredBy'->>'username', ''),
	COALESCE(s."created_at", now()),
	COALESCE(
		CASE
			WHEN COALESCE(s."data"->>'updatedAt', '') ~ '^\d{4}-\d{2}-\d{2}' THEN (s."data"->>'updatedAt')::timestamptz
		END,
		now()
	)
FROM "system_states" s
WHERE s."id" = 'subversive:guild_config'
	AND jsonb_typeof(s."data") = 'object'
	AND NULLIF(s."data"->>'guildId', '') IS NOT NULL
ON CONFLICT ("guild_id") DO NOTHING;--> statement-breakpoint
-- `subversive:recruitment_config` -> subversive_recruitment_configs (singleton).
--
-- Gated on `init`: the recruitment worker ignores a row whose `init` is false,
-- so importing one would silently activate settings it had been disregarding.
INSERT INTO "subversive_recruitment_configs" (
	"id",
	"min_stats",
	"min_attacks",
	"min_attack_percentage",
	"termed_cluster_percentage",
	"auto_scan_enabled",
	"excluded_faction_ids",
	"notifications_enabled",
	"notification_channel_id",
	"updated_by",
	"created_at",
	"updated_at"
)
SELECT
	'subversive:recruitment_config',
	COALESCE(
		CASE
			WHEN s."data"->>'minStats' ~ '^-?[0-9]+$' THEN (s."data"->>'minStats')::bigint
		END,
		100000000
	),
	COALESCE(
		CASE
			WHEN s."data"->>'minAttacks' ~ '^-?[0-9]+$' THEN GREATEST((s."data"->>'minAttacks')::integer, 0)
		END,
		25
	),
	COALESCE(
		CASE
			WHEN s."data"->>'minAttackPercentage' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN GREATEST((s."data"->>'minAttackPercentage')::double precision, 0)
		END,
		8
	),
	COALESCE(
		CASE
			WHEN s."data"->>'termedClusterPercentage' ~ '^-?[0-9]+$' THEN LEAST(GREATEST((s."data"->>'termedClusterPercentage')::integer, 10), 100)
		END,
		60
	),
	COALESCE(
		CASE
			WHEN lower(s."data"->>'autoScanEnabled') ~ '^(true|false|t|f|yes|no|y|n|1|0)$' THEN (s."data"->>'autoScanEnabled')::boolean
		END,
		false
	),
	CASE
		WHEN jsonb_typeof(s."data"->'excludedFactionIds') = 'array' THEN s."data"->'excludedFactionIds'
		ELSE '[]'::jsonb
	END,
	COALESCE(
		CASE
			WHEN lower(s."data"->>'notificationsEnabled') ~ '^(true|false|t|f|yes|no|y|n|1|0)$' THEN (s."data"->>'notificationsEnabled')::boolean
		END,
		false
	),
	NULLIF(s."data"->>'notificationChannelId', ''),
	NULLIF(s."data"->>'updatedBy', ''),
	COALESCE(s."created_at", now()),
	COALESCE(
		CASE
			WHEN COALESCE(s."data"->>'updatedAt', '') ~ '^\d{4}-\d{2}-\d{2}' THEN (s."data"->>'updatedAt')::timestamptz
		END,
		now()
	)
FROM "system_states" s
WHERE s."id" = 'subversive:recruitment_config'
	AND s."init"
	AND jsonb_typeof(s."data") = 'object'
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- `merc:master_keys:<guildId>` -> merc_master_keys, one row per faction.
--
-- The blob held a JSON object keyed by faction id, so it is expanded with
-- jsonb_each into the rows it always represented. The guild id is the third
-- segment of the key (`merc`:`master_keys`:`<guildId>`).
INSERT INTO "merc_master_keys" (
	"guild_id",
	"faction_id",
	"key_id",
	"faction_name",
	"torn_id",
	"torn_name",
	"created_at",
	"updated_at"
)
SELECT
	split_part(s."id", ':', 3),
	kv."key"::integer,
	kv."value"->>'keyId',
	NULLIF(kv."value"->>'factionName', ''),
	CASE
		WHEN kv."value"->>'tornId' ~ '^-?[0-9]+$' THEN (kv."value"->>'tornId')::integer
	END,
	NULLIF(kv."value"->>'tornName', ''),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_each(COALESCE(s."data", '{}'::jsonb)) AS kv("key", "value")
WHERE s."id" LIKE 'merc\_master\_keys\_%'
	AND jsonb_typeof(s."data") = 'object'
	AND split_part(s."id", ':', 3) <> ''
	AND kv."key" ~ '^[0-9]+$'
	AND jsonb_typeof(kv."value") = 'object'
	AND NULLIF(kv."value"->>'keyId', '') IS NOT NULL
ON CONFLICT ("guild_id", "faction_id") DO NOTHING;--> statement-breakpoint
-- `personal:battlestats_preferences` -> battlestats_preferences (singleton).
--
-- No `init` gate here: the ledger route reads `data` regardless of that flag.
INSERT INTO "battlestats_preferences" (
	"id",
	"main_stat",
	"ratio_type",
	"created_at",
	"updated_at"
)
SELECT
	'personal:battlestats_preferences',
	CASE
		WHEN s."data"->>'mainStat' IN ('strength', 'defense', 'speed', 'dexterity') THEN s."data"->>'mainStat'
		ELSE 'dexterity'
	END,
	CASE
		WHEN s."data"->>'ratioType' IN ('baldr', 'hank') THEN s."data"->>'ratioType'
		ELSE 'baldr'
	END,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:battlestats_preferences'
	AND jsonb_typeof(s."data") = 'object'
ON CONFLICT ("id") DO NOTHING;