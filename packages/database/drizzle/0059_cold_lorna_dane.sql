CREATE TABLE "personal_bounty_targets" (
	"target_id" integer PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"name" text NOT NULL,
	"level" integer NOT NULL,
	"reward" bigint DEFAULT 0 NOT NULL,
	"fair_fight" double precision,
	"estimated_bs" bigint,
	"age" integer NOT NULL,
	"status_state" text NOT NULL,
	"status_description" text,
	"status_until" bigint,
	"attack_url" text NOT NULL,
	"last_checked_at" bigint NOT NULL,
	"seconds_remaining" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_personal_bounty_targets_queue" ON "personal_bounty_targets" USING btree ("queue","reward");--> statement-breakpoint
-- Backfill bounty targets out of the legacy `personal:bounties` blob, expanding
-- its two arrays into rows keyed by target id.
--
-- The `queue` column is derived from which array the target sat in, and
-- `secondsRemaining` is only populated for hospital-queue entries — that field is
-- the sole difference between the two shapes.
--
-- Values are regex-guarded before casting so a hand-edited or partially written
-- blob degrades to a default instead of aborting the deploy. As with 0055-0058
-- the source row stays in place for one release as a read-only fallback.
INSERT INTO "personal_bounty_targets" (
	"target_id", "queue", "name", "level", "reward", "fair_fight", "estimated_bs",
	"age", "status_state", "status_description", "status_until", "attack_url",
	"last_checked_at", "seconds_remaining", "created_at", "updated_at"
)
SELECT
	(t."value"->>'id')::integer,
	q."queue",
	COALESCE(NULLIF(t."value"->>'name', ''), 'Unknown'),
	COALESCE(CASE WHEN COALESCE(t."value"->>'level', '') ~ '^-?[0-9]+$' THEN (t."value"->>'level')::integer END, 0),
	COALESCE(CASE WHEN COALESCE(t."value"->>'reward', '') ~ '^-?[0-9]+$' THEN (t."value"->>'reward')::bigint END, 0),
	CASE WHEN COALESCE(t."value"->>'fairFight', '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (t."value"->>'fairFight')::double precision END,
	CASE WHEN COALESCE(t."value"->>'estimatedBs', '') ~ '^-?[0-9]+$' THEN (t."value"->>'estimatedBs')::bigint END,
	COALESCE(CASE WHEN COALESCE(t."value"->>'age', '') ~ '^-?[0-9]+$' THEN (t."value"->>'age')::integer END, 0),
	COALESCE(NULLIF(t."value"->'status'->>'state', ''), 'Okay'),
	NULLIF(t."value"->'status'->>'description', ''),
	CASE WHEN COALESCE(t."value"->'status'->>'until', '') ~ '^-?[0-9]+$' THEN (t."value"->'status'->>'until')::bigint END,
	COALESCE(
		NULLIF(t."value"->>'attackUrl', ''),
		'https://www.torn.com/page.php?sid=attack&user2ID=' || (t."value"->>'id')
	),
	COALESCE(CASE WHEN COALESCE(t."value"->>'lastCheckedAt', '') ~ '^-?[0-9]+$' THEN (t."value"->>'lastCheckedAt')::bigint END, 0),
	CASE
		WHEN q."queue" = 'hospital' AND COALESCE(t."value"->>'secondsRemaining', '') ~ '^-?[0-9]+$'
		THEN (t."value"->>'secondsRemaining')::integer
	END,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN (
	VALUES ('readyTargets', 'ready'), ('hospitalQueue', 'hospital')
) AS q("array_key", "queue")
CROSS JOIN LATERAL jsonb_array_elements(
	CASE
		WHEN jsonb_typeof(s."data"->q."array_key") = 'array' THEN s."data"->q."array_key"
		ELSE '[]'::jsonb
	END
) AS t("value")
WHERE s."id" = 'personal:bounties'
	AND COALESCE(t."value"->>'id', '') ~ '^-?[0-9]+$'
ON CONFLICT ("target_id") DO NOTHING;--> statement-breakpoint
-- The deployment-level counters move to `worker_state`, matching every other
-- worker cursor. `cursor` carries the last sync timestamp.
INSERT INTO "worker_state" ("worker_id", "init", "cursor", "details", "created_at", "updated_at")
SELECT
	'personal:bounties',
	true,
	CASE WHEN COALESCE(s."data"->>'lastSyncTimestamp', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastSyncTimestamp')::bigint END,
	jsonb_strip_nulls(jsonb_build_object(
		'pendingCount', CASE WHEN COALESCE(s."data"->>'pendingCount', '') ~ '^-?[0-9]+$' THEN (s."data"->>'pendingCount')::bigint END
	)),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:bounties'
	AND s."init"
ON CONFLICT ("worker_id") DO NOTHING;