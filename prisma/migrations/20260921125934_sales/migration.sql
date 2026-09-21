-- Selling: customers, sales, payments, allocations, receivables and the
-- idempotency record (Sprint 5). docs/ARCHITECTURE.md §5.5–§5.8, §10, §11, §26.
--
-- NOTE: `prisma migrate dev` generated 25 DROP statements for the hand-written
-- constraints of the earlier migrations. Prisma does not know about them and
-- proposes removing them every time. Stripped by hand, as in every migration
-- since 20260917124931_catalog.

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('DRAFT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SaleReturnStatus" AS ENUM ('NONE', 'PARTIAL', 'FULL');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'CLICK', 'PAYME', 'UZUM', 'TRANSFER', 'LOYALTY', 'OTHER');

-- CreateEnum
CREATE TYPE "ReceivableOrigin" AS ENUM ('SALE', 'OPENING_BALANCE', 'MANUAL', 'EXCHANGE');

-- CreateEnum
CREATE TYPE "ReceivableStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" CITEXT,
    "address" TEXT,
    "notes" TEXT,
    "credit_limit" BIGINT,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "customer_id" UUID,
    "sale_number" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'DRAFT',
    "return_status" "SaleReturnStatus" NOT NULL DEFAULT 'NONE',
    "subtotal_amount" BIGINT NOT NULL DEFAULT 0,
    "order_discount_amount" BIGINT NOT NULL DEFAULT 0,
    "tax_amount" BIGINT NOT NULL DEFAULT 0,
    "rounding_adjustment" BIGINT NOT NULL DEFAULT 0,
    "total_amount" BIGINT NOT NULL DEFAULT 0,
    "paid_amount" BIGINT NOT NULL DEFAULT 0,
    "credit_amount" BIGINT NOT NULL DEFAULT 0,
    "refunded_amount" BIGINT NOT NULL DEFAULT 0,
    "cost_amount" BIGINT NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" UUID,
    "cancel_reason" TEXT,
    "client_id" UUID,
    "client_created_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "name_snapshot" TEXT NOT NULL,
    "sku_snapshot" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "line_discount_amount" BIGINT NOT NULL DEFAULT 0,
    "allocated_order_discount" BIGINT NOT NULL DEFAULT 0,
    "net_amount" BIGINT NOT NULL,
    "unit_cost" BIGINT NOT NULL,
    "returned_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "refunded_amount" BIGINT NOT NULL DEFAULT 0,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "sale_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "customer_id" UUID,
    "direction" "PaymentDirection" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'COMPLETED',
    "provider_ref" TEXT,
    "provider_meta" JSONB NOT NULL DEFAULT '{}',
    "received_by" UUID NOT NULL,
    "note" TEXT,
    "idempotency_key" TEXT,
    "client_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocation" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "sale_id" UUID,
    "receivable_id" UUID,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_receivable" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "sale_id" UUID,
    "origin" "ReceivableOrigin" NOT NULL DEFAULT 'SALE',
    "original_amount" BIGINT NOT NULL,
    "paid_amount" BIGINT NOT NULL DEFAULT 0,
    "written_off_amount" BIGINT NOT NULL DEFAULT 0,
    "status" "ReceivableStatus" NOT NULL DEFAULT 'OPEN',
    "issued_at" TIMESTAMPTZ(6) NOT NULL,
    "due_date" DATE NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_receivable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "resource_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_organization_id_full_name_idx" ON "customer"("organization_id", "full_name");

-- CreateIndex
CREATE INDEX "customer_organization_id_phone_idx" ON "customer"("organization_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "customer_organization_id_id_key" ON "customer"("organization_id", "id");

-- CreateIndex
CREATE INDEX "sale_organization_id_store_id_completed_at_idx" ON "sale"("organization_id", "store_id", "completed_at" DESC);

-- CreateIndex
CREATE INDEX "sale_organization_id_customer_id_completed_at_idx" ON "sale"("organization_id", "customer_id", "completed_at" DESC);

-- CreateIndex
CREATE INDEX "sale_organization_id_status_idx" ON "sale"("organization_id", "status");

-- CreateIndex
CREATE INDEX "sale_organization_id_created_by_completed_at_idx" ON "sale"("organization_id", "created_by", "completed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "sale_organization_id_id_key" ON "sale"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_organization_id_store_id_sale_number_key" ON "sale"("organization_id", "store_id", "sale_number");

-- CreateIndex
CREATE INDEX "sale_item_organization_id_product_variant_id_idx" ON "sale_item"("organization_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_item_organization_id_id_key" ON "sale_item"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_item_sale_id_position_key" ON "sale_item"("sale_id", "position");

-- CreateIndex
CREATE INDEX "payment_organization_id_customer_id_created_at_idx" ON "payment"("organization_id", "customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payment_organization_id_store_id_created_at_idx" ON "payment"("organization_id", "store_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payment_organization_id_method_created_at_idx" ON "payment"("organization_id", "method", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_organization_id_id_key" ON "payment"("organization_id", "id");

-- CreateIndex
CREATE INDEX "payment_allocation_sale_id_idx" ON "payment_allocation"("sale_id");

-- CreateIndex
CREATE INDEX "payment_allocation_receivable_id_idx" ON "payment_allocation"("receivable_id");

-- CreateIndex
CREATE INDEX "payment_allocation_payment_id_idx" ON "payment_allocation"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_allocation_organization_id_id_key" ON "payment_allocation"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_receivable_sale_id_key" ON "customer_receivable"("sale_id");

-- CreateIndex
CREATE INDEX "customer_receivable_organization_id_customer_id_status_idx" ON "customer_receivable"("organization_id", "customer_id", "status");

-- CreateIndex
CREATE INDEX "customer_receivable_organization_id_due_date_idx" ON "customer_receivable"("organization_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "customer_receivable_organization_id_id_key" ON "customer_receivable"("organization_id", "id");

-- CreateIndex
CREATE INDEX "idempotency_record_expires_at_idx" ON "idempotency_record"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_organization_id_key_key" ON "idempotency_record"("organization_id", "key");

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item" ADD CONSTRAINT "sale_item_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_receivable_id_fkey" FOREIGN KEY ("receivable_id") REFERENCES "customer_receivable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receivable" ADD CONSTRAINT "customer_receivable_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_receivable" ADD CONSTRAINT "customer_receivable_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN — outside what Prisma can express.
-- docs/ARCHITECTURE.md §5.5–§5.8, §6.2, §10.3, §11.3.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cross-organization integrity ───────────────────────────────────────────
ALTER TABLE "customer"
  ADD CONSTRAINT "ck_customer_name_not_blank" CHECK (length(btrim("full_name")) > 0);

ALTER TABLE "sale"
  ADD CONSTRAINT "fk_sale_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale"
  ADD CONSTRAINT "fk_sale_warehouse_same_org"
  FOREIGN KEY ("organization_id", "warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale"
  ADD CONSTRAINT "fk_sale_customer_same_org"
  FOREIGN KEY ("organization_id", "customer_id")
  REFERENCES "customer" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale_item"
  ADD CONSTRAINT "fk_sale_item_sale_same_org"
  FOREIGN KEY ("organization_id", "sale_id")
  REFERENCES "sale" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "sale_item"
  ADD CONSTRAINT "fk_sale_item_variant_same_org"
  FOREIGN KEY ("organization_id", "product_variant_id")
  REFERENCES "product_variant" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "payment"
  ADD CONSTRAINT "fk_payment_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "payment"
  ADD CONSTRAINT "fk_payment_customer_same_org"
  FOREIGN KEY ("organization_id", "customer_id")
  REFERENCES "customer" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "fk_allocation_payment_same_org"
  FOREIGN KEY ("organization_id", "payment_id")
  REFERENCES "payment" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "fk_allocation_sale_same_org"
  FOREIGN KEY ("organization_id", "sale_id")
  REFERENCES "sale" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "fk_allocation_receivable_same_org"
  FOREIGN KEY ("organization_id", "receivable_id")
  REFERENCES "customer_receivable" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "fk_receivable_customer_same_org"
  FOREIGN KEY ("organization_id", "customer_id")
  REFERENCES "customer" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "fk_receivable_sale_same_org"
  FOREIGN KEY ("organization_id", "sale_id")
  REFERENCES "sale" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "fk_receivable_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

-- ── The sale's arithmetic, checked by the database ─────────────────────────
-- These are the reason a receipt cannot fail to add up. The service computes
-- every figure server-side; these make it impossible for a bug in that
-- computation — or a future code path that skips it — to persist a sale whose
-- own numbers disagree.

ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_total_adds_up" CHECK (
    "total_amount"
      = "subtotal_amount" - "order_discount_amount" + "tax_amount" + "rounding_adjustment"
  );

-- Paid plus credit must equal the total, for a completed sale. A sale that is
-- short by a soʻm is a sale nobody can reconcile.
ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_settled_when_completed" CHECK (
    "status" <> 'COMPLETED' OR "paid_amount" + "credit_amount" = "total_amount"
  );

-- Credit needs somebody to owe it.
ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_credit_needs_customer" CHECK (
    "credit_amount" = 0 OR "customer_id" IS NOT NULL
  );

ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_amounts_non_negative" CHECK (
    "subtotal_amount" >= 0 AND "order_discount_amount" >= 0 AND "tax_amount" >= 0
    AND "total_amount" >= 0 AND "paid_amount" >= 0 AND "credit_amount" >= 0
    AND "refunded_amount" >= 0 AND "cost_amount" >= 0
  );

ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_cancel_has_reason" CHECK (
    "status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)
  );

ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_completed_has_timestamp" CHECK (
    "status" <> 'COMPLETED' OR "completed_at" IS NOT NULL
  );

ALTER TABLE "sale"
  ADD CONSTRAINT "ck_sale_number_not_blank" CHECK (length(btrim("sale_number")) > 0);

-- Offline replay safety: a device resending its queue cannot create a second
-- sale for the same client-generated id, whatever it does with its
-- Idempotency-Key (§26.4).
CREATE UNIQUE INDEX "uq_sale_client_id"
  ON "sale" ("organization_id", "client_id") WHERE "client_id" IS NOT NULL;

-- Receipt lookup by number prefix, for the "find sale 000123" box.
CREATE INDEX "ix_sale_number_pattern"
  ON "sale" ("organization_id", "sale_number" text_pattern_ops);

-- ── Sale lines ─────────────────────────────────────────────────────────────
ALTER TABLE "sale_item"
  ADD CONSTRAINT "ck_sale_item_quantity_positive" CHECK ("quantity" > 0);

-- BR-6, in the database: a line can never be returned more than it was sold.
-- The return service checks this too, but a concurrent pair of returns is
-- exactly the case an application check misses.
ALTER TABLE "sale_item"
  ADD CONSTRAINT "ck_sale_item_returned_within_sold"
  CHECK ("returned_quantity" >= 0 AND "returned_quantity" <= "quantity");

ALTER TABLE "sale_item"
  ADD CONSTRAINT "ck_sale_item_net_adds_up" CHECK (
    "net_amount" = "gross_amount" - "line_discount_amount" - "allocated_order_discount"
  );

-- A discount may take a line to zero, never below it.
ALTER TABLE "sale_item"
  ADD CONSTRAINT "ck_sale_item_amounts_sane" CHECK (
    "net_amount" >= 0 AND "gross_amount" >= 0 AND "unit_price" >= 0 AND "unit_cost" >= 0
    AND "line_discount_amount" >= 0 AND "allocated_order_discount" >= 0
    AND "refunded_amount" >= 0
  );

ALTER TABLE "sale_item"
  ADD CONSTRAINT "ck_sale_item_snapshots_not_blank"
  CHECK (length(btrim("name_snapshot")) > 0 AND length(btrim("sku_snapshot")) > 0);

-- ── Payments ───────────────────────────────────────────────────────────────
-- Always positive; the direction carries the sign. A negative payment would
-- make every SUM in the system quietly wrong.
ALTER TABLE "payment"
  ADD CONSTRAINT "ck_payment_amount_positive" CHECK ("amount" > 0);

CREATE UNIQUE INDEX "uq_payment_idempotency_key"
  ON "payment" ("organization_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;

CREATE UNIQUE INDEX "uq_payment_client_id"
  ON "payment" ("organization_id", "client_id") WHERE "client_id" IS NOT NULL;

-- ── Allocations ────────────────────────────────────────────────────────────
ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "ck_allocation_amount_positive" CHECK ("amount" > 0);

-- Exactly one target. This replaces a polymorphic (target_type, target_id)
-- pair and keeps real foreign keys: three nullable columns is a small price
-- for the database actually verifying that the thing being paid for exists.
ALTER TABLE "payment_allocation"
  ADD CONSTRAINT "ck_allocation_single_target"
  CHECK (num_nonnulls("sale_id", "receivable_id") = 1);

-- Append-only, like the inventory ledger and the audit log: an allocation that
-- can be edited is a payment history that can be rewritten.
CREATE OR REPLACE FUNCTION payment_allocation_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'payment_allocation is append-only (%s attempted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_payment_allocation_immutable
  BEFORE UPDATE OR DELETE ON "payment_allocation"
  FOR EACH ROW EXECUTE FUNCTION payment_allocation_immutable();

-- ── Receivables ────────────────────────────────────────────────────────────
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "ck_receivable_original_positive" CHECK ("original_amount" > 0);

-- BR-8, in the database. Over-payment becomes an error rather than a negative
-- balance that somebody has to notice.
ALTER TABLE "customer_receivable"
  ADD CONSTRAINT "ck_receivable_not_overpaid" CHECK (
    "paid_amount" >= 0 AND "written_off_amount" >= 0
    AND "paid_amount" + "written_off_amount" <= "original_amount"
  );

-- NOTE: the architecture specified `remaining_amount` as a STORED generated
-- column, valued for being unable to drift from its inputs. It is omitted:
-- not storing it at all achieves the same thing more simply, Prisma cannot
-- declare one, and a generated column would be proposed for removal by every
-- future `migrate dev`. Remaining is `original - paid - written_off`,
-- computed wherever it is needed and bounded by the CHECK above.

-- The overdue and due-soon dashboards are one index scan.
CREATE INDEX "ix_receivable_due"
  ON "customer_receivable" ("organization_id", "due_date")
  WHERE "status" IN ('OPEN', 'PARTIALLY_PAID');

-- ── Customers ──────────────────────────────────────────────────────────────
-- Phone identifies a customer at the counter, so it is unique among live rows
-- and scoped to the tenant — two shops may have the same customer.
CREATE UNIQUE INDEX "uq_customer_phone_active"
  ON "customer" ("organization_id", "phone")
  WHERE "phone" IS NOT NULL AND "archived_at" IS NULL;

ALTER TABLE "customer"
  ADD CONSTRAINT "ck_customer_phone_format"
  CHECK ("phone" IS NULL OR "phone" ~ '^\+[0-9]{9,15}$');

ALTER TABLE "customer"
  ADD CONSTRAINT "ck_customer_credit_limit_non_negative"
  CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0);

-- POS customer search: substring on either field.
CREATE INDEX "ix_customer_name_trgm" ON "customer" USING GIN ("full_name" gin_trgm_ops);
CREATE INDEX "ix_customer_phone_trgm" ON "customer" USING GIN ("phone" gin_trgm_ops);

-- ── Idempotency ────────────────────────────────────────────────────────────
ALTER TABLE "idempotency_record"
  ADD CONSTRAINT "ck_idempotency_completed_has_response" CHECK (
    "status" <> 'COMPLETED' OR "response_status" IS NOT NULL
  );
