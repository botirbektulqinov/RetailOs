-- Catalog: Category, Product, ProductVariant (Sprint 3)
--
-- NOTE: `prisma migrate dev` generated this file with DROP statements for the
-- hand-written constraints of 20260917092323_identity_tenancy_rbac (four
-- composite same-org foreign keys, two trigram indexes). Prisma does not know
-- about them, reads them as drift, and proposes removing them every time.
-- They were stripped by hand. Do the same for every future migration — see
-- docs/ARCHITECTURE.md §6.2 and the README migration rules.

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "Unit" AS ENUM ('PIECE', 'KG', 'LITRE', 'METRE', 'PACK');







-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "path" TEXT NOT NULL DEFAULT '',
    "depth" SMALLINT NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "category_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "brand" TEXT,
    "image_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "has_variants" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "name" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "unit" "Unit" NOT NULL DEFAULT 'PIECE',
    "purchase_price" BIGINT NOT NULL DEFAULT 0,
    "selling_price" BIGINT NOT NULL,
    "min_stock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_variant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "category_organization_id_parent_id_idx" ON "category"("organization_id", "parent_id");

-- CreateIndex
CREATE INDEX "category_organization_id_status_idx" ON "category"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "category_organization_id_id_key" ON "category"("organization_id", "id");

-- CreateIndex
CREATE INDEX "product_organization_id_category_id_idx" ON "product"("organization_id", "category_id");

-- CreateIndex
CREATE INDEX "product_organization_id_status_archived_at_idx" ON "product"("organization_id", "status", "archived_at");

-- CreateIndex
CREATE INDEX "product_organization_id_created_at_idx" ON "product"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "product_organization_id_id_key" ON "product"("organization_id", "id");

-- CreateIndex
CREATE INDEX "product_variant_organization_id_barcode_idx" ON "product_variant"("organization_id", "barcode");

-- CreateIndex
CREATE INDEX "product_variant_organization_id_sku_idx" ON "product_variant"("organization_id", "sku");

-- CreateIndex
CREATE INDEX "product_variant_product_id_idx" ON "product_variant"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_organization_id_id_key" ON "product_variant"("organization_id", "id");

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written catalog constraints
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cross-tenant integrity ─────────────────────────────────────────────────
-- A product's category, and a variant's product, must belong to the SAME
-- organization. Composite foreign keys make "assign organization B's category
-- to organization A's product" impossible in the database, not merely
-- rejected by a service method someone could bypass.
ALTER TABLE "product"
  ADD CONSTRAINT "fk_product_category_same_org"
  FOREIGN KEY ("organization_id", "category_id")
  REFERENCES "category" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "product_variant"
  ADD CONSTRAINT "fk_variant_product_same_org"
  FOREIGN KEY ("organization_id", "product_id")
  REFERENCES "product" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "category"
  ADD CONSTRAINT "fk_category_parent_same_org"
  FOREIGN KEY ("organization_id", "parent_id")
  REFERENCES "category" ("organization_id", "id") ON DELETE RESTRICT;

-- ── Uniqueness among live rows ─────────────────────────────────────────────
-- Tenant-scoped, not global: two shops may legitimately both use "CH-021".
-- Partial, so archiving a product frees its SKU for reuse.
CREATE UNIQUE INDEX "uq_variant_sku_active"
  ON "product_variant" ("organization_id", "sku") WHERE "archived_at" IS NULL;

CREATE UNIQUE INDEX "uq_variant_barcode_active"
  ON "product_variant" ("organization_id", "barcode")
  WHERE "barcode" IS NOT NULL AND "archived_at" IS NULL;

-- Exactly one default variant per product.
CREATE UNIQUE INDEX "uq_default_variant_per_product"
  ON "product_variant" ("product_id") WHERE "is_default";

-- Sibling categories cannot share a name. COALESCE because a NULL parent (a
-- root category) would otherwise make every root name unique-by-accident.
CREATE UNIQUE INDEX "uq_category_name_per_parent"
  ON "category" ("organization_id", COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"))
  WHERE "archived_at" IS NULL;

-- ── Value constraints ──────────────────────────────────────────────────────
-- Prices are never negative. There is deliberately NO rule that selling price
-- must exceed purchase price: clearing stock below cost is ordinary retail,
-- and a backend that forbids it would be wrong about the business.
ALTER TABLE "product_variant"
  ADD CONSTRAINT "ck_variant_prices_non_negative"
  CHECK ("purchase_price" >= 0 AND "selling_price" >= 0);

ALTER TABLE "product_variant"
  ADD CONSTRAINT "ck_variant_min_stock_non_negative" CHECK ("min_stock" >= 0);

ALTER TABLE "product_variant"
  ADD CONSTRAINT "ck_variant_sku_not_blank" CHECK (length(btrim("sku")) > 0);

-- Digits only. A scanner emits digits; anything else is a typed mistake that
-- would never match a scan.
ALTER TABLE "product_variant"
  ADD CONSTRAINT "ck_variant_barcode_digits"
  CHECK ("barcode" IS NULL OR "barcode" ~ '^[0-9]{6,20}$');

ALTER TABLE "product"
  ADD CONSTRAINT "ck_product_name_not_blank" CHECK (length(btrim("name")) > 0);

ALTER TABLE "category"
  ADD CONSTRAINT "ck_category_name_not_blank" CHECK (length(btrim("name")) > 0);

-- A category may not be its own parent. Deeper cycles are prevented in the
-- service by walking the ancestor chain; a recursive trigger is not worth it
-- at eighteen categories.
ALTER TABLE "category"
  ADD CONSTRAINT "ck_category_not_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

ALTER TABLE "category"
  ADD CONSTRAINT "ck_category_depth" CHECK ("depth" BETWEEN 1 AND 3);

-- ── Search ─────────────────────────────────────────────────────────────────
-- The product list searches by name; POS searches by barcode then SKU prefix
-- then name. Trigram indexes serve substring matching, which is what a user
-- typing "choy" into a search box actually means.
CREATE INDEX "ix_product_name_trgm" ON "product" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "ix_product_brand_trgm" ON "product" USING GIN ("brand" gin_trgm_ops);
CREATE INDEX "ix_variant_sku_trgm" ON "product_variant" USING GIN ("sku" gin_trgm_ops);
