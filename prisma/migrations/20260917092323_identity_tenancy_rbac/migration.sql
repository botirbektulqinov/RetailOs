-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "currency_code" CHAR(3) NOT NULL DEFAULT 'UZS',
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "max_users" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_settings" (
    "organization_id" UUID NOT NULL,
    "currency_exponent" SMALLINT NOT NULL DEFAULT 0,
    "cash_rounding_unit" BIGINT NOT NULL DEFAULT 0,
    "allow_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "default_debt_term_days" SMALLINT NOT NULL DEFAULT 30,
    "loyalty_earn_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "loyalty_point_value" BIGINT NOT NULL DEFAULT 1,
    "return_window_days" SMALLINT NOT NULL DEFAULT 14,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "locale" TEXT NOT NULL DEFAULT 'uz-UZ',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "store" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "legal_name" TEXT,
    "tax_id" TEXT,
    "working_hours" TEXT,
    "timezone" TEXT,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "allow_negative_stock" BOOLEAN,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "email" CITEXT,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_membership" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "permission_version" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by_id" UUID,
    "device_name" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "organization_id" UUID NOT NULL,
    "store_id" UUID,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "store_organization_id_status_idx" ON "store"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "store_organization_id_id_key" ON "store"("organization_id", "id");

-- CreateIndex
CREATE INDEX "warehouse_organization_id_store_id_idx" ON "warehouse"("organization_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_organization_id_id_key" ON "warehouse"("organization_id", "id");

-- CreateIndex
CREATE INDEX "app_user_organization_id_status_idx" ON "app_user"("organization_id", "status");

-- CreateIndex
CREATE INDEX "app_user_organization_id_full_name_idx" ON "app_user"("organization_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_organization_id_id_key" ON "app_user"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_phone_key" ON "app_user"("phone");

-- CreateIndex
CREATE INDEX "store_membership_organization_id_store_id_status_idx" ON "store_membership"("organization_id", "store_id", "status");

-- CreateIndex
CREATE INDEX "store_membership_role_id_idx" ON "store_membership"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_membership_user_id_store_id_key" ON "store_membership"("user_id", "store_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_membership_organization_id_id_key" ON "store_membership"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "role_organization_id_code_key" ON "role"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "role_organization_id_id_key" ON "role"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_revoked_at_idx" ON "refresh_token"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "refresh_token"("expires_at");

-- CreateIndex
CREATE INDEX "audit_log_organization_id_created_at_idx" ON "audit_log"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_organization_id_entity_type_entity_id_created_at_idx" ON "audit_log"("organization_id", "entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_organization_id_actor_user_id_created_at_idx" ON "audit_log"("organization_id", "actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_organization_id_action_created_at_idx" ON "audit_log"("organization_id", "action", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "store_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_membership" ADD CONSTRAINT "store_membership_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_membership" ADD CONSTRAINT "store_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_membership" ADD CONSTRAINT "store_membership_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_membership" ADD CONSTRAINT "store_membership_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written constraints (docs/ARCHITECTURE.md §6.2)
--
-- Everything below is invariant enforcement Prisma cannot express. Several of
-- these ARE the security model, so they belong in the database rather than in
-- a service method someone can forget to call.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cross-tenant integrity ─────────────────────────────────────────────────
-- A membership must join a user, a store and a role that all belong to the
-- SAME organization. Composite foreign keys make a cross-organization
-- membership impossible at the database level — an application check can be
-- bypassed by any future code path that forgets it, this cannot.
ALTER TABLE "store_membership"
  ADD CONSTRAINT "fk_membership_user_same_org"
  FOREIGN KEY ("organization_id", "user_id")
  REFERENCES "app_user" ("organization_id", "id") ON DELETE CASCADE;

ALTER TABLE "store_membership"
  ADD CONSTRAINT "fk_membership_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

ALTER TABLE "store_membership"
  ADD CONSTRAINT "fk_membership_role_same_org"
  FOREIGN KEY ("organization_id", "role_id")
  REFERENCES "role" ("organization_id", "id") ON DELETE RESTRICT;

-- A warehouse must sit in a store of its own organization.
ALTER TABLE "warehouse"
  ADD CONSTRAINT "fk_warehouse_store_same_org"
  FOREIGN KEY ("organization_id", "store_id")
  REFERENCES "store" ("organization_id", "id") ON DELETE RESTRICT;

-- ── Uniqueness that only applies to live rows ──────────────────────────────
CREATE UNIQUE INDEX "uq_store_code_active"
  ON "store" ("organization_id", "code") WHERE "archived_at" IS NULL;

CREATE UNIQUE INDEX "uq_warehouse_code_active"
  ON "warehouse" ("organization_id", "code") WHERE "archived_at" IS NULL;

-- At most one default warehouse per store.
CREATE UNIQUE INDEX "uq_default_warehouse_per_store"
  ON "warehouse" ("store_id") WHERE "is_default" AND "archived_at" IS NULL;

-- At most one primary store per user.
CREATE UNIQUE INDEX "uq_primary_membership_per_user"
  ON "store_membership" ("user_id") WHERE "is_primary";

-- Email is optional, so uniqueness must skip NULLs.
CREATE UNIQUE INDEX "uq_user_email"
  ON "app_user" ("email") WHERE "email" IS NOT NULL;

-- ── Value constraints ──────────────────────────────────────────────────────
ALTER TABLE "organization"
  ADD CONSTRAINT "ck_organization_max_users" CHECK ("max_users" > 0);

-- Phones are stored E.164-normalised so login lookup is an exact match; a
-- formatted or spaced value would silently fail to find the account.
ALTER TABLE "app_user"
  ADD CONSTRAINT "ck_user_phone_e164" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');

ALTER TABLE "app_user"
  ADD CONSTRAINT "ck_user_full_name_not_blank" CHECK (length(btrim("full_name")) > 0);

ALTER TABLE "store"
  ADD CONSTRAINT "ck_store_code_not_blank" CHECK (length(btrim("code")) > 0);

ALTER TABLE "role"
  ADD CONSTRAINT "ck_role_code_not_blank" CHECK (length(btrim("code")) > 0);

-- A refresh token that never expires is a permanent credential.
ALTER TABLE "refresh_token"
  ADD CONSTRAINT "ck_refresh_expiry_after_issue" CHECK ("expires_at" > "created_at");

-- ── Search support ─────────────────────────────────────────────────────────
-- The employees screen searches "Ism yoki telefon bo'yicha" (name or phone).
CREATE INDEX "ix_user_full_name_trgm"
  ON "app_user" USING GIN ("full_name" gin_trgm_ops);
CREATE INDEX "ix_user_phone_trgm"
  ON "app_user" USING GIN ("phone" gin_trgm_ops);

-- ── Append-only enforcement ────────────────────────────────────────────────
-- A careless ORM call must fail loudly rather than quietly rewriting history.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
