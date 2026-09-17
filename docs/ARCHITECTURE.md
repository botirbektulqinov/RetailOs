# RetailOS — Technical Architecture & Backend Specification

**Status:** pre-implementation specification
**Version:** 1.0 (2026-09-17)
**Scope:** Backend (NestJS + PostgreSQL + Prisma), MVP → multi-tenant SaaS
**Audience:** the engineers who will build and review this backend

---

## 0. Note on the design source of truth

The brief names the Penpot project as the UX source of truth. No Penpot export
is present in this workspace (`RetailOS_figma/`, `RetailOS_frontend/`,
`RetailOS_mobile/` are all empty). The only reachable design artifact is a
pen.dev document containing a **mobile design system stub**: primary/secondary/
disabled button, default input, success and error feedback, search field, a
filter chip, one product row ("Artel choynak 1.7L"), a save-product button and a
primary navigation bar.

That artifact confirms visual language and a handful of component contracts. It
does **not** contain the 30+ screens listed in the brief. This specification is
therefore built from the module list in the brief, treating it as the
authoritative feature inventory, and it flags every place where a screen would
change a backend decision (see §35).

**Action required:** export the Penpot screens (or share the project link) before
implementation starts, so the DTO field lists in §22 can be reconciled against
the actual forms. The domain model below is not expected to change; field-level
details will.

---

## 1. Executive architecture summary

### 1.1 Shape

RetailOS is a **modular monolith**: one NestJS application, one PostgreSQL
database, deployed as one container. Modules have explicit boundaries (own
service layer, own DTOs, no cross-module repository access) so that a module can
later be lifted out, but nothing in the MVP is split across a network hop.

There are no microservices, no Kafka, no ClickHouse, no Kubernetes. There is
also **no Redis and no BullMQ in the MVP** — see §1.4 for why and for the exact
trigger that reverses that decision.

### 1.2 The five decisions that shape everything else

1. **Money is `BIGINT` minor units.** One currency per organization, exponent
   read from org config (UZS → exponent 0, so 1 unit = 1 soʻm). No floats, no
   `Decimal` type, no per-row currency column. Rounding happens once, at a
   defined point, half-up, and every rounded result is persisted. (§8)

2. **Inventory is an append-only ledger with a denormalized level.**
   `inventory_movement` is the truth; `inventory_level` is the fast read,
   mutated only by conditional atomic `UPDATE`s in the same transaction. The two
   are reconcilable by a report. Overselling is prevented by the `WHERE quantity
   >= ?` clause, not by application-level checks. (§9, §25)

3. **Debt is a receivable document plus a shared payment/allocation ledger.**
   `Payment` + `PaymentAllocation` serve POS checkout, debt collection and
   refunds with one mechanism. There is no `customer.debt` column that anything
   trusts. (§12)

4. **Every product has at least one variant row, from day one.** Simple products
   get an auto-created default variant. Inventory, sale lines, purchase lines and
   transfers all point at `product_variant_id`. This costs ~20 lines now and
   avoids repointing eight foreign keys later. (§10)

5. **Tenant isolation is enforced in three layers**: the org is never read from
   the request body, a request-scoped tenant context is derived from the verified
   JWT, and a Prisma client extension injects `organizationId` into every query
   against a tenant-scoped model. PostgreSQL RLS is the phase-2 hardening. (§5)

### 1.3 What the MVP deliberately does not build

| Deferred | Why | Add when |
|---|---|---|
| Tax / VAT (QQS) engine | Brief says "if introduced"; Uzbek fiscalization rules must be confirmed first | Fiscal requirement confirmed (§35) |
| FIFO cost layers | Moving weighted average gives correct-enough COGS at small-store volume | Multi-warehouse landed-cost reporting is requested |
| Offline sync engine | Online-first; only the *hooks* are built now | A store actually loses connectivity in production |
| Cursor pagination everywhere | Offset with `limit ≤ 100` is fine below ~100k rows per list | A list crosses ~100k rows (ledgers already use keyset) |
| Redis / BullMQ | Single instance; an outbox table + cron covers async delivery | A second app instance, or delayed/scheduled jobs at volume |
| `Permission` table | Permission strings ship with code, not user-edited | Never, realistically — roles stay user-editable |
| Multi-barcode per variant | One barcode column covers the observed design | A second barcode standard is needed |
| Store credit as a tender | Refund-to-cash / refund-to-card covers MVP returns | Exchanges with refund-due become common |

### 1.4 Why no Redis in the MVP

Redis would be justified by any of: a second app instance, distributed rate
limiting, a shared cache, or genuine background job scheduling. The MVP has one
instance. The only real async work is outbound notification delivery (Telegram,
low-stock alerts), which is served by a `notification` table with
`status`/`attempts`/`next_attempt_at` columns and a `@nestjs/schedule` poller —
about 60 lines, no new infrastructure, and durable across restarts because it
lives in Postgres.

Rate limiting uses the in-memory `@nestjs/throttler` store. Permission
resolution uses an in-process LRU keyed by `role_id:version`.

**Trigger to adopt Redis + BullMQ:** the first horizontal scale-out, or the
first scheduled job that needs delayed execution at a rate the cron poller can't
absorb. Both the notification poller and the throttler are one-file swaps at
that point; the outbox table stays and becomes the job source.

### 1.5 Deployment topology (MVP)

```
                 ┌──────────────────────────────┐
  clients ──────▶│  nginx / Caddy (TLS, gzip)   │
 (web, mobile)   └───────────────┬──────────────┘
                                 │
                 ┌───────────────▼──────────────┐
                 │   RetailOS API (NestJS)      │
                 │   modular monolith, 1 image  │
                 │   + in-process cron poller   │
                 └───────────────┬──────────────┘
                                 │
                 ┌───────────────▼──────────────┐
                 │   PostgreSQL 16              │
                 │   + nightly pg_dump → object │
                 │     storage                  │
                 └──────────────────────────────┘
```

---

## 2. Domain model

### 2.1 Bounded contexts

RetailOS splits into eight contexts. Module boundaries in §30 follow these.

| Context | Owns | Aggregate roots |
|---|---|---|
| **Identity & Tenancy** | who you are, what you may do, where | Organization, User, Role, Store, Warehouse |
| **Catalog** | what is sold | Category, Product (→ ProductVariant) |
| **Inventory** | how much exists, and where | InventoryMovement (ledger), InventoryCount, StockTransfer |
| **Selling** | money in, goods out | Sale (→ SaleItem), Return (→ ReturnItem), Exchange |
| **Tender** | how money actually moved | Payment (→ PaymentAllocation), CashRegisterShift |
| **Receivables** | what customers owe | CustomerReceivable |
| **Procurement** | goods in, money out | Purchase (→ PurchaseItem), Supplier, SupplierPayment |
| **Engagement & Platform** | customers, loyalty, promos, audit, alerts | Customer, LoyaltyAccount, Promotion, AuditLog, Notification |

### 2.2 Entity decisions — what becomes a table, and why

**Tables (core, MVP):**

| Entity | Root? | Justification |
|---|---|---|
| `Organization` | aggregate | Tenant boundary. Every tenant-owned row carries `organization_id`. |
| `Store` | yes | Selling location. Sales, shifts, cash registers, employees scope here. |
| `Warehouse` | yes | Stock location. Inventory is *always* warehouse-scoped, never store-scoped. One is auto-created per store in MVP; the transfers module requires the concept to exist from day one. |
| `User` | yes | Auth principal, org-scoped. |
| `StoreMembership` | part of User | Join of (user, store, role). A user may work in several stores with different roles. Without it, RBAC cannot express "manager at store A, cashier at store B", and adding it later rewrites the auth guard. |
| `Role` | yes | Named permission bundle, org-owned, user-editable. Holds `permissions TEXT[]`. |
| `Category` | yes | Product taxonomy. Self-referencing `parent_id`, max depth 2 enforced in service. |
| `Product` | aggregate | Shared identity: name, category, description, images, default supplier, status. |
| `ProductVariant` | part of Product | Sellable unit. SKU, barcode, prices, unit. **Always exists** (see §10.2). |
| `InventoryLevel` | projection | Denormalized `(variant, warehouse) -> quantity, avg_cost`. Read path plus concurrency guard. |
| `InventoryMovement` | event | Append-only ledger. The only source of truth for stock. |
| `InventoryCount` / `InventoryCountItem` | yes / part | Stocktake document with a draft→finalized lifecycle. |
| `StockTransfer` / `StockTransferItem` | yes / part | Warehouse-to-warehouse document, with in-transit state. |
| `Supplier` | yes | Vendor master; payable balance derived. |
| `Purchase` / `PurchaseItem` | yes / part | Goods-in document with partial receiving. |
| `SupplierPayment` | yes | Money out. Deliberately **not** the same table as `Payment` (see §15.4). |
| `Customer` | yes | Buyer master. `CustomerGroup` FK drives default discount. |
| `CustomerGroup` | yes | Segment with a default discount percent. |
| `Sale` / `SaleItem` | yes / part | The central selling document. |
| `Payment` / `PaymentAllocation` | yes / part | Every movement of customer money, any direction, any method. |
| `CustomerReceivable` | yes | One debt document, usually per credit sale. |
| `Return` / `ReturnItem` | yes / part | Goods back, money back. |
| `Exchange` | yes (thin) | Links one Return to one replacement Sale plus the settlement. |
| `Promotion` | yes | The *rule*. Applied discounts are columns on sale lines, not rows. |
| `LoyaltyAccount` | yes | 1:1 with Customer; caches balance. |
| `LoyaltyTransaction` | event | Append-only points ledger. |
| `CashRegister` | yes | The till. |
| `CashRegisterShift` | yes | Open→close session. Owns expected-vs-actual reconciliation. |
| `CashMovement` | part of Shift | Manual cash in/out (drop, payout, expense) inside a shift. |
| `AuditLog` | event | Append-only. |
| `Notification` | yes | In-app feed row **and** outbound delivery record. |
| `OrganizationSettings` | part of Org | 1:1 with Organization; typed columns, not key/value. |
| `RefreshToken` | part of User | Session and rotation record. |
| `IdempotencyRecord` | infra | Replay protection. |
| `DocumentCounter` | infra | Per-store, per-document-type sequence. |

**Entities from the brief that are deliberately NOT tables:**

| Not a table | Instead | Why |
|---|---|---|
| `DebtPayment` | `Payment` with an allocation to a `CustomerReceivable` | A debt payment *is* money received at a till, by a method, inside a shift, with an idempotency key. Duplicating that as a second table duplicates the cash-drawer logic, the refund logic and the shift reconciliation. The API still exposes `POST /debts/{id}/payments` — the concept survives, the table does not. |
| `Permission` | `Role.permissions TEXT[]` plus a constant list in code | Permission strings ship with code. A permission no guard references is meaningless; a guard referencing a missing permission should be a compile error. A table adds two joins per request and zero capability. |
| `Discount` (as an applied instance) | columns on `sale_item` / `sale` plus nullable `promotion_id` | The applied discount is a property of the line, not an object with its own lifecycle. |
| `Receipt` | rendered on demand from `Sale` plus a `receipt_number` column | Nothing is stored that the Sale does not already hold. |
| `CustomerTag` | `CustomerGroup` in MVP | Group covers segmentation and discounting. Free-form tags are a phase-2 many-to-many. |
| `CustomerNote` | `customer.notes TEXT` in MVP | Threaded, attributed notes matter for collections at scale; a text field covers the small store. Promote when debt collection gets its own workflow. |
| `PaymentMethod` | `payment.method` enum plus `payment.provider_meta JSONB` | See §11.2 — an enum plus metadata is extensible without a lookup table's joins. |

### 2.3 Lifecycles and statuses

```
Sale.status            DRAFT ──▶ COMPLETED ──▶ (terminal)
                          └────▶ CANCELLED  (void; only while the shift is OPEN)
Sale.return_status     NONE ──▶ PARTIAL ──▶ FULL         (derived, denormalized)

Purchase.status        DRAFT ─▶ ORDERED ─▶ PARTIALLY_RECEIVED ─▶ RECEIVED
                          └───────┴──────────┴──▶ CANCELLED (only if nothing received)

StockTransfer.status   DRAFT ─▶ SENT ─▶ RECEIVED
                          └──────┴────▶ CANCELLED (only while nothing is received)

InventoryCount.status  DRAFT ─▶ COUNTING ─▶ FINALIZED (terminal)
                          └──────┴────────▶ CANCELLED

CashRegisterShift      OPEN ─▶ CLOSED (terminal)

CustomerReceivable     OPEN ─▶ PARTIALLY_PAID ─▶ PAID (terminal)
                          └──────┴────▶ WRITTEN_OFF (terminal, permissioned)
                       "overdue" is DERIVED from due_date, never stored as a status

Payment.status         COMPLETED | VOIDED
Return.status          COMPLETED  (returns are atomic in MVP — no draft state)
Exchange.status        COMPLETED
```

**Rule:** transactional documents are never hard-deleted; they reach a terminal
status. Master data (`Product`, `Customer`, `Category`, `Supplier`, `User`) is
archived via `archived_at` / `deactivated_at`, never deleted, because
transactional rows reference it forever.

### 2.4 Core business rules — the invariants

These are the statements the tests in §31 must defend. Each is enforced in the
database where possible, and inside a transaction otherwise.

| # | Invariant | Enforced by |
|---|---|---|
| BR-1 | A completed sale's `total` equals `subtotal − order_discount + rounding_adjustment` | service, plus integration test |
| BR-2 | Sum of a sale's payment allocations plus the credited receivable equals the sale `total`, exactly | checkout transaction |
| BR-3 | Stock never goes below zero unless the warehouse explicitly allows it | `UPDATE … WHERE quantity >= ?` plus `CHECK` |
| BR-4 | Every stock change produces exactly one `inventory_movement` row | single code path (`InventoryService.apply`) |
| BR-5 | `SUM(inventory_movement.quantity_delta)` per (variant, warehouse) equals `inventory_level.quantity` | reconciliation report plus test |
| BR-6 | `sale_item.returned_quantity <= sale_item.quantity`, always | conditional `UPDATE` plus `CHECK` |
| BR-7 | Total refunded against a sale never exceeds the sale's `total` | return transaction |
| BR-8 | `receivable.paid_amount <= receivable.original_amount` | conditional `UPDATE` plus `CHECK` |
| BR-9 | `receivable.remaining_amount` is a generated column and is never written | PG `GENERATED ALWAYS` |
| BR-10 | Loyalty balance equals `SUM(loyalty_transaction.points_delta)` | ledger plus reconciliation |
| BR-11 | A shift's `expected_cash` is fully derived; `difference` is computed and stored at close | shift-close transaction |
| BR-12 | Allocated line discounts sum exactly to the order discount — no lost or invented units | largest-remainder allocator plus property test |
| BR-13 | The same `Idempotency-Key` never produces two documents | unique index |
| BR-14 | No query ever returns a row belonging to another organization | Prisma extension plus isolation test suite |
| BR-15 | A sale may only be voided while its shift is `OPEN` | service check |
| BR-16 | `purchase_item.received_quantity <= purchase_item.ordered_quantity` | `CHECK` |
| BR-17 | A variant may not be sold from a warehouse it has no level row in | insert-on-first-receipt, plus checkout guard |

---

## 3. Entity relationship explanation

### 3.1 The tenancy spine

```
Organization (tenant root)
├── OrganizationSettings        1:1   currency, rounding, negative-stock policy
├── User                        1:N   org-scoped login
│   └── StoreMembership         1:N   (user, store, role)
├── Role                        1:N   permissions TEXT[]
├── Store                       1:N
│   ├── Warehouse               1:N   stock lives here
│   ├── CashRegister            1:N
│   │   └── CashRegisterShift   1:N
│   └── Sale                    1:N
├── Category / Product          1:N   catalog is org-wide, not store-wide
├── Customer / Supplier         1:N   org-wide
└── AuditLog / Notification     1:N
```

**Why the catalog is org-wide, not store-wide.** A product is the same product in
every store. The real variations are per-store *price* and per-store
*availability*, and both are additive later via a `store_product_override` table
without moving the product itself. Store-scoping products from the start would
duplicate SKUs across stores and break barcode lookup.

**Why inventory is warehouse-scoped, not store-scoped.** The brief includes
warehouses and transfers. If stock hung off `store_id`, adding a second warehouse
would require migrating every movement row ever written. `warehouse_id` costs
nothing today.

### 3.2 The selling chain

```
Customer ──┐
           ▼
        Sale ───────────────► SaleItem ───► ProductVariant
         │  │                    │
         │  │                    └──────► InventoryMovement (SALE, −qty)
         │  │
         │  ├──► PaymentAllocation ◄──── Payment ──► CashRegisterShift
         │  │                                └──► method: CASH | CARD | CLICK | PAYME | …
         │  │
         │  ├──► CustomerReceivable   (the unpaid remainder, if any)
         │  │         ▲
         │  │         └── PaymentAllocation ◄── Payment   (later debt collection)
         │  │
         │  ├──► LoyaltyTransaction   (EARN on completion, SPEND if redeemed)
         │  │
         │  └──► Return ──► ReturnItem ──► SaleItem      (what is being undone)
         │                     │  │
         │                     │  └──► InventoryMovement (RETURN, +qty)
         │                     └─────► PaymentAllocation ◄── Payment (direction OUT)
         │
         └──► Exchange ──► (return_id, replacement_sale_id, settlement)
```

The critical shape: **`Payment` is not owned by `Sale`.** A payment is owned by
the shift and the customer; `PaymentAllocation` ties money to a document. That
one indirection makes mixed payments, split tenders, debt collection,
over-payment and refunds a single mechanism instead of four.

### 3.3 The procurement chain

```
Supplier ──► Purchase ──► PurchaseItem ──► ProductVariant
                 │              │
                 │              └──► InventoryMovement (PURCHASE, +qty, unit_cost)
                 │                        └──► updates InventoryLevel.avg_cost
                 └──► SupplierPayment (money out, reduces payable)
```

Procurement mirrors selling but is **intentionally not shared code**. A supplier
payable and a customer receivable have opposite signs, different approval rules,
different reporting and different permissions. Forcing them into one "party
ledger" abstraction is the classic over-generalization that makes both harder to
read and neither easier to change. Two small parallel models beat one clever one.

### 3.4 The inventory chain

```
                     ┌─ INITIAL           (+)  onboarding / opening stock
                     ├─ PURCHASE          (+)  from a PurchaseItem receipt
                     ├─ SALE              (−)  from a SaleItem
                     ├─ RETURN            (+)  from a ReturnItem
InventoryMovement ◄──┼─ TRANSFER_OUT      (−)  from a StockTransferItem
 (append-only)       ├─ TRANSFER_IN       (+)  from a StockTransferItem
                     ├─ COUNT_CORRECTION  (±)  from an InventoryCountItem
                     ├─ ADJUSTMENT        (±)  manual, reason required
                     ├─ DAMAGE            (−)  manual, reason required
                     └─ WRITE_OFF         (−)  manual, reason required
                                │
                                ▼
                     InventoryLevel  (variant, warehouse) → quantity, avg_cost
```

Every movement carries `source_type` plus `source_id` pointing back at the
document that caused it, so any stock number traces to a business event in one
join, and the ledger can be replayed to rebuild every level.

---

## 4. Multi-tenant strategy

### 4.1 Model: shared database, shared schema, `organization_id` column

Rejected alternatives:

- **Database per tenant** — migration fan-out and connection-pool cost are
  unacceptable at the scale where SaaS becomes interesting, and cross-tenant
  analytics becomes impossible.
- **Schema per tenant** — Prisma has no first-class support; every query needs
  `SET search_path`, and 500 tenants means 500 × ~40 tables to migrate.
- **Shared schema plus `organization_id`** — chosen. One migration, one pool,
  cheap. The cost is that isolation becomes an *application* responsibility,
  which is why it gets three layers of defence below.

Every tenant-owned table carries `organization_id UUID NOT NULL` as the **leading
column of its compound indexes**, so tenant filtering is always index-led rather
than a post-filter.

### 4.2 Scope levels

| Scope | Column | Applies to |
|---|---|---|
| Tenant | `organization_id` | everything except `Organization` itself |
| Store | `store_id` | Sale, Return, Exchange, Payment, CashRegister, CashRegisterShift, CashMovement, StoreMembership, Warehouse, InventoryCount, Purchase (receiving store) |
| Warehouse | `warehouse_id` | InventoryLevel, InventoryMovement, InventoryCountItem, StockTransferItem |
| Org-wide | — | Product, ProductVariant, Category, Customer, CustomerGroup, Supplier, Role, Promotion, LoyaltyAccount |

Rule of thumb: **masters are org-wide, documents are store-scoped, stock is
warehouse-scoped.**

### 4.3 Tenant resolution

Resolution is **never** from a header, query parameter or body field. It derives
solely from the verified access token:

```
Access token claims
  sub      user id
  org      organization id
  store    active store id (the store this session operates in)
  role     role id for that store membership
  pv       permission-set version (cache invalidation)
  tv       token version (bumped on password change / deactivation)
  jti, iat, exp
```

Per request:

1. `JwtAuthGuard` verifies signature and expiry, producing claims.
2. `TenantGuard` builds a request-scoped `TenantContext { orgId, storeId, userId,
   roleId }` held in `AsyncLocalStorage` via `nestjs-cls`.
3. `PermissionsGuard` resolves the role's permission set (in-process LRU keyed by
   `roleId:pv`) and checks the `@RequirePermissions(...)` metadata.
4. Every Prisma call runs through a client extension that:
   - **injects** `organizationId` into `where` for every tenant-scoped model on
     `findMany`, `findFirst`, `updateMany`, `deleteMany`, `count`, `aggregate`;
   - **injects** `organizationId` into `data` on `create` and `createMany`;
   - **rejects at runtime** a `findUnique` / `update` / `delete` by bare `id` on a
     tenant-scoped model. Those must target the compound unique
     `(organization_id, id)`, which every tenant table declares for exactly this
     reason.

Store scoping is **not** automated by the extension — it is context-dependent (a
manager legitimately reads across stores). It is enforced explicitly per service
and covered by the isolation test suite.

### 4.4 Switching stores

`POST /api/v1/auth/switch-store` issues a new access token with a different
`store` claim after verifying a `StoreMembership` exists. The refresh token is
untouched. Store context stays inside the signed token rather than in a mutable
header a client could tamper with.

### 4.5 What the client is never trusted for

`organization_id`, `store_id`, actor `user_id`, `role`, `permissions`, unit
`price` (always re-read server-side from the variant), `subtotal`, `total`,
discount eligibility, loyalty balance, stock availability.

DTOs for these endpoints **do not contain those fields at all** — a field that
does not exist cannot be forged. Where a client legitimately must send a price
(manual override at POS), it is gated by its own permission
(`sales.override_price`) and always writes an audit event.

### 4.6 Phase-2 hardening: PostgreSQL RLS

RLS is the correct end state, but it requires `SET LOCAL app.current_org` on
every transaction, which Prisma supports cleanly only inside interactive
`$transaction` callbacks. Adopting it before the transaction boundaries in §24
are implemented and stable would mean writing them twice. Plan: enable RLS on all
tenant tables once those boundaries settle, keeping the Prisma extension as
defence-in-depth rather than replacing it.
---

## 5. PostgreSQL schema

> Read §8 (money model) first — every `BIGINT` money column below is integer
> minor units of the organization's currency, and every `NUMERIC(14,3)` column is
> a physical quantity, never money.

### 5.1 Conventions applied to every table

