CREATE TABLE "worker_state" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"init" boolean DEFAULT false NOT NULL,
	"status" text,
	"last_error" text,
	"cursor" bigint,
	"last_run_at" timestamp with time zone,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_state_details_is_object" CHECK (jsonb_typeof("worker_state"."details") = 'object')
);--> statement-breakpoint
-- Backfill the remaining worker cursors and first-run flags out of `system_states`.
--
-- Only the fields workers actually read become columns: `init` (the first-run
-- gate), `status`, `last_error` and `cursor` (the progress watermark). Every
-- other counter a worker records is carried into `details`, which is constrained
-- to a JSON object so the double-encoded rows the legacy blob accepted silently
-- cannot reappear.
--
-- Values are regex-guarded before casting so a hand-edited or partially written
-- blob degrades to a default instead of aborting the deploy. As in 0055-0057 the
-- source rows stay in place for one release as a read-only fallback.
--> statement-breakpoint
-- `personal:log_manager`. `init` is derived exactly as the worker derived it:
-- the backfill phase having completed.
INSERT INTO "worker_state" (
	"worker_id", "init", "status", "last_error", "cursor", "details", "created_at", "updated_at"
)
SELECT
	'personal:log_manager',
	COALESCE(s."data"->>'backfillStatus' = 'completed', false),
	COALESCE(NULLIF(s."data"->>'status', ''), 'idle'),
	NULLIF(s."data"->>'lastError', ''),
	CASE
		WHEN COALESCE(s."data"->>'newestTimestampReached', '') ~ '^-?[0-9]+$' THEN (s."data"->>'newestTimestampReached')::bigint
	END,
	jsonb_strip_nulls(jsonb_build_object(
		'backfillStatus', s."data"->>'backfillStatus',
		'forwardStatus', s."data"->>'forwardStatus',
		'totalLogsRecorded', CASE WHEN COALESCE(s."data"->>'totalLogsRecorded', '') ~ '^-?[0-9]+$' THEN (s."data"->>'totalLogsRecorded')::bigint END,
		'backfillLogsCount', CASE WHEN COALESCE(s."data"->>'backfillLogsCount', '') ~ '^-?[0-9]+$' THEN (s."data"->>'backfillLogsCount')::bigint END,
		'forwardLogsCount', CASE WHEN COALESCE(s."data"->>'forwardLogsCount', '') ~ '^-?[0-9]+$' THEN (s."data"->>'forwardLogsCount')::bigint END,
		'oldestTimestampReached', CASE WHEN COALESCE(s."data"->>'oldestTimestampReached', '') ~ '^-?[0-9]+$' THEN (s."data"->>'oldestTimestampReached')::bigint END,
		'lastForwardCheckedAt', CASE WHEN COALESCE(s."data"->>'lastForwardCheckedAt', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastForwardCheckedAt')::bigint END,
		'lastBackfillCheckedAt', CASE WHEN COALESCE(s."data"->>'lastBackfillCheckedAt', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastBackfillCheckedAt')::bigint END,
		'lastSyncDurationMs', CASE WHEN COALESCE(s."data"->>'lastSyncDurationMs', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastSyncDurationMs')::bigint END
	)),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:log_manager'
	AND jsonb_typeof(s."data") = 'object'
ON CONFLICT ("worker_id") DO NOTHING;--> statement-breakpoint
-- `personal:log_manager_resync`. The window bounds identify the job, so the row
-- is only imported when both survived.
INSERT INTO "worker_state" (
	"worker_id", "init", "status", "last_error", "cursor", "details", "created_at", "updated_at"
)
SELECT
	'personal:log_manager_resync',
	false,
	COALESCE(NULLIF(s."data"->>'status', ''), 'pending'),
	NULLIF(s."data"->>'lastError', ''),
	CASE
		WHEN COALESCE(s."data"->>'cursor', '') ~ '^-?[0-9]+$' THEN (s."data"->>'cursor')::bigint
	END,
	jsonb_strip_nulls(jsonb_build_object(
		'from', CASE WHEN COALESCE(s."data"->>'from', '') ~ '^-?[0-9]+$' THEN (s."data"->>'from')::bigint END,
		'to', CASE WHEN COALESCE(s."data"->>'to', '') ~ '^-?[0-9]+$' THEN (s."data"->>'to')::bigint END,
		'fetched', CASE WHEN COALESCE(s."data"->>'fetched', '') ~ '^-?[0-9]+$' THEN (s."data"->>'fetched')::bigint END,
		'pages', CASE WHEN COALESCE(s."data"->>'pages', '') ~ '^-?[0-9]+$' THEN (s."data"->>'pages')::bigint END,
		'failures', CASE WHEN COALESCE(s."data"->>'failures', '') ~ '^-?[0-9]+$' THEN (s."data"->>'failures')::bigint END,
		'startedAt', s."data"->>'startedAt',
		'finishedAt', s."data"->>'finishedAt'
	)),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:log_manager_resync'
	AND jsonb_typeof(s."data") = 'object'
	AND COALESCE(s."data"->>'from', '') ~ '^-?[0-9]+$'
	AND COALESCE(s."data"->>'to', '') ~ '^-?[0-9]+$'
ON CONFLICT ("worker_id") DO NOTHING;--> statement-breakpoint
-- `personal:wealth`. The worker's `initialised` flag maps onto `init`, and the
-- anchor timestamp onto `cursor`.
INSERT INTO "worker_state" (
	"worker_id", "init", "status", "last_error", "cursor", "details", "created_at", "updated_at"
)
SELECT
	'personal:wealth',
	COALESCE(lower(s."data"->>'initialised') ~ '^(true|t|yes|y|1)$', false),
	COALESCE(NULLIF(s."data"->>'status', ''), 'idle'),
	NULLIF(s."data"->>'lastError', ''),
	CASE
		WHEN COALESCE(s."data"->>'anchorTimestamp', '') ~ '^-?[0-9]+$' THEN (s."data"->>'anchorTimestamp')::bigint
	END,
	jsonb_strip_nulls(jsonb_build_object(
		'anchorDate', s."data"->>'anchorDate',
		'totalIndexedEvents', CASE WHEN COALESCE(s."data"->>'totalIndexedEvents', '') ~ '^-?[0-9]+$' THEN (s."data"->>'totalIndexedEvents')::bigint END,
		'logTypesSyncedAt', s."data"->>'logTypesSyncedAt',
		'lastReconciledAt', s."data"->>'lastReconciledAt'
	)),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:wealth'
	AND jsonb_typeof(s."data") = 'object'
ON CONFLICT ("worker_id") DO NOTHING;--> statement-breakpoint
-- `subversive:recruitment_state`. `init` is load-bearing: while it is false the
-- recruitment scan widens its window back to the start of today UTC, so it is
-- copied from the flag the worker already relied on.
INSERT INTO "worker_state" (
	"worker_id", "init", "status", "last_error", "cursor", "details", "created_at", "updated_at"
)
SELECT
	'subversive:recruitment_state',
	s."init",
	NULL,
	NULL,
	CASE
		WHEN COALESCE(s."data"->>'lastScanTimestamp', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastScanTimestamp')::bigint
	END,
	jsonb_strip_nulls(jsonb_build_object(
		'lastScanDate', s."data"->>'lastScanDate',
		'evaluatedWarsCount', CASE WHEN COALESCE(s."data"->>'evaluatedWarsCount', '') ~ '^-?[0-9]+$' THEN (s."data"->>'evaluatedWarsCount')::bigint END
	)),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'subversive:recruitment_state'
ON CONFLICT ("worker_id") DO NOTHING;--> statement-breakpoint
-- The territory first-run flags. Each held a single boolean in a whole row, so
-- only a true value is worth importing: a missing row is already read as false.
INSERT INTO "worker_state" ("worker_id", "init", "created_at", "updated_at")
SELECT m."worker_id", true, COALESCE(s."created_at", now()), COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN (
	VALUES ('war_ledger_init_state'), ('tt_init_state')
) AS m("worker_id")
WHERE s."id" = m."worker_id"
	AND s."init"
ON CONFLICT ("worker_id") DO NOTHING;
