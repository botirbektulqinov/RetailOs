-- Returns and exchanges (Sprint 8). docs/ARCHITECTURE.md §5.5, §13, §14.
--
-- NOTE: 52 DROP statements for earlier migrations' hand-written constraints
-- were generated and stripped by hand, as in every migration since the catalog.

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DEFECTIVE', 'WRONG_ITEM', 'CHANGED_MIND', 'EXPIRED', 'OTHER');

-- CreateEnum
CREATE TYPE "ItemCondition" AS ENUM ('SELLABLE', 'DAMAGED');

-- CreateEnum
CREATE TYPE "ExchangeSettlement" AS ENUM ('CUSTOMER_PAID', 'REFUNDED', 'EVEN', 'CREDITED_TO_DEBT');

-- AlterTable
ALTER TABLE "payment_allocation" ADD COLUMN     "return_id" UUID;

-- CreateTable
CREATE TABLE "sale_return" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "customer_id" UUID,
    "return_number" TEXT NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "reason_note" TEXT,
    "refund_amount" BIGINT NOT NULL,
    "credit_offset_amount" BIGINT NOT NULL DEFAULT 0,
    "exchange_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sale_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "sale_item_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_refund_amount" BIGINT NOT NULL,
    "refund_amount" BIGINT NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,
    "condition" "ItemCondition" NOT NULL DEFAULT 'SELLABLE',

    CONSTRAINT "return_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "exchange_number" TEXT NOT NULL,
    "return_id" UUID NOT NULL,
    "replacement_sale_id" UUID NOT NULL,
    "customer_id" UUID,
    "returned_value" BIGINT NOT NULL,
    "replacement_value" BIGINT NOT NULL,
    "net_amount" BIGINT NOT NULL,
    "settlement" "ExchangeSettlement" NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_exchange_id_key" ON "sale_return"("exchange_id");

-- CreateIndex
CREATE INDEX "sale_return_organization_id_sale_id_idx" ON "sale_return"("organization_id", "sale_id");

-- CreateIndex
CREATE INDEX "sale_return_organization_id_created_at_idx" ON "sale_return"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sale_return_organization_id_customer_id_created_at_idx" ON "sale_return"("organization_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_organization_id_id_key" ON "sale_return"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_return_organization_id_store_id_return_number_key" ON "sale_return"("organization_id", "store_id", "return_number");