| Concern | Convention |
|---|---|
| Primary key | `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`. UUIDv7 generated in application code for documents, so ids sort by creation time and index locality stays good. |
| Tenant key | `organization_id UUID NOT NULL REFERENCES organization(id)` on every tenant-owned table, plus `UNIQUE (organization_id, id)` so all tenant-scoped lookups can be compound. |
| Timestamps | `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Append-only tables (`inventory_movement`, `audit_log`, `loyalty_transaction`, `payment_allocation`) have `created_at` only. |
| Actor | `created_by UUID REFERENCES app_user(id)` on documents only. Master data uses the audit log instead. |
| Money | `BIGINT`, never `NUMERIC`, never `float`. Column names end in `_amount`, `_price`, `_total`, `_cost`. |
| Quantity | `NUMERIC(14,3)` — supports weight/volume selling; whole units store `.000`. |
| Percent | `NUMERIC(5,2)` (0.00–100.00) for user-entered rates only; never used for stored money. |
| Soft delete | `archived_at TIMESTAMPTZ NULL` on master data only. Documents use status. No `deleted_at` anywhere. |
| Delete behaviour | `ON DELETE RESTRICT` by default; `ON DELETE CASCADE` only from an aggregate root to its own child lines (`sale → sale_item`, `purchase → purchase_item`, etc.). Nothing else cascades. |
| Enums | Native PostgreSQL enums for closed, code-coupled sets (movement type, sale status). `TEXT` with a `CHECK` for sets likely to be extended by configuration. |
| Concurrency | `version INTEGER NOT NULL DEFAULT 0` on `product`, `product_variant`, `organization_settings`, `role`, `promotion` — tables edited by humans through forms. |

### 5.2 Identity and tenancy

**`organization`**
`id`, `name`, `slug UNIQUE`, `currency_code CHAR(3) NOT NULL DEFAULT 'UZS'`,
`status` (`ACTIVE`|`SUSPENDED`), `created_at`, `updated_at`.
No `organization_id` (it is the root).

**`organization_settings`** — 1:1 with organization
`organization_id PK/FK`, `currency_exponent SMALLINT NOT NULL DEFAULT 0`,
`cash_rounding_unit BIGINT NOT NULL DEFAULT 0` (0 = no rounding; 100 = round cash
totals to the nearest 100 soʻm), `allow_negative_stock BOOLEAN NOT NULL DEFAULT
false`, `default_debt_term_days SMALLINT NOT NULL DEFAULT 30`,
`loyalty_earn_percent NUMERIC(5,2) NOT NULL DEFAULT 0`,
`loyalty_point_value BIGINT NOT NULL DEFAULT 1`, `low_stock_check_enabled
BOOLEAN`, `timezone TEXT NOT NULL DEFAULT 'Asia/Tashkent'`, `version`.

**`store`**
`id`, `organization_id`, `name`, `code`, `address`, `phone`, `timezone`,
`status`, `archived_at`, timestamps.
`UNIQUE (organization_id, code) WHERE archived_at IS NULL`.

**`warehouse`**
`id`, `organization_id`, `store_id NULL` (NULL = central warehouse not attached
to a store), `name`, `code`, `is_default BOOLEAN NOT NULL DEFAULT false`,
`allow_negative_stock BOOLEAN NULL` (NULL = inherit org setting), `archived_at`,
timestamps.
`UNIQUE (organization_id, code) WHERE archived_at IS NULL`.
Partial unique: at most one default warehouse per store —
`UNIQUE (store_id) WHERE is_default AND archived_at IS NULL`.

**`app_user`** (`user` is reserved in PostgreSQL)
`id`, `organization_id`, `email CITEXT`, `phone`, `full_name`,
`password_hash TEXT NOT NULL`, `token_version INTEGER NOT NULL DEFAULT 0`,
`last_login_at`, `deactivated_at`, timestamps.
`UNIQUE (organization_id, email) WHERE deactivated_at IS NULL`.
Login lookup index: `(email)` — email is globally unique across orgs in MVP to
keep the login form single-field. Revisit if white-label sign-up is added (§35).

**`role`**
`id`, `organization_id`, `name`, `code`, `permissions TEXT[] NOT NULL DEFAULT
'{}'`, `is_system BOOLEAN NOT NULL DEFAULT false`, `permission_version INTEGER
NOT NULL DEFAULT 0`, `version`, timestamps.
`UNIQUE (organization_id, code)`.
System roles (`OWNER`, `MANAGER`, `CASHIER`, `WAREHOUSE`, `SALES`) are seeded per
organization and cannot be deleted; `OWNER` cannot have permissions removed.

**`store_membership`**
`id`, `organization_id`, `user_id`, `store_id`, `role_id`, `is_primary BOOLEAN`,
timestamps.
`UNIQUE (user_id, store_id)`. Index `(organization_id, store_id)`.

**`refresh_token`**
`id`, `organization_id`, `user_id`, `token_hash TEXT NOT NULL` (SHA-256 of the
opaque token — the token itself is never stored), `family_id UUID NOT NULL`,
`expires_at`, `revoked_at NULL`, `replaced_by_id NULL`, `user_agent`, `ip INET`,
`created_at`.
`UNIQUE (token_hash)`. Index `(user_id, revoked_at)`, `(expires_at)` for cleanup.

### 5.3 Catalog

**`category`**
`id`, `organization_id`, `parent_id NULL REFERENCES category(id)`, `name`,
`slug`, `sort_order INTEGER`, `archived_at`, timestamps.
`UNIQUE (organization_id, parent_id, name) WHERE archived_at IS NULL`.
Depth limited to 2 in the service; a `CHECK` cannot express that and a recursive
trigger is not worth it at this size.

**`product`**
`id`, `organization_id`, `category_id NULL`, `default_supplier_id NULL`,
`name TEXT NOT NULL`, `description TEXT NULL`, `image_urls TEXT[] NOT NULL
DEFAULT '{}'`, `has_variants BOOLEAN NOT NULL DEFAULT false`,
`status` (`ACTIVE`|`INACTIVE`), `archived_at`, `version`, timestamps,
`search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', name)) STORED`.
Indexes: `(organization_id, category_id)`, `(organization_id, status)`,
GIN on `search_tsv`, GIN trigram on `name` for substring search.

**`product_variant`**
`id`, `organization_id`, `product_id`, `sku TEXT NOT NULL`,
`barcode TEXT NULL`, `name TEXT NULL` (NULL for the default variant),
`attributes JSONB NOT NULL DEFAULT '{}'` (e.g. `{"color":"red","size":"XL"}`),
`unit` (`PIECE`|`KG`|`LITRE`|`METRE`|`PACK`), `purchase_price BIGINT NOT NULL
DEFAULT 0`, `selling_price BIGINT NOT NULL`, `min_stock NUMERIC(14,3) NOT NULL
DEFAULT 0`, `is_default BOOLEAN NOT NULL DEFAULT false`, `archived_at`,
`version`, timestamps.
Constraints:
- `UNIQUE (organization_id, sku) WHERE archived_at IS NULL`
- `UNIQUE (organization_id, barcode) WHERE barcode IS NOT NULL AND archived_at IS NULL`
- `UNIQUE (product_id) WHERE is_default` — exactly one default per product
- `CHECK (selling_price >= 0 AND purchase_price >= 0)`
Index: `(organization_id, barcode)` for the POS scan path — this is the hottest
lookup in the system and must be a single index hit.

### 5.4 Inventory

**`inventory_level`** — the projection
`id`, `organization_id`, `warehouse_id`, `product_variant_id`,
`quantity NUMERIC(14,3) NOT NULL DEFAULT 0`,
`avg_cost BIGINT NOT NULL DEFAULT 0`, `updated_at`.
- `UNIQUE (warehouse_id, product_variant_id)` — the row that gets locked
- `CHECK (quantity >= 0)` is **conditional**: it is not declared, because some
  warehouses allow negative. Negative-stock policy is enforced by the
  conditional `UPDATE` in §25.2. A `CHECK (quantity >= -1000000)` sanity bound is
  declared to catch sign-flip bugs.
- Index `(organization_id, product_variant_id)` for "stock across warehouses"
- Partial index `(organization_id, warehouse_id) WHERE quantity <= 0` for the
  out-of-stock report

**`inventory_movement`** — append-only ledger
`id`, `organization_id`, `warehouse_id`, `product_variant_id`,
`type inventory_movement_type NOT NULL`,
`quantity_delta NUMERIC(14,3) NOT NULL` (signed; sign must match the type),
`quantity_after NUMERIC(14,3) NOT NULL` (the level's value after this movement —
makes any point-in-time stock question a single row read),
`unit_cost BIGINT NULL` (cost at the time; required for `PURCHASE` and `INITIAL`),
`source_type TEXT NOT NULL`, `source_id UUID NULL`,
`reason TEXT NULL`, `note TEXT NULL`,
`created_by UUID`, `created_at`.
Constraints:
- `CHECK (quantity_delta <> 0)`
- `CHECK (type IN ('SALE','TRANSFER_OUT','DAMAGE','WRITE_OFF') AND quantity_delta < 0 OR type IN ('PURCHASE','RETURN','TRANSFER_IN','INITIAL') AND quantity_delta > 0 OR type IN ('ADJUSTMENT','COUNT_CORRECTION'))`
- `CHECK (type NOT IN ('ADJUSTMENT','DAMAGE','WRITE_OFF') OR reason IS NOT NULL)`
- No `UPDATE` or `DELETE` grant for the application role — enforced by a
  `BEFORE UPDATE OR DELETE` trigger that raises, so a careless Prisma call fails
  loudly rather than silently corrupting the ledger.
Indexes: `(organization_id, product_variant_id, created_at DESC)`,
`(warehouse_id, created_at DESC)`, `(source_type, source_id)`.

**`inventory_count`**
`id`, `organization_id`, `warehouse_id`, `count_number TEXT NOT NULL`,
`status`, `scope` (`FULL`|`PARTIAL`|`CATEGORY`), `category_id NULL`,
`started_at`, `finalized_at NULL`, `created_by`, `finalized_by NULL`,
`note`, timestamps.
`UNIQUE (organization_id, count_number)`.
Partial unique: one open count per warehouse —
`UNIQUE (warehouse_id) WHERE status IN ('DRAFT','COUNTING')`. This single index
removes an entire class of race condition.

**`inventory_count_item`**
`id`, `organization_id`, `inventory_count_id`, `product_variant_id`,
`expected_quantity NUMERIC(14,3) NOT NULL` (snapshot at the moment the line was
added), `counted_quantity NUMERIC(14,3) NULL`,
`difference NUMERIC(14,3) GENERATED ALWAYS AS (counted_quantity − expected_quantity) STORED`,
`unit_cost BIGINT NULL`, `counted_by NULL`, `counted_at NULL`, timestamps.
`UNIQUE (inventory_count_id, product_variant_id)`.

**`stock_transfer`**
`id`, `organization_id`, `transfer_number`, `from_warehouse_id`,
`to_warehouse_id`, `status`, `sent_at NULL`, `received_at NULL`,
`created_by`, `sent_by NULL`, `received_by NULL`, `note`, timestamps.
`CHECK (from_warehouse_id <> to_warehouse_id)`,
`UNIQUE (organization_id, transfer_number)`.

**`stock_transfer_item`**
`id`, `organization_id`, `stock_transfer_id`, `product_variant_id`,
`quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0)`,
`received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0`,
`CHECK (received_quantity <= quantity)`, `unit_cost BIGINT`.
`UNIQUE (stock_transfer_id, product_variant_id)`.

### 5.5 Selling

**`sale`**
```
id                    UUID PK
organization_id       UUID NOT NULL
store_id              UUID NOT NULL
warehouse_id          UUID NOT NULL      -- which stock this sale drew from
cash_register_shift_id UUID NULL         -- NULL only for DRAFT
customer_id           UUID NULL          -- NULL = walk-in
sale_number           TEXT NOT NULL      -- human receipt number, per store
status                sale_status NOT NULL DEFAULT 'DRAFT'
return_status         sale_return_status NOT NULL DEFAULT 'NONE'
subtotal_amount       BIGINT NOT NULL DEFAULT 0   -- sum of line net amounts
order_discount_amount BIGINT NOT NULL DEFAULT 0
tax_amount            BIGINT NOT NULL DEFAULT 0   -- reserved, always 0 in MVP
rounding_adjustment   BIGINT NOT NULL DEFAULT 0   -- cash rounding, can be ±
total_amount          BIGINT NOT NULL DEFAULT 0
paid_amount           BIGINT NOT NULL DEFAULT 0   -- sum of allocations, maintained in tx
credit_amount         BIGINT NOT NULL DEFAULT 0   -- amount pushed to a receivable
refunded_amount       BIGINT NOT NULL DEFAULT 0
cost_amount           BIGINT NOT NULL DEFAULT 0   -- COGS snapshot for margin reports
promotion_id          UUID NULL
discount_reason       TEXT NULL
note                  TEXT NULL
created_by            UUID NOT NULL      -- the cashier
completed_at          TIMESTAMPTZ NULL
cancelled_at          TIMESTAMPTZ NULL
cancelled_by          UUID NULL
cancel_reason         TEXT NULL
client_id             UUID NULL          -- offline hook: client-generated id
client_created_at     TIMESTAMPTZ NULL   -- offline hook: device clock
created_at, updated_at
```
Constraints:
- `UNIQUE (organization_id, store_id, sale_number)`
- `UNIQUE (organization_id, client_id) WHERE client_id IS NOT NULL`
- `CHECK (total_amount = subtotal_amount − order_discount_amount + tax_amount + rounding_adjustment)`
- `CHECK (paid_amount + credit_amount = total_amount OR status <> 'COMPLETED')`
- `CHECK (status <> 'COMPLETED' OR cash_register_shift_id IS NOT NULL)`
Indexes: `(organization_id, store_id, completed_at DESC)` (the sales list),
`(organization_id, customer_id, completed_at DESC)`,
`(cash_register_shift_id)`, `(organization_id, status)`,
`(organization_id, sale_number text_pattern_ops)` for receipt lookup.

**`sale_item`**
```
id, organization_id, sale_id (CASCADE), product_variant_id
name_snapshot       TEXT NOT NULL    -- what the receipt said, immune to renames
sku_snapshot        TEXT NOT NULL
quantity            NUMERIC(14,3) NOT NULL CHECK (quantity > 0)
unit_price          BIGINT NOT NULL  -- server-resolved, or overridden w/ permission
gross_amount        BIGINT NOT NULL  -- round(unit_price * quantity)
line_discount_amount   BIGINT NOT NULL DEFAULT 0
allocated_order_discount BIGINT NOT NULL DEFAULT 0  -- share of the order discount
net_amount          BIGINT NOT NULL  -- gross − line_discount − allocated_order_discount
unit_cost           BIGINT NOT NULL  -- avg_cost at time of sale (COGS)
returned_quantity   NUMERIC(14,3) NOT NULL DEFAULT 0
refunded_amount     BIGINT NOT NULL DEFAULT 0
promotion_id        UUID NULL
position            SMALLINT NOT NULL
```
Constraints:
- `CHECK (returned_quantity <= quantity)` — **BR-6, enforced by the database**
- `CHECK (net_amount >= 0)`
- `CHECK (line_discount_amount >= 0 AND allocated_order_discount >= 0)`
- `UNIQUE (sale_id, position)`
Index: `(organization_id, product_variant_id)` for the top-products report.

**`return`** (`sale_return` as the physical table name — `return` is reserved)
```
id, organization_id, store_id, cash_register_shift_id, sale_id, customer_id NULL
return_number       TEXT NOT NULL
status              DEFAULT 'COMPLETED'
reason              return_reason NOT NULL   -- DEFECTIVE | WRONG_ITEM | CHANGED_MIND | EXPIRED | OTHER
reason_note         TEXT NULL
refund_amount       BIGINT NOT NULL          -- money actually returned
credit_offset_amount BIGINT NOT NULL DEFAULT 0 -- amount written off an open receivable instead
restock             BOOLEAN NOT NULL DEFAULT true
warehouse_id        UUID NOT NULL            -- where restocked goods go
exchange_id         UUID NULL                -- set if part of an exchange
created_by, created_at, updated_at
```
`UNIQUE (organization_id, store_id, return_number)`.
Index `(organization_id, sale_id)`, `(organization_id, created_at DESC)`.

**`return_item`**
`id`, `organization_id`, `return_id (CASCADE)`, `sale_item_id`,
`product_variant_id`, `quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0)`,
`unit_refund_amount BIGINT NOT NULL`, `refund_amount BIGINT NOT NULL`,
`restock BOOLEAN NOT NULL DEFAULT true`, `condition` (`SELLABLE`|`DAMAGED`).
`UNIQUE (return_id, sale_item_id)`.

**`exchange`**
`id`, `organization_id`, `store_id`, `exchange_number`, `return_id UNIQUE`,
`replacement_sale_id UNIQUE`, `customer_id NULL`,
`returned_value BIGINT NOT NULL`, `replacement_value BIGINT NOT NULL`,
`net_amount BIGINT NOT NULL` (positive = customer owes, negative = refund due),
`settlement` (`CUSTOMER_PAID`|`REFUNDED`|`EVEN`|`CREDITED_TO_DEBT`),
`created_by`, timestamps.
`CHECK (net_amount = replacement_value − returned_value)`.

### 5.6 Tender

**`payment`**
```
id, organization_id, store_id
cash_register_shift_id UUID NULL      -- NULL for non-till payments (e.g. bank transfer)
customer_id            UUID NULL
direction              payment_direction NOT NULL   -- IN | OUT
method                 payment_method NOT NULL      -- CASH|CARD|CLICK|PAYME|UZUM|TRANSFER|LOYALTY|OTHER
amount                 BIGINT NOT NULL CHECK (amount > 0)   -- always positive; direction carries sign
status                 DEFAULT 'COMPLETED'          -- COMPLETED | VOIDED
provider_ref           TEXT NULL                    -- external transaction id
provider_meta          JSONB NOT NULL DEFAULT '{}'
received_by            UUID NOT NULL
note                   TEXT NULL
idempotency_key        TEXT NULL
client_id              UUID NULL
created_at, updated_at
```
- `UNIQUE (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
- `UNIQUE (organization_id, client_id) WHERE client_id IS NOT NULL`
- Index `(cash_register_shift_id, method)` — the shift Z-report reads this
- Index `(organization_id, customer_id, created_at DESC)`

**`payment_allocation`** — append-only
```
id, organization_id, payment_id
sale_id        UUID NULL
receivable_id  UUID NULL
return_id      UUID NULL
amount         BIGINT NOT NULL CHECK (amount > 0)
created_at
CHECK (num_nonnulls(sale_id, receivable_id, return_id) = 1)
```
The `num_nonnulls` check replaces a polymorphic `(target_type, target_id)` pair,
keeping real foreign keys and real referential integrity. Three nullable columns
is a small price for the database actually verifying the target exists.
Indexes: `(sale_id)`, `(receivable_id)`, `(return_id)`, `(payment_id)`.

**`cash_register`**
`id`, `organization_id`, `store_id`, `name`, `code`, `status`, `archived_at`,
timestamps. `UNIQUE (organization_id, store_id, code)`.

**`cash_register_shift`**
```
id, organization_id, store_id, cash_register_id
shift_number        TEXT NOT NULL
opened_by, opened_at
opening_amount      BIGINT NOT NULL
closed_by NULL, closed_at NULL
expected_cash_amount BIGINT NULL     -- computed at close
counted_cash_amount  BIGINT NULL     -- what the cashier physically counted
difference_amount    BIGINT NULL     -- counted − expected; negative = short
status              shift_status NOT NULL DEFAULT 'OPEN'
note                TEXT NULL
```
- `UNIQUE (cash_register_id) WHERE status = 'OPEN'` — **one open shift per
  register, enforced by the database.** This single partial index eliminates the
  entire "two cashiers opened the same till" race.
- `CHECK (status <> 'CLOSED' OR (closed_at IS NOT NULL AND expected_cash_amount IS NOT NULL AND counted_cash_amount IS NOT NULL))`

**`cash_movement`**
`id`, `organization_id`, `store_id`, `cash_register_shift_id`,
`direction` (`IN`|`OUT`), `type` (`DROP`|`PAYOUT`|`EXPENSE`|`CORRECTION`|`OTHER`),
`amount BIGINT NOT NULL CHECK (amount > 0)`, `reason TEXT NOT NULL`,
`created_by`, `created_at`.

### 5.7 Receivables

**`customer_receivable`**
```
id, organization_id, store_id
customer_id       UUID NOT NULL
sale_id           UUID NULL UNIQUE   -- NULL for opening balances / manual debts
origin            receivable_origin NOT NULL  -- SALE | OPENING_BALANCE | MANUAL | EXCHANGE
original_amount   BIGINT NOT NULL CHECK (original_amount > 0)
paid_amount       BIGINT NOT NULL DEFAULT 0 CHECK (paid_amount >= 0)
written_off_amount BIGINT NOT NULL DEFAULT 0
remaining_amount  BIGINT GENERATED ALWAYS AS
                    (original_amount − paid_amount − written_off_amount) STORED
