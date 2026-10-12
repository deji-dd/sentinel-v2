DROP TABLE "assets" CASCADE;--> statement-breakpoint
DROP TABLE "ledger_events" CASCADE;--> statement-breakpoint
DROP TABLE "torn_log_types" CASCADE;--> statement-breakpoint
DROP TABLE "wealth_account_snapshots" CASCADE;--> statement-breakpoint
-- The four tables above had exactly one writer: the personal wealth worker.
-- Its code is gone, so its persisted cursors go with it rather than outliving
-- the worker that read them — `0058` backfilled the `worker_state` row and the
-- legacy `system_states` key it replaced, and neither has a reader now.
DELETE FROM "worker_state" WHERE "worker_id" = 'personal:wealth';--> statement-breakpoint
DELETE FROM "system_states" WHERE "id" = 'personal:wealth';