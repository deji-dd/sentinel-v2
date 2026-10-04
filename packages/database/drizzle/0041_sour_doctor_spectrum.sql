CREATE TABLE "subversive_dibs_configs" (
	"faction_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channel_id" text,
	"claim_lead_time" integer DEFAULT 5 NOT NULL,
	"max_dibs_per_person" integer DEFAULT 1 NOT NULL,
	"post_hosp_timeout_seconds" integer DEFAULT 20 NOT NULL,
	"auto_delete_on_downed" boolean DEFAULT true NOT NULL,
	"channel_maintenance_enabled" boolean DEFAULT true NOT NULL,
	"max_dibs_message_age_hours" integer DEFAULT 6 NOT NULL,
	"sweep_interval_minutes" integer DEFAULT 15 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subversive_rw_channel_configs" (
	"faction_id" integer PRIMARY KEY NOT NULL,
	"primary_displays_channel_id" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backfill dibs settings out of the old jsonb system_states blob.
--
-- Two row shapes existed: the legacy unsuffixed `subversive:dibs_config` (which
-- belongs to the primary faction) and the per-faction
-- `subversive:dibs_config:<factionId>` rows. When both are present for a
-- faction the keyed row wins, which matches how the manager resolved them
-- before this table existed.
--
-- Every value is regex-guarded before casting so a hand-edited or partially
-- written blob degrades to the column default instead of aborting the deploy.
INSERT INTO "subversive_dibs_configs" (
	"faction_id",
	"enabled",
	"channel_id",
	"claim_lead_time",
	"max_dibs_per_person",
	"post_hosp_timeout_seconds",
	"auto_delete_on_downed",
	"channel_maintenance_enabled",
	"max_dibs_message_age_hours",
	"sweep_interval_minutes",
	"updated_by",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON (c.faction_id)
	c.faction_id,
	COALESCE(
		CASE
			WHEN c."enabled" ~* '^(true|false|t|f|yes|no|y|n|1|0)$' THEN c."enabled"::boolean
		END,
		true
	),
	NULLIF(c."channel_id", ''),
	COALESCE(
		CASE
			WHEN c."claim_lead_time" ~ '^-?[0-9]+$' THEN GREATEST(c."claim_lead_time"::integer, 0)
		END,
		5
	),
	COALESCE(
		CASE
			WHEN c."max_dibs_per_person" ~ '^-?[0-9]+$' THEN GREATEST(c."max_dibs_per_person"::integer, 0)
		END,
		1
	),
	COALESCE(
		CASE
			WHEN c."post_hosp_timeout_seconds" ~ '^-?[0-9]+$' THEN GREATEST(c."post_hosp_timeout_seconds"::integer, 0)
		END,
		20
	),
	COALESCE(
		CASE
			WHEN c."auto_delete_on_downed" ~* '^(true|false|t|f|yes|no|y|n|1|0)$' THEN c."auto_delete_on_downed"::boolean
		END,
		true
	),
	COALESCE(
		CASE
			WHEN c."channel_maintenance_enabled" ~* '^(true|false|t|f|yes|no|y|n|1|0)$' THEN c."channel_maintenance_enabled"::boolean
		END,
		true
	),
	COALESCE(
		CASE
			WHEN c."max_dibs_message_age_hours" ~ '^-?[0-9]+$' THEN GREATEST(c."max_dibs_message_age_hours"::integer, 0)
		END,
		6
	),
	COALESCE(
		CASE
			WHEN c."sweep_interval_minutes" ~ '^-?[0-9]+$' THEN GREATEST(c."sweep_interval_minutes"::integer, 0)
		END,
		15
	),
	NULLIF(c."updated_by", ''),
	COALESCE(
		CASE
			WHEN c."created_at" ~ '^\d{4}-\d{2}-\d{2}' THEN c."created_at"::timestamptz
		END,
		now()
	),
	COALESCE(
		CASE
			WHEN c."updated_at" ~ '^\d{4}-\d{2}-\d{2}' THEN c."updated_at"::timestamptz
		END,
		now()
	)
FROM (
	SELECT
		CASE
			WHEN s.id = 'subversive:dibs_config' THEN 2013
			ELSE split_part(s.id, ':', 3)::integer
		END AS faction_id,
		-- Keyed rows outrank the legacy unsuffixed row.
		CASE WHEN s.id = 'subversive:dibs_config' THEN 0 ELSE 1 END AS priority,
		s.data ->> 'enabled' AS "enabled",
		s.data ->> 'channelId' AS "channel_id",
		s.data ->> 'claimLeadTime' AS "claim_lead_time",
		s.data ->> 'maxDibsPerPerson' AS "max_dibs_per_person",
		s.data ->> 'postHospTimeoutSeconds' AS "post_hosp_timeout_seconds",
		s.data ->> 'autoDeleteOnDowned' AS "auto_delete_on_downed",
		s.data ->> 'channelMaintenanceEnabled' AS "channel_maintenance_enabled",
		s.data ->> 'maxDibsMessageAgeHours' AS "max_dibs_message_age_hours",
		s.data ->> 'sweepIntervalMinutes' AS "sweep_interval_minutes",
		s.data ->> 'updatedBy' AS "updated_by",
		s.data ->> 'createdAt' AS "created_at",
		s.data ->> 'updatedAt' AS "updated_at"
	FROM "system_states" s
	WHERE s.id = 'subversive:dibs_config'
		OR s.id LIKE 'subversive:dibs\_config:%'
) AS c
WHERE c.faction_id IN (2013, 27312)
ORDER BY c.faction_id, c.priority DESC;
--> statement-breakpoint
-- Backfill ranked-war channel selections from the same blob store.
INSERT INTO "subversive_rw_channel_configs" (
	"faction_id",
	"primary_displays_channel_id",
	"updated_by",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON (c.faction_id)
	c.faction_id,
	NULLIF(c."primary_displays_channel_id", ''),
	NULLIF(c."updated_by", ''),
	COALESCE(
		CASE
			WHEN c."created_at" ~ '^\d{4}-\d{2}-\d{2}' THEN c."created_at"::timestamptz
		END,
		now()
	),
	COALESCE(
		CASE
			WHEN c."updated_at" ~ '^\d{4}-\d{2}-\d{2}' THEN c."updated_at"::timestamptz
		END,
		now()
	)
FROM (
	SELECT
		split_part(s.id, ':', 3)::integer AS faction_id,
		s.data ->> 'primaryDisplaysChannelId' AS "primary_displays_channel_id",
		s.data ->> 'updatedBy' AS "updated_by",
		s.data ->> 'createdAt' AS "created_at",
		s.data ->> 'updatedAt' AS "updated_at"
	FROM "system_states" s
	WHERE s.id LIKE 'subversive:rw\_channels\_config:%'
) AS c
WHERE c.faction_id IN (2013, 27312)
ORDER BY c.faction_id;
--> statement-breakpoint
-- The typed tables are now authoritative; drop the jsonb rows so the two
-- stores cannot silently diverge. The settings survive inside the new tables.
DELETE FROM "system_states"
WHERE id = 'subversive:dibs_config'
	OR id LIKE 'subversive:dibs\_config:%'
	OR id LIKE 'subversive:rw\_channels\_config:%';