status            receivable_status NOT NULL DEFAULT 'OPEN'
issued_at         TIMESTAMPTZ NOT NULL
due_date          DATE NOT NULL
closed_at         TIMESTAMPTZ NULL
note              TEXT NULL
created_by
created_at, updated_at
```
- `CHECK (paid_amount + written_off_amount <= original_amount)` — **BR-8, in the
  database.** Over-payment becomes an error, not a negative balance.
- `remaining_amount` is `GENERATED ALWAYS` — it cannot drift from its inputs
  because nothing may write it. This is the single most valuable constraint in
  the debt module.
- Indexes: `(organization_id, customer_id, status)`,
  `(organization_id, due_date) WHERE status IN ('OPEN','PARTIALLY_PAID')` — the
  overdue/due-soon dashboards are one index scan,
  `(organization_id, status, remaining_amount DESC)` for the top-debtors report.

A customer's total debt is `SUM(remaining_amount)` over their open receivables.
There is **no `customer.debt` column**. If that aggregate ever becomes slow, it
becomes a materialized view, not a mutable column.

### 5.8 Customers, loyalty, promotions

**`customer_group`** — `id`, `organization_id`, `name`,
`discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0`, `credit_limit BIGINT NULL`,
`archived_at`, timestamps.

**`customer`**
`id`, `organization_id`, `customer_group_id NULL`, `full_name`, `phone`,
`email NULL`, `birth_date NULL`, `address NULL`, `notes TEXT NULL`,
`credit_limit BIGINT NULL` (overrides the group's), `archived_at`, timestamps.
`UNIQUE (organization_id, phone) WHERE phone IS NOT NULL AND archived_at IS NULL`.
Trigram index on `full_name` and `phone` for POS customer search.

**`loyalty_account`** — `id`, `organization_id`, `customer_id UNIQUE`,
`points_balance BIGINT NOT NULL DEFAULT 0`, `lifetime_earned BIGINT`,
`updated_at`. The balance is a cache; the ledger is authoritative.

**`loyalty_transaction`** — append-only
`id`, `organization_id`, `loyalty_account_id`, `type` (`EARN`|`SPEND`|
`ADJUSTMENT`|`EXPIRY`), `points_delta BIGINT NOT NULL CHECK (points_delta <> 0)`,
`balance_after BIGINT NOT NULL`, `sale_id NULL`, `return_id NULL`,
`reason TEXT NULL`, `expires_at NULL`, `created_by`, `created_at`.
Index `(loyalty_account_id, created_at DESC)`.

**`promotion`**
`id`, `organization_id`, `name`, `type` (`PERCENT_OFF`|`FIXED_OFF`|
`BUY_X_GET_Y`), `scope` (`ITEM`|`ORDER`), `value NUMERIC(10,2) NOT NULL`,
`min_subtotal BIGINT NULL`, `applies_to` (`ALL`|`CATEGORY`|`PRODUCT`),
`category_ids UUID[]`, `product_ids UUID[]`, `customer_group_ids UUID[]`,
`starts_at`, `ends_at`, `is_active BOOLEAN`, `priority SMALLINT NOT NULL DEFAULT 0`,
`max_uses INTEGER NULL`, `used_count INTEGER NOT NULL DEFAULT 0`, `version`,
timestamps.
Index `(organization_id, is_active, starts_at, ends_at)`.

### 5.9 Procurement

**`supplier`** — `id`, `organization_id`, `name`, `contact_name`, `phone`,
`email`, `address`, `payment_term_days SMALLINT`, `notes`, `archived_at`,
timestamps. `UNIQUE (organization_id, name) WHERE archived_at IS NULL`.

**`purchase`**
`id`, `organization_id`, `store_id`, `warehouse_id`, `supplier_id`,
`purchase_number`, `status`, `supplier_invoice_number NULL`,
`ordered_at NULL`, `expected_at NULL`, `received_at NULL`,
`subtotal_amount BIGINT`, `discount_amount BIGINT DEFAULT 0`,
`shipping_amount BIGINT DEFAULT 0`, `total_amount BIGINT`,
`paid_amount BIGINT NOT NULL DEFAULT 0`,
`remaining_amount BIGINT GENERATED ALWAYS AS (total_amount − paid_amount) STORED`,
`created_by`, `received_by NULL`, `note`, timestamps.
`UNIQUE (organization_id, purchase_number)`.
`CHECK (paid_amount <= total_amount)`.
Index `(organization_id, supplier_id, status)`,
`(organization_id, status, remaining_amount) WHERE remaining_amount > 0`.

**`purchase_item`**
`id`, `organization_id`, `purchase_id (CASCADE)`, `product_variant_id`,
`ordered_quantity NUMERIC(14,3) NOT NULL CHECK (ordered_quantity > 0)`,
`received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0`,
`unit_cost BIGINT NOT NULL`, `line_amount BIGINT NOT NULL`,
`CHECK (received_quantity <= ordered_quantity)`.
`UNIQUE (purchase_id, product_variant_id)`.

**`supplier_payment`**
`id`, `organization_id`, `store_id`, `supplier_id`, `purchase_id NULL`,
`cash_register_shift_id NULL`, `method payment_method NOT NULL`,
`amount BIGINT NOT NULL CHECK (amount > 0)`, `reference TEXT NULL`,
`paid_at`, `created_by`, `idempotency_key`, `note`, `created_at`.
`UNIQUE (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.

### 5.10 Platform

**`audit_log`** — append-only, no updates, no deletes
`id BIGSERIAL`, `organization_id`, `store_id NULL`, `actor_user_id NULL`
(NULL = system), `action TEXT NOT NULL` (`sale.cancelled`,
`product.price_changed`, …), `entity_type TEXT NOT NULL`, `entity_id UUID NULL`,
`metadata JSONB NOT NULL DEFAULT '{}'`, `ip INET NULL`, `user_agent TEXT NULL`,
`request_id UUID NULL`, `created_at`.
Indexes: `(organization_id, created_at DESC)`,
`(organization_id, entity_type, entity_id, created_at DESC)`,
`(organization_id, actor_user_id, created_at DESC)`.
Partitioning by month is the escape hatch when this table grows; the schema is
already partition-ready (`created_at` is in every index prefix that matters).

**`notification`** — feed row and delivery record in one table
`id`, `organization_id`, `store_id NULL`, `user_id NULL` (NULL = broadcast to a
role), `role_code TEXT NULL`, `type TEXT NOT NULL`, `title`, `body`,
`payload JSONB`, `severity` (`INFO`|`WARNING`|`CRITICAL`),
`read_at NULL`, `channel` (`IN_APP`|`TELEGRAM`), `delivery_status`
(`PENDING`|`SENT`|`FAILED`|`SKIPPED`), `attempts SMALLINT NOT NULL DEFAULT 0`,
`next_attempt_at TIMESTAMPTZ NULL`, `last_error TEXT NULL`, `created_at`.
Index `(organization_id, user_id, read_at)`,
partial index `(next_attempt_at) WHERE delivery_status = 'PENDING'` — this is the
poller's only query, and it stays tiny because delivered rows leave the index.

**`idempotency_record`**
`organization_id`, `key TEXT`, `endpoint TEXT NOT NULL`,
`request_hash TEXT NOT NULL`, `status` (`IN_PROGRESS`|`COMPLETED`),
`response_status SMALLINT NULL`, `response_body JSONB NULL`,
`resource_id UUID NULL`, `created_at`, `expires_at`.
`PRIMARY KEY (organization_id, key)`. Index `(expires_at)` for the purge job.

**`document_counter`**
`organization_id`, `store_id`, `document_type TEXT`, `period_key TEXT`
(e.g. `2026-09` or `ALL`), `next_value BIGINT NOT NULL DEFAULT 1`.
`PRIMARY KEY (organization_id, store_id, document_type, period_key)`.

### 5.11 Index strategy summary

Indexes exist for a named query, not for symmetry. The load-bearing ones:

| Index | Serves |
|---|---|
| `product_variant (organization_id, barcode)` | POS barcode scan — the hottest path |
| `product (search_tsv)` GIN + trigram on `name` | POS product search |
| `inventory_level (warehouse_id, product_variant_id)` UNIQUE | the row locked on every sale line |
| `sale (organization_id, store_id, completed_at DESC)` | sales list, daily reports |
| `sale (cash_register_shift_id)` | shift close and Z-report |
| `payment (cash_register_shift_id, method)` | expected-cash computation |
| `customer_receivable (organization_id, due_date) WHERE OPEN/PARTIAL` | debt dashboards |
| `inventory_movement (organization_id, product_variant_id, created_at DESC)` | stock card |
| `notification (next_attempt_at) WHERE PENDING` | outbound delivery poller |
| `cash_register_shift (cash_register_id) WHERE status='OPEN'` | one-open-shift invariant |
---

## 6. Prisma model draft

The full draft lives in **[`prisma/schema.draft.prisma`](../prisma/schema.draft.prisma)**.
It is deliberately named `.draft.prisma` so the Prisma CLI will not pick it up —
**no migration has been generated or run.** Rename it to `schema.prisma` only
after §35 is answered.

### 6.1 Modelling notes

**Naming.** Prisma models are PascalCase and camelCase; every one carries
`@@map` / `@map` to snake_case physical names. This keeps SQL readable for the
reporting layer, which is raw SQL by design (§28).

**`SaleReturn`, not `Return`.** `return` is reserved in both PostgreSQL and
TypeScript. The model is `SaleReturn`, the table is `sale_return`, and the API
path stays `/returns`.

**Money is `BigInt`.** Prisma maps `BigInt` to PostgreSQL `BIGINT` and to JS
`bigint`. `Decimal` is used only for physical quantities and user-entered
percentages — never for money. See §8.3 for the serialization rule.

**`@@unique([organizationId, id])` on every tenant model.** This is not
decoration. It is what lets `findUniqueOrThrow({ where: { organizationId_id: {...} } })`
be the *only* single-row read pattern, which is what the Prisma tenant extension
enforces (§4.3). A bare `findUnique({ where: { id } })` on a tenant model throws
at runtime.

### 6.2 What Prisma cannot express — the hand-written migration

Roughly 25 constraints in §5 have no Prisma representation. They are not
optional; several of them *are* the business rules. They go into
`prisma/migrations/<ts>_constraints/migration.sql`, appended after Prisma's
generated DDL:

```sql
-- Generated columns (the debt module's most valuable constraint)
ALTER TABLE customer_receivable
  DROP COLUMN remaining_amount,
  ADD COLUMN remaining_amount BIGINT
    GENERATED ALWAYS AS (original_amount - paid_amount - written_off_amount) STORED;

ALTER TABLE purchase
  DROP COLUMN remaining_amount,
  ADD COLUMN remaining_amount BIGINT
    GENERATED ALWAYS AS (total_amount - paid_amount) STORED;

ALTER TABLE inventory_count_item
  ADD COLUMN difference NUMERIC(14,3)
    GENERATED ALWAYS AS (counted_quantity - expected_quantity) STORED;

-- Business-rule CHECKs
ALTER TABLE sale_item            ADD CONSTRAINT ck_returned_le_sold
  CHECK (returned_quantity <= quantity);                              -- BR-6
ALTER TABLE customer_receivable  ADD CONSTRAINT ck_not_overpaid
  CHECK (paid_amount + written_off_amount <= original_amount);        -- BR-8
ALTER TABLE purchase_item        ADD CONSTRAINT ck_received_le_ordered
  CHECK (received_quantity <= ordered_quantity);                      -- BR-16
ALTER TABLE sale                 ADD CONSTRAINT ck_total_identity
  CHECK (total_amount = subtotal_amount - order_discount_amount
                        + tax_amount + rounding_adjustment);          -- BR-1
ALTER TABLE payment_allocation   ADD CONSTRAINT ck_one_target
  CHECK (num_nonnulls(sale_id, receivable_id, return_id) = 1);
ALTER TABLE payment              ADD CONSTRAINT ck_amount_positive
  CHECK (amount > 0);

-- Partial unique indexes (invariants the application must not have to police)
CREATE UNIQUE INDEX uq_one_open_shift_per_register
  ON cash_register_shift (cash_register_id) WHERE status = 'OPEN';
CREATE UNIQUE INDEX uq_one_open_count_per_warehouse
  ON inventory_count (warehouse_id) WHERE status IN ('DRAFT','COUNTING');
CREATE UNIQUE INDEX uq_variant_sku_active
  ON product_variant (organization_id, sku) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_variant_barcode_active
  ON product_variant (organization_id, barcode)
  WHERE barcode IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX uq_default_variant_per_product
  ON product_variant (product_id) WHERE is_default;
CREATE UNIQUE INDEX uq_payment_idem
  ON payment (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Search
ALTER TABLE product ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(name,''))) STORED;
CREATE INDEX ix_product_search  ON product USING GIN (search_tsv);
CREATE INDEX ix_product_name_trgm ON product USING GIN (name gin_trgm_ops);
CREATE INDEX ix_customer_name_trgm ON customer USING GIN (full_name gin_trgm_ops);

-- Append-only enforcement: a careless ORM call must fail loudly
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tg_inventory_movement_immutable
  BEFORE UPDATE OR DELETE ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER tg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER tg_loyalty_tx_immutable
  BEFORE UPDATE OR DELETE ON loyalty_transaction
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
```

Generated columns must be declared read-only in Prisma (`@ignore` on write paths
or, more simply, never included in a `create`/`update` payload — the DTO layer
does not expose them).

### 6.3 Prisma-specific gotchas already designed around

| Gotcha | Handling |
|---|---|
| `BigInt` is not JSON-serializable | global serializer, §8.3 |
| Prisma has no `SELECT … FOR UPDATE` | use `$queryRaw` inside `$transaction`, or the conditional `UPDATE` pattern which needs no explicit lock (§25.2) |
| Prisma middleware is deprecated | use `$extends` client extensions for tenant injection |
| `updateMany` returns a count, not rows | that count *is* the concurrency check — `count === 0` means the guard failed |
| Nested writes have implicit transactions but no isolation control | all money paths use explicit `$transaction(fn, { isolationLevel: 'ReadCommitted', timeout: 15_000 })` |
| Connection pool exhaustion from long transactions | transaction bodies do no I/O other than database calls; Telegram, receipt rendering and notifications happen *after* commit |

---

## 7. Business rules

The invariant table is §2.4 (BR-1 … BR-17). This section states the rules that
are procedures rather than invariants.

### 7.1 Pricing resolution (server-side, always)

For each line at checkout, in order:

1. Load `product_variant.selling_price`. This is the base. A client-supplied
   price is ignored unless the caller holds `sales.override_price`, in which case
   it is used and an audit event `sale.price_overridden` is written.
2. Determine the best applicable **item-scope** promotion:
   filter active promotions where `now BETWEEN starts_at AND ends_at`,
   `is_active`, `used_count < max_uses`, target matches the variant's product or
   category, and the customer's group is in `customer_group_ids` (or the list is
   empty). Sort by `priority DESC, value DESC`. **Take one — promotions do not
   stack.** Non-stacking is a deliberate MVP rule; stacking needs a conflict
   matrix nobody has specified.
3. A manual line discount from the cashier **replaces** the promotion discount if
   it is larger, and requires `sales.discount_item`.

### 7.2 Order-level discount resolution

1. Customer group default discount percent, if the customer has a group.
2. Best applicable **order-scope** promotion where `subtotal >= min_subtotal`.
3. Manual order discount from the cashier, requiring `sales.discount_order`.

Take the **largest single** one. Same non-stacking rule, same reason.

### 7.3 Credit eligibility

A sale may push a remainder to a receivable only if all of:
- a customer is attached (walk-in cannot owe money),
- the caller holds `debt.create`,
- `SUM(customer open receivables remaining) + new credit <= credit_limit`, where
  the limit comes from `customer.credit_limit`, falling back to
  `customer_group.credit_limit`, falling back to unlimited,
- the customer has no receivable more than *N* days overdue, where *N* is
  `organization_settings.default_debt_term_days` (blocked-debtor rule).

Violations return `409 CREDIT_LIMIT_EXCEEDED` or `409 CUSTOMER_BLOCKED_OVERDUE`.

### 7.4 Void vs return

| | Void (cancel) | Return |
|---|---|---|
| When | same shift, sale not yet returned against | any time within the return window |
| Effect on stock | full reversal, `ADJUSTMENT` movements referencing the sale | `RETURN` movements per returned line |
| Effect on money | payments voided, no refund document | refund `Payment` with `direction=OUT` |
| Effect on debt | receivable deleted if untouched, else void is refused | receivable reduced via `credit_offset_amount` |
| Permission | `sales.cancel` | `sales.refund` |
| Audit | `sale.cancelled` with reason (required) | `return.created` |

A sale with any payment allocation from a *closed* shift cannot be voided —
that would falsify a closed Z-report. It must be returned instead.

### 7.5 Return window

`organization_settings.return_window_days` (default 14). Returns outside the
window require `sales.refund_expired` and always write an audit event. Zero means
no limit.

### 7.6 Low-stock rule

After any movement that decreases a level, if
`quantity <= variant.min_stock AND min_stock > 0`, enqueue one `Notification` of
type `inventory.low_stock`, **deduplicated**: skip if an unread low-stock
notification already exists for that (variant, warehouse). This check runs
*after* commit, never inside the sale transaction.

---

## 8. Money model

### 8.1 Representation

> **Money is a `BIGINT` count of the organization's currency minor units.
> Nothing else. Ever.**

- `organization.currency_code` — ISO 4217, `UZS` for the MVP.
- `organization_settings.currency_exponent` — how many decimal places the minor
  unit has. **UZS → `0`**, so one stored unit is one soʻm. (USD would be `2`, so
  one stored unit is one cent.)
- Every money column is `BIGINT`, named `*_amount`, `*_price`, `*_total` or
  `*_cost`.
- There is **no per-row currency column**, because an organization trades in one
  currency. Multi-currency purchasing is a phase-2 change that adds
  `currency_code` + `fx_rate` to `purchase` only — the selling side never needs it.

Why not `NUMERIC(18,2)` / Prisma `Decimal`? It is exact in the database, but on
the JS side it invites `Number(decimal)` at exactly the moment nobody is looking,
and it makes "is this value money or a quantity?" a naming convention rather than
a type. `BigInt` cannot be silently mixed with a float: `1n + 0.5` is a
`TypeError`. The language enforces the rule for us, which is cheaper than a lint
rule and a code review.

Range: `BIGINT` holds ±9.2 × 10^18. Even in whole soʻm that is far beyond any
conceivable total.

### 8.2 The arithmetic rules

1. **Addition and subtraction are exact and unrestricted.** `bigint + bigint`.
2. **Multiplication by a quantity rounds once**, at the line:
   `gross_amount = roundHalfUp(unit_price × quantity)`, where quantity is a
   3-decimal `Decimal`. Implemented in integer arithmetic:
   `(unit_price * qtyMilli + 500n) / 1000n` for positive values.
3. **Percentages round once**, half-up, at the point of application:
   `discount = roundHalfUp(base × percent / 100)`.
4. **Every rounded result is persisted.** Nothing is ever recomputed from a
   percentage at read time. A receipt reprinted in a year shows the same numbers
   because the numbers are stored, not derived.
5. **Division never happens except in allocation**, and allocation uses
   largest-remainder so the parts sum exactly to the whole (§8.4).
6. **Rounding mode is half-up, away from zero**, everywhere, without exception.
   One mode, one helper, no per-site choice.

All of this lives in one file, `src/common/money/money.ts`, with no class
wrapper — a `bigint` *is* the money type:

```ts
export type Money = bigint;          // minor units of the org currency

export const roundHalfUp = (numerator: bigint, denominator: bigint): Money => {
  const half = denominator / 2n;
  return numerator >= 0n
    ? (numerator + half) / denominator
    : -((-numerator + half) / denominator);
};

/** unit_price × quantity, where quantity has 3 decimal places. */
export const priceTimesQty = (unitPrice: Money, qtyMilli: bigint): Money =>
  roundHalfUp(unitPrice * qtyMilli, 1000n);

/** percent has 2 decimal places, e.g. 12.5% arrives as 1250n. */
export const percentOf = (base: Money, percentCentis: bigint): Money =>
  roundHalfUp(base * percentCentis, 10_000n);
```

No `Money` class, no `Currency` value object, no arithmetic DSL. Four functions
and a type alias cover every calculation in the system.

### 8.3 Serialization

`BigInt` throws on `JSON.stringify`. Handled once, in `main.ts`:

```ts
// A money value is an integer count of minor units; JSON numbers are exact
// for integers up to 2^53. The largest realistic UZS total is ~1e12, which
// leaves four orders of magnitude of headroom. The assertion is the guard.
(BigInt.prototype as any).toJSON = function () {
  const n = Number(this);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`money value ${this} exceeds safe integer range`);
  }
  return n;
};
```

API contract: **money is a JSON integer in minor units.** `450000` means
450,000 soʻm. The client formats using `currency_code` + `currency_exponent`,
both returned by `GET /api/v1/settings`. No money value is ever sent as a string,
a float, or a pre-formatted display string.

### 8.4 Allocation — the rule that prevents the classic 1-soʻm bug

Distributing an order discount across lines, or a refund across a partly-returned
line, must sum **exactly**. Proportional rounding does not:
40,000 split across three lines of equal value gives 13,333 × 3 = 39,999.

Largest remainder fixes it:

```ts
/** Split `total` across `weights` so the parts sum exactly to `total`. */
export function allocate(total: Money, weights: Money[]): Money[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map(() => 0n);

  const parts = weights.map((w) => (total * w) / sum);       // floor
  let remainder = total - parts.reduce((a, b) => a + b, 0n);

  // Hand the leftover units to the largest fractional remainders, in order.
  const order = weights
    .map((w, i) => ({ i, frac: (total * w) % sum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));

  for (let k = 0; remainder > 0n; k++, remainder--) parts[order[k].i] += 1n;
  return parts;
}
```

This is used for: order discount → lines, refund → returned units, and
(post-MVP) tax → lines. It has a property test in the suite: for any `total` and
any weights, `sum(allocate(total, w)) === total`.

### 8.5 Cash rounding (UZS-specific)

Uzbekistan has no circulating coin below 100 soʻm and in practice below 1,000.
`organization_settings.cash_rounding_unit` (0 = off, typically 100 or 1000)
applies **only when the tender is cash and only to the total**:

```
rounded_total       = roundHalfUp(total / unit) × unit
rounding_adjustment = rounded_total − total        // stored on the sale, can be ±
```

`rounding_adjustment` is a real column in the total identity (BR-1), so the
sale's arithmetic still closes and the daily report can show exactly how much was
gained or lost to rounding. Card, Click and Payme payments are **not** rounded.

### 8.6 Cost and margin

Costing method: **moving weighted average**, held in `inventory_level.avg_cost`.

On receipt of `qty` at `unit_cost` into a level holding `q0` at `c0`:
```
avg_cost = roundHalfUp(q0 × c0 + qty × unit_cost, q0 + qty)
```
(computed in minor units; `q0`/`qty` in milli-units, so the denominators cancel.)

On sale, `sale_item.unit_cost` snapshots the level's `avg_cost` at that moment,
and `sale.cost_amount` is the sum. Margin is then a pure subtraction on stored
values, never a lookup of a price that may since have changed.

FIFO layers are rejected for the MVP: they need a `cost_layer` table, layer
consumption on every sale, and layer restoration on every return — meaningful
complexity for a difference that only shows up under volatile purchase costs.
Revisit when landed-cost reporting is requested (§35).

---

## 9. Inventory model

### 9.1 Two structures, one truth

| | `inventory_movement` | `inventory_level` |
|---|---|---|
| Role | the ledger — **truth** | the projection — **speed** |
| Mutation | insert only (trigger-enforced) | `UPDATE` only, inside the same transaction |
| Rebuildable | no | yes, from the ledger |
| Queried by | stock card, audit, reconciliation | POS availability, stock list, low-stock |

`product.stock` does not exist as a column, anywhere. Stock is always
`inventory_level.quantity` for a (variant, warehouse), and always verifiable
against `SUM(inventory_movement.quantity_delta)`.

### 9.2 The single write path

Every stock change in the entire system goes through one method. There is no
second way to touch a level.

```ts
// src/inventory/inventory.service.ts
async apply(tx: Tx, cmd: {
  warehouseId: string;
  variantId: string;
  type: InventoryMovementType;
  delta: Decimal;                  // signed
  unitCost?: bigint;
  sourceType: string;
  sourceId: string;
  reason?: string;
  actorId: string;
}): Promise<{ quantityAfter: Decimal }>
```

`apply` performs, in order:

1. The conditional level update (§9.3), which both mutates and guards.
2. Insert the `inventory_movement` row, carrying `quantity_after` from step 1.
3. For inbound movements with a cost, recompute `avg_cost` (§8.6).

`apply` never opens its own transaction — it always receives one. That is what
makes "sale and its stock movements commit or fail together" structurally true
rather than a thing someone has to remember.

### 9.3 Stock deduction, and why it cannot oversell

```sql
UPDATE inventory_level
   SET quantity   = quantity + $delta,
       updated_at = now()
 WHERE warehouse_id       = $warehouse
   AND product_variant_id = $variant
   AND ($allowNegative OR quantity + $delta >= 0)
RETURNING quantity;
```

- A single statement. PostgreSQL takes a row lock for the duration of the
  `UPDATE` and re-evaluates the `WHERE` against the **committed** row, so two
  concurrent cashiers serialize on that row automatically.
- `rowCount === 0` means either the level does not exist (BR-17) or the guard
  failed → `409 INSUFFICIENT_STOCK` with the available quantity in the payload.
- No `SELECT … FOR UPDATE` + application check. That pattern has a window between
  the read and the write in `READ COMMITTED`, and closing it requires
  `REPEATABLE READ` plus retry logic. The conditional `UPDATE` has no window.
- **Deadlock avoidance:** a multi-line sale sorts its lines by
  `product_variant_id` before applying, so two sales touching the same two
  products always lock in the same order.

### 9.4 Negative stock

Resolution order: `warehouse.allow_negative_stock` → if `NULL`, inherit
`organization_settings.allow_negative_stock` → default `false`.

When permitted, the guard clause drops out, the sale proceeds, and a
`inventory.negative_stock` notification fires after commit. Negative stock is a
deliberate, visible, audited state — not a silent one.

Recommended MVP setting: **`false`**. A small store that cannot sell what it does
not have finds its data-entry mistakes on day one instead of month three. Flagged
in §35 for confirmation.

### 9.5 Inventory count

Three phases, and only the third moves stock:

1. **DRAFT** — scope chosen (full / category / partial), lines generated with
   `expected_quantity` snapshotted from the current levels.
2. **COUNTING** — staff enter `counted_quantity` per line. Nothing is locked;
   stock keeps moving. This is intentional — locking a store's entire catalogue
   for the duration of a stocktake is not workable.
3. **FINALIZED** — in one transaction, for each line with a non-null count:
   - **re-read** the level's current quantity (it may have moved since the
     snapshot),
   - `delta = counted_quantity − current_quantity` (**not** `− expected_quantity`
     — using the stale snapshot would silently reverse every sale made during the
     count),
   - if `delta ≠ 0`, `apply()` a `COUNT_CORRECTION` movement,
   - set status `FINALIZED`, write an audit event with the total shrinkage value
     (`SUM(delta × unit_cost)`).

