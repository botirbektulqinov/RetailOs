-- Procurement: suppliers, purchases, receiving and supplier payments (Sprint 7).
-- docs/ARCHITECTURE.md §5.9, §15, §16.
--
-- NOTE: 43 DROP statements for earlier migrations' hand-written constraints
-- were generated and stripped by hand, as in every migration since the catalog.

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "supplier" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "phone" TEXT,
    "email" CITEXT,
    "address" TEXT,
    "notes" TEXT,
    "payment_term_days" SMALLINT NOT NULL DEFAULT 0,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_number" TEXT NOT NULL,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "supplier_invoice_number" TEXT,
    "ordered_at" TIMESTAMPTZ(6),
    "expected_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "subtotal_amount" BIGINT NOT NULL DEFAULT 0,
    "discount_amount" BIGINT NOT NULL DEFAULT 0,
    "shipping_amount" BIGINT NOT NULL DEFAULT 0,
    "total_amount" BIGINT NOT NULL DEFAULT 0,
    "paid_amount" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "cancel_reason" TEXT,
    "created_by" UUID NOT NULL,
    "received_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_item" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "ordered_quantity" DECIMAL(14,3) NOT NULL,
    "received_quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "unit_cost" BIGINT NOT NULL,
    "line_amount" BIGINT NOT NULL,

    CONSTRAINT "purchase_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_id" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "paid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supplier_organization_id_name_idx" ON "supplier"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_organization_id_id_key" ON "supplier"("organization_id", "id");

-- CreateIndex
CREATE INDEX "purchase_organization_id_supplier_id_status_idx" ON "purchase"("organization_id", "supplier_id", "status");

