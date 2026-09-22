-- Promotions and loyalty (Sprint 9). docs/ARCHITECTURE.md §5.8, §17, §18.
--
-- NOTE: 63 DROP statements for earlier migrations' hand-written constraints
-- were generated and stripped by hand, as in every migration since the catalog.

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT_OFF', 'FIXED_OFF');

-- CreateEnum
CREATE TYPE "PromotionScope" AS ENUM ('ITEM', 'ORDER');

-- CreateEnum
CREATE TYPE "PromotionTarget" AS ENUM ('ALL', 'CATEGORY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "LoyaltyTransactionType" AS ENUM ('EARN', 'SPEND', 'ADJUSTMENT', 'EXPIRY');

-- AlterTable
ALTER TABLE "sale" ADD COLUMN     "promotion_id" UUID;

-- AlterTable
ALTER TABLE "sale_item" ADD COLUMN     "promotion_id" UUID;

-- CreateTable
CREATE TABLE "promotion" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "PromotionType" NOT NULL,
    "scope" "PromotionScope" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "min_subtotal" BIGINT,
    "max_discount" BIGINT,
    "applies_to" "PromotionTarget" NOT NULL DEFAULT 'ALL',
    "category_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "product_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "customer_group_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "max_uses" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_account" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "points_balance" BIGINT NOT NULL DEFAULT 0,
    "lifetime_earned" BIGINT NOT NULL DEFAULT 0,
    "lifetime_spent" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "loyalty_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_transaction" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "loyalty_account_id" UUID NOT NULL,
    "type" "LoyaltyTransactionType" NOT NULL,
    "points_delta" BIGINT NOT NULL,
    "balance_after" BIGINT NOT NULL,
    "sale_id" UUID,
    "return_id" UUID,
    "reason" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotion_organization_id_is_active_starts_at_ends_at_idx" ON "promotion"("organization_id", "is_active", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_organization_id_id_key" ON "promotion"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_account_customer_id_key" ON "loyalty_account"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_account_organization_id_id_key" ON "loyalty_account"("organization_id", "id");

-- CreateIndex
CREATE INDEX "loyalty_transaction_loyalty_account_id_created_at_idx" ON "loyalty_transaction"("loyalty_account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "loyalty_transaction_organization_id_sale_id_idx" ON "loyalty_transaction"("organization_id", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_transaction_organization_id_id_key" ON "loyalty_transaction"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "loyalty_account" ADD CONSTRAINT "loyalty_account_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_transaction" ADD CONSTRAINT "loyalty_transaction_loyalty_account_id_fkey" FOREIGN KEY ("loyalty_account_id") REFERENCES "loyalty_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN — docs/ARCHITECTURE.md §5.8, §17, §18.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "loyalty_account"
  ADD CONSTRAINT "fk_loyalty_account_customer_same_org"
  FOREIGN KEY ("organization_id", "customer_id")
  REFERENCES "customer" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "loyalty_transaction"
  ADD CONSTRAINT "fk_loyalty_tx_account_same_org"
  FOREIGN KEY ("organization_id", "loyalty_account_id")
  REFERENCES "loyalty_account" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "sale"
  ADD CONSTRAINT "fk_sale_promotion_same_org"
  FOREIGN KEY ("organization_id", "promotion_id")
  REFERENCES "promotion" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "sale_item"
  ADD CONSTRAINT "fk_sale_item_promotion_same_org"
  FOREIGN KEY ("organization_id", "promotion_id")
  REFERENCES "promotion" ("organization_id", "id") ON DELETE RESTRICT;

-- ── Promotions ─────────────────────────────────────────────────────────────
ALTER TABLE "promotion"
  ADD CONSTRAINT "ck_promotion_name_not_blank" CHECK (length(btrim("name")) > 0);

-- A percentage is bounded; a fixed amount is not, but neither may be negative
-- or zero — a promotion that discounts nothing is a promotion nobody meant.
ALTER TABLE "promotion"
  ADD CONSTRAINT "ck_promotion_value_sane" CHECK (
    ("type" = 'PERCENT_OFF' AND "value" > 0 AND "value" <= 100)
    OR ("type" = 'FIXED_OFF' AND "value" > 0)
  );

ALTER TABLE "promotion"
  ADD CONSTRAINT "ck_promotion_window" CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");

ALTER TABLE "promotion"
  ADD CONSTRAINT "ck_promotion_uses_sane" CHECK (
    "used_count" >= 0 AND ("max_uses" IS NULL OR ("max_uses" > 0 AND "used_count" <= "max_uses"))
  );

-- A targeted promotion must say what it targets. Otherwise "CATEGORY, no
-- categories" silently means "nothing", and the campaign quietly never fires.
ALTER TABLE "promotion"
  ADD CONSTRAINT "ck_promotion_target_populated" CHECK (
    ("applies_to" = 'ALL')
    OR ("applies_to" = 'CATEGORY' AND array_length("category_ids", 1) > 0)
    OR ("applies_to" = 'PRODUCT' AND array_length("product_ids", 1) > 0)
  );

ALTER TABLE "promotion"
  ADD CONSTRAINT "ck_promotion_limits_non_negative" CHECK (
    ("min_subtotal" IS NULL OR "min_subtotal" >= 0)
    AND ("max_discount" IS NULL OR "max_discount" > 0)
  );

CREATE UNIQUE INDEX "uq_promotion_name_active"
  ON "promotion" ("organization_id", lower("name")) WHERE "is_active";

-- ── Loyalty ────────────────────────────────────────────────────────────────
-- The balance is a cache, but it may never go negative: points that were never
-- earned cannot be spent.
ALTER TABLE "loyalty_account"
  ADD CONSTRAINT "ck_loyalty_balance_non_negative" CHECK ("points_balance" >= 0);

ALTER TABLE "loyalty_account"
  ADD CONSTRAINT "ck_loyalty_lifetime_non_negative"
  CHECK ("lifetime_earned" >= 0 AND "lifetime_spent" >= 0);

-- A movement that moves nothing is a row nobody meant to write.
ALTER TABLE "loyalty_transaction"
  ADD CONSTRAINT "ck_loyalty_tx_delta_nonzero" CHECK ("points_delta" <> 0);

-- The sign must match the type, exactly as it must in the inventory ledger.
-- ADJUSTMENT is the only bidirectional one, and it must say why.
ALTER TABLE "loyalty_transaction"
  ADD CONSTRAINT "ck_loyalty_tx_sign" CHECK (
    ("type" = 'EARN' AND "points_delta" > 0)
    OR ("type" IN ('SPEND', 'EXPIRY') AND "points_delta" < 0)
    OR ("type" = 'ADJUSTMENT')
  );

ALTER TABLE "loyalty_transaction"
  ADD CONSTRAINT "ck_loyalty_tx_adjustment_has_reason"
  CHECK ("type" <> 'ADJUSTMENT' OR "reason" IS NOT NULL);

ALTER TABLE "loyalty_transaction"
  ADD CONSTRAINT "ck_loyalty_tx_balance_non_negative" CHECK ("balance_after" >= 0);

-- Append-only. A points balance that can be edited is a currency anybody can
-- print.
CREATE OR REPLACE FUNCTION loyalty_transaction_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'loyalty_transaction is append-only (%s attempted)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_loyalty_transaction_immutable
  BEFORE UPDATE OR DELETE ON "loyalty_transaction"
  FOR EACH ROW EXECUTE FUNCTION loyalty_transaction_immutable();