Lines with a `NULL` count are skipped, not zeroed. Counting nothing is not the
same as counting zero, and conflating the two destroys inventory.

The partial unique index `uq_one_open_count_per_warehouse` makes two simultaneous
counts of the same warehouse impossible at the database level.

### 9.6 Stock transfer

```
DRAFT      lines editable, no stock effect
  │ send
  ▼
SENT       TRANSFER_OUT applied at source (stock leaves immediately;
           goods in transit belong to neither warehouse's sellable stock)
  │ receive (quantities may differ — shrinkage in transit is real)
  ▼
RECEIVED   TRANSFER_IN applied at destination for the received quantity.
           received < sent → the difference stays as a documented discrepancy
           and is written off with a WRITE_OFF movement at the source,
           requiring a reason.
```

Both legs carry `source_type='stock_transfer'` and the same `source_id`, so the
pair is one join away from each other.

### 9.7 Reconciliation

A nightly job (and an on-demand endpoint) runs:

```sql
SELECT l.warehouse_id, l.product_variant_id, l.quantity AS level_qty,
       COALESCE(SUM(m.quantity_delta), 0) AS ledger_qty
  FROM inventory_level l
  LEFT JOIN inventory_movement m
    ON m.warehouse_id = l.warehouse_id
   AND m.product_variant_id = l.product_variant_id
 GROUP BY l.warehouse_id, l.product_variant_id, l.quantity
HAVING l.quantity <> COALESCE(SUM(m.quantity_delta), 0);
```

Any row returned is a bug — a code path that mutated a level outside `apply()`.
It raises a `CRITICAL` notification. In a correct system this query always
returns zero rows, which is exactly why it is worth running.

---

## 10. Sales / POS model

### 10.1 Lifecycle

```
                  POST /sales                 POST /sales/{id}/checkout
   (nothing)  ──────────────▶  DRAFT  ─────────────────────────────▶  COMPLETED
                                 │                                        │
                                 │ DELETE /sales/{id}                     │ POST /sales/{id}/cancel
                                 ▼                                        ▼
                             (removed)                                CANCELLED
```

- **DRAFT** is a *held* cart. It is only persisted when the cashier parks a sale
  to serve someone else; the normal fast path is a single `POST /sales/checkout`
  that creates and completes in one transaction. Building the cart in client
  memory and sending it once is both fewer round-trips and fewer ways to leave
  orphaned rows.
- **Drafts do not reserve stock.** Reservation means expiry timers, a reservation
  table and release-on-crash handling, for a scenario (last unit contested
  between two parked carts) that a small store resolves by talking. Stock is
  checked and deducted at checkout, atomically. Documented, deliberate, revisit
  if a real store complains.
- **COMPLETED is terminal.** Money moved. It changes only via void or return.
- **CANCELLED** requires the shift to still be `OPEN` (BR-15) and a reason.

`return_status` (`NONE` / `PARTIAL` / `FULL`) is maintained on the sale in the
return transaction, derived from `SUM(returned_quantity) vs SUM(quantity)`. It is
denormalized purely so the sales list can filter without a subquery.

### 10.2 Product variants from day one

**Decision: `ProductVariant` exists in v1, and every product has at least one.**

Creating a simple product auto-creates one variant with `is_default = true`,
`name = NULL`, `attributes = {}`, inheriting the SKU. The UI never shows it; the
product form writes product fields and default-variant fields together.

The alternative — put SKU, barcode, prices and stock on `product`, add variants
later — means that when the first clothing store arrives, `inventory_level`,
`inventory_movement`, `sale_item`, `purchase_item`, `return_item`,
`stock_transfer_item` and `inventory_count_item` all change their foreign key,
with live data to migrate and every query to rewrite. That is a multi-week
migration bought for a few hours saved now.

Cost of doing it now: one table, one auto-create, one `is_default` flag.

`has_variants` on the product controls only presentation: `false` → the UI edits
the default variant inline; `true` → the variant editor appears.

### 10.3 Checkout — the calculation pipeline

Executed server-side, in this exact order. Ambiguity here is how POS systems end
up with receipts that do not add up.

```
 1  for each line:
       unit_price   ← variant.selling_price   (or override, permissioned)
       gross        ← roundHalfUp(unit_price × quantity)
 2  for each line:
       line_discount ← max(best item promotion, manual line discount)
       line_discount ← min(line_discount, gross)          -- never negative
 3  subtotal_before_order_discount ← Σ (gross − line_discount)
 4  order_discount ← best of { group %, order promotion, manual order discount }
       order_discount ← min(order_discount, subtotal_before_order_discount)
 5  allocate(order_discount, weights = each line's (gross − line_discount))
       → line.allocated_order_discount           -- sums EXACTLY (§8.4)
 6  for each line:
       net_amount ← gross − line_discount − allocated_order_discount
       unit_cost  ← inventory_level.avg_cost     -- snapshot for COGS
 7  subtotal_amount ← Σ net_amount
 8  tax_amount ← 0                               -- reserved; see §35
 9  total_before_rounding ← subtotal_amount + tax_amount
10  rounding_adjustment ← cash rounding, only if the tender is entirely cash (§8.5)
11  total_amount ← total_before_rounding + rounding_adjustment
12  loyalty redemption, if requested, becomes a PAYMENT of method LOYALTY —
       it is NOT a discount. (§18.5 explains why this matters.)
13  Σ payments + credit_amount must equal total_amount, exactly, or 422.
```

Note step 5's weights: the order discount is allocated over line values *after*
line discounts. Allocating over gross would over-discount lines that already had
a promotion.

### 10.4 The checkout transaction

```
BEGIN  (READ COMMITTED, statement_timeout 15s)
  ├─ idempotency: INSERT INTO idempotency_record ... ON CONFLICT → replay §26
  ├─ resolve shift: the caller's open shift for the register; 409 if none
  ├─ re-read every variant's price and current avg_cost         (never trust client)
  ├─ run the §10.3 pipeline
  ├─ credit check, if credit_amount > 0                         (§7.3)
  ├─ sale_number ← DocumentCounter UPDATE ... RETURNING
  ├─ INSERT sale + sale_item[]
  ├─ for each line, sorted by variant_id:                       (deadlock order)
  │      inventory.apply(SALE, −qty)                            → may 409
  ├─ INSERT payment[] + payment_allocation[]                    (§11.3)
  ├─ INSERT customer_receivable                                 if credit_amount > 0
  ├─ INSERT loyalty_transaction (EARN, and SPEND if redeemed)
  ├─ UPDATE sale SET status='COMPLETED', paid_amount, credit_amount, cost_amount
  ├─ INSERT audit_log
  └─ UPDATE idempotency_record SET status='COMPLETED', response_body = ...
COMMIT

-- after commit, outside the transaction:
   low-stock check → notification rows
   receipt rendering / print payload
   Telegram sale notification (if configured)
```

Nothing after `COMMIT` can fail the sale. A Telegram outage must never cost a
store a transaction.

### 10.5 Offline hooks in the sale model

Four columns and one header, nothing more (Appendix B):
`sale.client_id`, `sale.client_created_at`, `payment.client_id`, and the
`Idempotency-Key` header. Together they make a replayed offline sale safe to
submit, and they cost nothing today.

---

## 11. Payment model

### 11.1 Shape

```
Payment                       — money moved: how much, which method, which till
  └─ PaymentAllocation[]      — what that money settled
        ├─ sale_id            (paying for goods now)
        ├─ receivable_id      (paying off a debt later)
        └─ return_id          (refunding a return)
```

`direction` is `IN` (customer → store) or `OUT` (store → customer). `amount` is
always positive; the direction carries the sign. This keeps `SUM(amount)`
meaningful with a `WHERE direction = ...` instead of relying on every writer to
get a sign right.

### 11.2 Extensibility without a lookup table

`payment.method` is a PostgreSQL enum:
`CASH | CARD | CLICK | PAYME | UZUM | TRANSFER | LOYALTY | OTHER`.

Adding a provider costs one enum value plus, if it is an online provider, one
adapter implementing:

```ts
interface PaymentProvider {
  readonly method: PaymentMethod;
  charge(input: ChargeInput): Promise<ProviderResult>;    // returns providerRef
  refund(input: RefundInput): Promise<ProviderResult>;
  verifyWebhook(req: RawRequest): WebhookEvent;
}
```

Providers are registered in a `Map<PaymentMethod, PaymentProvider>`. `CASH`,
`CARD` (terminal-side) and `TRANSFER` have no adapter — they are recorded, not
executed. Nothing in the domain branches on the method except:
- cash-drawer expectation (`method === 'CASH'`),
- loyalty deduction (`method === 'LOYALTY'`),
- provider dispatch (only where an adapter exists).

Three narrow branches. A lookup table with a `is_cash` / `affects_drawer` /
`requires_provider` flag triple would add two joins to the hot path to express
exactly the same three branches.

`provider_ref` holds the external transaction id; `provider_meta JSONB` holds
whatever else the provider returned. No provider-specific column ever reaches the
core schema.

### 11.3 Mixed payment — the worked example

Sale total **450,000 UZS**: 200,000 cash, 150,000 card, 100,000 on credit.

```
sale
  id = S1,  total_amount = 450000,  paid_amount = 350000,  credit_amount = 100000

payment P1  direction=IN  method=CASH   amount=200000  shift=SH1
payment P2  direction=IN  method=CARD   amount=150000  shift=SH1  provider_ref='…'

payment_allocation  A1  payment=P1  sale=S1  amount=200000
payment_allocation  A2  payment=P2  sale=S1  amount=150000

customer_receivable R1
  sale_id=S1  customer=C1  origin=SALE
  original_amount=100000  paid_amount=0  remaining_amount=100000  (generated)
  issued_at=now()  due_date=now()+30d  status=OPEN
```

Checks the transaction enforces:
- `Σ allocation.amount (350,000) + credit_amount (100,000) = total_amount` (BR-2)
- each payment's allocations sum to its own `amount` (no money allocated twice)
- only `P1` counts toward the shift's expected cash

Later the customer pays 100,000 in cash:

```
payment P3  direction=IN  method=CASH  amount=100000  shift=SH7  customer=C1
payment_allocation  A3  payment=P3  receivable=R1  amount=100000

R1: paid_amount 0 → 100000, remaining_amount 100000 → 0 (generated), status=PAID
```

Same two tables. No debt-specific payment table, no duplicated cash-drawer logic:
`P3` lands in SH7's expected cash automatically because every cash payment does.

### 11.4 Over-tender (cash change)

The customer hands over 500,000 for a 450,000 sale. The payment recorded is
**450,000**, not 500,000. `change_due` is a display value computed by the client
from `tendered − total`; it is never stored, because no money moved. Storing
tendered-and-change would double-count the drawer.

### 11.5 Refunds

A refund is a `Payment` with `direction = OUT`, allocated to a `return_id`. Cash
refunds reduce the shift's expected cash. Card refunds through a provider adapter
carry the original `provider_ref` for the reversal. A refund against a sale that
still has an open receivable is offset against the debt first
(`return.credit_offset_amount`) before any cash leaves the drawer — refunding
cash to someone who still owes you money is a mistake the system should not make
on its own.

---

## 12. Customer debt / receivable model

### 12.1 The choice: receivable documents, not a running balance

Two candidate designs:

**(a) Customer account ledger** — one append-only `customer_ledger` of debits and
credits; balance is the running sum.
**(b) Receivable documents + allocations** — one `customer_receivable` per credit
sale; payments allocate against specific receivables.

**Chosen: (b).**

A pure ledger answers "how much do they owe?" and nothing else. It cannot answer
the questions this product's screens actually ask — *which* debt is overdue, what
its due date was, which sale it came from, how old it is — without inventing
document grouping on top of the ledger anyway. Aging reports, due-date reminders,
and per-invoice payment history all fall out of (b) for free.

(b) also composes with §11: a debt payment is just a `Payment` allocated to a
receivable. The ledger view is still available as a query over receivables and
allocations if the UI wants a chronological statement — but it is a projection,
not the storage.

There is **no `customer.debt` column.** Total exposure is
`SUM(remaining_amount) WHERE customer_id = ? AND status IN ('OPEN','PARTIALLY_PAID')`
— an index-only scan on `(organization_id, customer_id, status)`. If that ever
becomes slow, it becomes a materialized view. A denormalized mutable balance
column is the one thing it will never become, because a balance that can drift
from its history is worse than no balance at all.

### 12.2 The worked example from the brief

**Credit sale of 450,000, nothing paid:**
```
customer_receivable R1
  original_amount   450000
  paid_amount            0
  written_off_amount     0
  remaining_amount  450000   (GENERATED ALWAYS — cannot be written)
  status            OPEN
  issued_at         2026-09-17T10:00Z
  due_date          2026-10-17
  sale_id           S1
```

**Payment of 100,000:**
```
payment P2 (IN, CASH, 100000, shift SH3, customer C1)
payment_allocation (payment=P2, receivable=R1, amount=100000)

R1.paid_amount      0 → 100000
R1.remaining_amount      350000   (recomputed by PostgreSQL)
R1.status           OPEN → PARTIALLY_PAID
```

**Payment of 350,000:**
```
payment P3 (IN, CARD, 350000, shift SH9, customer C1)
payment_allocation (payment=P3, receivable=R1, amount=350000)

R1.paid_amount      100000 → 450000
R1.remaining_amount                0
R1.status           PARTIALLY_PAID → PAID
R1.closed_at        set
```

Full history survives: two `payment` rows, two `payment_allocation` rows, the
original receivable, and the sale it came from. Nothing was overwritten except
the running `paid_amount`, and even that is reconstructible by summing the
allocations — which the integration test does.

### 12.3 Status derivation

```
paid + written_off = 0                  → OPEN
0 < paid + written_off < original        → PARTIALLY_PAID
paid + written_off = original            → PAID       (closed_at set)
written_off > 0 and remaining = 0        → PAID or WRITTEN_OFF per which dominated
```

**`OVERDUE` is not a status.** It is `remaining_amount > 0 AND due_date < today`,
computed in the query. Making it a status would require a nightly job to flip
rows, and a row whose status is a lie until that job runs. The filters the UI
needs are:

| Filter | Predicate |
|---|---|
| `overdue` | `status IN ('OPEN','PARTIALLY_PAID') AND due_date < CURRENT_DATE` |
| `due_today` | `status IN (…) AND due_date = CURRENT_DATE` |
| `due_soon` | `status IN (…) AND due_date BETWEEN CURRENT_DATE+1 AND CURRENT_DATE+7` |
| `unpaid` | `status = 'OPEN'` |
| `partially_paid` | `status = 'PARTIALLY_PAID'` |
| `paid` | `status = 'PAID'` |

All served by `ix_receivable_due (organization_id, due_date) WHERE status IN ('OPEN','PARTIALLY_PAID')`.

### 12.4 The debt-payment transaction

```
BEGIN
  ├─ idempotency guard
  ├─ resolve open shift (if the payment is at a till)
  ├─ INSERT payment (IN, method, amount)
  ├─ allocate across receivables:
  │     explicit receivable_ids, or FIFO by due_date when unspecified
  │     for each target:
  │       UPDATE customer_receivable
  │          SET paid_amount = paid_amount + $part,
  │              status      = CASE WHEN paid_amount + $part + written_off_amount
  │                                      >= original_amount THEN 'PAID'
  │                                 ELSE 'PARTIALLY_PAID' END,
  │              closed_at   = CASE WHEN … THEN now() ELSE closed_at END
  │        WHERE id = $id
  │          AND paid_amount + written_off_amount + $part <= original_amount;
  │     rowCount = 0  →  409 RECEIVABLE_OVERPAYMENT    (BR-8)
  │     INSERT payment_allocation
  ├─ assert Σ allocated = payment.amount, else 422 ALLOCATION_MISMATCH
  ├─ INSERT audit_log ('debt.payment_recorded')
  └─ commit
after commit: notification to the customer's Telegram, if configured
```

The conditional `UPDATE` is doing the concurrency work: two cashiers collecting
against the same receivable at the same moment cannot together push it past
`original_amount`. One of them gets the 409.

### 12.5 Over-payment

Deliberately **rejected**, not absorbed. A payment larger than the outstanding
debt returns `409 RECEIVABLE_OVERPAYMENT` with the remaining amount in the
payload. Store credit — the other reasonable answer — needs a credit balance, a
redemption tender and an expiry policy, none of which are in the design. Adding
it later means a `customer_credit` table and one new `PaymentMethod`; it does not
disturb anything built here.

### 12.6 Write-off

`POST /debts/{id}/write-off` requires `debt.write_off` (owner/manager only),
demands a reason, increments `written_off_amount`, and always writes an audit
event. `remaining_amount` falls out automatically because it is generated. A
write-off is a real financial event and is reported separately from collections —
never netted into "paid".
---

## 13. Returns

### 13.1 Relationship chain

```
Sale ──► SaleItem ──┬──────────────────────────────────┐
                    │                                  │
                    │            SaleReturn ──► ReturnItem
                    │                 │            │
                    │                 │            ├──► InventoryMovement (RETURN, +qty)
                    │                 │            └──► sale_item.returned_quantity += qty
                    │                 │
                    │                 ├──► Payment (direction=OUT) ──► PaymentAllocation(return_id)
                    │                 └──► CustomerReceivable  (offset, if debt is open)
                    └──► sale.return_status ← NONE | PARTIAL | FULL
```

A return always references the original sale **and** the original sale line. A
"return without a receipt" is out of scope for the MVP — it is a different
business process (it needs a price source, a fraud policy and usually store
credit) and pretending it is the same flow produces a bad version of both.

### 13.2 Quantity guard

The rule: **returnable = `sale_item.quantity − sale_item.returned_quantity`.**

Enforced by a conditional `UPDATE`, in the same transaction as everything else:

```sql
UPDATE sale_item
   SET returned_quantity = returned_quantity + $qty,
       refunded_amount   = refunded_amount   + $refund
 WHERE id = $saleItemId
   AND returned_quantity + $qty <= quantity;
```

`rowCount = 0` → `409 RETURN_QUANTITY_EXCEEDED`, carrying the actual returnable
quantity so the client can correct itself. The `CHECK (returned_quantity <=
quantity)` constraint is the backstop if a future code path forgets the guard —
it turns a data-corruption bug into a failed transaction.

### 13.3 Refund amount — and the rounding trap

The refund for a partial return must reflect what the customer actually paid for
that unit, i.e. the line's **net** amount after both the line discount and the
allocated share of the order discount — not the list price.

```
unit_refund = roundHalfUp(sale_item.net_amount × return_qty, sale_item.quantity)
```

Rounding here drifts: three returns of 1 unit from a line of 3 at net 100,000
give 33,333 × 3 = 99,999, leaving 1 soʻm the customer never gets back.

**The fix:** on the return that closes the line
(`returned_quantity + qty == quantity`), the refund is the exact remainder:

```
unit_refund = sale_item.net_amount − sale_item.refunded_amount
```

So the last return sweeps up the residue and the line always reconciles to zero.
Same technique as §8.4, applied over time instead of across lines.

### 13.4 Restock

`return_item.restock` defaults to `true`; `condition` is `SELLABLE` or `DAMAGED`.

- `restock = true, SELLABLE` → `RETURN` movement, `+qty`, back into the
  return's `warehouse_id`.
- `restock = false` or `DAMAGED` → **no `RETURN` movement**. The goods never
  re-enter sellable stock. If they physically came back and are being scrapped,
  the operator records a separate `DAMAGE` movement, because "returned" and
  "written off" are different facts and merging them hides shrinkage.

### 13.5 Refund destination

Decided by the sale's payment state, in this order:

1. **Open receivable on the sale** → offset first, up to
   `receivable.remaining_amount`. The offset is recorded as a `Payment` with
   `direction = IN`, `method = OTHER`, `note = 'return offset'`, allocated to the
   receivable, and mirrored on the return as `credit_offset_amount`. No cash
   moves, but the allocation keeps the receivable's arithmetic honest (its
   `paid_amount` rises, `remaining_amount` falls, both through the same guarded
   `UPDATE` as any other collection) and the history stays readable. The
   receivable's `written_off_amount` is **not** touched — that column means bad
   debt, and a return is not bad debt.
2. **Remaining refund** → a `Payment` with `direction = OUT`, method chosen by
   the cashier from the methods the original sale used, allocated to the return.
3. Cash refunds require an open shift with sufficient expected cash; otherwise
   `409 INSUFFICIENT_CASH_IN_DRAWER`.

### 13.6 The return transaction

```
BEGIN
  ├─ idempotency guard
  ├─ load sale + sale_items, assert status = COMPLETED
  ├─ assert within return window, or permission sales.refund_expired
  ├─ return_number ← DocumentCounter
  ├─ INSERT sale_return
  ├─ per line, sorted by variant_id:
  │     conditional UPDATE sale_item  (§13.2)   → may 409
  │     compute refund                (§13.3)
  │     INSERT return_item
  │     if restockable: inventory.apply(RETURN, +qty)
  ├─ assert Σ refunds ≤ sale.total_amount − sale.refunded_amount   (BR-7)
  ├─ UPDATE sale SET refunded_amount += Σ, return_status = NONE|PARTIAL|FULL
  ├─ offset open receivable, if any   (§13.5 step 1)
  ├─ INSERT payment (OUT) + payment_allocation(return_id)
  ├─ reverse loyalty EARN proportionally (INSERT LoyaltyTransaction, negative)
  ├─ INSERT audit_log ('return.created')
  └─ commit
```

Idempotency is mandatory on this endpoint. A double-tapped refund button that
creates two refunds is the single most expensive bug a POS can ship.

---

## 14. Exchanges

### 14.1 Model: a composite, not a new document type

```
Exchange
  ├─ return_id            → SaleReturn (goods coming back)
  ├─ replacement_sale_id  → Sale       (goods going out)
  ├─ returned_value, replacement_value, net_amount
  └─ settlement           CUSTOMER_PAID | REFUNDED | EVEN | CREDITED_TO_DEBT
```

An exchange is a return and a sale that happen together. Modelling it as a third
kind of line-item document would duplicate the stock logic, the refund logic, the
loyalty logic and the debt logic — all of which the return and the sale already
implement, correctly and with their guards.

The `Exchange` row exists only to link the pair and record the settlement, so the
UI can present one event and reporting does not count the replacement sale as
organic revenue.

### 14.2 The four cases

`net_amount = replacement_value − returned_value`

| Case | Example | `net_amount` | Settlement |
|---|---|---|---|
| Higher price | return A 500,000 → take B 650,000 | +150,000 | `CUSTOMER_PAID` — a `Payment IN` for 150,000 allocated to the replacement sale |
| Equal price | return A 500,000 → take B 500,000 | 0 | `EVEN` — no payment rows at all |
| Lower price | return A 500,000 → take B 400,000 | −100,000 | `REFUNDED` — a `Payment OUT` for 100,000 allocated to the return |
| Customer owes | return A 500,000 → take B 650,000, customer on credit | +150,000 | `CREDITED_TO_DEBT` — a new `CustomerReceivable` for 150,000 |

The brief's worked example is row 1: returned 500,000, received 650,000, customer
pays 150,000.

### 14.3 Inventory effects

Both legs are ordinary movements, produced by the code that already exists:
- `RETURN` `+1` of variant A into the return's warehouse (if restockable),
- `SALE` `−1` of variant B out of the sale's warehouse, with its normal
  insufficient-stock guard.

If B is out of stock, the whole exchange fails and nothing is written. This is
the correct behaviour and it comes free from running both legs in one
transaction.

### 14.4 Payment effects — the net-settlement rule

The exchange records **only the net movement of money**, never a gross refund
followed by a gross payment. Recording 500,000 out and 650,000 in would:

- double-count the day's revenue,
- make the cash drawer expect 500,000 that never left it,
- and require the cashier to physically handle money they did not handle.

