-- Customers, groups, notes and the debt module (Sprint 6).
-- docs/ARCHITECTURE.md §5.7, §5.8, §12.
--
-- NOTE: 41 DROP statements for earlier migrations` hand-written constraints
-- were generated and stripped by hand, as in every migration since
-- 20260917124931_catalog.

/*
  Warnings:

  - You are about to drop the column `notes` on the `customer` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "customer" DROP COLUMN "notes",
ADD COLUMN     "birth_date" DATE,
ADD COLUMN     "customer_group_id" UUID;

-- CreateTable
CREATE TABLE "customer_group" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "credit_limit" BIGINT,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_note" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_note_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_group_organization_id_id_key" ON "customer_group"("organization_id", "id");

-- CreateIndex
CREATE INDEX "customer_note_organization_id_customer_id_created_at_idx" ON "customer_note"("organization_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "customer_note_organization_id_id_key" ON "customer_note"("organization_id", "id");

-- CreateIndex
CREATE INDEX "customer_organization_id_customer_group_id_idx" ON "customer"("organization_id", "customer_group_id");

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_customer_group_id_fkey" FOREIGN KEY ("customer_group_id") REFERENCES "customer_group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_note" ADD CONSTRAINT "customer_note_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN — docs/ARCHITECTURE.md §5.8, §12.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "customer"
  ADD CONSTRAINT "fk_customer_group_same_org"
  FOREIGN KEY ("organization_id", "customer_group_id")
  REFERENCES "customer_group" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "customer_note"
  ADD CONSTRAINT "fk_note_customer_same_org"
  FOREIGN KEY ("organization_id", "customer_id")
  REFERENCES "customer" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "customer_group"
  ADD CONSTRAINT "ck_group_name_not_blank" CHECK (length(btrim("name")) > 0);

ALTER TABLE "customer_group"
  ADD CONSTRAINT "ck_group_discount_range"
  CHECK ("discount_percent" >= 0 AND "discount_percent" <= 100);

ALTER TABLE "customer_group"
  ADD CONSTRAINT "ck_group_credit_limit_non_negative"
  CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0);

CREATE UNIQUE INDEX "uq_group_name_active"
  ON "customer_group" ("organization_id", lower("name")) WHERE "archived_at" IS NULL;

ALTER TABLE "customer_note"
  ADD CONSTRAINT "ck_note_body_not_blank" CHECK (length(btrim("body")) > 0);

-- A note is a log entry. Editing one turns "called, promised Friday" into
-- whatever suits the person who broke the promise, so the log is append-only
-- like every other record in this system that somebody might want to revise.
CREATE OR REPLACE FUNCTION customer_note_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'customer_note is append-only (%s attempted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_customer_note_immutable
  BEFORE UPDATE ON "customer_note"
  FOR EACH ROW EXECUTE FUNCTION customer_note_immutable();

-- ── Receivables ────────────────────────────────────────────────────────────
-- The top-debtors report, and the per-customer statement.
CREATE INDEX "ix_receivable_customer_open"
  ON "customer_receivable" ("organization_id", "customer_id")
  WHERE "status" IN ('OPEN', 'PARTIALLY_PAID');

-- A closed receivable must say when. Without this, "paid" rows accumulate with
-- no date and the collections report cannot answer "how long did it take".
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "ck_receivable_closed_has_timestamp" CHECK (
    "status" NOT IN ('PAID', 'WRITTEN_OFF') OR "closed_at" IS NOT NULL
  );

-- A write-off is a real financial event and is reported separately from
-- collections. It is never netted into paid_amount, so it needs its own reason.
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "ck_receivable_writeoff_has_note" CHECK (
    "written_off_amount" = 0 OR "note" IS NOT NULL
  );