-- CreateIndex
CREATE INDEX "purchase_organization_id_status_created_at_idx" ON "purchase"("organization_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_organization_id_id_key" ON "purchase"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_organization_id_purchase_number_key" ON "purchase"("organization_id", "purchase_number");

-- CreateIndex
CREATE INDEX "purchase_item_organization_id_product_variant_id_idx" ON "purchase_item"("organization_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_item_organization_id_id_key" ON "purchase_item"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_item_purchase_id_product_variant_id_key" ON "purchase_item"("purchase_id", "product_variant_id");

-- CreateIndex
CREATE INDEX "supplier_payment_organization_id_supplier_id_paid_at_idx" ON "supplier_payment"("organization_id", "supplier_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "supplier_payment_purchase_id_idx" ON "supplier_payment"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_organization_id_id_key" ON "supplier_payment"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_item" ADD CONSTRAINT "purchase_item_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_item" ADD CONSTRAINT "purchase_item_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN — docs/ARCHITECTURE.md §5.9, §15, §16.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "purchase"
  ADD CONSTRAINT "fk_purchase_supplier_same_org"
  FOREIGN KEY ("organization_id", "supplier_id")
  REFERENCES "supplier" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "purchase"
  ADD CONSTRAINT "fk_purchase_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "purchase"
  ADD CONSTRAINT "fk_purchase_warehouse_same_org"
  FOREIGN KEY ("organization_id", "warehouse_id")
  REFERENCES "warehouse" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "purchase_item"
  ADD CONSTRAINT "fk_purchase_item_purchase_same_org"
  FOREIGN KEY ("organization_id", "purchase_id")
  REFERENCES "purchase" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "purchase_item"
  ADD CONSTRAINT "fk_purchase_item_variant_same_org"
  FOREIGN KEY ("organization_id", "product_variant_id")
  REFERENCES "product_variant" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "supplier_payment"
  ADD CONSTRAINT "fk_supplier_payment_supplier_same_org"
  FOREIGN KEY ("organization_id", "supplier_id")
  REFERENCES "supplier" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "supplier_payment"
  ADD CONSTRAINT "fk_supplier_payment_purchase_same_org"
  FOREIGN KEY ("organization_id", "purchase_id")
  REFERENCES "purchase" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "supplier_payment"
  ADD CONSTRAINT "fk_supplier_payment_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

-- ── Suppliers ──────────────────────────────────────────────────────────────
ALTER TABLE "supplier"
  ADD CONSTRAINT "ck_supplier_name_not_blank" CHECK (length(btrim("name")) > 0);

ALTER TABLE "supplier"
  ADD CONSTRAINT "ck_supplier_payment_term_sane"
  CHECK ("payment_term_days" >= 0 AND "payment_term_days" <= 365);

CREATE UNIQUE INDEX "uq_supplier_name_active"
  ON "supplier" ("organization_id", lower("name")) WHERE "archived_at" IS NULL;

CREATE INDEX "ix_supplier_name_trgm" ON "supplier" USING GIN ("name" gin_trgm_ops);

-- ── Purchases ──────────────────────────────────────────────────────────────
ALTER TABLE "purchase"
  ADD CONSTRAINT "ck_purchase_total_adds_up" CHECK (
    "total_amount" = "subtotal_amount" - "discount_amount" + "shipping_amount"
  );

ALTER TABLE "purchase"
  ADD CONSTRAINT "ck_purchase_amounts_non_negative" CHECK (
    "subtotal_amount" >= 0 AND "discount_amount" >= 0 AND "shipping_amount" >= 0
    AND "total_amount" >= 0 AND "paid_amount" >= 0
  );

-- Payment state is separate from receipt state, but neither may exceed itself.
-- Over-payment becomes an error rather than a negative payable.
ALTER TABLE "purchase"
  ADD CONSTRAINT "ck_purchase_not_overpaid" CHECK ("paid_amount" <= "total_amount");

ALTER TABLE "purchase"
  ADD CONSTRAINT "ck_purchase_number_not_blank"
  CHECK (length(btrim("purchase_number")) > 0);

ALTER TABLE "purchase"
  ADD CONSTRAINT "ck_purchase_cancel_has_reason" CHECK (
    "status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)
  );

-- The payables report is one index scan. Partial, because in a healthy
-- business most purchases are settled.
CREATE INDEX "ix_purchase_payable"
  ON "purchase" ("organization_id", "supplier_id")
  WHERE "status" IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED')
    AND "paid_amount" < "total_amount";

-- NOTE: the architecture specified `remaining_amount` as a STORED generated
-- column. Omitted for the same reason as customer_receivable's: not storing it
-- is a stronger guarantee than generating it, Prisma cannot declare one, and
-- it would be proposed for removal by every future `migrate dev`. Remaining is
-- `total_amount - paid_amount`, bounded by ck_purchase_not_overpaid.

-- ── Purchase lines ─────────────────────────────────────────────────────────
ALTER TABLE "purchase_item"
  ADD CONSTRAINT "ck_purchase_item_ordered_positive" CHECK ("ordered_quantity" > 0);

-- BR-16, in the database. Over-receipt is rejected rather than silently
-- accepted: a delivery larger than the order is a real event, but it is a
-- purchase amendment, and treating it as an automatic quantity bump is how
-- phantom stock appears.
ALTER TABLE "purchase_item"
  ADD CONSTRAINT "ck_purchase_item_received_within_ordered"
  CHECK ("received_quantity" >= 0 AND "received_quantity" <= "ordered_quantity");

ALTER TABLE "purchase_item"
  ADD CONSTRAINT "ck_purchase_item_costs_non_negative"
  CHECK ("unit_cost" >= 0 AND "line_amount" >= 0);

-- ── Supplier payments ──────────────────────────────────────────────────────
ALTER TABLE "supplier_payment"
  ADD CONSTRAINT "ck_supplier_payment_amount_positive" CHECK ("amount" > 0);

CREATE UNIQUE INDEX "uq_supplier_payment_idempotency"
  ON "supplier_payment" ("organization_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Money that has left the business is not editable. A payment recorded wrongly
-- is corrected by another payment, exactly as in the customer ledger.
CREATE OR REPLACE FUNCTION supplier_payment_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'supplier_payment is append-only (%s attempted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_supplier_payment_immutable
  BEFORE UPDATE OR DELETE ON "supplier_payment"
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_immutable();
