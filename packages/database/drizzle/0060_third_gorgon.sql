CREATE TABLE "merc_active_alerts" (
	"contract_id" text NOT NULL,
	"target_id" integer NOT NULL,
	"guild_id" text NOT NULL,
	"channel_name" text NOT NULL,
	"target_name" text NOT NULL,
	"target_level" integer NOT NULL,
	"estimated_bs" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"claimed_by_discord_id" text,
	"claimed_by_discord_tag" text,
	"claimed_by_torn_id" integer,
	"claimed_by_torn_name" text,
	"claimed_at" bigint,
	"message_id" text,
	"last_alert_at" bigint NOT NULL,
	"is_stricken_eligible" boolean DEFAULT false NOT NULL,
	"hospital_until" bigint,
	"rw_cooldown_until" bigint,
	"was_in_hospital" boolean,
	"hospital_exit_time" bigint,
	"lock_started_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merc_active_alerts_contract_id_target_id_pk" PRIMARY KEY("contract_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "merc_hospital_trackers" (
	"contract_id" text NOT NULL,
	"target_id" integer NOT NULL,
	"was_in_hospital" boolean NOT NULL,
	"hospital_until" bigint,
	"hospital_exit_time" bigint,
	"last_seen_hosp_sec" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merc_hospital_trackers_contract_id_target_id_pk" PRIMARY KEY("contract_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "merc_offline_trackers" (
	"contract_id" text NOT NULL,
	"target_id" integer NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merc_offline_trackers_contract_id_target_id_pk" PRIMARY KEY("contract_id","target_id")
);
--> statement-breakpoint
CREATE INDEX "idx_merc_active_alerts_contract" ON "merc_active_alerts" USING btree ("contract_id");--> statement-breakpoint
-- Backfill the mercenary target manager's state out of the `merc:active_state`
-- blob: one JSON object holding an alerts list plus two tracker maps keyed
-- `contractId:targetId`.
--
-- Each collection becomes its own table, matching the three in-memory maps the
-- worker keeps. Tracker keys are split on the LAST colon, because contract ids
-- are free-form strings and only the trailing segment is the numeric target id.
--
-- Values are regex-guarded before casting so a partially written blob degrades
-- to a default instead of aborting the deploy. As with 0055-0059 the source row
-- stays in place for one release as a read-only fallback.
--> statement-breakpoint
-- Alerts.
INSERT INTO "merc_active_alerts" (
	"contract_id", "target_id", "guild_id", "channel_name", "target_name",
	"target_level", "estimated_bs", "status", "claimed_by_discord_id",
	"claimed_by_discord_tag", "claimed_by_torn_id", "claimed_by_torn_name",
	"claimed_at", "message_id", "last_alert_at", "is_stricken_eligible",
	"hospital_until", "rw_cooldown_until", "was_in_hospital", "hospital_exit_time",
	"lock_started_at", "created_at", "updated_at"
)
SELECT
	a."value"->>'contractId',
	(a."value"->>'targetId')::integer,
	COALESCE(NULLIF(a."value"->>'guildId', ''), ''),
	COALESCE(NULLIF(a."value"->>'channelName', ''), ''),
	COALESCE(NULLIF(a."value"->>'targetName', ''), 'Unknown'),
	COALESCE(CASE WHEN COALESCE(a."value"->>'targetLevel', '') ~ '^-?[0-9]+$' THEN (a."value"->>'targetLevel')::integer END, 0),
	COALESCE(CASE WHEN COALESCE(a."value"->>'estimatedBs', '') ~ '^-?[0-9]+$' THEN (a."value"->>'estimatedBs')::bigint END, 0),
	CASE WHEN a."value"->>'status' IN ('open', 'claimed') THEN a."value"->>'status' ELSE 'open' END,
	NULLIF(a."value"->'claimedBy'->>'discordId', ''),
	NULLIF(a."value"->'claimedBy'->>'discordTag', ''),
	CASE WHEN COALESCE(a."value"->'claimedBy'->>'tornId', '') ~ '^-?[0-9]+$' THEN (a."value"->'claimedBy'->>'tornId')::integer END,
	NULLIF(a."value"->'claimedBy'->>'tornName', ''),
	CASE WHEN COALESCE(a."value"->>'claimedAt', '') ~ '^-?[0-9]+$' THEN (a."value"->>'claimedAt')::bigint END,
	NULLIF(a."value"->>'messageId', ''),
	COALESCE(CASE WHEN COALESCE(a."value"->>'lastAlertAt', '') ~ '^-?[0-9]+$' THEN (a."value"->>'lastAlertAt')::bigint END, 0),
	COALESCE(lower(a."value"->>'isStrickenEligible') ~ '^(true|t|yes|y|1)$', false),
	CASE WHEN COALESCE(a."value"->>'hospitalUntil', '') ~ '^-?[0-9]+$' THEN (a."value"->>'hospitalUntil')::bigint END,
	CASE WHEN COALESCE(a."value"->>'rwCooldownUntil', '') ~ '^-?[0-9]+$' THEN (a."value"->>'rwCooldownUntil')::bigint END,
	CASE WHEN lower(a."value"->>'wasInHospital') ~ '^(true|t|yes|y|1)$' THEN true WHEN lower(a."value"->>'wasInHospital') ~ '^(false|f|no|n|0)$' THEN false END,
	CASE WHEN COALESCE(a."value"->>'hospitalExitTime', '') ~ '^-?[0-9]+$' THEN (a."value"->>'hospitalExitTime')::bigint END,
	CASE WHEN COALESCE(a."value"->>'lockStartedAt', '') ~ '^-?[0-9]+$' THEN (a."value"->>'lockStartedAt')::bigint END,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_array_elements(
	CASE WHEN jsonb_typeof(s."data"->'alerts') = 'array' THEN s."data"->'alerts' ELSE '[]'::jsonb END
) AS a("value")
WHERE s."id" = 'merc:active_state'
	AND NULLIF(a."value"->>'contractId', '') IS NOT NULL
	AND COALESCE(a."value"->>'targetId', '') ~ '^-?[0-9]+$'
ON CONFLICT ("contract_id", "target_id") DO NOTHING;--> statement-breakpoint
-- Hospital tracker. Entries are [key, record] pairs, so the key is element 0
-- and the record element 1.
INSERT INTO "merc_hospital_trackers" (
	"contract_id", "target_id", "was_in_hospital", "hospital_until",
	"hospital_exit_time", "last_seen_hosp_sec", "created_at", "updated_at"
)
SELECT
	left(h."value"->>0, length(h."value"->>0) - length(split_part(h."value"->>0, ':', -1)) - 1),
	(split_part(h."value"->>0, ':', -1))::integer,
	COALESCE(lower(h."value"->1->>'wasInHospital') ~ '^(true|t|yes|y|1)$', false),
	CASE WHEN COALESCE(h."value"->1->>'hospitalUntil', '') ~ '^-?[0-9]+$' THEN (h."value"->1->>'hospitalUntil')::bigint END,
	CASE WHEN COALESCE(h."value"->1->>'hospitalExitTime', '') ~ '^-?[0-9]+$' THEN (h."value"->1->>'hospitalExitTime')::bigint END,
	COALESCE(CASE WHEN COALESCE(h."value"->1->>'lastSeenHospSec', '') ~ '^-?[0-9]+$' THEN (h."value"->1->>'lastSeenHospSec')::bigint END, 0),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_array_elements(
	CASE WHEN jsonb_typeof(s."data"->'hospitalTracker') = 'array' THEN s."data"->'hospitalTracker' ELSE '[]'::jsonb END
) AS h("value")
WHERE s."id" = 'merc:active_state'
	AND jsonb_typeof(h."value") = 'array'
	AND length(h."value"->>0) > length(split_part(h."value"->>0, ':', -1))
	AND COALESCE(split_part(h."value"->>0, ':', -1), '') ~ '^-?[0-9]+$'
ON CONFLICT ("contract_id", "target_id") DO NOTHING;--> statement-breakpoint
-- Offline tracker. Entries are [key, epochSeconds] pairs.
INSERT INTO "merc_offline_trackers" (
	"contract_id", "target_id", "last_seen_at", "created_at", "updated_at"
)
SELECT
	left(o."value"->>0, length(o."value"->>0) - length(split_part(o."value"->>0, ':', -1)) - 1),
	(split_part(o."value"->>0, ':', -1))::integer,
	(o."value"->>1)::bigint,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_array_elements(
	CASE WHEN jsonb_typeof(s."data"->'offlineTracker') = 'array' THEN s."data"->'offlineTracker' ELSE '[]'::jsonb END
) AS o("value")
WHERE s."id" = 'merc:active_state'
	AND jsonb_typeof(o."value") = 'array'
	AND length(o."value"->>0) > length(split_part(o."value"->>0, ':', -1))
	AND COALESCE(split_part(o."value"->>0, ':', -1), '') ~ '^-?[0-9]+$'
	AND COALESCE(o."value"->>1, '') ~ '^-?[0-9]+$'
ON CONFLICT ("contract_id", "target_id") DO NOTHING;