`returned_value` and `replacement_value` are stored on the exchange for
reporting, but the `payment` rows reflect the 150,000 that actually changed
hands.

### 14.5 Transaction

One transaction containing the full §13.6 return sequence and the full §10.4
checkout sequence, then the `Exchange` row, then the net settlement. Either the
customer walks out with the new item and the books balance, or nothing happened.

---

## 15. Purchases

### 15.1 Lifecycle

```
DRAFT              lines editable, no stock, no payable
  │ POST /purchases/{id}/order
  ▼
ORDERED            committed to the supplier; still no stock
  │ POST /purchases/{id}/receive   (partial or full, repeatable)
  ▼
PARTIALLY_RECEIVED  ──repeat──▶ RECEIVED
  │
  └─ CANCELLED      allowed from DRAFT or ORDERED only,
                    and only while every received_quantity = 0
```

### 15.2 Receiving

`POST /purchases/{id}/receive` takes the lines and quantities actually received.
It is repeatable — three deliveries against one order produce three receive calls
and three sets of movements.

Per line, in one transaction:

```sql
UPDATE purchase_item
   SET received_quantity = received_quantity + $qty
 WHERE id = $id
   AND received_quantity + $qty <= ordered_quantity;     -- BR-16
```
`rowCount = 0` → `409 OVER_RECEIPT`.

Then `inventory.apply(PURCHASE, +qty, unitCost)`, which also rolls the level's
moving average cost forward (§8.6).

Over-receipt is rejected rather than silently accepted. A delivery larger than
the order is a real event, but it is a *purchase amendment*, and treating it as
an automatic quantity bump is how phantom stock appears.

Purchase status after the loop:
`all received_quantity = ordered_quantity` → `RECEIVED`, else
`PARTIALLY_RECEIVED`.

### 15.3 Receiving is idempotent

`Idempotency-Key` is required. Receiving the same delivery twice — a
double-click, a retried request after a timeout — would add real stock that does
not exist. This is the second-most expensive duplicate in the system after a
double refund.

### 15.4 Why `SupplierPayment` is a separate table from `Payment`

They look symmetrical and are not:

| | `Payment` (customer) | `SupplierPayment` |
|---|---|---|
| Direction | dominated by `IN` | always out |
| Targets | sale, receivable, return — three, polymorphic | a purchase, or the supplier generally |
| Till | usually tied to a shift and the cash drawer | usually a bank transfer, often no shift |
| Permissions | `sales.create`, `debt.pay` (cashier) | `purchases.pay` (manager/owner) |
| Reporting | revenue, cash flow in | payables, cash flow out |
| Volume | hundreds per day | a handful per week |

Unifying them would mean a `direction` plus a target discriminator plus a
permission branch plus a reporting branch — four conditionals to avoid one small
table. The "party ledger" generalization is the classic accounting-system trap;
two clear tables read better and change independently.

### 15.5 Purchase costing

`purchase_item.unit_cost` is the supplier's unit price.
`shipping_amount` and `discount_amount` sit at the purchase header and are **not**
allocated into unit costs in the MVP — landed cost is a real feature but it needs
an allocation basis (by value, by weight, by quantity) that nobody has specified.
Flagged in §35. When it arrives, `allocate()` from §8.4 does the work and only
the receiving code changes.

---

## 16. Supplier balances

### 16.1 Derived, never stored

A supplier's payable is:

```sql
SELECT COALESCE(SUM(p.remaining_amount), 0) AS payable
  FROM purchase p
 WHERE p.organization_id = $org
   AND p.supplier_id     = $supplier
   AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
   AND p.remaining_amount > 0;
```

`purchase.remaining_amount` is `GENERATED ALWAYS AS (total_amount - paid_amount)`,
so it cannot drift. Index:
`(organization_id, status, remaining_amount) WHERE remaining_amount > 0`.

Same reasoning as customer debt (§12.1): a mutable `supplier.balance` column is a
number that can silently disagree with its own history.

### 16.2 Payments against a purchase, or on account

`supplier_payment.purchase_id` is nullable:

- **Set** — a payment against a specific invoice. Increments that purchase's
  `paid_amount` under the guard `paid_amount + $amount <= total_amount`;
  `rowCount = 0` → `409 SUPPLIER_OVERPAYMENT`.
- **Null** — a payment on account. It reduces the supplier's total payable but is
  not attached to an invoice. The supplier statement (§16.3) shows it as
  unapplied, and a manager can apply it later via
  `POST /suppliers/{id}/payments/{paymentId}/apply`.

Partial payment is the normal case: pay 3,000,000 against a 5,000,000 purchase,
`remaining_amount` becomes 2,000,000, status unchanged (payment state is separate
from receipt state — a purchase can be `RECEIVED` and unpaid, or paid and
unreceived).

### 16.3 Supplier statement

`GET /api/v1/suppliers/{id}/statement?from=&to=` returns a chronological merge of
purchases (debits) and payments (credits) with a running balance, computed in one
SQL `UNION ALL` ordered by date. It is a read model, built on demand, cached for
60 seconds. No table backs it.

---

## 17. Loyalty

### 17.1 Ledger, with a cached balance

```
LoyaltyAccount          1:1 with Customer
  points_balance        CACHE — convenient, never authoritative
  lifetime_earned
     │
     └── LoyaltyTransaction[]     APPEND-ONLY — the truth
            type          EARN | SPEND | ADJUSTMENT | EXPIRY
            points_delta  signed, never zero
            balance_after running balance snapshot
            sale_id / return_id / reason
```

`points_balance` exists so the POS can show a balance in one read. It is written
only inside the same transaction as the `LoyaltyTransaction` that changes it, and
a nightly reconciliation asserts
`points_balance = SUM(points_delta)` (BR-10) — the same
projection-plus-ledger pattern as inventory, for the same reason.

### 17.2 Points and money

Two settings decide everything:

- `loyalty_earn_percent` — percent of the sale's `subtotal_amount` earned as
  points, e.g. `1.00`.
- `loyalty_point_value` — how many money minor units one point redeems for, e.g.
  `1` (1 point = 1 soʻm).

```
earn   = roundHalfUp(sale.subtotal_amount × earn_percent, 10000)   // percent is 2dp
redeem = points × loyalty_point_value
```

Points are earned on `subtotal_amount` — the net of discounts — not on
`total_amount`, so cash rounding does not leak into loyalty, and not on the gross,
so a discounted sale does not also generate full points.

### 17.3 Redemption is a payment, not a discount

Redeeming points creates a `Payment` with `method = LOYALTY` allocated to the
sale, plus a `LoyaltyTransaction` of type `SPEND`. It does **not** reduce
`subtotal_amount`.

This matters: a discount reduces revenue; a redemption is revenue settled with a
liability the store already recognized when the points were earned. Treating
redemption as a discount understates revenue, corrupts margin, and makes the
outstanding points liability invisible. The distinction costs nothing to
implement correctly now and is painful to unpick later.

### 17.4 Earning, returns and expiry

- **Earn** fires at checkout completion, inside the transaction.
- **Return** reverses points proportionally: a `LoyaltyTransaction` with a
  negative delta equal to the earn attributable to the returned value. If that
  drives the balance below zero, it is clamped to zero and the shortfall is
  recorded in `reason` — clawing back points a customer already spent is a
  policy decision, not a default.
- **ADJUSTMENT** is a manual correction requiring `loyalty.adjust` and a reason.
- **EXPIRY** — the `expires_at` column exists and nothing writes it in the MVP.
  Expiry needs a policy (rolling window? calendar year? per-transaction FIFO?)
  that has not been specified. When it arrives, it is a cron job inserting
  `EXPIRY` rows. The column is there so the ledger does not need migrating.

---

## 18. Discounts

### 18.1 Two levels, one rule each

| Level | Stored on | Set by |
|---|---|---|
| Item | `sale_item.line_discount_amount` | manual line discount, or an `ITEM`-scope promotion |
| Order | `sale.order_discount_amount`, allocated to `sale_item.allocated_order_discount` | manual order discount, customer-group percent, or an `ORDER`-scope promotion |

Both are stored as **money amounts**, never as percentages. A percentage is an
input; the resolved amount is the fact. Storing the percent means every read
recomputes, and the recomputation drifts the moment a rounding rule changes.

### 18.2 Calculation order — normative

This is the order in §10.3, restated because it is the part of the system most
likely to be got wrong:

```
1.  gross      = roundHalfUp(unit_price × quantity)                 per line
2.  line_disc  = max(best ITEM promotion, manual line discount)     per line
                 capped at gross
3.  subtotal₀  = Σ (gross − line_disc)
4.  order_disc = best of { group %, ORDER promotion, manual order } single winner
                 capped at subtotal₀
5.  allocate(order_disc, weights = gross − line_disc)  → per-line share  [§8.4]
6.  net        = gross − line_disc − allocated_order_discount        per line
7.  subtotal   = Σ net
8.  tax        = 0                                     (reserved)
9.  rounding   = cash rounding on the total, cash tenders only       [§8.5]
10. total      = subtotal + tax + rounding
11. loyalty redemption applies HERE, as a payment — not as a discount [§17.3]
```

Two things this order guarantees: an order discount can never make a line
negative, and the per-line shares always sum exactly to the order discount, so a
later partial return refunds the right amount.

### 18.3 Promotions do not stack

At each level, exactly one discount wins: the largest. Resolution is
`priority DESC, computed_value DESC`, and a manual discount beats a promotion
only if it is larger.

Stacking requires a combinability matrix, an application order, and a policy for
what "20% off plus 10,000 off" means when applied in the other order. None of
that is specified, and inventing it produces a system where the cashier cannot
predict the price. Non-stacking is explicit, testable and reversible.

### 18.4 Permissions and audit

| Action | Permission | Audit event |
|---|---|---|
| Line discount | `sales.discount_item` | `sale.discount_applied` (line, amount, reason) |
| Order discount | `sales.discount_order` | `sale.discount_applied` (order, amount, reason) |
| Price override | `sales.override_price` | `sale.price_overridden` (old, new) |

An organization-level ceiling (`max_discount_percent`) on what a cashier may
grant without escalation is a natural next step; it is not in the MVP because no
screen specifies it. Flagged in §35.

### 18.5 What is not a discount

Deliberately excluded from the discount pipeline, and why:

- **Loyalty redemption** — a tender, not a price reduction (§17.3).
- **Cash rounding** — an adjustment on the total, tracked in its own column so
  it can be reported separately.
- **Returns** — a reversal, not a negative discount.
- **Exchange net settlement** — a payment difference.

Each of these would, if folded into the discount amount, quietly corrupt the
revenue and margin numbers the reports exist to produce.

---

## 19. Cash register

### 19.1 Model

```
CashRegister                      the physical till, belongs to a Store
  └── CashRegisterShift           one OPEN at a time, enforced by a partial unique index
        ├── Sale[]                sales rung on this shift
        ├── Payment[]             every tender taken on this shift, all methods
        └── CashMovement[]        manual drawer movements: DROP, PAYOUT, EXPENSE, CORRECTION
```

`UNIQUE (cash_register_id) WHERE status = 'OPEN'` — two cashiers cannot open the
same till, and the database says so, not a service method with a race in it.

### 19.2 What affects the drawer

| Event | Cash drawer | Recorded in the shift |
|---|---|---|
| Cash sale payment | **+** | yes |
| Card / Click / Payme / transfer payment | no effect | yes — needed for the Z-report |
| Cash refund (`Payment OUT`, `CASH`) | **−** | yes |
| Card refund | no effect | yes |
| Cash debt collection | **+** | yes |
| Cash supplier payment from the till | **−** | yes (`supplier_payment.shift_id`) |
| Cash drop to safe (`CashMovement OUT / DROP`) | **−** | yes |
| Petty cash expense (`CashMovement OUT / EXPENSE`) | **−** | yes |
| Cash added to float (`CashMovement IN`) | **+** | yes |
| Credit sale (no tender) | no effect | yes, as a sale |
| Loyalty redemption | no effect | yes, as a `LOYALTY` payment |

### 19.3 Expected cash

```
expected_cash =
      opening_amount
    + Σ payment.amount        WHERE shift AND method='CASH' AND direction='IN'  AND status='COMPLETED'
    − Σ payment.amount        WHERE shift AND method='CASH' AND direction='OUT' AND status='COMPLETED'
    + Σ cash_movement.amount  WHERE shift AND direction='IN'
    − Σ cash_movement.amount  WHERE shift AND direction='OUT'
    − Σ supplier_payment.amount WHERE shift AND method='CASH'
```

One index serves the dominant term: `payment (cash_register_shift_id, method)`.

`difference = counted_cash_amount − expected_cash_amount`. Negative is short,
positive is over. Both are stored; neither is silently corrected.

### 19.4 Closing a shift

```
BEGIN
  ├─ SELECT … FROM cash_register_shift WHERE id = $id FOR UPDATE
  ├─ assert status = 'OPEN', else 409 SHIFT_ALREADY_CLOSED
  ├─ assert no DRAFT sales remain on this shift, else 409 OPEN_DRAFTS_EXIST
  ├─ compute expected_cash (§19.3)
  ├─ UPDATE … SET counted_cash_amount, expected_cash_amount, difference_amount,
  │              closed_by, closed_at, status='CLOSED'
  ├─ INSERT audit_log ('shift.closed', metadata: the full breakdown)
  └─ commit
after commit: if |difference| > threshold → CRITICAL notification to the manager
```

`FOR UPDATE` is used here rather than a conditional `UPDATE` because the close
must read a large aggregate and write a consistent snapshot of it; the row lock
holds for the few milliseconds that takes. Shift closes are rare — this is the
one place where a pessimistic lock is the simpler answer.

### 19.5 The Z-report

Returned by `GET /cash-register/shifts/{id}/report` and rendered at close:
opening float; sales count and gross; per-method tender totals; refunds by
method; cash in / cash out with reasons; debt collected; expected, counted and
difference; the cashier and the time range. Every number is a query over the
shift's payments and sales — nothing is precomputed, because a shift's data is
small and a stale report is worse than a slow one.

---

## 20. Roles and permissions

### 20.1 Model

```
Role   { code, name, permissions: TEXT[], is_system, permission_version }
             ▲
             │
StoreMembership { user_id, store_id, role_id }
```

A user's authority is **per store**. The same person can be `MANAGER` at one
store and `CASHIER` at another. `OWNER` is org-wide and implicitly a member of
every store.

There is no `Permission` table (§2.2). Permission strings are a TypeScript
`const` object, which means a typo in a guard is a compile error rather than a
silently-always-false check at runtime:

```ts
export const PERMISSIONS = {
  products:  ['read', 'create', 'update', 'delete', 'import'],
  inventory: ['read', 'adjust', 'count', 'transfer'],
  sales:     ['read', 'create', 'cancel', 'refund', 'refund_expired',
              'discount_item', 'discount_order', 'override_price', 'hold'],
  customers: ['read', 'create', 'update', 'delete'],
  debt:      ['read', 'create', 'pay', 'write_off'],
  purchases: ['read', 'create', 'receive', 'pay', 'cancel'],
  suppliers: ['read', 'create', 'update'],
  cash:      ['read', 'open_shift', 'close_shift', 'movement'],
  loyalty:   ['read', 'adjust'],
  promotions:['read', 'manage'],
  reports:   ['read', 'export'],
  employees: ['read', 'manage'],
  roles:     ['read', 'manage'],
  settings:  ['read', 'manage'],
  audit:     ['read'],
} as const;
// → 'products.read' | 'products.create' | … as a derived union type
```

### 20.2 Seeded system roles

| Role | Permissions |
|---|---|
| `OWNER` | `*` — cannot be edited or deleted |
| `MANAGER` | everything except `roles.manage`, `settings.manage`, `employees.manage` for owners |
| `CASHIER` | `sales.read/create/hold`, `sales.discount_item`, `products.read`, `inventory.read`, `customers.read/create`, `debt.read/create/pay`, `cash.open_shift/close_shift`, `loyalty.read` |
| `WAREHOUSE` | `products.read`, `inventory.*`, `purchases.read/receive`, `suppliers.read` |
| `SALES` | `sales.read/create`, `products.read`, `inventory.read`, `customers.*` |

System roles are seeded per organization and are editable except `OWNER`. Custom
roles are ordinary rows.

### 20.3 Evaluation

```ts
@RequirePermissions('sales.refund')
@Post(':id/returns')
createReturn(...) {}
```

`PermissionsGuard`:

1. Reads the required permissions from the handler metadata (AND semantics —
   all must hold).
2. Resolves the caller's permission set: in-process LRU keyed by
   `roleId:permission_version`; miss → one query on `role`.
3. Matches, supporting a trailing wildcard:
   `has('sales.refund')` is true if the set contains `sales.refund`, `sales.*`
   or `*`.
4. Denies with `403 FORBIDDEN` and the missing permission in the payload (the
   permission name is not a secret, and hiding it just makes support harder).

**Cache invalidation:** editing a role bumps `permission_version`, which changes
the cache key — no eviction protocol, no stale grant. The JWT carries `pv` so a
token minted against an old permission set is rejected on the next request,
bounding privilege lag to zero rather than to the token lifetime.

Role names are never checked anywhere. `if (user.role === 'MANAGER')` is banned
by review: it makes custom roles unusable and hides authorization logic from the
one place that is audited.

### 20.4 Layered authorization

Permission is necessary, not sufficient. Three checks compose:

1. **Permission** — may this role do this kind of thing?
2. **Tenant scope** — is the row in the caller's organization? (automatic, §4.3)
3. **Store scope** — is the row in a store the caller is a member of? (explicit,
   per service)

A manager with `sales.read` still cannot read another store's sales.

---

## 21. Audit logging

### 21.1 Explicit, not automatic

Auditing is an explicit `auditService.record(tx, {...})` call inside the
business transaction — not a global interceptor.

An interceptor that logs every mutating request produces a table full of
`PATCH /products/x` entries with a before/after blob, which is a change log, not
an audit trail. It cannot express "discount applied" (an event inside a larger
request) and it cannot omit the noise. Explicit calls at the ~25 points that
matter give a readable trail, and being inside the transaction means the audit
row and the change it describes commit together.

### 21.2 Record shape

```
audit_log
  organization_id, store_id
  actor_user_id        NULL = system (cron, webhook)
  action               'sale.cancelled'   — noun.verb, past tense, always
  entity_type          'sale'
  entity_id
  metadata JSONB       the minimum needed to understand the event later
  ip, user_agent, request_id
  created_at
```

`request_id` ties an audit row to the structured log lines of the same request,
which is what makes an incident reconstructable.

### 21.3 Audited events

| Domain | Actions |
|---|---|
| Sales | `sale.completed` (money only, not the full basket), `sale.cancelled`, `sale.discount_applied`, `sale.price_overridden` |
| Returns | `return.created`, `return.expired_window_override` |
| Inventory | `inventory.adjusted`, `inventory.written_off`, `inventory.count_finalized` (with shrinkage value), `inventory.transfer_sent/received`, `inventory.negative_stock` |
| Catalog | `product.created`, `product.price_changed` (old → new), `product.archived` |
| Debt | `debt.created`, `debt.payment_recorded`, `debt.written_off` |
| Purchases | `purchase.received`, `purchase.cancelled`, `supplier.payment_recorded` |
| Cash | `shift.opened`, `shift.closed` (with the full breakdown), `cash.movement_recorded` |
| Loyalty | `loyalty.adjusted` |
| Identity | `user.created`, `user.deactivated`, `user.role_changed`, `role.permissions_changed`, `auth.login_failed`, `auth.password_changed` |
| Settings | `settings.changed` (old → new per field) |

### 21.4 What never enters the audit log

Password hashes, tokens, refresh tokens, full card numbers, provider secrets, API
keys, and any `provider_meta` field not on an explicit allow-list. The
`record()` helper takes an explicit metadata object — there is no "log the whole
DTO" convenience, because that convenience is how secrets end up in a table that
nobody can delete from.

### 21.5 Immutability and growth

`UPDATE` and `DELETE` are blocked by trigger (§6.2). Reading requires
`audit.read`. The table is `BIGSERIAL`-keyed and every index is prefixed by
`(organization_id, created_at)`, so range-partitioning by month is a migration,
not a redesign, when volume calls for it.
---

## 22. API specification

### 22.1 Conventions

| | |
|---|---|
| Base | `/api/v1` — the version is in the path, not a header |
| Auth | `Authorization: Bearer <access token>`, except `/auth/login`, `/auth/refresh`, `/health` |
| Content | `application/json`; `multipart/form-data` for image upload only |
| Casing | `camelCase` in JSON, `snake_case` in the database |
| IDs | UUID strings |
| Money | JSON **integer**, minor units (§8.3) |
| Quantity | JSON **string** decimal (`"1.500"`) — quantities are not money and must not lose precision to float |
| Dates | ISO-8601 with offset (`2026-09-17T10:00:00+05:00`); date-only fields are `YYYY-MM-DD` |
| Mutation safety | `Idempotency-Key: <uuid>` required on the endpoints marked **I** |
| Tenancy | never in the path or body — always from the token (§4.3) |
| Docs | Swagger at `/api/docs`, generated from the DTOs, disabled in production unless `SWAGGER_ENABLED=true` |

### 22.2 Resource map

`Auth` column: 🔓 public, 🔒 authenticated. `Perm` is the required permission.
**I** = requires an idempotency key.

#### auth
| Method | Path | Purpose | Auth | Perm |
|---|---|---|---|---|
| POST | `/auth/login` | email + password → token pair | 🔓 | — |
| POST | `/auth/refresh` | rotate refresh token → new pair | 🔓 | — |
| POST | `/auth/logout` | revoke the refresh-token family | 🔒 | — |
| GET | `/auth/me` | profile, active store, permission list | 🔒 | — |
| POST | `/auth/switch-store` | re-mint the token for another store | 🔒 | — |
| POST | `/auth/change-password` | rotate password, revoke all sessions | 🔒 | — |

#### organizations, stores, settings
| Method | Path | Purpose | Perm |
|---|---|---|---|
| GET | `/organizations/current` | the caller's org | — |
| PATCH | `/organizations/current` | rename, status | `settings.manage` |
| GET | `/settings` | currency, exponent, rounding, policies | `settings.read` |
| PATCH | `/settings` | update settings (optimistic, `version`) | `settings.manage` |
| GET/POST | `/stores` | list / create | `settings.manage` |
| GET/PATCH/DELETE | `/stores/{id}` | read / update / archive | `settings.manage` |
| GET/POST | `/warehouses` | list / create | `inventory.read` / `settings.manage` |
| GET/PATCH/DELETE | `/warehouses/{id}` | read / update / archive | `settings.manage` |

#### catalog
| Method | Path | Purpose | Perm |
|---|---|---|---|
| GET | `/products` | search, filter, paginate | `products.read` |
| POST | `/products` | create (auto-creates the default variant) | `products.create` |
| GET/PATCH | `/products/{id}` | read / update | `products.read` / `products.update` |
| DELETE | `/products/{id}` | archive | `products.delete` |
| GET/POST | `/products/{id}/variants` | list / add a variant | `products.read` / `products.update` |
| PATCH/DELETE | `/variants/{id}` | update / archive a variant | `products.update` |
| **GET** | **`/variants/lookup?barcode=`** | **POS scan — one indexed read** | `products.read` |
| POST | `/products/import` | CSV bulk import (dry-run supported) | `products.import` |
| GET/POST | `/categories` | tree / create | `products.read` / `products.create` |
| GET/PATCH/DELETE | `/categories/{id}` | read / update / archive | … |

#### inventory
| Method | Path | Purpose | Perm | |
|---|---|---|---|---|
| GET | `/inventory` | levels by warehouse, with filters | `inventory.read` | |
| GET | `/inventory/low-stock` | `quantity <= min_stock` | `inventory.read` | |
| GET | `/inventory/movements` | the stock card (keyset paginated) | `inventory.read` | |
| POST | `/inventory/adjustments` | manual ± with a reason | `inventory.adjust` | **I** |
| POST | `/inventory/write-offs` | damage / write-off | `inventory.adjust` | **I** |
| GET | `/inventory/reconciliation` | ledger vs level mismatches (should be empty) | `inventory.read` | |

