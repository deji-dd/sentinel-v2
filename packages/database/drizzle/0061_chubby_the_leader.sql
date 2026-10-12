CREATE TABLE "personal_gym_unlocks" (
	"gym_id" integer PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_perks" (
	"perk" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_reference_summaries" (
	"id" text PRIMARY KEY DEFAULT 'personal:reference_summary' NOT NULL,
	"perks_fetched_at" bigint,
	"has_airstrip" boolean DEFAULT false NOT NULL,
	"has_book_perk" boolean DEFAULT false NOT NULL,
	"has_wlt_benefit" boolean DEFAULT false NOT NULL,
	"faction_travel_reduction" double precision DEFAULT 0 NOT NULL,
	"total_travel_reduction" double precision DEFAULT 0 NOT NULL,
	"gyms_fetched_at" bigint,
	"strength_gym" integer,
	"defense_gym" integer,
	"speed_gym" integer,
	"dexterity_gym" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_personal_perks_category" ON "personal_perks" USING btree ("category");--> statement-breakpoint
-- Backfill the personal reference caches out of the `personal:user_perks` and
-- `personal:gym_unlocks` blobs.
--
-- The perks blob stored every perk string twice — in `allPerks` and again inside
-- `categorizedPerks` — so only the categorized copy is read here; `allPerks` is
-- derived from the rows at read time. Duplicate perk strings across categories
-- are collapsed by the DISTINCT, matching the primary key.
--
-- Values are regex-guarded before casting so a partially written blob degrades
-- to a default instead of aborting the deploy. As with 0055-0060 the source rows
-- stay in place for one release as a read-only fallback.
--> statement-breakpoint
-- Perks: one row per perk, carrying its category.
INSERT INTO "personal_perks" ("perk", "category", "created_at", "updated_at")
SELECT DISTINCT ON (p."perk")
	p."perk",
	p."category",
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_each(
	CASE
		WHEN jsonb_typeof(s."data"->'categorizedPerks') = 'object' THEN s."data"->'categorizedPerks'
		ELSE '{}'::jsonb
	END
) AS c("category", "perks")
CROSS JOIN LATERAL jsonb_array_elements(
	CASE WHEN jsonb_typeof(c."perks") = 'array' THEN c."perks" ELSE '[]'::jsonb END
) AS raw("perk")
CROSS JOIN LATERAL (SELECT raw."perk" #>> '{}' AS "perk", c."category" AS "category") AS p
WHERE s."id" = 'personal:user_perks'
	AND NULLIF(p."perk", '') IS NOT NULL
ON CONFLICT ("perk") DO NOTHING;--> statement-breakpoint
-- Unlocked gyms: one row per gym id.
INSERT INTO "personal_gym_unlocks" ("gym_id", "created_at", "updated_at")
SELECT DISTINCT
	(g."value" #>> '{}')::integer,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_array_elements(
	CASE WHEN jsonb_typeof(s."data"->'unlockedGymIds') = 'array' THEN s."data"->'unlockedGymIds' ELSE '[]'::jsonb END
) AS g("value")
WHERE s."id" = 'personal:gym_unlocks'
	AND COALESCE(g."value" #>> '{}', '') ~ '^-?[0-9]+$'
ON CONFLICT ("gym_id") DO NOTHING;--> statement-breakpoint
-- Summary, perks half. Written as a partial upsert so the gyms half below can
-- fill in its own columns without clearing these.
INSERT INTO "personal_reference_summaries" (
	"id", "perks_fetched_at", "has_airstrip", "has_book_perk", "has_wlt_benefit",
	"faction_travel_reduction", "total_travel_reduction", "created_at", "updated_at"
)
SELECT
	'personal:reference_summary',
	CASE WHEN COALESCE(s."data"->>'timestamp', '') ~ '^-?[0-9]+$' THEN (s."data"->>'timestamp')::bigint END,
	COALESCE(lower(s."data"->'travelPerks'->>'hasAirstrip') ~ '^(true|t|yes|y|1)$', false),
	COALESCE(lower(s."data"->'travelPerks'->>'hasBookPerk') ~ '^(true|t|yes|y|1)$', false),
	COALESCE(lower(s."data"->'travelPerks'->>'hasWltBenefit') ~ '^(true|t|yes|y|1)$', false),
	COALESCE(
		CASE WHEN COALESCE(s."data"->'travelPerks'->>'factionTravelReduction', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
			THEN (s."data"->'travelPerks'->>'factionTravelReduction')::double precision END,
		0
	),
	COALESCE(
		CASE WHEN COALESCE(s."data"->'travelPerks'->>'totalTravelReduction', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
			THEN (s."data"->'travelPerks'->>'totalTravelReduction')::double precision END,
		0
	),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:user_perks'
ON CONFLICT ("id") DO UPDATE SET
	"perks_fetched_at" = EXCLUDED."perks_fetched_at",
	"has_airstrip" = EXCLUDED."has_airstrip",
	"has_book_perk" = EXCLUDED."has_book_perk",
	"has_wlt_benefit" = EXCLUDED."has_wlt_benefit",
	"faction_travel_reduction" = EXCLUDED."faction_travel_reduction",
	"total_travel_reduction" = EXCLUDED."total_travel_reduction",
	"updated_at" = EXCLUDED."updated_at";--> statement-breakpoint
-- Summary, gyms half.
INSERT INTO "personal_reference_summaries" (
	"id", "gyms_fetched_at", "strength_gym", "defense_gym", "speed_gym",
	"dexterity_gym", "created_at", "updated_at"
)
SELECT
	'personal:reference_summary',
	CASE WHEN COALESCE(s."data"->>'timestamp', '') ~ '^-?[0-9]+$' THEN (s."data"->>'timestamp')::bigint END,
	CASE WHEN COALESCE(s."data"->>'strengthGym', '') ~ '^-?[0-9]+$' THEN (s."data"->>'strengthGym')::integer END,
	CASE WHEN COALESCE(s."data"->>'defenseGym', '') ~ '^-?[0-9]+$' THEN (s."data"->>'defenseGym')::integer END,
	CASE WHEN COALESCE(s."data"->>'speedGym', '') ~ '^-?[0-9]+$' THEN (s."data"->>'speedGym')::integer END,
	CASE WHEN COALESCE(s."data"->>'dexterityGym', '') ~ '^-?[0-9]+$' THEN (s."data"->>'dexterityGym')::integer END,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'personal:gym_unlocks'
ON CONFLICT ("id") DO UPDATE SET
	"gyms_fetched_at" = EXCLUDED."gyms_fetched_at",
	"strength_gym" = EXCLUDED."strength_gym",
	"defense_gym" = EXCLUDED."defense_gym",
	"speed_gym" = EXCLUDED."speed_gym",
	"dexterity_gym" = EXCLUDED."dexterity_gym",
	"updated_at" = EXCLUDED."updated_at";