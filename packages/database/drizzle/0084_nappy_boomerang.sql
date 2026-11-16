-- Keep the oldest operator per book; a database that predates the seeded
-- operator may have extras from the old manual-create path. They keep their
-- lots but stop being operators so the unique index can be created.
UPDATE "capital_investors" AS ci
SET "kind" = 'user'
WHERE ci."kind" = 'operator'
  AND EXISTS (
    SELECT 1
    FROM "capital_investors" AS other
    WHERE other."book" = ci."book"
      AND other."kind" = 'operator'
      AND (other."created_at", other."id") < (ci."created_at", ci."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX "capital_investors_book_operator_idx" ON "capital_investors" USING btree ("book") WHERE "capital_investors"."kind" = 'operator';