#### inventory counts
| Method | Path | Purpose | Perm | |
|---|---|---|---|---|
| GET/POST | `/inventory-counts` | list / open a count | `inventory.count` | |
| GET | `/inventory-counts/{id}` | header + lines | `inventory.read` | |
| POST | `/inventory-counts/{id}/items` | add / update counted quantities (bulk) | `inventory.count` | |
| POST | `/inventory-counts/{id}/finalize` | apply corrections | `inventory.count` | **I** |
| POST | `/inventory-counts/{id}/cancel` | discard | `inventory.count` | |

#### transfers
| Method | Path | Purpose | Perm | |
|---|---|---|---|---|
| GET/POST | `/transfers` | list / create draft | `inventory.transfer` | |
| GET/PATCH | `/transfers/{id}` | read / edit draft | `inventory.transfer` | |
| POST | `/transfers/{id}/send` | apply `TRANSFER_OUT` | `inventory.transfer` | **I** |
| POST | `/transfers/{id}/receive` | apply `TRANSFER_IN` | `inventory.transfer` | **I** |
| POST | `/transfers/{id}/cancel` | cancel | `inventory.transfer` | |

#### suppliers & purchases
| Method | Path | Purpose | Perm | |
|---|---|---|---|---|
| GET/POST | `/suppliers` | list / create | `suppliers.read` / `suppliers.create` | |
| GET/PATCH/DELETE | `/suppliers/{id}` | read / update / archive | … | |
| GET | `/suppliers/{id}/balance` | derived payable | `purchases.read` | |
| GET | `/suppliers/{id}/statement` | chronological ledger view | `purchases.read` | |
| GET/POST | `/purchases` | list / create draft | `purchases.read` / `purchases.create` | |
| GET/PATCH | `/purchases/{id}` | read / edit draft | … | |
| POST | `/purchases/{id}/order` | DRAFT → ORDERED | `purchases.create` | |
| POST | `/purchases/{id}/receive` | receive lines, move stock | `purchases.receive` | **I** |
| POST | `/purchases/{id}/cancel` | cancel | `purchases.cancel` | |
| GET/POST | `/purchases/{id}/payments` | history / pay supplier | `purchases.pay` | **I** |

#### customers, debt, loyalty
| Method | Path | Purpose | Perm | |
|---|---|---|---|---|
| GET/POST | `/customers` | search / create | `customers.read` / `customers.create` | |
| GET/PATCH/DELETE | `/customers/{id}` | read / update / archive | … | |
| GET | `/customers/{id}/summary` | totals, debt, points, last purchase | `customers.read` | |
| GET | `/customers/{id}/sales` | purchase history | `sales.read` | |
| GET/POST | `/customer-groups` | list / create | `customers.read` | |
| GET | `/debts` | receivables: filters `overdue`/`due_today`/`due_soon`/`unpaid`/… | `debt.read` | |
| GET | `/debts/{id}` | receivable + allocation history | `debt.read` | |
| POST | `/debts` | manual debt / opening balance | `debt.create` | **I** |
| POST | `/debts/{id}/payments` | record a debt payment | `debt.pay` | **I** |
| POST | `/debts/payments` | pay across receivables (FIFO by due date) | `debt.pay` | **I** |
| POST | `/debts/{id}/write-off` | write off, reason required | `debt.write_off` | |
| GET | `/debts/summary` | totals by aging bucket | `debt.read` | |
| GET | `/loyalty/{customerId}` | balance + ledger | `loyalty.read` | |
| POST | `/loyalty/{customerId}/adjust` | manual adjustment | `loyalty.adjust` | **I** |

#### sales, returns, exchanges, payments
| Method | Path | Purpose | Perm | |
|---|---|---|---|---|
| GET | `/sales` | list with filters | `sales.read` | |
| POST | `/sales` | create a held DRAFT | `sales.hold` | |
| GET/PATCH/DELETE | `/sales/{id}` | read / edit draft / discard draft | … | |
| **POST** | **`/sales/checkout`** | **create + complete in one transaction** | `sales.create` | **I** |
| POST | `/sales/{id}/checkout` | complete an existing draft | `sales.create` | **I** |
| POST | `/sales/{id}/cancel` | void, reason required | `sales.cancel` | **I** |
| GET | `/sales/{id}/receipt` | receipt payload for printing | `sales.read` | |
| GET/POST | `/returns` | list / create a return | `sales.read` / `sales.refund` | **I** |
| GET | `/returns/{id}` | read | `sales.read` | |
| GET | `/sales/{id}/returnable` | per-line returnable quantities and amounts | `sales.refund` | |
| POST | `/exchanges` | return + replacement sale + settlement | `sales.refund` | **I** |
| GET | `/exchanges/{id}` | read | `sales.read` | |
| GET | `/payments` | list with filters | `sales.read` | |
| GET | `/payments/{id}` | payment + allocations | `sales.read` | |

#### cash register
| Method | Path | Purpose | Perm | |
|---|---|---|---|---|
| GET/POST | `/cash-registers` | list / create | `cash.read` / `settings.manage` | |
| GET | `/cash-register/shifts/current` | the caller's open shift | `cash.read` | |
| POST | `/cash-register/shifts` | open a shift | `cash.open_shift` | **I** |
| POST | `/cash-register/shifts/{id}/close` | close, with counted cash | `cash.close_shift` | **I** |
| GET | `/cash-register/shifts/{id}/report` | Z-report | `cash.read` | |
| POST | `/cash-register/shifts/{id}/movements` | cash in / out | `cash.movement` | **I** |

#### employees, roles, promotions, reports, platform
| Method | Path | Purpose | Perm |
|---|---|---|---|
| GET/POST | `/employees` | list / invite a user + membership | `employees.manage` |
| GET/PATCH | `/employees/{id}` | read / update, incl. role | `employees.manage` |
| POST | `/employees/{id}/deactivate` | deactivate, revoke sessions | `employees.manage` |
| GET/POST | `/roles` | list / create | `roles.read` / `roles.manage` |
| GET/PATCH/DELETE | `/roles/{id}` | read / update / delete (non-system) | `roles.manage` |
| GET | `/permissions` | the permission catalogue (static) | `roles.read` |
| GET/POST | `/promotions` | list / create | `promotions.read` / `promotions.manage` |
| GET/PATCH/DELETE | `/promotions/{id}` | read / update / deactivate | `promotions.manage` |
| GET | `/reports/sales-summary` | revenue, count, average check, by period | `reports.read` |
| GET | `/reports/top-products` | by revenue / quantity / margin | `reports.read` |
| GET | `/reports/inventory-valuation` | stock value at average cost | `reports.read` |
| GET | `/reports/debt-aging` | buckets: current, 1-30, 31-60, 60+ | `reports.read` |
| GET | `/reports/cash-register` | shifts, differences | `reports.read` |
| GET | `/reports/returns` | rate, reasons, by product | `reports.read` |
| GET | `/reports/{name}/export` | CSV/XLSX (async job over a row threshold) | `reports.export` |
| GET | `/notifications` | the caller's feed | — |
| POST | `/notifications/{id}/read`, `/notifications/read-all` | mark read | — |
| GET/PUT | `/integrations/telegram` | read / configure the bot binding | `settings.manage` |
| POST | `/integrations/telegram/test` | send a test message | `settings.manage` |
| GET | `/audit` | audit log, keyset paginated, filterable | `audit.read` |
| GET | `/health`, `/health/ready` | liveness / readiness | 🔓 |

### 22.3 Critical endpoints in detail

---

#### `POST /api/v1/sales/checkout` — **the most important endpoint in the system**

**Purpose** Create and complete a sale in one atomic operation: reserve nothing,
deduct stock, take payment, optionally create debt, earn loyalty.
**Auth** 🔒 **Perm** `sales.create` (plus `sales.discount_*`, `sales.override_price`,
`debt.create` conditionally) **Idempotency** required.

**Request**
```jsonc
{
  "clientId": "0192f3c1-…",          // optional, offline hook; unique per org
  "clientCreatedAt": "2026-09-17T10:00:00+05:00",
  "customerId": "…",                 // null = walk-in
  "warehouseId": "…",                // defaults to the store's default warehouse
  "items": [
    { "variantId": "…", "quantity": "2.000",
      "unitPriceOverride": 45000,    // ignored without sales.override_price
      "discountAmount": 5000,        // line discount, needs sales.discount_item
      "discountReason": "chipped" }
  ],
  "orderDiscountAmount": 10000,      // needs sales.discount_order
  "orderDiscountReason": "regular customer",
  "loyaltyPointsToRedeem": 5000,     // becomes a LOYALTY payment, not a discount
  "payments": [
    { "method": "CASH", "amount": 200000 },
    { "method": "CARD", "amount": 150000, "providerRef": "…" }
  ],
  "creditAmount": 100000,            // needs debt.create + a customerId
  "dueDate": "2026-10-17",           // defaults to today + default_debt_term_days
  "note": "…"
}
```
Note what is absent: no `subtotal`, no `total`, no `unitPrice` (except the
permissioned override). The server computes them; the client cannot disagree.

**Response `201`**
```jsonc
{
  "id": "…", "saleNumber": "S-0001-000123", "status": "COMPLETED",
  "subtotalAmount": 450000, "orderDiscountAmount": 10000,
  "roundingAdjustment": 0, "totalAmount": 450000,
  "paidAmount": 350000, "creditAmount": 100000,
  "items": [ { "id": "…", "variantId": "…", "name": "Artel choynak 1.7L",
               "quantity": "2.000", "unitPrice": 45000, "grossAmount": 90000,
               "lineDiscountAmount": 5000, "allocatedOrderDiscount": 2000,
               "netAmount": 83000 } ],
  "payments": [ { "id": "…", "method": "CASH", "amount": 200000 } ],
  "receivable": { "id": "…", "originalAmount": 100000, "dueDate": "2026-10-17" },
  "loyalty": { "earned": 4500, "redeemed": 5000, "balance": 12300 },
  "completedAt": "2026-09-17T10:00:03+05:00"
}
```

**Validation** at least one item; `quantity > 0`; every variant active and in the
caller's org; `Σ payments + creditAmount == computed total` (the one place the
client's arithmetic is checked, so a mismatch is caught rather than silently
absorbed); `creditAmount > 0` requires a customer; `dueDate >= today`.

**Errors** `400 VALIDATION_FAILED` · `401` · `403 FORBIDDEN` ·
`409 INSUFFICIENT_STOCK` (with `available` per variant) ·
`409 NO_OPEN_SHIFT` · `409 CREDIT_LIMIT_EXCEEDED` · `409 CUSTOMER_BLOCKED_OVERDUE` ·
`409 IDEMPOTENCY_KEY_REUSED` (same key, different body) ·
`422 PAYMENT_TOTAL_MISMATCH` · `422 INSUFFICIENT_LOYALTY_POINTS` · `500`

---

#### `POST /api/v1/returns`

**Perm** `sales.refund` (+ `sales.refund_expired` outside the window) **I**

**Request**
```jsonc
{
  "saleId": "…",
  "reason": "DEFECTIVE",
  "reasonNote": "handle cracked",
  "warehouseId": "…",
  "items": [ { "saleItemId": "…", "quantity": "1.000",
               "restock": true, "condition": "SELLABLE" } ],
  "refundMethod": "CASH",
  "offsetDebtFirst": true
}
```

**Response `201`** the return with per-item `refundAmount`, the total
`refundAmount`, `creditOffsetAmount`, the refund `payment`, the sale's new
`returnStatus` and `refundedAmount`, and the loyalty reversal.

**Errors** `404 SALE_NOT_FOUND` · `409 SALE_NOT_COMPLETED` ·
`409 RETURN_QUANTITY_EXCEEDED` (with `returnable` per line) ·
`409 RETURN_WINDOW_EXPIRED` · `409 INSUFFICIENT_CASH_IN_DRAWER` ·
`409 NO_OPEN_SHIFT` · `422 REFUND_EXCEEDS_SALE_TOTAL`

---

#### `POST /api/v1/debts/{id}/payments`

**Perm** `debt.pay` **I**

**Request** `{ "amount": 100000, "method": "CASH", "note": "…", "paidAt": "…" }`
**Response `201`** the payment, its allocation, and the receivable's new
`paidAmount`, `remainingAmount` and `status`.
**Errors** `404 RECEIVABLE_NOT_FOUND` · `409 RECEIVABLE_ALREADY_PAID` ·
`409 RECEIVABLE_OVERPAYMENT` (with `remaining`) · `409 NO_OPEN_SHIFT` (cash only)

`POST /api/v1/debts/payments` takes `{ customerId, amount, method, receivableIds? }`
and spreads the amount across receivables — explicit list if given, otherwise
FIFO by `due_date`. The response lists every allocation made.

---

#### `POST /api/v1/purchases/{id}/receive`

**Perm** `purchases.receive` **I**

**Request**
```jsonc
{ "items": [ { "purchaseItemId": "…", "receivedQuantity": "10.000",
               "unitCost": 32000 } ],
  "supplierInvoiceNumber": "INV-2026-441",
  "receivedAt": "2026-09-17T09:00:00+05:00" }
```
`unitCost` may differ from the ordered cost — suppliers change prices between
order and delivery. The received cost is what updates the moving average.

**Response `200`** the purchase with updated per-line `receivedQuantity`, the new
status, and the movements created.
**Errors** `409 OVER_RECEIPT` (with `remaining` per line) ·
`409 PURCHASE_NOT_RECEIVABLE` (wrong status) · `409 IDEMPOTENCY_KEY_REUSED`

---

#### `POST /api/v1/inventory-counts/{id}/finalize`

**Perm** `inventory.count` **I**

**Request** `{ "note": "Q3 stocktake" }`
**Response `200`** `{ id, status: "FINALIZED", correctedLines, totalShrinkageQuantity, totalShrinkageValue, movements[] }`
**Errors** `409 COUNT_ALREADY_FINALIZED` · `409 COUNT_HAS_NO_COUNTED_ITEMS` ·
`403` without permission

Recall §9.5: corrections are computed against the level's **current** quantity,
not the snapshot.

---

#### `POST /api/v1/cash-register/shifts/{id}/close`

**Perm** `cash.close_shift` **I**

**Request** `{ "countedCashAmount": 1250000, "note": "…" }`
**Response `200`** the shift with `expectedCashAmount`, `countedCashAmount`,
`differenceAmount`, plus the full Z-report breakdown.
**Errors** `409 SHIFT_ALREADY_CLOSED` · `409 OPEN_DRAFTS_EXIST` ·
`403 NOT_SHIFT_OWNER` (a cashier may close only their own shift; a manager may
close any)

---

#### `GET /api/v1/variants/lookup?barcode=4780010101010`

**Perm** `products.read`. The POS scan path, held to a single index hit on
`(organization_id, barcode)`. Returns the variant, its product, its price, and
the current level for the caller's default warehouse.
`404 VARIANT_NOT_FOUND` when unknown — the POS then offers "create product".

---

#### `POST /api/v1/auth/login`

**Request** `{ "email": "…", "password": "…" }`
**Response `200`**
```jsonc
{ "accessToken": "…", "expiresIn": 900,
  "refreshToken": "…",                     // opaque, 30d, rotating
  "user": { "id": "…", "fullName": "…", "email": "…" },
  "organization": { "id": "…", "name": "…", "currencyCode": "UZS",
                    "currencyExponent": 0 },
  "activeStore": { "id": "…", "name": "…" },
  "stores": [ … ],
  "permissions": [ "sales.create", … ] }
```
**Errors** `401 INVALID_CREDENTIALS` (identical response for a wrong email and a
wrong password — no account enumeration) · `403 USER_DEACTIVATED` ·
`429 TOO_MANY_ATTEMPTS`

---

## 23. Error model

### 23.1 Success

No envelope. A single resource returns the resource; the HTTP status carries the
outcome. Wrapping everything in `{ success: true, data: … }` adds a level of
nesting to every client access path in exchange for information the status code
already carries.

Lists return exactly one wrapper, because pagination metadata has nowhere else to
live:

```jsonc
{ "data": [ … ],
  "page": { "limit": 50, "offset": 0, "total": 1234, "hasMore": true } }
```
Keyset-paginated lists replace `offset`/`total` with `"nextCursor": "…"`.

| Status | When |
|---|---|
| 200 | read, or a successful mutation returning the updated resource |
| 201 | resource created (`Location` header set) |
| 204 | delete / archive with nothing to return |

### 23.2 Errors

RFC 9457-shaped, with a machine-readable `code` that clients branch on:

```jsonc
{
  "type": "https://docs.retailos.uz/errors/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "code": "INSUFFICIENT_STOCK",
  "detail": "Requested quantity exceeds available stock for 1 item.",
  "traceId": "0192f3c1-8a4e-7c3d-b1e2-5f6a7b8c9d0e",
  "timestamp": "2026-09-17T10:00:00+05:00",
  "errors": [
    { "field": "items[0].quantity", "code": "INSUFFICIENT_STOCK",
      "message": "Only 3 available", "meta": { "variantId": "…", "available": "3.000" } }
  ]
}
```

`code` is stable and is the contract. `title` and `detail` are for humans and may
be reworded or localized without breaking a client.

### 23.3 The catalogue

| Status | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | DTO validation; `errors[]` is per field |
| 400 | `MALFORMED_REQUEST` | unparseable body |
| 401 | `INVALID_CREDENTIALS` | login failed (deliberately ambiguous) |
| 401 | `TOKEN_EXPIRED` | access token expired — refresh |
| 401 | `TOKEN_INVALID` | bad signature / malformed / revoked |
| 403 | `FORBIDDEN` | missing permission; `meta.required` names it |
| 403 | `STORE_ACCESS_DENIED` | no membership in the target store |
| 403 | `USER_DEACTIVATED` | account disabled |
| 404 | `RESOURCE_NOT_FOUND` | generic; `meta.resource` names the type |
| 404 | `SALE_NOT_FOUND`, `VARIANT_NOT_FOUND`, `RECEIVABLE_NOT_FOUND` | specific, where the client reacts differently |
| 409 | `INSUFFICIENT_STOCK` | oversell prevented |
| 409 | `NO_OPEN_SHIFT` | a till operation without an open shift |
| 409 | `SHIFT_ALREADY_CLOSED` | double close |
| 409 | `RETURN_QUANTITY_EXCEEDED` | BR-6 |
| 409 | `RETURN_WINDOW_EXPIRED` | outside the window, no override permission |
| 409 | `RECEIVABLE_OVERPAYMENT` | BR-8 |
| 409 | `CREDIT_LIMIT_EXCEEDED` | §7.3 |
| 409 | `CUSTOMER_BLOCKED_OVERDUE` | §7.3 |
| 409 | `OVER_RECEIPT` | BR-16 |
| 409 | `COUNT_ALREADY_FINALIZED` | double finalize |
| 409 | `DUPLICATE_RESOURCE` | unique constraint — `meta.field` names it |
| 409 | `IDEMPOTENCY_KEY_REUSED` | same key, different payload |
| 409 | `CONCURRENT_MODIFICATION` | optimistic `version` mismatch |
| 422 | `PAYMENT_TOTAL_MISMATCH` | BR-2 |
| 422 | `REFUND_EXCEEDS_SALE_TOTAL` | BR-7 |
| 422 | `ALLOCATION_MISMATCH` | allocations ≠ payment amount |
| 422 | `INSUFFICIENT_LOYALTY_POINTS` | redemption over balance |
| 429 | `RATE_LIMIT_EXCEEDED` | `Retry-After` header set |
| 500 | `INTERNAL_ERROR` | `traceId` only — nothing else |
| 503 | `SERVICE_UNAVAILABLE` | database or a dependency down |

### 23.4 Leakage control

One global `AllExceptionsFilter`:

