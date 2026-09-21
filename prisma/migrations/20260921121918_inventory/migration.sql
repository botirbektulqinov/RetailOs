-- Inventory: levels, the append-only movement ledger, counts and transfers
-- (Sprint 4). docs/ARCHITECTURE.md §5.4 and §9.
--
-- NOTE: `prisma migrate dev` again generated DROP statements for the
-- hand-written constraints of the identity and catalog migrations — seven
-- composite same-org foreign keys and five trigram indexes. Prisma does not
-- know about them, reads them as drift, and proposes removing them every
-- time. They were stripped by hand, as in 20260917124931_catalog.

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('INITIAL', 'PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'DAMAGE', 'WRITE_OFF', 'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT_CORRECTION');

-- CreateEnum
CREATE TYPE "InventoryCountStatus" AS ENUM ('DRAFT', 'COUNTING', 'FINALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InventoryCountScope" AS ENUM ('FULL', 'PARTIAL', 'CATEGORY');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "inventory_level" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "avg_cost" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movement" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity_delta" DECIMAL(14,3) NOT NULL,
    "quantity_after" DECIMAL(14,3) NOT NULL,
    "unit_cost" BIGINT,
    "source_type" TEXT NOT NULL,
    "source_id" UUID,
    "reason" TEXT,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "count_number" TEXT NOT NULL,
    "status" "InventoryCountStatus" NOT NULL DEFAULT 'DRAFT',
    "scope" "InventoryCountScope" NOT NULL DEFAULT 'FULL',
    "category_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "finalized_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "finalized_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_count_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "inventory_count_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "expected_quantity" DECIMAL(14,3) NOT NULL,
    "counted_quantity" DECIMAL(14,3),
    "unit_cost" BIGINT,
    "counted_by" UUID,
    "counted_at" TIMESTAMPTZ(6),
    "applied_delta" DECIMAL(14,3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_count_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "transfer_number" TEXT NOT NULL,
    "from_warehouse_id" UUID NOT NULL,
    "to_warehouse_id" UUID NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "sent_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "sent_by" UUID,
    "received_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "stock_transfer_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "received_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unit_cost" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "stock_transfer_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_counter" (
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "document_counter_pkey" PRIMARY KEY ("organization_id","store_id","document_type","period_key")
);

-- CreateIndex
CREATE INDEX "inventory_level_organization_id_product_variant_id_idx" ON "inventory_level"("organization_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_level_warehouse_id_product_variant_id_key" ON "inventory_level"("warehouse_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_level_organization_id_id_key" ON "inventory_level"("organization_id", "id");

-- CreateIndex
CREATE INDEX "inventory_movement_organization_id_product_variant_id_creat_idx" ON "inventory_movement"("organization_id", "product_variant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_movement_organization_id_warehouse_id_created_at_idx" ON "inventory_movement"("organization_id", "warehouse_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_movement_organization_id_type_created_at_idx" ON "inventory_movement"("organization_id", "type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_movement_source_type_source_id_idx" ON "inventory_movement"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movement_organization_id_id_key" ON "inventory_movement"("organization_id", "id");

-- CreateIndex
CREATE INDEX "inventory_count_organization_id_warehouse_id_status_idx" ON "inventory_count"("organization_id", "warehouse_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_organization_id_count_number_key" ON "inventory_count"("organization_id", "count_number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_organization_id_id_key" ON "inventory_count"("organization_id", "id");

-- CreateIndex
CREATE INDEX "inventory_count_item_organization_id_inventory_count_id_idx" ON "inventory_count_item"("organization_id", "inventory_count_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_item_inventory_count_id_product_variant_id_key" ON "inventory_count_item"("inventory_count_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_count_item_organization_id_id_key" ON "inventory_count_item"("organization_id", "id");

-- CreateIndex
CREATE INDEX "stock_transfer_organization_id_status_idx" ON "stock_transfer"("organization_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfer_organization_id_from_warehouse_id_idx" ON "stock_transfer"("organization_id", "from_warehouse_id");

-- CreateIndex
CREATE INDEX "stock_transfer_organization_id_to_warehouse_id_idx" ON "stock_transfer"("organization_id", "to_warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_organization_id_transfer_number_key" ON "stock_transfer"("organization_id", "transfer_number");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_organization_id_id_key" ON "stock_transfer"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_item_stock_transfer_id_product_variant_id_key" ON "stock_transfer_item"("stock_transfer_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_item_organization_id_id_key" ON "stock_transfer_item"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_level" ADD CONSTRAINT "inventory_level_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count" ADD CONSTRAINT "inventory_count_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_inventory_count_id_fkey" FOREIGN KEY ("inventory_count_id") REFERENCES "inventory_count"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_count_item" ADD CONSTRAINT "inventory_count_item_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_from_warehouse_id_fkey" FOREIGN KEY ("from_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_to_warehouse_id_fkey" FOREIGN KEY ("to_warehouse_id") REFERENCES "warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_stock_transfer_id_fkey" FOREIGN KEY ("stock_transfer_id") REFERENCES "stock_transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_item" ADD CONSTRAINT "stock_transfer_item_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN — everything below is outside what Prisma can express.
-- docs/ARCHITECTURE.md §5.4, §6.2, §9.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cross-organization integrity ───────────────────────────────────────────
-- Composite foreign keys on (organization_id, <fk>). A single-column FK would
-- happily let warehouse A of one organization hold stock of another
-- organization's variant. These make that impossible in the database, so a
-- tenant leak needs a schema change rather than a forgotten WHERE clause.

ALTER TABLE "inventory_level"
  ADD CONSTRAINT "fk_level_warehouse_same_org"
  FOREIGN KEY ("organization_id", "warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "inventory_level"
  ADD CONSTRAINT "fk_level_variant_same_org"
  FOREIGN KEY ("organization_id", "product_variant_id")
  REFERENCES "product_variant" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "inventory_movement"
  ADD CONSTRAINT "fk_movement_warehouse_same_org"
  FOREIGN KEY ("organization_id", "warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "inventory_movement"
  ADD CONSTRAINT "fk_movement_variant_same_org"
  FOREIGN KEY ("organization_id", "product_variant_id")
  REFERENCES "product_variant" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "inventory_count"
  ADD CONSTRAINT "fk_count_warehouse_same_org"
  FOREIGN KEY ("organization_id", "warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

-- scope = CATEGORY narrows the count to one category; it must be ours.
ALTER TABLE "inventory_count"
  ADD CONSTRAINT "fk_count_category_same_org"
  FOREIGN KEY ("organization_id", "category_id")
  REFERENCES "category" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "inventory_count_item"
  ADD CONSTRAINT "fk_count_item_count_same_org"
  FOREIGN KEY ("organization_id", "inventory_count_id")
  REFERENCES "inventory_count" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "inventory_count_item"
  ADD CONSTRAINT "fk_count_item_variant_same_org"
  FOREIGN KEY ("organization_id", "product_variant_id")
  REFERENCES "product_variant" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "stock_transfer"
  ADD CONSTRAINT "fk_transfer_from_same_org"
  FOREIGN KEY ("organization_id", "from_warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "stock_transfer"
  ADD CONSTRAINT "fk_transfer_to_same_org"
  FOREIGN KEY ("organization_id", "to_warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "stock_transfer_item"
  ADD CONSTRAINT "fk_transfer_item_transfer_same_org"
  FOREIGN KEY ("organization_id", "stock_transfer_id")
  REFERENCES "stock_transfer" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "stock_transfer_item"
  ADD CONSTRAINT "fk_transfer_item_variant_same_org"
  FOREIGN KEY ("organization_id", "product_variant_id")
  REFERENCES "product_variant" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "document_counter"
  ADD CONSTRAINT "fk_counter_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE CASCADE;

-- ── The ledger's own rules ─────────────────────────────────────────────────

-- A movement that moves nothing is a bug that would otherwise sit in the
-- history looking like a real event.
ALTER TABLE "inventory_movement"
  ADD CONSTRAINT "ck_movement_delta_nonzero" CHECK ("quantity_delta" <> 0);

-- The sign must match the type. A PURCHASE that removes stock, or a SALE that
-- adds it, is not a transaction anyone meant to write — and once written it
-- cannot be corrected, because this table is append-only. ADJUSTMENT and
-- COUNT_CORRECTION are the two genuinely bidirectional types.
ALTER TABLE "inventory_movement"
  ADD CONSTRAINT "ck_movement_sign" CHECK (
    ("type" IN ('SALE', 'TRANSFER_OUT', 'DAMAGE', 'WRITE_OFF') AND "quantity_delta" < 0)
    OR ("type" IN ('PURCHASE', 'RETURN', 'TRANSFER_IN', 'INITIAL') AND "quantity_delta" > 0)
    OR ("type" IN ('ADJUSTMENT', 'COUNT_CORRECTION'))
  );

-- Stock that leaves for a human reason must name it. "Where did those three
-- go" is the question this table exists to answer.
ALTER TABLE "inventory_movement"
  ADD CONSTRAINT "ck_movement_reason_required" CHECK (
    "type" NOT IN ('ADJUSTMENT', 'DAMAGE', 'WRITE_OFF') OR "reason" IS NOT NULL
  );

ALTER TABLE "inventory_movement"
  ADD CONSTRAINT "ck_movement_unit_cost_non_negative"
  CHECK ("unit_cost" IS NULL OR "unit_cost" >= 0);

ALTER TABLE "inventory_movement"
  ADD CONSTRAINT "ck_movement_source_type_not_blank"
  CHECK (length(btrim("source_type")) > 0);

-- ── Append-only ────────────────────────────────────────────────────────────
-- The ledger is the truth (§9.1). Without this, a single careless
-- `updateMany` silently rewrites history that every stock number rests on,
-- and reconciliation would report a discrepancy nobody could explain.
--
-- A trigger rather than a permission grant: the application connects as the
-- owner in the MVP, so REVOKE UPDATE would be revoked from the role that can
-- grant it right back.
CREATE OR REPLACE FUNCTION inventory_movement_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movement is append-only (%s attempted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_inventory_movement_immutable
  BEFORE UPDATE OR DELETE ON "inventory_movement"
  FOR EACH ROW EXECUTE FUNCTION inventory_movement_immutable();

-- ── Levels ─────────────────────────────────────────────────────────────────
-- Deliberately NO `CHECK (quantity >= 0)`. Negative stock is a per-warehouse
-- policy (§9.4) enforced by the conditional UPDATE in InventoryService.apply();
-- a blanket constraint would make the policy unimplementable. The bound below
-- is a sanity rail that catches a sign-flip bug without constraining policy.
ALTER TABLE "inventory_level"
  ADD CONSTRAINT "ck_level_quantity_sane"
  CHECK ("quantity" BETWEEN -1000000 AND 99999999999);

ALTER TABLE "inventory_level"
  ADD CONSTRAINT "ck_level_avg_cost_non_negative" CHECK ("avg_cost" >= 0);

-- The out-of-stock and low-stock reports read only these rows. A partial index
-- keeps it a few pages even when the catalogue is large, because in a healthy
-- shop most levels are positive.
CREATE INDEX "ix_level_out_of_stock"
  ON "inventory_level" ("organization_id", "warehouse_id")
  WHERE "quantity" <= 0;

-- ── Counts ─────────────────────────────────────────────────────────────────
-- One open count per warehouse. This single index removes an entire class of
-- race condition: two stocktakes of the same warehouse, both snapshotting the
-- same expected quantities, both finalizing, the second undoing the first.
CREATE UNIQUE INDEX "uq_one_open_count_per_warehouse"
  ON "inventory_count" ("warehouse_id")
  WHERE "status" IN ('DRAFT', 'COUNTING');

ALTER TABLE "inventory_count"
  ADD CONSTRAINT "ck_count_category_scope" CHECK (
    ("scope" = 'CATEGORY' AND "category_id" IS NOT NULL)
    OR ("scope" <> 'CATEGORY' AND "category_id" IS NULL)
  );

ALTER TABLE "inventory_count"
  ADD CONSTRAINT "ck_count_finalized_fields" CHECK (
    "status" <> 'FINALIZED' OR ("finalized_at" IS NOT NULL AND "finalized_by" IS NOT NULL)
  );

ALTER TABLE "inventory_count_item"
  ADD CONSTRAINT "ck_count_item_counted_non_negative"
  CHECK ("counted_quantity" IS NULL OR "counted_quantity" >= 0);

-- NOTE: the architecture specified `difference` as a STORED generated column.
-- It is omitted deliberately: Prisma 7 cannot declare one, so it would read as
-- drift and be proposed for removal on every future migration — the exact
-- failure mode this file's header warns about. The value it bought was the
-- predicate `counted_quantity <> expected_quantity`, which is written directly
-- wherever it is needed. `applied_delta` (a real column) records what the
-- finalization actually moved, which is the number that matters afterwards and
-- which a generated column could not have held.

-- ── Transfers ──────────────────────────────────────────────────────────────
ALTER TABLE "stock_transfer"
  ADD CONSTRAINT "ck_transfer_distinct_warehouses"
  CHECK ("from_warehouse_id" <> "to_warehouse_id");

ALTER TABLE "stock_transfer_item"
  ADD CONSTRAINT "ck_transfer_item_quantity_positive" CHECK ("quantity" > 0);

-- Receiving more than was sent is not shrinkage, it is a data-entry error.
ALTER TABLE "stock_transfer_item"
  ADD CONSTRAINT "ck_transfer_item_received_within_sent"
  CHECK ("received_quantity" >= 0 AND "received_quantity" <= "quantity");

ALTER TABLE "stock_transfer_item"
  ADD CONSTRAINT "ck_transfer_item_unit_cost_non_negative" CHECK ("unit_cost" >= 0);

-- ── Document numbers ───────────────────────────────────────────────────────
ALTER TABLE "document_counter"
  ADD CONSTRAINT "ck_counter_next_value_positive" CHECK ("next_value" >= 1);
