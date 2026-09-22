-- Cash register, shifts and drawer movements (Sprint 10).
-- docs/ARCHITECTURE.md §5.6, §19.
--
-- NOTE: 67 DROP statements for earlier migrations' hand-written constraints
-- were generated and stripped by hand, as in every migration since the catalog.

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('DROP', 'PAYOUT', 'EXPENSE', 'CORRECTION', 'OTHER');

-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "cash_register_shift_id" UUID;

-- AlterTable
ALTER TABLE "sale" ADD COLUMN     "cash_register_shift_id" UUID;

-- AlterTable
ALTER TABLE "supplier_payment" ADD COLUMN     "cash_register_shift_id" UUID;

-- CreateTable
CREATE TABLE "cash_register" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cash_register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_register_shift" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "cash_register_id" UUID NOT NULL,
    "shift_number" TEXT NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "opening_amount" BIGINT NOT NULL,
    "opened_by" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_cash_amount" BIGINT,
    "counted_cash_amount" BIGINT,
    "difference_amount" BIGINT,
    "closed_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cash_register_shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movement" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "cash_register_shift_id" UUID NOT NULL,
    "direction" "CashMovementDirection" NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cash_register_organization_id_store_id_idx" ON "cash_register"("organization_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_register_organization_id_id_key" ON "cash_register"("organization_id", "id");