- `BusinessRuleException` (the app's own type, carrying `code`, `status`, `meta`)
  → rendered as-is. This is the only path that produces a 4xx body with detail.
- `class-validator` errors → `400 VALIDATION_FAILED` with a field list.
- Prisma errors → mapped: `P2002` → `409 DUPLICATE_RESOURCE` with the constraint
  translated to a field name, `P2025` → `404`, `P2003` → `409`. **The Prisma
  message is never forwarded** — it contains table and column names.
- Anything else → logged at `error` with the full stack and the `traceId`, and
  returned as `500 INTERNAL_ERROR` carrying *only* `traceId`. No message, no
  stack, no SQL, in any environment. The developer reads the log; the client
  reads the trace id.

Idempotent by design: the same `traceId` appears in the response, in the
structured log, and in the audit row.

---

## 24. Transaction boundaries

Every operation below runs in a single `prisma.$transaction(fn, { isolationLevel:
'ReadCommitted', timeout: 15_000, maxWait: 5_000 })`. The rule that makes them
safe is **no external I/O inside a transaction** — no HTTP calls, no Telegram, no
receipt rendering, no file writes. Those happen after commit, and their failure
cannot roll back a sale.

| # | Operation | Commits together | Rolls back together |
|---|---|---|---|
| 1 | **Sale checkout** | idempotency record · `sale` · `sale_item[]` · `inventory_level` updates · `inventory_movement[]` · `payment[]` · `payment_allocation[]` · `customer_receivable` · `loyalty_transaction` · `loyalty_account` · `document_counter` · `audit_log` | any insufficient stock, any credit-limit failure, any payment mismatch → **no sale, no stock change, no money** |
| 2 | **Debt sale** (checkout with `creditAmount > 0`) | as #1, plus the receivable | a credit-limit breach after stock was already deducted rolls the stock back too |
| 3 | **Debt payment** | `payment` · `payment_allocation[]` · guarded `customer_receivable` update(s) · `audit_log` | an over-payment on the second of three receivables reverses the first two |
| 4 | **Return** | `sale_return` · `return_item[]` · guarded `sale_item` updates · `inventory_level`/`movement` · `sale` totals and `return_status` · refund `payment` + allocation · receivable offset · loyalty reversal · `audit_log` | a quantity-guard failure on line 3 reverses the restock of lines 1–2 |
| 5 | **Exchange** | the whole of #4 **and** the whole of #1, plus the `exchange` row and the net settlement | replacement item out of stock → the return does not happen either |
| 6 | **Purchase receiving** | guarded `purchase_item` updates · `inventory_level` + `avg_cost` · `inventory_movement[]` · `purchase` status · `audit_log` | an over-receipt on one line reverses the stock added by the others |
| 7 | **Inventory adjustment / write-off** | `inventory_level` · `inventory_movement` · `audit_log` | — (single unit of work, but the movement and the level must never diverge) |
| 8 | **Inventory count finalization** | every `COUNT_CORRECTION` movement · every level update · `inventory_count` status · `audit_log` | a failure on item 400 of 500 leaves the count re-runnable, with no partial corrections |
| 9 | **Stock transfer send / receive** | guarded item updates · movements at one warehouse · transfer status · `audit_log` | — |
| 10 | **Cash register close** | shift row lock · computed expected/counted/difference · status · `audit_log` | — |
| 11 | **Mixed payment settlement** | not a separate transaction: it is inside #1, which is the point. Cash, card and credit either all land or none do | partial tender is impossible by construction |
| 12 | **Sale void** | reversal movements · payment voids · receivable deletion · sale status · `audit_log` | — |
| 13 | **Role permission change** | `role` update · `permission_version` bump · `audit_log` | — |

**Not transactional, deliberately:** notification creation and delivery, receipt
rendering, report generation, Telegram calls, the reconciliation job, and the
idempotency purge. Each is retryable and none can corrupt state.

---

## 25. Concurrency strategy

### 25.1 The scenario that drives the design

Two cashiers, one unit left, both scan it at the same millisecond. Exactly one
sale must succeed.

The naive implementation reads the stock, checks it in JavaScript, then writes.
Under `READ COMMITTED` both reads see 1, both checks pass, both write, and stock
is −1. This is not rare in a two-till store; it is a Tuesday.

### 25.2 Conditional atomic UPDATE — the default

```sql
UPDATE inventory_level
   SET quantity = quantity - $qty
 WHERE warehouse_id = $w AND product_variant_id = $v
   AND quantity >= $qty
RETURNING quantity;
```

PostgreSQL takes a row lock for the `UPDATE`. The second transaction blocks,
then **re-evaluates the `WHERE` against the newly committed row** (the
`READ COMMITTED` EvalPlanQual recheck) and matches zero rows. `rowCount === 0`
→ `409 INSUFFICIENT_STOCK`.

No explicit lock, no retry loop, no elevated isolation level, no window between
check and write. This is the same pattern used for:

| Guard | Condition |
|---|---|
| Stock | `quantity >= $qty` |
| Return quantity | `returned_quantity + $qty <= quantity` |
| Debt over-payment | `paid_amount + written_off_amount + $amt <= original_amount` |
| Purchase over-receipt | `received_quantity + $qty <= ordered_quantity` |
| Supplier over-payment | `paid_amount + $amt <= total_amount` |
| Promotion usage cap | `used_count < max_uses` |

Six invariants, one mechanism. Every one of them also has a `CHECK` constraint
behind it, so a future code path that forgets the guard fails the transaction
instead of corrupting data.

### 25.3 Deadlock avoidance

A sale with lines A and B and a concurrent sale with lines B and A would deadlock
if each locked in its own order. Every multi-line operation therefore **sorts by
`product_variant_id` before applying**. One `.sort()` per loop, and the class of
bug disappears.

PostgreSQL still detects any deadlock we missed and aborts one side with
`40P01`; a tiny wrapper retries such a transaction once, then surfaces `409`.

### 25.4 Pessimistic locking — used exactly once

Shift closing (§19.4) takes `SELECT … FOR UPDATE` on the shift row, because it
must read a large aggregate and write a consistent snapshot of it. Shift closes
are rare and short. Everywhere else, pessimistic locking is avoided.

### 25.5 Optimistic concurrency — for human edits

`version INTEGER` on `product`, `product_variant`, `organization_settings`,
`role`, `promotion`:

```sql
UPDATE product SET …, version = version + 1
 WHERE id = $id AND version = $expectedVersion;
```
`rowCount = 0` → `409 CONCURRENT_MODIFICATION`. This exists so that two managers
editing the same product in two tabs do not silently overwrite each other. It is
not used on transactional documents, which are append-only or status-driven.

### 25.6 Document numbering

```sql
UPDATE document_counter
   SET next_value = next_value + 1
 WHERE organization_id=$o AND store_id=$s AND document_type=$t AND period_key=$p
RETURNING next_value - 1;
```

Row-locked, so numbers are gapless and unique — which matters for receipts and
for anything a tax authority might read. The cost is that concurrent checkouts at
one store serialize on this row for the remainder of the transaction.

At a small store (a few sales per minute) this is free. **The ceiling is roughly
50–100 checkouts per second per store**, and the upgrade path is a PostgreSQL
sequence per store with gaps tolerated, or number assignment moved to the end of
the transaction to shorten the lock window. Marked in the code with a
`ponytail:` comment naming both.

### 25.7 What is not protected, and why that is fine

Two managers editing two different products; two cashiers selling two different
items; a report reading while a sale writes (readers never block writers in
PostgreSQL MVCC). None of these need coordination, and adding it would cost
throughput for nothing.

---

## 26. Idempotency strategy

### 26.1 Which operations need it

Anything that moves money or stock and could plausibly be submitted twice — a
double-tapped button, a client retry after a timeout, an offline POS replaying
its queue:

| Operation | Cost of a duplicate |
|---|---|
| Sale checkout | double charge, double stock deduction |
| Return / refund | **money leaves twice** |
| Debt payment | customer credited twice, drawer short |
| Purchase receiving | phantom stock |
| Inventory adjustment / write-off | corrupted stock |
| Count finalization | corrections applied twice |
| Transfer send / receive | stock created or destroyed |
| Shift open / close | duplicate shift, falsified Z-report |
| Supplier payment | double payment |
| Loyalty adjustment | inflated balance |

Reads, list endpoints and master-data CRUD do not need it. `PUT`/`PATCH` on a
master record is naturally idempotent; a duplicate `POST /products` creates a
duplicate product, which is annoying, not dangerous, and is caught by the SKU
unique index.

### 26.2 Mechanism

`Idempotency-Key: <uuid v4>` header, required on the marked endpoints; missing →
`400 IDEMPOTENCY_KEY_REQUIRED`.

```
1  hash = sha256(method + path + canonical(body))
2  INSERT INTO idempotency_record (organization_id, key, endpoint, request_hash,
                                   status, expires_at)
   VALUES (…, 'IN_PROGRESS', now() + 24h)
   ON CONFLICT (organization_id, key) DO NOTHING
3  inserted?
     yes → run the handler
            success → UPDATE … SET status='COMPLETED',
                          response_status, response_body, resource_id
            failure → DELETE the record (a failed attempt must be retryable
                      with the same key)
     no  → load the existing record
            request_hash ≠ hash   → 409 IDEMPOTENCY_KEY_REUSED
            status = 'IN_PROGRESS'→ 409 REQUEST_IN_PROGRESS  (client retries)
            status = 'COMPLETED'  → replay the stored response verbatim,
                                     with `Idempotency-Replayed: true`
```

Implemented as an `IdempotencyInterceptor` activated by an
`@Idempotent()` decorator. The record is written in the **same transaction** as
the business work, so "the sale committed but the idempotency record did not" is
impossible.

### 26.3 Retention

24 hours, enough to cover any realistic client retry including an offline device
reconnecting the next morning. A daily cron deletes expired rows. `response_body`
is stored as JSONB; responses over 64 KB store only `resource_id` and the replay
re-reads the resource.

### 26.4 Second-layer protection

Idempotency keys are a client-cooperation mechanism: a client that generates a
fresh key per retry defeats them. So the money paths also carry natural keys:

- `payment.client_id` — unique per org
- `sale.client_id` — unique per org
- `customer_receivable.sale_id` — unique, so one sale cannot spawn two debts
- `exchange.return_id` / `exchange.replacement_sale_id` — both unique

These are database constraints, not conventions, and they hold even when the
client misbehaves.

---

## 27. Search, pagination, filtering

### 27.1 One query DTO

```ts
class ListQueryDto {
  q?: string;                          // free-text search, per-resource fields
  limit  = 50;                         // @Max(100) — hard ceiling, no exceptions
  offset = 0;                          // @Max(100_000) — deeper than this: use a cursor
  cursor?: string;                     // keyset; mutually exclusive with offset
  sort?: string;                       // 'createdAt:desc,name:asc'; whitelisted per resource
  dateFrom?: string;                   // ISO date, inclusive
  dateTo?: string;                     // ISO date, inclusive
  // plus per-resource filters declared by extending this class
}
```

**No endpoint returns an unbounded set.** `limit` defaults to 50 and is capped at
100 by a validator, not by convention. A request for `limit=10000` gets 100, not
an error — clients that paginate correctly are unaffected, and clients that do
not cannot take the database down.

Sort fields are whitelisted per resource against an indexed set. An arbitrary
`sort=<column>` is how a sequential scan on a million-row table reaches
production.

### 27.2 Offset by default, keyset where it matters

| Resource | Strategy | Why |
|---|---|---|
| products, customers, suppliers, categories, roles, promotions | offset | small, and the UI wants page numbers |
| sales, returns, purchases, payments, debts | offset, with a date range required beyond 30 days | bounded by the date filter in practice |
| `inventory/movements`, `audit`, `loyalty` ledger | **keyset** | append-only, unbounded, and always read newest-first |

Keyset cursor: base64 of `{ createdAt, id }`, applied as
`WHERE (created_at, id) < ($ts, $id) ORDER BY created_at DESC, id DESC`, which
matches the index exactly. The response carries `nextCursor` instead of `total` —
counting an append-only table is both expensive and pointless.

Offset pagination returns `total` from a `COUNT(*)` over the same predicate.
Above ~100k matching rows the count is replaced by an estimate from
`pg_class.reltuples` and flagged `"totalIsEstimate": true`.

### 27.3 Search per resource

| Resource | `q` matches | Index |
|---|---|---|
| products | name (full-text), SKU prefix, exact barcode | GIN tsvector + trigram + `(org, barcode)` |
| customers | name, phone | trigram on both |
| suppliers | name | trigram |
| sales | `saleNumber`, customer name | `text_pattern_ops` + join |
| purchases | `purchaseNumber`, supplier name | same |

The POS product search hits a dedicated path: exact barcode first (one index
read, returns immediately), then SKU prefix, then full-text on name — ordered
cheapest-first, so the common case never touches the expensive query.

### 27.4 Filters by resource

| Resource | Filters |
|---|---|
| products | `categoryId`, `status`, `supplierId`, `hasVariants`, `lowStock`, `warehouseId` |
| inventory | `warehouseId`, `categoryId`, `belowMinStock`, `zeroStock`, `negativeStock` |
| sales | `storeId`, `cashierId`, `customerId`, `status`, `returnStatus`, `paymentMethod`, `minTotal`, `maxTotal`, `shiftId` |
| debts | `customerId`, `status`, `overdue`, `dueToday`, `dueSoon`, `minRemaining` |
| purchases | `supplierId`, `status`, `unpaidOnly`, `warehouseId` |
| movements | `variantId`, `warehouseId`, `type`, `sourceType` |
| audit | `actorUserId`, `action`, `entityType`, `entityId` |

Date ranges default to the last 30 days on high-volume resources when the client
sends none — an unfiltered "all sales ever" request is a mistake, and defaulting
is friendlier than rejecting it.

### 27.5 Response

```jsonc
{ "data": [ … ],
  "page": { "limit": 50, "offset": 0, "total": 1234, "hasMore": true } }
```
Keyset variant: `{ "limit": 50, "nextCursor": "eyJ…", "hasMore": true }`.
---

## 28. Reporting strategy

### 28.1 PostgreSQL only

No ClickHouse, no warehouse, no ETL. A small store produces a few hundred sales a
day — tens of thousands a year. PostgreSQL answers every question in this
section in milliseconds against the indexes that already exist for the
transactional paths.

The rule that keeps it that way: **reports are raw SQL, not the ORM.** A
`reports/` module using `prisma.$queryRaw` with hand-written, reviewed,
`EXPLAIN`-checked SQL. Prisma's query builder is excellent for row access and
poor at analytical SQL, and a report is the one place where seeing the query
matters more than type inference over the result.

Reads are physically separated from writes at the code level so that pointing
reports at a read replica later is a connection-string change, not a refactor:

```ts
// src/reports/reports.repository.ts
constructor(@InjectReadDb() private readonly db: PrismaClient) {}
// MVP: the same client. Phase 2: a replica. Nothing above this line changes.
```

### 28.2 Metrics

| Report | Definition | Source |
|---|---|---|
| Revenue | `Σ sale.total_amount WHERE status='COMPLETED'` minus `Σ return.refund_amount` in the period | `sale`, `sale_return` |
| Sales count | completed sales in the period | `sale` |
| Average check | revenue ÷ sales count | derived |
| Gross margin | `Σ (sale.subtotal_amount − sale.cost_amount)` less returns | `sale` |
| Top products | by revenue, quantity or margin | `sale_item` grouped by variant |
| Customer debt | `Σ receivable.remaining_amount`, bucketed by aging | `customer_receivable` |
| Debt aging | current / 1–30 / 31–60 / 60+ days past `due_date` | `customer_receivable` |
| Inventory valuation | `Σ level.quantity × level.avg_cost` per warehouse | `inventory_level` |
| Stock movement | ins and outs by type over a period | `inventory_movement` |
| Cash register | per shift: expected, counted, difference; sums per method | `cash_register_shift`, `payment` |
| Returns | rate (returns ÷ sales), reasons, worst products | `sale_return`, `return_item` |
| Employee performance | sales count and value per cashier | `sale` grouped by `created_by` |
| Supplier spend | purchases and payments per supplier | `purchase`, `supplier_payment` |

Every report is scoped by organization (automatic) and store (explicit), and
every one takes a required date range.

### 28.3 The one pre-aggregation

`mv_daily_sales_summary`, a materialized view keyed by
`(organization_id, store_id, business_date)` holding sales count, gross, discount,
refunds, cost, margin and per-method tender totals.

It exists for one reason: the dashboard's 12-month trend chart, which otherwise
scans a year of `sale` on every load. Refreshed nightly with
`REFRESH MATERIALIZED VIEW CONCURRENTLY`, plus on demand after a shift close.
Today's figures come from the live tables and are unioned on top, so the
dashboard is never stale.

One materialized view, one justification. Everything else is a live query.

### 28.4 Exports

CSV and XLSX. Under 5,000 rows: streamed synchronously. Over 5,000: a row is
written to a small `export_job` table, the cron worker generates the file, and
the user is notified with a download link — the same after-commit worker pattern
as notifications, no new infrastructure.

### 28.5 Business date

Reports group by **business date**, not UTC date: the shift's date in the store's
timezone (`Asia/Tashkent`). A sale at 00:30 belongs to the shift that opened the
previous evening. Computed as
`(completed_at AT TIME ZONE store.timezone)::date`, with the shift's opening date
taking precedence when the sale belongs to a shift. Getting this wrong makes
every daily number disagree with the cashier's own count, which destroys trust in
the reports faster than any bug.

---

## 29. Security architecture

### 29.1 Passwords

**Argon2id** via `@node-rs/argon2` — memory 19 MiB, iterations 2, parallelism 1
(OWASP's current baseline). Not bcrypt: bcrypt silently truncates at 72 bytes and
has no memory hardness.

Policy: minimum 10 characters, checked against a small list of the most common
passwords, no composition rules (they produce `Password1!` and nothing else).
Changing a password bumps `user.token_version`, which invalidates every existing
access token, and revokes every refresh-token family.

### 29.2 Tokens

| | Access | Refresh |
|---|---|---|
| Format | JWT, HS256 (single service; RS256 when a second service needs to verify) | opaque 256-bit random, **SHA-256 hashed at rest** |
| Lifetime | 15 minutes | 30 days |
| Storage | client memory; never `localStorage` | `httpOnly`, `Secure`, `SameSite=Strict` cookie for web; secure storage for mobile |
| Revocation | via `token_version` + `permission_version` claims, bounded by the 15-minute lifetime | immediate — delete the row |

**Rotation with reuse detection:** every refresh issues a new token and marks the
old one `revoked_at` with `replaced_by_id`. Presenting an already-revoked token
means it was stolen, so the whole `family_id` is revoked at once and an audit
event is written. This is the standard mitigation and it costs two columns.

The access token is verified on every request; `token_version` and
`permission_version` are compared against the cached role/user record, so a
deactivated user or a changed role takes effect on the next request rather than
in fifteen minutes.

### 29.3 Guard chain

Registered globally, in order:

```
ThrottlerGuard      → rate limits
JwtAuthGuard        → signature, expiry, tv/pv — skipped by @Public()
TenantGuard         → builds TenantContext into AsyncLocalStorage
PermissionsGuard    → @RequirePermissions(...)
StoreScopeGuard     → @StoreScoped() — membership in the target store
```

Everything is protected by default; `@Public()` is the explicit, greppable
exception. The inverse (opt-in protection) leaves an unguarded endpoint one
forgotten decorator away.

### 29.4 Tenant isolation

Three layers, detailed in §4.3: org never accepted from the client · request-scoped
`TenantContext` from the verified token · Prisma client extension injecting
`organizationId` and rejecting bare-id lookups on tenant models. PostgreSQL RLS
is the phase-2 fourth layer (§4.6).

The isolation test suite (§31.4) is the thing that keeps this honest: it creates
two organizations with identical-looking data and asserts, for every endpoint,
that org A's token cannot read, update or delete anything of org B's — 404, never
403, so the existence of another tenant's row is not even confirmed.

### 29.5 Rate limiting

`@nestjs/throttler`, in-memory in the MVP (§1.4), keyed per route group:

| Scope | Limit |
|---|---|
| `POST /auth/login` | 5 per 15 min **per email + IP**, then exponential backoff |
| `POST /auth/refresh` | 30 per hour per user |
| Write endpoints | 120 per minute per user |
| Read endpoints | 600 per minute per user |
| Reports and exports | 20 per minute per user |

Login attempts are also counted in `audit_log` (`auth.login_failed`), so a
distributed attempt is visible even when no single IP crosses a threshold.

### 29.6 Input validation

Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`,
`transform: true`. Unknown fields are a `400`, not silently dropped — an
unexpected field means the client and server disagree about the contract, and
failing loudly finds that in development.

Additionally: `class-validator` on every DTO; money fields validated as
non-negative integers within range; quantities as decimal strings matching
`/^\d{1,11}(\.\d{1,3})?$/`; a 1 MB body limit (10 MB on image upload); UUID
format validated on every path parameter before it reaches a query.

SQL injection: Prisma parameterizes everything, and the raw SQL in `reports/`
uses tagged-template `$queryRaw` exclusively. `$queryRawUnsafe` is banned by lint
rule, not by convention.

### 29.7 Transport and headers

`helmet` with HSTS (1 year, `includeSubDomains`, `preload`), `X-Content-Type-Options`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a CSP that matters
only for the Swagger page.

CORS: an explicit origin allow-list from `CORS_ORIGINS`, `credentials: true`.
Never `origin: '*'`, and never `origin: true` (which reflects any origin and is
`*` with extra steps).

TLS terminates at the reverse proxy; the app refuses to start in production
without `TRUST_PROXY` set, so client IPs in the audit log are real.

### 29.8 Secrets

Environment variables, validated at boot by a Zod schema — the app **fails to
start** on a missing or malformed secret rather than discovering it at 3 a.m.
`JWT_SECRET` must be at least 32 bytes and must not equal the development
default; that check is a startup assertion, not a code review item.

Never committed, never logged, never in an audit row, never in an error response.
Docker secrets or the platform's secret manager in production; `.env` locally,
with `.env.example` committed as documentation.

Rotation: `JWT_SECRET` supports a previous value (`JWT_SECRET_PREVIOUS`) for
verification only, so rotation does not log everybody out.

### 29.9 Sensitive data

RetailOS stores no card data — card payments are recorded as a method plus a
provider reference, so PCI scope is nil, and it must stay that way. Customer PII
(name, phone, address) is ordinary data with access gated by `customers.read`.

Logging redaction is a deny-list applied by the logger serializer:
`password`, `passwordHash`, `token`, `accessToken`, `refreshToken`,
`authorization`, `cookie`, `providerMeta`, `idempotency-key`. The audit log takes
explicitly constructed metadata only (§21.4).

---

## 30. NestJS module structure

```
src/
  main.ts                     bootstrap, global pipes/filters/interceptors, BigInt serializer
  app.module.ts

  common/                     no business logic, imported by everything
    decorators/               @Public, @RequirePermissions, @StoreScoped, @Idempotent, @CurrentUser
    guards/                   jwt-auth, tenant, permissions, store-scope
    interceptors/             request-id, logging, idempotency, transform
    filters/                  all-exceptions
    exceptions/               BusinessRuleException + the §23.3 code catalogue
    dto/                      ListQueryDto, PageMeta, ErrorResponse
    money/                    money.ts — Money type, roundHalfUp, priceTimesQty, percentOf, allocate
    pagination/               offset + keyset helpers
    utils/                    business-date, document-number, decimal helpers

  config/                     env schema (Zod), typed config objects, validate-on-boot

  database/
    prisma.service.ts         lifecycle, $extends tenant injection, transaction helper
    prisma.module.ts          global
    seeds/                    system roles, permissions, demo org

  auth/                       login, refresh, rotation, switch-store, password
  organizations/              org + settings
  stores/                     stores + warehouses
  employees/                  users, memberships, invitations
  roles/                      roles; permission catalogue (static)

  catalog/                    ← products, variants, categories together
    products/                 product + variant services; barcode lookup
    categories/
  inventory/                  ← the whole stock domain
    levels/                   read model, low-stock
    movements/                InventoryService.apply — THE single write path
    counts/
    transfers/
  customers/                  customers, groups
  loyalty/                    accounts, ledger
  suppliers/
  purchases/                  purchases, receiving, supplier payments
  sales/                      ← the selling domain
    sales/                    checkout, drafts, void, receipt payload
    returns/
    exchanges/
    pricing/                  the §10.3 calculation pipeline — pure, no I/O
  payments/                   payments, allocations, provider adapters
  debts/                      receivables, collection, write-off
  cash-register/              registers, shifts, movements, Z-report
  promotions/
  reports/                    raw SQL read models, exports
  notifications/              feed, outbox poller, telegram adapter
  audit/                      AuditService.record
  health/                     liveness, readiness, db check
```

### 30.1 Why these groupings differ from the brief's example

- **`catalog/`** holds products and categories together. A category exists only
  to organize products; splitting them into peer modules creates a circular
  import on day two.
- **`sales/`** holds sales, returns and exchanges, because an exchange *is* a
  return plus a sale (§14) and a return mutates a sale's lines. Three peer
  modules would mean three-way cross-service calls for one transaction.
- **`inventory/`** holds levels, movements, counts and transfers. All four mutate
  the same two tables through the same `apply()` method; separating them would
  put four modules inside one transaction boundary.
- **`payments/` is separate from `sales/`** because debt collection, supplier
  payments and refunds all use it. It has no dependency on sales.
- **No `discounts/` module.** Discounts are a calculation, not a domain — they
  live in `sales/pricing/` beside the rest of the checkout arithmetic.
- **`pricing/` is pure.** No database, no HTTP: it takes resolved inputs and
  returns amounts. That is what makes the calculation order in §18.2 testable
  without a database, which is why it will actually be tested.

### 30.2 Module boundary rules (enforced by review and by a lint rule)

1. A module exposes a **service**, never its repository or its Prisma models.
2. Cross-module access goes through the exported service interface. No module
   reads another module's tables directly. The single exception is `reports/`,
   which reads everything by design and writes nothing.
3. `common/` depends on nothing. Feature modules depend on `common/` and
   `database/`. Circular module imports are a build failure.
4. Transactions are owned by the **initiating** module. `SalesService.checkout`
   opens the transaction and passes `tx` down into `InventoryService.apply`,
   `PaymentsService.record` and `AuditService.record`. A method that needs a
   transaction takes one; it never opens its own.
5. Every service method that mutates takes `tx` as its first parameter. This is
   what makes rule 4 mechanical rather than aspirational.

### 30.3 The seam for future extraction

Each top-level module has an `index.ts` exporting only its public service
interface and DTOs. When a module eventually moves out of the monolith, that file
becomes the client interface and nothing else changes. That is the entire cost of
keeping the microservice door open — one barrel file per module, no message bus,
no service registry, no speculative HTTP layer.

---

## 31. Testing strategy

### 31.1 Shape

| Layer | Tool | Target | What it covers |
|---|---|---|---|
| Unit | Jest | ~150 tests, fast | pure calculation: money, allocation, pricing pipeline, permission matching, cursor encoding, business-date |
| Integration | Jest + real PostgreSQL (Testcontainers, or a docker-compose service in CI) | ~120 tests | services against a real database: transactions, constraints, concurrency, idempotency |
| E2E | Jest + supertest | ~40 tests | full HTTP flows through the guard chain: auth, permissions, tenant isolation |

**No mocked database anywhere.** The invariants in §2.4 are enforced by
PostgreSQL constraints and by `READ COMMITTED` semantics, and a mock reproduces
neither. A test suite that mocks Prisma tests the mock.

### 31.2 Highest-risk business rules — these get tested first and hardest

Ranked by cost of failure:

| Rank | Rule | Test |
|---|---|---|
| 1 | **Concurrent stock deduction cannot oversell** (BR-3) | 20 parallel checkouts against 1 unit → exactly 1× `201`, 19× `409`, final quantity `0`, exactly 1 `SALE` movement |
| 2 | **A refund never executes twice** (BR-13) | same `Idempotency-Key` fired 10× in parallel → one refund, one payment row, nine replays |
| 3 | **Tenant isolation** (BR-14) | every endpoint, org A token against org B data → `404` |
| 4 | **Mixed payment sums exactly** (BR-2) | 200k cash + 150k card + 100k credit on a 450k sale → allocations 350k, receivable 100k, `payment_total_mismatch` on any other split |
| 5 | **Return quantity cap** (BR-6) | 5 parallel returns of 1 unit from a line of 3 → exactly 3 succeed |
| 6 | **Debt over-payment rejected** (BR-8) | 2 parallel payments of 300k against a 450k debt → one `409`, `remaining = 150000` |
| 7 | **Discount allocation sums exactly** (BR-12) | property test: 10,000 random (total, weights) pairs → `Σ parts === total`, always |
| 8 | **Ledger equals level** (BR-5) | after a randomized 500-operation sequence, reconciliation returns zero rows |
| 9 | **Shift expected cash** (BR-11) | a scripted shift (sales, refunds, debt collection, drop, expense) → expected cash matches a hand-computed figure |
| 10 | **Count finalization uses current, not snapshot** (§9.5) | sell during a count, finalize, assert the sale was not reversed |
| 11 | **Refund rounding leaves no residue** (§13.3) | return a 3-unit line one at a time → `Σ refunds === net_amount` |
| 12 | **Exchange is atomic** (§14.5) | replacement out of stock → the return did not happen either |

### 31.3 Per-domain integration coverage

- **Auth** — login, wrong password, deactivated user, expired token, refresh
  rotation, **refresh reuse revokes the family**, store switching.
- **Authorization** — each system role against a matrix of endpoints; wildcard
  matching; permission change takes effect on the next request.
- **Catalog** — product creates a default variant; SKU uniqueness; barcode
  uniqueness; archived product is unsellable; archiving a product with sales does
  not delete history.
- **Inventory** — every movement type; negative-stock policy on and off;
  transfer send/receive with shrinkage; count finalize with additions,
  shortages and untouched lines.
- **Sales** — walk-in, customer, discounts at both levels, override with and
  without permission, cash rounding, void inside and outside the shift.
- **Debt** — credit sale creates a receivable; partial then final payment; FIFO
  multi-receivable allocation; credit limit; blocked overdue customer;
  write-off.
- **Purchases** — partial receipt, over-receipt rejection, cost change on
  receipt updating the moving average, supplier payment and balance.
- **Cash register** — open, two-cashiers-one-register rejection, movements,
  close with a difference, Z-report figures.

### 31.4 Fixtures and data

One `seedTestOrg()` helper builds a complete, realistic organization: org,
settings, two stores, three warehouses, five roles, six users, 40 products with
variants, opening stock, customers with groups, suppliers. Every test starts from
a transaction that is rolled back, except concurrency tests, which need real
commits and therefore truncate afterwards.

`seedTestOrg()` is called **twice** in the isolation suite, producing two
organizations with deliberately identical names, SKUs and phone numbers — so a
cross-tenant leak surfaces as a wrong-org row rather than a not-found.

### 31.5 CI gates

Unit and integration on every push; E2E on every PR. Coverage floors: 90% on
`common/money`, `sales/pricing` and the guard chain; 80% on service layers; no
floor on controllers, which are thin by design and covered by E2E. A failing
invariant test blocks merge without exception.

---

## 32. DevOps strategy

### 32.1 Docker

Multi-stage build: `node:22-alpine` builder → `node:22-alpine` runtime with
production dependencies only, running as a non-root user, with a `HEALTHCHECK`
hitting `/health`. Prisma's query engine is copied explicitly (a classic
Alpine/OpenSSL footgun).

`docker-compose.yml` for development: `api` (watch mode), `postgres:16-alpine`
with a named volume, and `adminer`. No Redis service, per §1.4 — adding one when
it is justified is a four-line diff.

### 32.2 Environments

| | Development | Test | Production |
|---|---|---|---|
| Database | compose Postgres | ephemeral container, migrated per run | managed Postgres, daily backups |
| Migrations | `prisma migrate dev` | `migrate deploy` on boot | `migrate deploy` as a **separate step before** the app starts |
| Logging | pretty, `debug` | `warn` | JSON, `info` |
| Swagger | on | off | off unless `SWAGGER_ENABLED=true` |
| Seed | full demo data | fixtures only | system roles + the first owner only |
| Errors | full stack in the response | full stack | `traceId` only |

### 32.3 Environment variables

Validated by Zod at boot; the app exits non-zero on anything missing or
malformed.

```
NODE_ENV, PORT, API_PREFIX
DATABASE_URL, DATABASE_POOL_SIZE
JWT_SECRET, JWT_SECRET_PREVIOUS, JWT_ACCESS_TTL, JWT_REFRESH_TTL
CORS_ORIGINS, TRUST_PROXY
LOG_LEVEL
TELEGRAM_BOT_TOKEN                      (optional; the feature disables itself without it)
UPLOAD_DRIVER, UPLOAD_BUCKET, S3_*      (local disk in dev, object storage in prod)
SWAGGER_ENABLED
```

### 32.4 Migrations

- `prisma migrate dev` in development; **`prisma migrate deploy` only** in test
  and production. `migrate dev` against a shared database can reset it.
- The constraint migration from §6.2 is hand-written and committed alongside the
  generated one. Every future model change must consider whether it needs a
  companion constraint — a checklist item in the PR template, because Prisma will
  not remind anyone.
- Migrations run as a separate step (a compose `depends_on` job, or a
  pre-deploy hook), never from the application's `main.ts`. Two app replicas
  racing to migrate is a bad first production incident.
- Expand/contract for anything destructive: add the column, backfill, switch
  reads, drop the old column in a later release. A down-migration is written but
  restoring from backup is the real rollback plan, because a down-migration that
  has never been run is fiction.

### 32.5 Seeds

- **`seed:system`** — idempotent, safe in production: the five system roles with
  their permission arrays, and the permission catalogue.
- **`seed:demo`** — development only: a full organization, refuses to run when
  `NODE_ENV=production`.
- **Bootstrap** — a CLI command creating the first organization, its owner, one
  store and one default warehouse. Not an HTTP endpoint, because a public
  "create the first admin" endpoint is a liability the day someone forgets to
  disable it.

### 32.6 CI/CD

```
push  → lint · typecheck · unit · integration (Postgres service)
PR    → the above + E2E + a migration dry-run against a restored production dump
main  → build image · push to registry · deploy to staging · smoke test
tag   → migrate (separate job) · deploy production · health gate · notify
```

Non-negotiable gates: types clean, no lint errors, all tests green, and no
migration that drops a column without an expand/contract note in the PR.

### 32.7 Backups

`pg_dump` nightly to object storage with 30 days retention, plus WAL archiving
for point-in-time recovery once the managed database supports it. **A monthly
restore drill is part of the plan** — an untested backup is a hypothesis, and a
retail business that loses its sales history loses its receivables with it.

---

## 33. Implementation order

Ten phases. Each ends with something demonstrable and tested; none leaves a
half-built domain.

| # | Phase | Contents | Exit criterion |
|---|---|---|---|
| 0 | **Foundation** | repo, Docker, config + Zod validation, Prisma connection, `common/` (money, errors, pagination, request-id), health, Swagger, CI skeleton | `docker compose up` serves `/health`; money unit tests green |
| 1 | **Tenancy & auth** | Organization, Settings, Store, Warehouse, User, Role, StoreMembership, RefreshToken; login, refresh + rotation, switch-store; the full guard chain; Prisma tenant extension; audit service | **the isolation test suite passes** — this gate is absolute; nothing else starts until it is green |
| 2 | **Catalog** | Category, Product, ProductVariant (with auto-default), barcode lookup, search indexes, CSV import | a product can be created and scanned |
| 3 | **Inventory core** | InventoryLevel, InventoryMovement, `apply()`, adjustments, write-offs, stock card, low-stock, reconciliation | the concurrency test (rank 1, §31.2) passes |
| 4 | **Cash register** | CashRegister, Shift (with the one-open partial index), CashMovement | a shift opens and closes with a correct expected figure and no sales yet |
| 5 | **Sales / POS** | pricing pipeline, checkout transaction, drafts, void, payments + allocations, idempotency interceptor, receipt payload | a mixed-payment sale completes, deducts stock and reconciles (ranks 2 and 4) |
| 6 | **Customers & debt** | Customer, CustomerGroup, CustomerReceivable, credit sales, debt collection, aging, write-off | the brief's 450k → 100k → 350k scenario passes end to end (rank 6) |
| 7 | **Returns & exchanges** | Return, ReturnItem, refunds, restock, exchange composite | partial returns, the rounding-residue test, and the atomic-exchange test pass (ranks 5, 11, 12) |
| 8 | **Procurement** | Supplier, Purchase, receiving with moving-average cost, SupplierPayment, statement | a partial receipt updates stock and average cost correctly |
| 9 | **Inventory operations** | InventoryCount (+ finalize), StockTransfer (send/receive) | the count-during-sale test passes (rank 10) |
| 10 | **Loyalty & promotions** | LoyaltyAccount, ledger, earn/redeem as a tender; Promotion rules | redemption appears as a payment and not as a discount |
| 11 | **Reporting & platform** | reports module, materialized view, exports, notifications + outbox poller, Telegram adapter, audit read API | the dashboard renders from real data |

Phases 1 and 5 are the ones worth slowing down for. Everything downstream either
trusts the tenant boundary or trusts the checkout transaction.

---

## 34. Architecture risks

Ordered by expected damage.

| # | Risk | Why it is real | Mitigation | Residual |
|---|---|---|---|---|
| 1 | **A tenant-isolation leak** | one `findUnique({ where: { id } })` on a tenant model is all it takes; SaaS-fatal | Prisma extension rejects bare-id lookups · compound `(org, id)` uniques · the isolation suite runs every endpoint · RLS in phase 2 | low, and the suite must never be allowed to be skipped |
| 2 | **Stock drift between ledger and level** | a future code path writes a level without a movement | one `apply()` method · append-only trigger · nightly reconciliation raising `CRITICAL` | low; detection is guaranteed even if prevention fails |
| 3 | **Money rounding drift** | percentages, allocations and partial returns each round | `bigint` only · one rounding mode · largest-remainder allocation · last-return-sweeps-residue · property tests | low |
| 4 | **Duplicate financial operations** | mobile retries and double taps are routine | idempotency keys on every money path · natural unique keys as the second layer | low |
| 5 | **`document_counter` becomes the checkout bottleneck** | one row per store, locked for the rest of the transaction | fine below ~50 checkouts/sec/store · documented ceiling · upgrade path is a sequence or late number assignment | acceptable for the MVP, revisit at multi-till scale |
| 6 | **Fiscalization (soliq / online kassa) is not designed in** | Uzbek retail requires a registered fiscal device and receipt registration | receipt is already derived, not stored, so fiscal fields are additive: `fiscal_receipt_number`, `fiscal_sign`, `fiscal_status` on `sale`, plus an adapter like the payment providers | **open — §35.1, the highest-impact unknown** |
| 7 | **The Penpot screens have not been inspected** | field-level DTO details come from forms nobody has seen | the domain model is form-independent; DTOs are the last thing written in each phase | medium, closes as soon as the design is exported |
| 8 | **Moving-average cost is wrong under volatile purchase prices** | a common complaint once purchase costs swing | `unit_cost` is snapshotted on every movement, so FIFO can be reconstructed historically if adopted | low |
| 9 | **Reports slow down as `sale` grows** | live SQL on a growing table | date ranges required · indexes in place · one materialized view · read-replica seam already in the code | low for years at small-store volume |
| 10 | **No stock reservation on held drafts** | two parked carts can contest the last unit | documented, deliberate; checkout is atomic so nothing corrupts — one cashier simply gets a `409` | accepted |
| 11 | **Offline POS arrives before the sync design** | the brief lists offline as a future state | four columns and an idempotency key already in place (Appendix B) | medium; the real sync engine is a project of its own |
| 12 | **The notification poller silently stops** | in-process cron, single instance | `attempts`/`last_error` columns · a health check asserting the pending queue is not aging · Redis+BullMQ is the documented upgrade | low |
| 13 | **`BigInt` leaks into a float** | one `Number(x)` in a calculation | the type system prevents mixing · the serializer asserts safe range · lint rule against `Number()` in `money/` and `pricing/` | low |
| 14 | **Permission sprawl** | 50+ strings, easy to mis-assign | the catalogue is a typed constant · the role matrix is E2E tested · `roles.manage` is owner-only | low |

---

## 35. Decisions that must be confirmed before coding

Four of these change the schema and should be answered **before the first
migration is generated**. The rest are policy defaults that can ship as proposed
and be changed in settings.

### Blocking — they change columns

**35.1 Fiscalization.** Does this deployment need to register receipts with the
Uzbek tax authority (online nazorat-kassa / soliq)? If yes: which device or
provider, and does it require a receipt number issued *before* the sale
completes? This is the one open question that can alter the checkout transaction
rather than just add fields. *Proposed until answered: build without it, keep
`sale` extensible, treat the fiscal device as a payment-provider-style adapter.*

**35.2 VAT / QQS.** Is tax in scope for v1, and if so: is it inclusive or
exclusive of the displayed price, one rate or several, and per-product or
per-category? *Proposed: out of scope; `tax_amount` columns exist and stay zero;
prices are tax-inclusive when tax arrives, which is the Uzbek retail norm.*

**35.3 Cash rounding unit.** 0 (off), 100 or 1,000 soʻm? This determines whether
`rounding_adjustment` is ever non-zero and whether cashiers' drawers reconcile.
*Proposed: 0 for launch, configurable, agreed with the pilot store on day one.*

**35.4 Login identity.** Is `email` globally unique across organizations, or
unique only within one? Global keeps the login form to a single field; per-org
requires an org selector or a subdomain. *Proposed: globally unique for the MVP,
since one organization exists. Changing it later is a unique-index migration.*

### Policy — proposed defaults, confirm or override

| # | Question | Proposed default |
|---|---|---|
| 35.5 | Allow negative stock? | **No.** Surfaces data-entry errors immediately. Per-warehouse override exists. |
| 35.6 | Return window | **14 days**, with `sales.refund_expired` to override |
| 35.7 | Default debt term | **30 days** from the sale |
| 35.8 | Credit limit source | customer's own, falling back to their group's, falling back to unlimited |
| 35.9 | Block sales to overdue debtors? | **Yes**, past the default term; `debt.create` holders can override |
| 35.10 | Over-payment of a debt | **Rejected** (409). Store credit is a phase-2 feature. |
| 35.11 | Loyalty earn rate and point value | 1% of subtotal, 1 point = 1 soʻm — must be confirmed with the business |
| 35.12 | Points on discounted sales | **Yes**, on `subtotal_amount` (post-discount) |
| 35.13 | Do promotions stack? | **No** — one winner per level |
| 35.14 | Max discount a cashier may grant | unlimited in the MVP; a `max_discount_percent` setting is the obvious next step |
| 35.15 | Costing method | **Moving weighted average**; FIFO is reconstructable from movement `unit_cost` if needed |
| 35.16 | Landed cost (shipping into unit cost) | **No** — needs an allocation basis nobody has specified |
| 35.17 | Multiple barcodes per variant | **No** — one column; a `product_barcode` table is additive |
| 35.18 | Warehouses at launch | one per store, auto-created; the transfers module ships but is unused at a single store |
| 35.19 | Who may close a shift | the cashier who opened it, or any manager |
| 35.20 | Shift difference alert threshold | **10,000 soʻm** — above it, a `CRITICAL` notification to the manager |
| 35.21 | Product images | object storage in production, local disk in development; max 5 per product, 5 MB each |
| 35.22 | Telegram scope | notifications out only — no command interface in the MVP |
| 35.23 | Audit retention | indefinite; partition by month when the table reaches ~10M rows |
| 35.24 | UI language(s) | affects nothing in the schema except whether `product.name` needs to become multilingual — **confirm, because that one does change a column** |

35.24 is worth a second look: if the product catalogue must be bilingual
(uz/ru), `name` becomes `name_uz` / `name_ru` or a JSONB, and the search index
changes with it. Cheap now, tedious later.

---

## Appendix A — Notifications and the Telegram boundary

### A.1 One table, two jobs

`notification` is both the in-app feed row and the outbound delivery record.
Splitting them would mean a feed table, an outbox table and a join, for a feature
whose entire volume is a few hundred rows a day.

```
notification
  user_id | role_code     who sees it (a role broadcast fans out at read time)
  type, title, body, payload, severity
  read_at                 the feed half
  channel                 IN_APP | TELEGRAM
  delivery_status, attempts, next_attempt_at, last_error    the delivery half
```

### A.2 Events

| Event | Trigger | Severity | Recipients |
|---|---|---|---|
| `inventory.low_stock` | after a movement, `quantity <= min_stock`, deduplicated against unread | WARNING | `inventory.read` holders at the store |
| `inventory.negative_stock` | a level goes below zero | CRITICAL | managers |
| `inventory.reconciliation_failed` | the nightly check finds a mismatch | CRITICAL | owner |
| `debt.due_soon` | daily, `due_date` within 3 days | INFO | the cashier who made the sale |
| `debt.overdue` | daily, `due_date` passed | WARNING | managers |
| `debt.payment_received` | a debt payment is recorded | INFO | managers |
| `sale.completed` | optional, high-value sales only | INFO | owner |
| `sale.cancelled` | a void | WARNING | managers |
| `shift.closed_with_difference` | `abs(difference) > threshold` | CRITICAL | managers |
| `system.alert` | job failures, degraded health | CRITICAL | owner |

### A.3 Delivery

A `@nestjs/schedule` cron every 30 seconds:

```sql
SELECT * FROM notification
 WHERE delivery_status = 'PENDING' AND channel <> 'IN_APP'
   AND (next_attempt_at IS NULL OR next_attempt_at <= now())
 ORDER BY created_at
 LIMIT 50
 FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE SKIP LOCKED` makes this safe the day a second instance appears,
before Redis exists. Backoff is exponential: 1 min, 5, 15, 60, 360; five failures
→ `FAILED` with `last_error`. Delivered rows leave the partial index, so the
poller's query stays tiny forever.

### A.4 Telegram as an integration boundary

```ts
interface NotificationChannel {
  readonly channel: NotificationChannelType;
  send(n: Notification, target: ChannelTarget): Promise<void>;
}
```

`TelegramChannel` is one implementation. Binding lives in
`organization_settings.telegram` (bot token reference, chat ids per role). The
feature **disables itself** when `TELEGRAM_BOT_TOKEN` is unset — no crash, no
degraded startup, a log line.

Nothing in the domain knows Telegram exists. Adding SMS or email later means one
more class and one more enum value. No webhook receiver in the MVP: outbound
only, so there is no public surface to secure.

---

## Appendix B — Offline preparation

The MVP is online-first. A full sync engine is not built. What *is* built is the
set of decisions that would be expensive to retrofit — four columns, one header,
and one structural property.

### B.1 What exists now

| Hook | Where | Purpose |
|---|---|---|
| `Idempotency-Key` | every money/stock endpoint (§26) | a replayed queue never double-applies |
| `sale.client_id`, `payment.client_id` | unique per organization | the device's own id is the deduplication key, even across key regeneration |
| `sale.client_created_at` | alongside the server's `created_at` | preserves the true sale time while keeping server ordering authoritative |
| Append-only inventory ledger | `inventory_movement` | replaying events in a different order still converges to the same total |
| Server-assigned `sale_number` | `document_counter` | offline devices never invent receipt numbers, so two devices cannot collide |

### B.2 What a future sync engine will still need

- **A device registry** — `pos_device(id, store_id, name, last_sync_at)`, so a
  sync cursor has an owner.
- **A change feed** — a monotonic `sync_sequence BIGSERIAL` on the tables a
  device caches (products, prices, customers), letting a device pull deltas.
- **A conflict policy.** Sales are append-only and therefore conflict-free. The
  genuine conflict is **stock**: a device sells offline what another store
  already sold. The policy must be decided then, not now, but the shape is:
  accept the sale (the goods physically left the shop), allow the level to go
  negative on sync regardless of the warehouse setting, and raise
  `inventory.negative_stock` for a human to resolve. Refusing a sale that has
  already physically happened is not an option.
- **Clock skew handling** — `client_created_at` is data, never a sort key or an
  expiry basis. All business time decisions use server time.
- **A bounded offline window** — a device offline for longer than the idempotency
  retention (24h) needs a longer-lived deduplication path, which is why
  `client_id` exists as a permanent unique key rather than relying on the
  expiring idempotency record.

### B.3 What the API must never do (so offline stays possible)

- Never require a server-generated id **before** a document can be built. The
  client composes the whole sale and submits it once — which is already the
  `POST /sales/checkout` design.
- Never make a write depend on a read that must be fresh. Prices and stock are
  re-read server-side at checkout, and a stale client price is simply overridden.
- Never use auto-increment integers as external identifiers. Everything is a
  UUID, generated anywhere.

All three are already true. That is the whole point of writing this appendix now
rather than later.

---

## Appendix C — Observability

Deliberately small. The MVP is one service and one database; a tracing stack
would be more operational surface than the system it watches.

### C.1 Structured logging

`pino` via `nestjs-pino`, JSON in production, pretty in development. Every line
carries `requestId`, `organizationId`, `userId`, `storeId`, `method`, `path`,
`statusCode`, `durationMs`.

`requestId` is a UUIDv7 taken from an inbound `X-Request-Id` when present, else
generated; it is returned in the response header, echoed in every error body as
`traceId`, and written to `audit_log.request_id`. One id ties an HTTP response,
a stack of log lines, and a permanent audit row together — which is the entire
observability requirement for a system this size.

Redaction is configured in the logger serializer (§29.9), not left to callers.

### C.2 Health

| Endpoint | Checks | Used by |
|---|---|---|
| `GET /health` | the process is up | Docker `HEALTHCHECK`, load balancer |
| `GET /health/ready` | `SELECT 1`, pool saturation, pending-migration check, notification-queue age | deployment gate, uptime monitor |

`/health/ready` returning 503 on a pending migration prevents the classic
half-deployed state where new code meets an old schema.

### C.3 Metrics

`prom-client` on `/metrics` (bound to the internal interface only):
default Node metrics, HTTP request duration by route and status, Prisma query
duration, and four business gauges that are worth an alert —
`open_shifts`, `pending_notifications_age_seconds`,
`inventory_reconciliation_mismatches`, `failed_logins_5m`.

Four business metrics, each tied to a specific failure this document predicts. No
dashboard is built until someone asks a question a log line cannot answer.

### C.4 What is deliberately absent

Distributed tracing (one service), APM (the request logs carry duration),
centralized log aggregation (one container — `docker logs`, then a hosted
collector when there are two), and error tracking beyond structured logs until
volume justifies Sentry. Each of these is a ten-minute addition when the need is
real, and a permanent maintenance cost when it is not.

---

## Closing statement

Every domain in the brief is modelled, every entity decision is justified
(including the six entities that deliberately do not become tables), every
money path has a defined rounding rule, every stock and money mutation has a
named transaction boundary and a database-level guard, the API surface is
enumerated with its permissions and error codes, and the deferred items each
carry an explicit trigger for when to build them.

The open items in §35 are policy defaults and four field-level confirmations.
None of them changes a domain boundary, a transaction boundary or a relationship
in this document; §35.1 (fiscalization) and §35.24 (multilingual catalogue) add
columns, and §35.2 (VAT) fills columns that already exist. The Penpot screens,
once exported, will refine DTO field lists — not the model they serve.

**ARCHITECTURE READY FOR IMPLEMENTATION**

Start with Phase 0 and Phase 1 (§33). Do not begin Phase 2 until the tenant
isolation suite is green — it is the one gate in this plan that cannot be
usefully retrofitted.