-- CreateIndex
CREATE INDEX "return_item_organization_id_product_variant_id_idx" ON "return_item"("organization_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "return_item_organization_id_id_key" ON "return_item"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "return_item_return_id_sale_item_id_key" ON "return_item"("return_id", "sale_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_return_id_key" ON "exchange"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_replacement_sale_id_key" ON "exchange"("replacement_sale_id");

-- CreateIndex
CREATE INDEX "exchange_organization_id_created_at_idx" ON "exchange"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_organization_id_id_key" ON "exchange"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_organization_id_store_id_exchange_number_key" ON "exchange"("organization_id", "store_id", "exchange_number");

-- CreateIndex
CREATE INDEX "payment_allocation_return_id_idx" ON "payment_allocation"("return_id");

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sale_return"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return" ADD CONSTRAINT "sale_return_exchange_id_fkey" FOREIGN KEY ("exchange_id") REFERENCES "exchange"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sale_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_item" ADD CONSTRAINT "return_item_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange" ADD CONSTRAINT "exchange_replacement_sale_id_fkey" FOREIGN KEY ("replacement_sale_id") REFERENCES "sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange" ADD CONSTRAINT "exchange_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN — docs/ARCHITECTURE.md §5.5, §13, §14.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── An allocation may now settle a return as well ──────────────────────────
-- Replaced rather than extended: the old constraint named two columns, and a
-- refund allocated to a return would have failed num_nonnulls = 1.
ALTER TABLE "payment_allocation" DROP CONSTRAINT "ck_allocation_single_target";

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "ck_allocation_single_target"
  CHECK (num_nonnulls("sale_id", "receivable_id", "return_id") = 1);

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "fk_allocation_return_same_org"
  FOREIGN KEY ("organization_id", "return_id")
  REFERENCES "sale_return" ("organization_id", "id") ON DELETE RESTRICT;

-- ── Cross-organization integrity ───────────────────────────────────────────
ALTER TABLE "sale_return"
  ADD CONSTRAINT "fk_return_sale_same_org"
  FOREIGN KEY ("organization_id", "sale_id")
  REFERENCES "sale" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale_return"
  ADD CONSTRAINT "fk_return_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale_return"
  ADD CONSTRAINT "fk_return_warehouse_same_org"
  FOREIGN KEY ("organization_id", "warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale_return"
  ADD CONSTRAINT "fk_return_customer_same_org"
  FOREIGN KEY ("organization_id", "customer_id")
  REFERENCES "customer" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "return_item"
  ADD CONSTRAINT "fk_return_item_return_same_org"
  FOREIGN KEY ("organization_id", "return_id")
  REFERENCES "sale_return" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "return_item"
  ADD CONSTRAINT "fk_return_item_sale_item_same_org"
  FOREIGN KEY ("organization_id", "sale_item_id")
  REFERENCES "sale_item" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "return_item"
  ADD CONSTRAINT "fk_return_item_variant_same_org"
  FOREIGN KEY ("organization_id", "product_variant_id")
  REFERENCES "product_variant" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "exchange"
  ADD CONSTRAINT "fk_exchange_sale_same_org"
  FOREIGN KEY ("organization_id", "replacement_sale_id")
  REFERENCES "sale" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "exchange"
  ADD CONSTRAINT "fk_exchange_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "exchange"
  ADD CONSTRAINT "fk_exchange_customer_same_org"
  FOREIGN KEY ("organization_id", "customer_id")
  REFERENCES "customer" ("organization_id", "id") ON DELETE RESTRICT;

-- ── Return arithmetic ──────────────────────────────────────────────────────
ALTER TABLE "sale_return"
  ADD CONSTRAINT "ck_return_amounts_non_negative"
  CHECK ("refund_amount" >= 0 AND "credit_offset_amount" >= 0);

ALTER TABLE "sale_return"
  ADD CONSTRAINT "ck_return_number_not_blank"
  CHECK (length(btrim("return_number")) > 0);

ALTER TABLE "return_item"
  ADD CONSTRAINT "ck_return_item_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "return_item"
  ADD CONSTRAINT "ck_return_item_refund_non_negative"
  CHECK ("refund_amount" >= 0 AND "unit_refund_amount" >= 0);

-- Goods in DAMAGED condition never go back on the shelf. Enforced here as
-- well as in the service, because "returned" and "written off" are different
-- facts and merging them hides shrinkage.
ALTER TABLE "return_item"
  ADD CONSTRAINT "ck_return_item_damaged_never_restocks"
  CHECK ("condition" <> 'DAMAGED' OR "restock" = false);

-- ── Exchange arithmetic ────────────────────────────────────────────────────
ALTER TABLE "exchange"
  ADD CONSTRAINT "ck_exchange_net_adds_up"
  CHECK ("net_amount" = "replacement_value" - "returned_value");

ALTER TABLE "exchange"
  ADD CONSTRAINT "ck_exchange_values_non_negative"
  CHECK ("returned_value" >= 0 AND "replacement_value" >= 0);

-- The settlement must match the sign of the net. An EVEN exchange that owes
-- money, or a REFUNDED one where the customer actually paid, is a reporting
-- lie that nothing downstream could detect.
ALTER TABLE "exchange"
  ADD CONSTRAINT "ck_exchange_settlement_matches_net" CHECK (
    ("net_amount" = 0 AND "settlement" = 'EVEN')
    OR ("net_amount" > 0 AND "settlement" IN ('CUSTOMER_PAID', 'CREDITED_TO_DEBT'))
    OR ("net_amount" < 0 AND "settlement" = 'REFUNDED')
  );

ALTER TABLE "exchange"
  ADD CONSTRAINT "ck_exchange_number_not_blank"
  CHECK (length(btrim("exchange_number")) > 0);

-- ── Sale, revisited ────────────────────────────────────────────────────────
-- A sale can never be refunded for more than it was worth. BR-7, and the
-- backstop for the service's own running check.
ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_refund_within_total"
  CHECK ("refunded_amount" <= "total_amount");

-- A line's refunds likewise cannot exceed what it was sold for.
ALTER TABLE "sale_item"
  ADD CONSTRAINT "ck_sale_item_refund_within_net"
  CHECK ("refunded_amount" <= "net_amount");
