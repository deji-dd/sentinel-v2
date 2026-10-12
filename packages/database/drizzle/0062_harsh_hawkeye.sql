CREATE TABLE "personal_live_bars" (
	"bar" text PRIMARY KEY NOT NULL,
	"current" integer NOT NULL,
	"maximum" integer NOT NULL,
	"increment" integer NOT NULL,
	"interval" integer NOT NULL,
	"full_time" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_live_states" (
	"id" text PRIMARY KEY DEFAULT 'personal:live_state' NOT NULL,
	"drug_cooldown" bigint DEFAULT 0 NOT NULL,
	"medical_cooldown" bigint DEFAULT 0 NOT NULL,
	"booster_cooldown" bigint DEFAULT 0 NOT NULL,
	"strength" bigint DEFAULT 0 NOT NULL,
	"defense" bigint DEFAULT 0 NOT NULL,
	"speed" bigint DEFAULT 0 NOT NULL,
	"dexterity" bigint DEFAULT 0 NOT NULL,
	"total_stats" bigint,
	"last_sync_duration_ms" integer,
	"money" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_live_states_money_is_object" CHECK (jsonb_typeof("personal_live_states"."money") = 'object')
);--> statement-breakpoint
-- Backfill the live-state snapshot out of `personal:live_state`, and the company
-- sync state out of `personal:company_sync`.
--
-- Values are regex-guarded before casting so a partially written blob degrades
-- to a column default instead of aborting the deploy. As with 0055-0061 the
-- source rows stay in place for one release as a read-only fallback.
--> statement-breakpoint
-- Bars: the four keys of the `bars` object are structurally identical, so each
-- becomes a row rather than twenty repeated columns.
INSERT INTO "personal_live_bars" (
	"bar", "current", "maximum", "increment", "interval", "full_time", "created_at", "updated_at"
)
SELECT
	b."key",
	COALESCE(CASE WHEN COALESCE(b."value"->>'current', '') ~ '^-?[0-9]+$' THEN (b."value"->>'current')::integer END, 0),
	COALESCE(CASE WHEN COALESCE(b."value"->>'maximum', '') ~ '^-?[0-9]+$' THEN (b."value"->>'maximum')::integer END, 0),
	COALESCE(CASE WHEN COALESCE(b."value"->>'increment', '') ~ '^-?[0-9]+$' THEN (b."value"->>'increment')::integer END, 0),
	COALESCE(CASE WHEN COALESCE(b."value"->>'interval', '') ~ '^-?[0-9]+$' THEN (b."value"->>'interval')::integer END, 0),
	COALESCE(CASE WHEN COALESCE(b."value"->>'fullTime', '') ~ '^-?[0-9]+$' THEN (b."value"->>'fullTime')::bigint END, 0),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_each(
	CASE WHEN jsonb_typeof(s."data"->'bars') = 'object' THEN s."data"->'bars' ELSE '{}'::jsonb END
) AS b("key", "value")
WHERE s."id" = 'personal:live_state'
	AND b."key" IN ('energy', 'nerve', 'happy', 'life')
	AND jsonb_typeof(b."value") = 'object'
ON CONFLICT ("bar") DO NOTHING;--> statement-breakpoint
-- Cooldowns, battle stats, sync duration and the raw money payload.
INSERT INTO "personal_live_states" (
	"id", "drug_cooldown", "medical_cooldown", "booster_cooldown", "strength",
	"defense", "speed", "dexterity", "total_stats", "last_sync_duration_ms",
	"money", "created_at", "updated_at"
)
SELECT
	'personal:live_state',
	COALESCE(CASE WHEN COALESCE(s."data"->'cooldowns'->>'drug', '') ~ '^-?[0-9]+$' THEN (s."data"->'cooldowns'->>'drug')::bigint END, 0),
	COALESCE(CASE WHEN COALESCE(s."data"->'cooldowns'->>'medical', '') ~ '^-?[0-9]+$' THEN (s."data"->'cooldowns'->>'medical')::bigint END, 0),
	COALESCE(CASE WHEN COALESCE(s."data"->'cooldowns'->>'booster', '') ~ '^-?[0-9]+$' THEN (s."data"->'cooldowns'->>'booster')::bigint END, 0),
	COALESCE(CASE WHEN COALESCE(s."data"->'battlestats'->>'strength', '') ~ '^-?[0-9]+$' THEN (s."data"->'battlestats'->>'strength')::bigint END, 0),
	COALESCE(CASE WHEN COALESCE(s."data"->'battlestats'->>'defense', '') ~ '^-?[0-9]+$' THEN (s."data"->'battlestats'->>'defense')::bigint END, 0),
	COALESCE(CASE WHEN COALESCE(s."data"->'battlestats'->>'speed', '') ~ '^-?[0-9]+$' THEN (s."data"->'battlestats'->>'speed')::bigint END, 0),
	COALESCE(CASE WHEN COALESCE(s."data"->'battlestats'->>'dexterity', '') ~ '^-?[0-9]+$' THEN (s."data"->'battlestats'->>'dexterity')::bigint END, 0),
	CASE WHEN COALESCE(s."data"->'battlestats'->>'total', '') ~ '^-?[0-9]+$' THEN (s."data"->'battlestats'->>'total')::bigint END,
	CASE WHEN COALESCE(s."data"->>'lastSyncDurationMs', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastSyncDurationMs')::integer END,
	CASE WHEN jsonb_typeof(s."data"->'money') = 'object' THEN s."data"->'money' ELSE '{}'::jsonb END,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:live_state'
	AND jsonb_typeof(s."data") = 'object'
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- `personal:company_sync` moves to `worker_state`: it is pure worker plumbing —
-- status, last error, a sync watermark and three counters.
INSERT INTO "worker_state" (
	"worker_id", "init", "status", "last_error", "cursor", "details", "created_at", "updated_at"
)
SELECT
	'personal:company_sync',
	COALESCE(s."data"->>'status' = 'completed', false),
	COALESCE(NULLIF(s."data"->>'status', ''), 'idle'),
	NULLIF(s."data"->>'lastError', ''),
	CASE WHEN COALESCE(s."data"->>'lastSyncTimestamp', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastSyncTimestamp')::bigint END,
	jsonb_strip_nulls(jsonb_build_object(
		'lastInflow', CASE WHEN COALESCE(s."data"->>'lastInflow', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastInflow')::bigint END,
		'lastOutflow', CASE WHEN COALESCE(s."data"->>'lastOutflow', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastOutflow')::bigint END,
		'lastProfit', CASE WHEN COALESCE(s."data"->>'lastProfit', '') ~ '^-?[0-9]+$' THEN (s."data"->>'lastProfit')::bigint END
	)),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:company_sync'
	AND jsonb_typeof(s."data") = 'object'
ON CONFLICT ("worker_id") DO NOTHING;