-- CreateIndex
CREATE INDEX "cash_register_shift_organization_id_store_id_opened_at_idx" ON "cash_register_shift"("organization_id", "store_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "cash_register_shift_cash_register_id_status_idx" ON "cash_register_shift"("cash_register_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_register_shift_organization_id_id_key" ON "cash_register_shift"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_register_shift_organization_id_shift_number_key" ON "cash_register_shift"("organization_id", "shift_number");

-- CreateIndex
CREATE INDEX "cash_movement_organization_id_cash_register_shift_id_idx" ON "cash_movement"("organization_id", "cash_register_shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_movement_organization_id_id_key" ON "cash_movement"("organization_id", "id");

-- CreateIndex
CREATE INDEX "payment_cash_register_shift_id_method_idx" ON "payment"("cash_register_shift_id", "method");

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_cash_register_shift_id_fkey" FOREIGN KEY ("cash_register_shift_id") REFERENCES "cash_register_shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_cash_register_shift_id_fkey" FOREIGN KEY ("cash_register_shift_id") REFERENCES "cash_register_shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_cash_register_shift_id_fkey" FOREIGN KEY ("cash_register_shift_id") REFERENCES "cash_register_shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_register" ADD CONSTRAINT "cash_register_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_register_shift" ADD CONSTRAINT "cash_register_shift_cash_register_id_fkey" FOREIGN KEY ("cash_register_id") REFERENCES "cash_register"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_cash_register_shift_id_fkey" FOREIGN KEY ("cash_register_shift_id") REFERENCES "cash_register_shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN — docs/ARCHITECTURE.md §5.6, §19.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "cash_register"
  ADD CONSTRAINT "fk_register_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "cash_register_shift"
  ADD CONSTRAINT "fk_shift_register_same_org"
  FOREIGN KEY ("organization_id", "cash_register_id")
  REFERENCES "cash_register" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "cash_register_shift"
  ADD CONSTRAINT "fk_shift_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "cash_movement"
  ADD CONSTRAINT "fk_movement_shift_same_org"
  FOREIGN KEY ("organization_id", "cash_register_shift_id")
  REFERENCES "cash_register_shift" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale"
  ADD CONSTRAINT "fk_sale_shift_same_org"
  FOREIGN KEY ("organization_id", "cash_register_shift_id")
  REFERENCES "cash_register_shift" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "payment"
  ADD CONSTRAINT "fk_payment_shift_same_org"
  FOREIGN KEY ("organization_id", "cash_register_shift_id")
  REFERENCES "cash_register_shift" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "supplier_payment"
  ADD CONSTRAINT "fk_supplier_payment_shift_same_org"
  FOREIGN KEY ("organization_id", "cash_register_shift_id")
  REFERENCES "cash_register_shift" ("organization_id", "id") ON DELETE RESTRICT;

-- ── Registers ──────────────────────────────────────────────────────────────
ALTER TABLE "cash_register"
  ADD CONSTRAINT "ck_register_code_not_blank" CHECK (length(btrim("code")) > 0);

CREATE UNIQUE INDEX "uq_register_code_active"
  ON "cash_register" ("organization_id", "store_id", "code")
  WHERE "archived_at" IS NULL;

-- ── Shifts ─────────────────────────────────────────────────────────────────
-- THE index of this sprint. Two cashiers cannot open the same till, and the
-- database says so rather than a service method with a race in it. This single
-- partial unique removes the entire "double-opened drawer" class of bug.
CREATE UNIQUE INDEX "uq_one_open_shift_per_register"
  ON "cash_register_shift" ("cash_register_id") WHERE "status" = 'OPEN';

ALTER TABLE "cash_register_shift"
  ADD CONSTRAINT "ck_shift_opening_non_negative" CHECK ("opening_amount" >= 0);

-- A closed shift must carry the whole reconciliation. Without this, shifts
-- accumulate with a status of CLOSED and no numbers behind it, and the
-- Z-report becomes unreproducible.
ALTER TABLE "cash_register_shift"
  ADD CONSTRAINT "ck_shift_closed_is_complete" CHECK (
    "status" <> 'CLOSED'
    OR ("closed_at" IS NOT NULL AND "closed_by" IS NOT NULL
        AND "expected_cash_amount" IS NOT NULL
        AND "counted_cash_amount" IS NOT NULL
        AND "difference_amount" IS NOT NULL)
  );

-- The difference is a derived fact and must stay consistent with its inputs.
-- Stored rather than computed because a Z-report reprinted next month must
-- show what the cashier signed for — but it may never disagree with the two
-- numbers it came from.
ALTER TABLE "cash_register_shift"
  ADD CONSTRAINT "ck_shift_difference_adds_up" CHECK (
    "difference_amount" IS NULL
    OR "difference_amount" = "counted_cash_amount" - "expected_cash_amount"
  );

ALTER TABLE "cash_register_shift"
  ADD CONSTRAINT "ck_shift_counted_non_negative"
  CHECK ("counted_cash_amount" IS NULL OR "counted_cash_amount" >= 0);

ALTER TABLE "cash_register_shift"
  ADD CONSTRAINT "ck_shift_number_not_blank" CHECK (length(btrim("shift_number")) > 0);

-- ── Drawer movements ───────────────────────────────────────────────────────
ALTER TABLE "cash_movement"
  ADD CONSTRAINT "ck_cash_movement_amount_positive" CHECK ("amount" > 0);

-- "Where did that 200,000 go" is the question this table exists to answer.
ALTER TABLE "cash_movement"
  ADD CONSTRAINT "ck_cash_movement_reason_not_blank"
  CHECK (length(btrim("reason")) > 0);

-- Append-only. A drawer movement that can be edited after the shift is closed
-- makes the difference meaningless.
CREATE OR REPLACE FUNCTION cash_movement_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'cash_movement is append-only (%s attempted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_cash_movement_immutable
  BEFORE UPDATE OR DELETE ON "cash_movement"
  FOR EACH ROW EXECUTE FUNCTION cash_movement_immutable();

-- NOTE: §5.5 specifies CHECK (status <> 'COMPLETED' OR cash_register_shift_id
-- IS NOT NULL) on `sale`. It is deliberately NOT declared. A shop that does
-- not open a till still sells, no screen forces a shift open, and mandating it
-- would make every existing checkout path fail. The shift is attached when one
-- is open; the Z-report is then about the shifts that actually happened.
-- Revisit when the POS guarantees an open shift before the first sale.
