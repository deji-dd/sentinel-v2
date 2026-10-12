CREATE TABLE "personal_ledger_sync_states" (
	"ledger" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"total_indexed" bigint DEFAULT 0 NOT NULL,
	"last_processed_timestamp" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Backfill the three personal ledger sync states out of the legacy
-- `system_states` JSON blobs into one keyed table.
--
-- All three blobs carried the same shape and the same job: a status, the last
-- error, how many log rows the backfill indexed, and the newest log timestamp it
-- consumed. They differed only in the counter's name (`totalIndexedLogs` for
-- battlestats and stocks, `totalIndexedCrimes` for crimes), which the shared
-- `total_indexed` column absorbs.
--
-- The legacy rows also carried an `init` boolean that was nothing more than
-- `status = 'completed'`; it is deliberately not reproduced, because the workers
-- wrote it but nothing ever read it, and `status` already carries it.
--
-- Every value is regex-guarded before casting so a hand-edited or partially
-- written blob degrades to the column default instead of aborting the deploy.
-- As in 0055/0056 the source rows are left in place for one release as a
-- read-only fallback.
INSERT INTO "personal_ledger_sync_states" (
	"ledger",
	"status",
	"last_error",
	"total_indexed",
	"last_processed_timestamp",
	"created_at",
	"updated_at"
)
SELECT
	m."ledger",
	CASE
		WHEN s."data"->>'status' IN ('idle', 'running', 'completed', 'error') THEN s."data"->>'status'
		ELSE 'idle'
	END,
	NULLIF(s."data"->>'lastError', ''),
	COALESCE(
		CASE
			WHEN COALESCE(s."data"->>m."counter", '') ~ '^-?[0-9]+$' THEN (s."data"->>m."counter")::bigint
		END,
		0
	),
	CASE
		WHEN COALESCE(s."data"->>'lastProcessedTimestamp', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastProcessedTimestamp')::bigint
	END,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN (
	VALUES
		('battlestats', 'personal:battlestats_ledger', 'totalIndexedLogs'),
		('crimes', 'personal:crimes_ledger', 'totalIndexedCrimes'),
		('stocks', 'personal:stocks_ledger', 'totalIndexedLogs')
) AS m("ledger", "state_id", "counter")
WHERE s."id" = m."state_id"
	AND jsonb_typeof(s."data") = 'object'
ON CONFLICT ("ledger") DO NOTHING;
