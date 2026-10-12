CREATE TABLE "subversive_dibs_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"target_id" integer NOT NULL,
	"faction_id" integer,
	"channel_id" text NOT NULL,
	"posted_at_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subversive_dibs_records" (
	"target_id" integer PRIMARY KEY NOT NULL,
	"faction_id" integer,
	"target_name" text NOT NULL,
	"target_level" integer NOT NULL,
	"estimated_bs" double precision NOT NULL,
	"fair_fight" double precision NOT NULL,
	"hospital_until" bigint NOT NULL,
	"status" text NOT NULL,
	"claimed_by_torn_id" integer,
	"claimed_by_torn_name" text,
	"claimed_by_discord_id" text,
	"claimed_by_discord_tag" text,
	"claimed_by_platform" text,
	"claimed_at" bigint,
	"discord_message_id" text,
	"discord_channel_id" text,
	"exit_hosp_at" bigint,
	"record_created_at" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torn_market_prices" (
	"ref_key" text PRIMARY KEY NOT NULL,
	"price" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_subversive_dibs_messages_target" ON "subversive_dibs_messages" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_dibs_messages_channel" ON "subversive_dibs_messages" USING btree ("channel_id","posted_at_ms");--> statement-breakpoint
CREATE INDEX "idx_subversive_dibs_messages_faction" ON "subversive_dibs_messages" USING btree ("faction_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_dibs_records_faction" ON "subversive_dibs_records" USING btree ("faction_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_dibs_records_status" ON "subversive_dibs_records" USING btree ("status");--> statement-breakpoint
-- Backfill the ledger tables out of the legacy `system_states` JSON blobs.
--
-- Every value is regex-guarded before casting so a hand-edited or partially
-- written blob degrades to a sane default instead of aborting the deploy, and
-- arrays/objects are type-checked before being expanded. Follows the approach in
-- 0041_sour_doctor_spectrum.sql.
--
-- As in 0055, the source rows are intentionally left in place for one release as
-- a read-only fallback; nothing writes them any more.
--> statement-breakpoint
-- `subversive:dibs_records` -> subversive_dibs_records (one row per dibbed target).
--
-- The blob held `{ "records": [ ... ] }`; the array is expanded into the rows it
-- always represented, keyed by the target id the in-memory board uses.
INSERT INTO "subversive_dibs_records" (
	"target_id",
	"faction_id",
	"target_name",
	"target_level",
	"estimated_bs",
	"fair_fight",
	"hospital_until",
	"status",
	"claimed_by_torn_id",
	"claimed_by_torn_name",
	"claimed_by_discord_id",
	"claimed_by_discord_tag",
	"claimed_by_platform",
	"claimed_at",
	"discord_message_id",
	"discord_channel_id",
	"exit_hosp_at",
	"record_created_at",
	"created_at",
	"updated_at"
)
SELECT
	(r."value"->>'targetId')::integer,
	CASE
		WHEN r."value"->>'factionId' ~ '^-?[0-9]+$' THEN (r."value"->>'factionId')::integer
	END,
	COALESCE(NULLIF(r."value"->>'targetName', ''), 'Unknown'),
	COALESCE(
		CASE
			WHEN r."value"->>'targetLevel' ~ '^-?[0-9]+$' THEN (r."value"->>'targetLevel')::integer
		END,
		0
	),
	COALESCE(
		CASE
			WHEN r."value"->>'estimatedBs' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (r."value"->>'estimatedBs')::double precision
		END,
		0
	),
	COALESCE(
		CASE
			WHEN r."value"->>'fairFight' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (r."value"->>'fairFight')::double precision
		END,
		0
	),
	COALESCE(
		CASE
			WHEN r."value"->>'hospitalUntil' ~ '^-?[0-9]+$' THEN (r."value"->>'hospitalUntil')::bigint
		END,
		0
	),
	CASE
		WHEN r."value"->>'status' IN ('open', 'claimed') THEN r."value"->>'status'
		ELSE 'open'
	END,
	CASE
		WHEN r."value"->'claimedBy'->>'tornId' ~ '^-?[0-9]+$' THEN (r."value"->'claimedBy'->>'tornId')::integer
	END,
	NULLIF(r."value"->'claimedBy'->>'tornName', ''),
	NULLIF(r."value"->'claimedBy'->>'discordId', ''),
	NULLIF(r."value"->'claimedBy'->>'discordTag', ''),
	NULLIF(r."value"->'claimedBy'->>'platform', ''),
	CASE
		WHEN r."value"->>'claimedAt' ~ '^-?[0-9]+$' THEN (r."value"->>'claimedAt')::bigint
	END,
	NULLIF(r."value"->>'discordMessageId', ''),
	NULLIF(r."value"->>'discordChannelId', ''),
	CASE
		WHEN r."value"->>'exitHospAt' ~ '^-?[0-9]+$' THEN (r."value"->>'exitHospAt')::bigint
	END,
	COALESCE(
		CASE
			WHEN r."value"->>'createdAt' ~ '^-?[0-9]+$' THEN (r."value"->>'createdAt')::bigint
		END,
		0
	),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_array_elements(
	CASE
		WHEN jsonb_typeof(s."data"->'records') = 'array' THEN s."data"->'records'
		ELSE '[]'::jsonb
	END
) AS r("value")
WHERE s."id" = 'subversive:dibs_records'
	AND COALESCE(r."value"->>'targetId', '') ~ '^-?[0-9]+$'
ON CONFLICT ("target_id") DO NOTHING;--> statement-breakpoint
-- `subversive:dibs_message_ledger` -> subversive_dibs_messages (one row per message).
--
-- The blob held `{ "messages": { "<messageId>": {...} } }`, so it is expanded
-- with jsonb_each using the object key as the primary key.
INSERT INTO "subversive_dibs_messages" (
	"message_id",
	"target_id",
	"faction_id",
	"channel_id",
	"posted_at_ms",
	"created_at",
	"updated_at"
)
SELECT
	kv."key",
	COALESCE(
		CASE
			WHEN kv."value"->>'targetId' ~ '^-?[0-9]+$' THEN (kv."value"->>'targetId')::integer
		END,
		0
	),
	CASE
		WHEN kv."value"->>'factionId' ~ '^-?[0-9]+$' THEN (kv."value"->>'factionId')::integer
	END,
	COALESCE(NULLIF(kv."value"->>'channelId', ''), ''),
	COALESCE(
		CASE
			WHEN kv."value"->>'createdAt' ~ '^-?[0-9]+$' THEN (kv."value"->>'createdAt')::bigint
		END,
		0
	),
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
CROSS JOIN LATERAL jsonb_each(
	CASE
		WHEN jsonb_typeof(s."data"->'messages') = 'object' THEN s."data"->'messages'
		ELSE '{}'::jsonb
	END
) AS kv("key", "value")
WHERE s."id" = 'subversive:dibs_message_ledger'
	AND kv."key" <> ''
ON CONFLICT ("message_id") DO NOTHING;--> statement-breakpoint
-- `points_market_price` -> torn_market_prices (the `points` reference).
--
-- The `~` guard means a double-encoded or otherwise unparseable row is skipped
-- entirely rather than inserting a bogus zero price; readers treat a missing row
-- as "unknown", which is the honest state.
INSERT INTO "torn_market_prices" (
	"ref_key",
	"price",
	"created_at",
	"updated_at"
)
SELECT
	'points',
	(s."data"->>'price')::bigint,
	COALESCE(s."created_at", now()),
	COALESCE(s."updated_at", now())
FROM "system_states" s
WHERE s."id" = 'points_market_price'
	AND jsonb_typeof(s."data") = 'object'
	AND COALESCE(s."data"->>'price', '') ~ '^-?[0-9]+$'
ON CONFLICT ("ref_key") DO NOTHING;