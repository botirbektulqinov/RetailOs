# RetailOS — Backend

Retail management platform for small stores, designed to grow into a
multi-tenant SaaS without a rewrite. NestJS modular monolith on PostgreSQL.

**Current state: Sprint 3 — product catalog.** Authentication, tenancy and
RBAC (Sprint 2) plus categories, products and variants. No inventory, POS or
selling endpoints yet; see [Roadmap](#roadmap).

The approved design is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and it is
the source of truth for every decision below. Section references like
*(§8 Money model)* point into it.

---

## Tech stack

| | |
|---|---|
| Runtime | Node.js 22+ (developed on 24) |
| Language | TypeScript 6, `strict` + `noUncheckedIndexedAccess` |
| Framework | NestJS 12 |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 (pg driver adapter) |
| Validation | class-validator + Zod (environment) |
| Logging | pino via nestjs-pino |
| Docs | Swagger / OpenAPI |
| Tests | Jest, supertest |
| Container | Docker + Docker Compose |

No Redis and no BullMQ: the MVP is a single instance, and an outbox table with
a cron poller covers async delivery. See *§1.4* for the exact trigger to adopt
them.

---

## Prerequisites

- Node.js **22 or newer** (`node -v`)
- npm 10+
- Docker Desktop (for PostgreSQL; a local PostgreSQL 16 works too)

---

## Quick start

```bash
git clone <repo> && cd RetailOS_backend

npm install
cp .env.example .env          # defaults work as-is for local development

npm run docker:up             # starts PostgreSQL on port 55432
npm run prisma:migrate        # applies migrations, generates the client
npm run seed                  # system roles + a demo organization

npm run start:dev
```

Then open:

- Health — <http://localhost:3000/api/v1/health>
- Readiness — <http://localhost:3000/api/v1/health/ready>
- Swagger — <http://localhost:3000/api/docs>
- OpenAPI JSON — <http://localhost:3000/api/docs/json>

> **Why port 55432?** The dev container publishes PostgreSQL on **55432**, not
> 5432, so it cannot collide with a PostgreSQL already installed on the host —
> which silently answers on 5432 *and* 5433 on some machines and produces a
> baffling `P1000: Authentication failed`. Change `POSTGRES_PORT` and
> `DATABASE_URL` together in `.env` if you want a different port.

---

## Environment variables

All variables are validated at startup by
[`src/config/env.schema.ts`](src/config/env.schema.ts). **The application
refuses to boot** if any is missing or malformed, and the error lists every
problem at once. `.env.example` is the authoritative template.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3000` | |
| `API_PREFIX` | `api` | Routes become `/{API_PREFIX}/v1/...` |
| `DATABASE_URL` | — | **Required.** Must be a `postgres://` / `postgresql://` URL |
| `DATABASE_POOL_SIZE` | `10` | pg pool max connections |
| `JWT_SECRET` | — | **Required.** ≥32 chars; rejected in production if it contains `dev-only` |
| `JWT_REFRESH_SECRET` | — | **Required.** Same rules |
| `JWT_ACCESS_TTL` | `15m` | Wired up in Sprint 2 |
| `JWT_REFRESH_TTL` | `30d` | Wired up in Sprint 2 |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allow-list. Must be non-empty in production. Never `*` |
| `TRUST_PROXY` | `false` | Enable behind a reverse proxy so client IPs are real |
| `BODY_LIMIT` | `1mb` | |
| `RATE_LIMIT_TTL_SECONDS` | `60` | |
| `RATE_LIMIT_LIMIT` | `600` | Requests per window per client |
| `LOG_LEVEL` | `info` | `fatal` … `trace` |
| `SWAGGER_ENABLED` | `false` | Keep `false` in production unless docs are deliberately public |

`.env` is git-ignored. **Never commit real secrets.** Generate production
secrets with `openssl rand -base64 48`.

---

## Commands

### Develop

```bash
npm run start:dev       # watch mode
npm run start:debug     # watch mode + inspector
npm run build           # compile to dist/
npm run start:prod      # run the compiled build
```

### Quality

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run lint:fix
npm run format          # prettier --write
npm run format:check
```

### Test

```bash
npm test                # unit tests (src/**/*.spec.ts)
npm run test:cov        # + coverage; money has a hard 95% floor
npm run test:e2e        # HTTP tests — REQUIRES a running database
```

The e2e suite exercises authentication, RBAC and tenant isolation against real
PostgreSQL, so it needs the credential rate limits raised or it throttles
itself out:

```bash
NODE_ENV=test AUTH_RATE_LIMIT=2000 RATE_LIMIT_LIMIT=20000 npm run test:e2e
```

That is also exactly how CI runs it.

> Jest runs under `node --experimental-vm-modules` because NestJS 12 ships as
> ESM. The flag is already in the npm scripts; run tests through npm, not by
> invoking `jest` directly.

### Database

```bash
npm run docker:up              # start PostgreSQL
npm run prisma:migrate         # create + apply a migration (development only)
npm run prisma:migrate:deploy  # apply existing migrations (test / production)
npm run prisma:migrate:status  # what is applied, what is pending
npm run prisma:generate        # regenerate the Prisma client
npm run prisma:studio          # browse data
npm run seed                   # idempotent, non-destructive
npm run prisma:reset           # DESTRUCTIVE: drops and recreates. Never in production.
```

**Migration rules** (*§32.4*):

- `prisma migrate dev` is for **development only** — it can reset a shared database.
- Test and production use `prisma migrate deploy`, run as a **separate step
  before** the application starts. Migrations never run from `main.ts`.
- Anything destructive uses expand/contract: add the column, backfill, switch
  reads, drop the old column in a later release.
- Prisma cannot express CHECK constraints, generated columns, partial unique
  indexes or triggers — several of which *are* the business rules (*§6.2*).
  Those go in a hand-written migration committed alongside the generated one.
- **Review every generated migration for drift deletions.** Prisma does not
  know about the hand-written constraints, so it proposes DROP statements for
  them in the *next* migration. `20260917095300_audit_actor_restrict` had four
  composite foreign keys and two trigram indexes stripped out by hand before
  it was applied.

---

## Docker

```bash
npm run docker:up              # PostgreSQL only (what local development needs)
docker compose up -d --build   # full stack: postgres -> migrate -> api
npm run docker:logs
npm run docker:down            # stop; add -v to also delete the data volume
```

Two different things:

- **`npm run docker:up`** starts only PostgreSQL. This is the everyday
  development path — run the API on the host with `npm run start:dev` for
  hot reload.
- **`docker compose up`** runs the *production* image. The `api` service is
  pinned to `NODE_ENV=production` because that image has its devDependencies
  pruned, so telling it `development` would make it ask for packages that are
  not there. It therefore **refuses to start with the `.env.example`
  placeholder secrets** — replace `JWT_SECRET` and `JWT_REFRESH_SECRET` in
  `.env` with real values first:

  ```bash
  openssl rand -base64 48
  ```

  That refusal is the `dev-only` guard in `env.schema.ts` doing its job, not a
  misconfiguration.

Three services:

| Service | Purpose |
|---|---|
| `postgres` | PostgreSQL 16, healthchecked with `pg_isready -d` so the API never races a half-initialised database |
| `migrate` | Runs `prisma migrate deploy` once and exits. `api` waits for it to complete successfully |
| `api` | The application. Multi-stage build; runtime image has no devDependencies and runs as a non-root user |

The full stack requires `JWT_SECRET` and `JWT_REFRESH_SECRET` in `.env` —
compose fails fast with a named error rather than starting a broken container.

---

## Project structure

```
src/
  main.ts                  entry point — creates the app, applies setup, listens
  bootstrap.ts             ALL global setup, shared by main.ts and the e2e suite
  app.module.ts            root module
  config/                  Zod environment schema + typed AppConfig
  database/                PrismaService (owns the pg pool), global DatabaseModule
  health/                  liveness + readiness
  auth/                    login, tokens, sessions, guards
  rbac/                    the permission catalogue and system roles
  organizations/ stores/ employees/
  catalog/                 categories, products, variants
  inventory/               levels, the movement ledger, counts, transfers
    stock-writer.ts        the two statements that move stock — the only copy
    inventory.service.ts   apply(): the single write path every caller uses
  sales/                   checkout, sale history, receipts, cancellation
    pricing.ts             the §10.3 calculation pipeline, pure and testable
  customers/               customers, groups, notes and the debt ledger
  procurement/             suppliers, purchase orders, receiving and payables
  returns/                 returns, refunds and exchanges
  loyalty/                 promotions, the points ledger
    ../sales/promotions.ts the §18.3 resolver, pure and testable
  audit/                   the append-only audit trail
  common/
    money/                 Money primitives: bigint minor units (§8)
    quantity.ts            NUMERIC(14,3) primitives and the low-stock rule
    document-number.ts     gapless per-store document numbers (§25.6)
    idempotency/           the record that commits with the work it guards (§26)
    tenant/                AsyncLocalStorage context + the Prisma isolation extension
    dto/                   ListQueryDto, PagedResult (§27)
    exceptions/            BusinessRuleException + the error-code catalogue (§23)
    filters/               AllExceptionsFilter — the only place an error becomes a response
    http/                  request/correlation id
    logging/               pino options + redaction
prisma/
  schema.prisma            foundation, catalog and inventory
  schema.draft.prisma      the full 40-model draft, promoted sprint by sprint
  migrations/
  seed.ts
test/
  setup-e2e.ts             raises the auth throttle before anything imports
  foundation · auth · catalog · inventory · sales
  customers · procurement · returns · loyalty      .e2e-spec.ts
  helpers/seed-org.ts      two complete look-alike organizations, for isolation probes
docs/
  ARCHITECTURE.md          the source of truth
```

Remaining feature modules (`cash/`, `reports/`, `notifications/`) are **not**
scaffolded as empty folders. They are created by the sprint that implements
them — see *§30* for the planned layout and the module boundary rules.

---

## Authentication

### The flow

```
POST /api/v1/auth/login        phone + password  ->  access + refresh token
     |
     |  Authorization: Bearer <access>        15 minutes
     |
POST /api/v1/auth/refresh      refresh token   ->  NEW access + NEW refresh
POST /api/v1/auth/logout       revoke this session
POST /api/v1/auth/logout-all   revoke every session on every device
```

**Login is by phone, not email.** The design's auth screens are phone-first
(`+998 90 123 45 67`) and the employees screen searches by name or phone, so
`phone` is the identifier and `email` is optional contact detail. Any format is
accepted — the server normalises to E.164 before looking anything up, so
`+998901234567`, `+998 90 123 45 67` and `901234567` all resolve to the same
account.

### Demo accounts (DEVELOPMENT ONLY)

`npm run seed` creates the fictional organization **Navro'z Market** with one
store (`FILIAL-017 - RetailOS Chorsu`) and one user per role. It prints the
credentials on every run and refuses to create them when `NODE_ENV=production`.

| Phone | Password | Role | Name |
|---|---|---|---|
| `+998901234567` | `RetailOS2026` | Administrator | Dilshod Karimov |
| `+998901234568` | `RetailOS2026` | Menejer | Sevara Tursunova |
| `+998901234569` | `RetailOS2026` | Kassir | Madina Aliyeva |
| `+998901234570` | `RetailOS2026` | Omborchi | Aziz Rasulov |

**These are throwaway development credentials.** Never use them anywhere real.

### Trying it

```bash
# 1. Log in
curl -s -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+998 90 123 45 67","password":"RetailOS2026","rememberDevice":true}'

# 2. Use the access token
TOKEN=<accessToken from step 1>
curl -s http://localhost:3000/api/v1/auth/me -H "Authorization: Bearer $TOKEN"

# 3. Refresh (this revokes the refresh token you just used)
curl -s -X POST http://localhost:3000/api/v1/auth/refresh \
  -H 'Content-Type: application/json' -d '{"refreshToken":"<refreshToken>"}'

# 4. Log out
curl -s -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"refreshToken":"<refreshToken>"}'
```

### Tokens

| | Access | Refresh |
|---|---|---|
| Format | JWT, HS256 | opaque random, **SHA-256 hashed at rest** |
| Lifetime | 15 minutes | 30 days, or 12 hours without "Eslab qolish" |
| Carries | user, org, store, role, `tv`, `pv` — never a permission list | nothing; it is a database lookup |
| Revocation | `tokenVersion` mismatch, checked on every request | delete the row |

**Rotation with reuse detection.** Every refresh issues a new token and revokes
the old one. Presenting an already-rotated token means it was captured, so the
whole session family is revoked and the legitimate holder must sign in again.

**Permissions are not in the token.** They are resolved per request from the
membership's current role, cached by `roleId:permissionVersion`. Editing a role
takes effect on the **very next request** — nobody is forced to log in again,
and a revoked permission is never honoured for the rest of a token's lifetime.

### Password policy

Straight from the "Yangi parol yarating" screen: **at least 8 characters** and
**at least one digit or symbol**, plus a small common-password blocklist.
Hashing is Argon2id (19 MiB, t=2, p=1).

**Changing a password revokes every session, including the one that requested
it.** You change a password when you think it was exposed, so leaving other
devices signed in would defeat the point. The client re-authenticates with the
new password immediately.

---

## Roles and permissions

Four system roles, seeded per organization, matching the "STANDART ROLLAR" list
on the roles screen:

| Code | Name | Description | Editable |
|---|---|---|---|
| `ADMIN` | Administrator | Barcha bo'limlar | no — an org that can strip its own admin can lock itself out |
| `MANAGER` | Menejer | Hisobot va boshqaruv | yes |
| `CASHIER` | Kassir | Savdo va cheklar | yes |
| `WAREHOUSE` | Omborchi | Mahsulot va ombor | yes |

Custom roles are ordinary rows (`POST /api/v1/roles`).

**Permissions are a typed constant in code**
([`src/rbac/permissions.ts`](src/rbac/permissions.ts)), not a database table. A
permission no guard references is meaningless, and a guard naming a permission
that does not exist should be a compile error rather than a check that is
silently false forever. Roles store permission strings in an array.

```ts
@RequirePermissions('sales.refund')   // misspelling this does not compile
@Post(':id/returns')
createReturn() {}
```

Matching supports `group.*` and `*`. **Role names are never checked anywhere** —
`if (role === 'MANAGER')` makes custom roles unusable and hides authorization
from the one place that is audited.

`GET /api/v1/roles/permissions/catalogue` returns the whole catalogue with
Uzbek labels and groups, which is what the permissions screen renders.

---

## Organization and store context

```
Organization  (the tenant boundary)
  |
  +-- Store                     a branch; "FILIAL #017"
        |
        +-- StoreMembership     (user, store, role)
```

A user's authority is **per store**. The same person can be a manager at one
branch and a cashier at another, which a `role` column on the user cannot
express — and which becomes a painful migration once sales reference the role.

**The organization is never read from the request.** Not from the body, not
from a query parameter, not from a path. It is derived from the signed access
token and re-validated against the database on every request. That is why there
is no `GET /organizations/:id` — only `GET /organizations/current`.

Store context lives inside the token too. `POST /api/v1/auth/switch-store`
re-mints the access token after verifying membership; `GET /api/v1/stores`
lists only the stores the caller actually belongs to.

### Three layers of isolation

1. **Never trusted from the client** — org, store, user and role come only from
   the verified token.
2. **A Prisma client extension**
   ([`src/common/tenant/tenant-extension.ts`](src/common/tenant/tenant-extension.ts))
   injects `organizationId` into every read and create, and **refuses** a
   single-row operation targeted by bare `id`. Deliberate cross-tenant work goes
   through `prisma.asSystem()`, which is named to be obvious in review.
3. **Composite foreign keys** — `store_membership` references
   `(organization_id, user_id)`, `(organization_id, store_id)` and
   `(organization_id, role_id)`, so a cross-organization membership is
   impossible at the database level even if every application check is removed.

Cross-tenant reads return **404, not 403**: confirming that another tenant's row
exists is itself a leak.

---

## Product catalog

### Ownership: organization, not store

A product is the same product in every branch, so the catalog hangs off the
**organization**. Per-store price and availability are the real variations and
both are additive later (a `store_product_override` table) without moving the
product itself. Store-scoping products now would duplicate SKUs across branches
and break barcode lookup, which must resolve to exactly one row.

### The three models

```
Category  (hierarchical, max 3 levels)
    |
    +-- Product          shared identity: name, brand, images, category
            |
            +-- ProductVariant    what is actually SOLD
                                  SKU, barcode, prices, min stock, unit
```

**Every product has at least one variant, always.** Creating a product
auto-creates one flagged `isDefault`, which the UI never shows and edits
inline. That is what lets inventory, sale lines and purchase lines point at a
single foreign key forever instead of branching on "does this have variants?".

- **Simple product** — one variant, `isDefault = true`, `hasVariants = false`.
- **Variant product** — several variants, `hasVariants = true`. The flag is
  presentation only; nothing downstream branches on it.

Variant combinations live in a JSONB `attributes` map
(`{ "Rang": "Qora", "O'lcham": "S" }`). The option pickers the variants screen
shows are **derived** from the variants themselves — there is no
attribute/value/assignment triple, because three tables would store exactly
what one pass over already-loaded rows computes.

### Categories

Three levels, root first: the categories screen renders a two-ancestor path
(`Choy va qahva` under `Ichimliklar / Issiq`). The path is **materialised** on
write, so listing 18 categories is one query rather than a recursive lookup per
row — and renaming or moving a node rewrites its descendants' paths.

Rejected at write time: a cycle (`A -> B -> A`, at any depth), a fourth level,
and two siblings sharing a name case-insensitively.

### SKU and barcode

| | Rule |
|---|---|
| **Uniqueness** | **per organization**, not global. Two shops may legitimately both use `CH-021`. |
| **Scope** | only among **live** rows — the unique indexes are partial on `archived_at IS NULL`, so archiving a product frees its SKU and barcode for reuse. |
| **SKU normalisation** | trimmed, **uppercased**, inner spaces removed. `ch-021` and `CH-021` cannot both exist and later confuse a stock count. |
| **Barcode normalisation** | non-digits stripped; empty becomes `null`. A scanner emits digits, so anything else a human typed would never match a scan. |
| **Barcode format** | 6–20 digits, enforced by a database `CHECK`. |

Duplicates are caught by the **database**, not by a pre-check. `if (!exists)
create` still races: two requests can both pass the check. The unique index is
the real guard and the API maps its violation to `SKU_ALREADY_USED` or
`BARCODE_ALREADY_USED` — the latter renders as "Bu shtrix-kod boshqa mahsulotda
mavjud", exactly as the design's product form shows it.

### Pricing

Both prices live on the **variant**, because the design's variants screen
prices each combination separately (Qora 129 000, Oq 135 000).

- `purchasePrice` — "Xarid narxi"
- `sellingPrice` — the price the POS charges

Both are `BIGINT` minor units (§8): `24000` means 24 000 so'm. Both must be
`>= 0`, enforced by a `CHECK`.

**There is deliberately no rule that selling price must exceed purchase
price.** Clearing stock below cost is ordinary retail, and a backend that
forbade it would be wrong about the business.

For a simple product the price can be set through `PATCH /products/:id` —
the client never has to know the default variant exists.

### Archiving, never deleting

Sales, purchases and inventory movements reference a product forever: a receipt
from last year must still name what was sold. So:

- `PATCH /products/:id/archive` sets `archivedAt` and archives its variants.
- Archived products vanish from search, listing and POS barcode lookup, but
  remain readable by id and keep every historical relation.
- `PATCH /products/:id/restore` brings one back — and returns `409` if another
  product has taken its SKU in the meantime.
- Categories refuse to archive while they still hold products or
  subcategories; the foreign keys are `ON DELETE RESTRICT`.

### Search, filtering, sorting, pagination

Search (`?q=`) matches product name, brand, variant SKU and variant barcode.
**Every branch is a database predicate** — the catalogue is never loaded into
JavaScript and filtered there. Trigram indexes back the substring matching.

| Filter | |
|---|---|
| `categoryId`, `status`, `brand`, `hasVariants` | direct column predicates |
| `minPrice` / `maxPrice` | matched against live variants |
| `includeArchived` | off by default |

Sorting is a **whitelist** (`createdAt`, `updatedAt`, `name`, each `:asc` or
`:desc`); anything else is a `400`. Raw client input never becomes an
`ORDER BY`.

Pagination is offset-based with `limit` capped at 100, as everywhere else.

### POS barcode lookup

```bash
GET /api/v1/products/lookup?barcode=4780012345678
```

One indexed read on `(organization_id, barcode)`. Sprint 5 calls this on every
scan, so it deliberately does no joins beyond the product row it returns.
Archived and inactive products are not found.

### Trying it

```bash
TOKEN=<accessToken from /auth/login>

# Category tree with product counts
curl -s "$API/categories" -H "Authorization: Bearer $TOKEN"

# Create a product (creates its default variant too)
curl -s -X POST "$API/products" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "name": "Safia qora choy 100g",
    "sku": "CH-021",
    "barcode": "4780012345678",
    "sellingPrice": 24000,
    "purchasePrice": 17500,
    "minStock": "5.000"
  }'

# Add a variant
curl -s -X POST "$API/products/<id>/variants" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
    "sku": "FT-Q-S",
    "attributes": { "Rang": "Qora", "O‘lcham": "S" },
    "sellingPrice": 129000
  }'

# Search, filter, sort
curl -s "$API/products?q=choy&sort=name:asc&limit=20" -H "Authorization: Bearer $TOKEN"
```

`npm run seed` creates a demo catalogue matching the design's screens: an
eight-category tree three levels deep, three simple products, and
`Futbolka Classic` with eight variants (two colours x four sizes).

### Permissions

| Action | Permission |
|---|---|
| read products and categories | `products.read` |
| create | `products.create` |
| update, and all variant writes | `products.update` |
| archive | `products.delete` |

Categories reuse the product permissions rather than declaring their own: a
category exists only to organise products, and a separate `categories.*` group
would be four more strings that always move together with `products.*`.

---

## Inventory

Stock is never a column on a product. There is no `product.stock` anywhere in
the schema, and adding one would be the fastest way to lose the ability to
answer "why is this number 47".

Two structures, one truth (*§9.1*):

| | `inventory_movement` | `inventory_level` |
|---|---|---|
| Role | the ledger — **truth** | the projection — **speed** |
| Mutation | insert only, trigger-enforced | `UPDATE`, in the same transaction |
| Rebuildable | no | yes, from the ledger |
| Read by | stock card, audit, reconciliation | POS availability, stock list, low stock |

Every stock number is always `inventory_level.quantity` for a (warehouse,
variant), and is always verifiable against `SUM(movement.quantity_delta)`. The
suite asserts that equality directly, and so can you:

```sql
SELECT l.warehouse_id, l.product_variant_id
  FROM inventory_level l
  LEFT JOIN inventory_movement m
    ON m.warehouse_id = l.warehouse_id AND m.product_variant_id = l.product_variant_id
 GROUP BY l.warehouse_id, l.product_variant_id, l.quantity
HAVING l.quantity <> COALESCE(SUM(m.quantity_delta), 0);
```

Any row this returns is a bug: some code path moved a level without going
through `apply()`. In a correct system it always returns nothing, which is
exactly why it is worth running.

### The single write path

Every stock change in the system — sale, purchase, return, transfer, count
correction, manual adjustment — goes through one method:

```ts
// src/inventory/inventory.service.ts
await inventory.apply(tx, {
  organizationId, warehouseId, variantId,
  type: 'SALE', delta: -2,        // signed
  sourceType: 'sale', sourceId: saleId,
  actorId: userId,
});
```

`apply()` **never opens its own transaction** — it always receives one. That is
what makes "the sale and its stock movements commit or fail together"
structurally true rather than something each caller has to remember. The two
statements it runs live in `src/inventory/stock-writer.ts`, so the seed can
write opening balances through exactly the same code rather than growing a
second, slowly diverging copy.

`applyMany()` sorts its commands by (warehouse, variant) before applying them,
so two multi-line documents touching the same products always take those row
locks in the same order and cannot deadlock.

### Why it cannot oversell

The guard and the mutation are one statement (*§9.3*):

```sql
UPDATE inventory_level
   SET quantity = quantity + $delta, ...
 WHERE warehouse_id = $w AND product_variant_id = $v
   AND ($allowNegative OR quantity + $delta >= 0)
RETURNING quantity;
```

PostgreSQL takes a row lock for the duration of the `UPDATE` and re-evaluates
the `WHERE` against the **committed** row, so two cashiers selling the last
unit serialize automatically and exactly one wins. Zero rows affected means the
guard refused: **409 `INSUFFICIENT_STOCK`**, with the available quantity in the
payload.

There is deliberately no `SELECT … FOR UPDATE` followed by an application-side
check. That pattern has a window between the read and the write under `READ
COMMITTED`, and closing it costs `REPEATABLE READ` plus a retry loop. This has
no window and needs no retries.

The same shape guards every state transition that moves stock. Finalizing a
count and receiving a transfer are both conditional `UPDATE`s on the document's
status, not a read-then-check — two clerks scanning the same pallet would
otherwise both pass the check and the goods would arrive twice. The e2e suite
fires those requests genuinely in parallel, because a check-then-act bug
survives any sequential test.

**Negative stock** resolves per warehouse: `warehouse.allow_negative_stock` →
else `organization_settings.allow_negative_stock` → else `false`. It is read
inside the guard itself, because a policy fetched a moment earlier is a policy
that can be stale at the only moment it matters. The MVP default is `false`: a
shop that cannot sell what it does not have finds its data-entry mistakes on
day one instead of month three.

### Warehouses

```
Organization
  └── Store
       └── Warehouse   (store_id may be NULL — a central warehouse)
```

Stock lives in a warehouse, never in a store. A store is where people are; a
warehouse is where goods are. `store_id` is nullable so a central warehouse can
serve several branches, and at most one warehouse per store may be the default
(a partial unique index enforces it).

A warehouse is archived, never deleted — every movement ever written names it,
and those foreign keys are `ON DELETE RESTRICT`. Archiving one that still holds
stock is refused: allowing it would hide that stock from every report while it
still counted in the totals.

### Movement types

| Type | Sign | Written by |
|---|---|---|
| `INITIAL` | + | onboarding / opening balance |
| `PURCHASE` | + | goods received (Sprint 7) |
| `SALE` | − | checkout (Sprint 5) |
| `RETURN` | + | a return (Sprint 8) |
| `TRANSFER_OUT` / `TRANSFER_IN` | − / + | stock transfer |
| `COUNT_CORRECTION` | ± | finalizing a stocktake |
| `ADJUSTMENT` | ± | manual, reason required |
| `DAMAGE` / `WRITE_OFF` | − | manual, reason required |

The sign is enforced by a `CHECK`, not by convention: a `PURCHASE` that removes
stock cannot be written even by hand-rolled SQL, and once written it could not
be corrected, because the table is append-only. `ADJUSTMENT` and
`COUNT_CORRECTION` are the only two types that may move in either direction.

`ADJUSTMENT`, `DAMAGE` and `WRITE_OFF` must carry a `reason` — also a `CHECK`.
"Where did those three go" is the question this table exists to answer.

The ledger is append-only for real: a `BEFORE UPDATE OR DELETE` trigger raises,
so a careless `updateMany` fails loudly instead of silently rewriting the
history every stock number rests on.

### Cost

Moving weighted average, held in `inventory_level.avg_cost` and recomputed
**inside the same `UPDATE` that moves the quantity** — so a quantity and the
cost it is valued at can never disagree (*§8.6*):

```
avg_cost = round((q0 × c0 + qty × unit_cost) / (q0 + qty))
```

FIFO layers are rejected for the MVP: they need a `cost_layer` table, layer
consumption on every sale and layer restoration on every return, for a
difference that only shows up under volatile purchase costs.

### Low stock

Derived, never stored (*§7.6*). A stored status would need updating on every
movement **and** on every edit of `minStock`, and the second one is the update
everybody forgets.

| Condition | Status |
|---|---|
| `quantity <= 0` | `OUT_OF_STOCK` |
| `minStock > 0 && quantity <= minStock` | `LOW_STOCK` |
| otherwise | `IN_STOCK` |

`minStock = 0` means no minimum is configured, so such a variant is never
`LOW_STOCK` — otherwise every product in the catalogue would be "low" the
moment it ran out, which is what `OUT_OF_STOCK` already says.

`GET /inventory` is driven from `product_variant` with a `LEFT JOIN` onto
levels, **not** the other way round. A product that has never been stocked has
no level row, and that is precisely the row an out-of-stock report must show; a
levels-driven report would silently omit everything most in need of ordering.
`?lowStock=true` is the re-order list: out of stock *or* at/below the minimum.

Every filter, including `LOW_STOCK`, is evaluated in the database. That
comparison reads two columns across a relation, which Prisma cannot express, so
that one list is hand-written SQL — and because the tenant extension never sees
a `$queryRaw`, it is also the one place in the codebase that names
`organization_id` explicitly.

### Inventory counts

Three phases, and only the third moves stock (*§9.5*):

```
DRAFT / COUNTING   lines generated, expected_quantity snapshotted;
                   staff enter what they found; the shop keeps selling
      │ finalize
      ▼
FINALIZED          corrections applied in one transaction
```

The counting phase deliberately locks nothing. A shop cannot stop trading for
the hours a stocktake takes.

The correction is `counted − current`, **not** `counted − expected`. The
snapshot is hours old by then, and using it would silently reverse every sale
made while the count was open: a shop that counted 50, sold 3 and finalized
would end up back at 50 holding three units it no longer has. Both numbers are
kept — `expected_quantity` for the report, `applied_delta` for what actually
moved.

Lines that were never counted are **skipped, not zeroed**. Counting nothing is
not the same as counting zero, and conflating the two destroys inventory.

A partial unique index allows one open count per warehouse, which removes an
entire class of race at the database level.

### Transfers

```
SENT       TRANSFER_OUT applied at the source immediately
  │ receive
  ▼
RECEIVED   TRANSFER_IN applied at the destination for what actually arrived
```

Stock leaves at send, not at receive, because the van is not a warehouse: a
branch that can still sell goods already loaded onto a truck will oversell
them. Goods in transit belong to neither warehouse's sellable stock.

Receiving less than was sent is allowed — shrinkage in transit is real — and
requires a note. The shortfall is **not** written off again at the source.

> *§9.6 prescribes a `WRITE_OFF` at the source for the difference. Followed
> literally that double-counts the loss: the source already gave up the full
> quantity at send time, so a second deduction takes stock it no longer has.
> The shortfall is instead documented on the transfer line (`quantity` versus
> `received_quantity`, with a mandatory note) and is already visible in the
> ledger as the gap between the two legs of the same `source_id`. The loss is
> recorded exactly once.*

Cancelling a transfer still in transit returns the goods as a `TRANSFER_IN` at
the source rather than deleting the `TRANSFER_OUT`. The ledger is append-only,
and "it went out and came back" is what actually happened.

### Document numbers

`INV-000001`, `TRF-000001`. A row-locked counter per (store, type, period), not
a sequence: a sequence is faster and leaves gaps on rollback, and a receipt
number with gaps is a question from a tax inspector. The ceiling is roughly
50–100 documents/sec/store and is marked in the code with its upgrade path.

### Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` | `/inventory` | `inventory.read` |
| `GET` | `/inventory/movements` | `inventory.read` |
| `GET` | `/inventory/:variantId` | `inventory.read` |
| `POST` | `/inventory/adjustments` | `inventory.adjust` |
| `GET` | `/warehouses`, `/warehouses/:id` | `inventory.read` |
| `POST` `PATCH` | `/warehouses`, `/warehouses/:id`, `…/archive`, `…/restore` | `stores.manage` |
| `GET` | `/inventory-counts`, `/inventory-counts/:id` | `inventory.read` |
| `POST` `PATCH` | `/inventory-counts`, `…/items`, `…/finalize`, `…/cancel` | `inventory.count` |
| `GET` | `/transfers`, `/transfers/:id` | `inventory.read` |
| `POST` | `/transfers`, `…/receive`, `…/cancel` | `inventory.transfer` |

Warehouses reuse the existing permission catalogue rather than declaring a
`warehouses.*` group. Reading one is `inventory.read` — a warehouse list with
no stock in it is not something anyone asks for — and creating one is
`stores.manage`, because a warehouse is part of how a store is structured. A
new group would have to be granted to every existing role before anyone could
use the feature.

```bash
# Stock across all warehouses, lowest first
curl -s "$API/inventory?sort=quantity:asc&limit=20" -H "Authorization: Bearer $TOKEN"

# The re-order list for one branch
curl -s "$API/inventory?storeId=$STORE&lowStock=true" -H "Authorization: Bearer $TOKEN"

# Write off three broken jars — reason is mandatory and enforced by the database
curl -s -X POST "$API/inventory/adjustments" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"warehouseId":"'$WH'","lines":[
        {"variantId":"'$V'","quantity":"-3.000","reason":"DAMAGE","note":"Sindirilgan"}]}'

# The stock card for one variant
curl -s "$API/inventory/movements?variantId=$V" -H "Authorization: Bearer $TOKEN"

# A stocktake, end to end
curl -s -X POST "$API/inventory-counts" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"warehouseId":"'$WH'"}'
curl -s -X PATCH "$API/inventory-counts/$C/items" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"variantId":"'$V'","countedQuantity":"47.000"}]}'
curl -s -X POST "$API/inventory-counts/$C/finalize" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'
```

---

## Sales and checkout

One rule shapes this whole module: **the server recalculates every financial
figure.** The request says what the customer wants and how they paid. It never
says what anything costs.

A client-supplied `totalAmount` is not compared against the server's and
rejected — it is not a field at all, so `forbidNonWhitelisted` returns 400 and
the request never reaches the pricing code. A field nobody reads cannot be
tampered with.

### The calculation pipeline

Executed in exactly this order (*§10.3*), as pure functions in
[pricing.ts](src/sales/pricing.ts) so it can be tested without a database, a
request or a clock:

```
 1  gross        = roundHalfUp(unit_price × quantity)     per line
 2  line_discount = min(requested, gross)                 never negative
 3  subtotal      = Σ (gross − line_discount)
 4  order_discount = min(requested, subtotal)
 5  allocate(order_discount, weights = each line's value AFTER its own discount)
 6  net_amount   = gross − line_discount − allocated_order_discount
 7  tax          = 0                                      reserved
 8  rounding     = cash rounding, only if the tender is entirely cash
 9  total        = subtotal − order_discount + tax + rounding
10  Σ payments + credit must equal total, EXACTLY, or 422
```

Step 5's weights matter: allocating the order discount over *gross* would
over-discount the lines that already had one. `allocate()` distributes the
remainder deterministically so the parts sum to exactly the whole (*§8.4*) —
splitting 1,000 three ways by rounding each share independently gives 999 and a
receipt that is one soʻm out.

> **A note on `subtotal_amount`.** §10.3 step 7 says "subtotal ← Σ net_amount",
> while §5.5's CHECK says "total = subtotal − order_discount + tax + rounding".
> Those are only compatible under one reading: `subtotal_amount` is the
> **pre-order-discount** figure. That is what is stored, it is the number a
> receipt prints above the discount line, and both identities then hold:
> `total = subtotal − order_discount + …` and `Σ net_amount = subtotal −
> order_discount`. A unit test asserts both.

Step 10 is `=`, not `>=`. An over-tender is change the client computes from
`tendered − total`; the drawer never sees it, and storing tendered-and-change
would double-count (*§11.4*).

### The checkout transaction

```
BEGIN
  ├─ idempotency record        INSERT … ON CONFLICT → replay
  ├─ sale_number               DocumentCounter UPDATE … RETURNING
  ├─ INSERT sale + sale_item[]
  ├─ inventory.apply(SALE, −qty)  per line, sorted by variant  → may 409
  ├─ INSERT payment[] + payment_allocation[]
  └─ INSERT customer_receivable   if credit > 0
COMMIT
  → audit
```

All of it, or none of it. There is no window in which the stock has moved but
the money has not been recorded, because there is no second transaction.

Stock is deducted through `InventoryService.apply()`, the same write path
everything else uses, so a sale is an ordinary entry in the ledger rather than
a special case — and the reconciliation query in *§9.7* still returns nothing
after a day's trading.

### Prices and permissions

| What the client may send | What the server does |
|---|---|
| `variantId`, `quantity` | trusted — this is the order |
| `unitPrice` | **403** unless `sales.override_price`; otherwise catalogue price |
| `discountAmount` (line) | **403** unless `sales.discount_item` |
| `orderDiscountAmount` | **403** unless `sales.discount_order` |
| `creditAmount` | **403** unless `debt.create`; requires a customer |
| anything else financial | **400** — the field does not exist |

`unit_cost` is snapshotted from `inventory_level.avg_cost` at the moment of
sale, and `name_snapshot` / `sku_snapshot` freeze what the receipt said. Rename
a product tomorrow and last month's receipt is unchanged; margin is a
subtraction on stored values rather than a lookup of a price that has since
moved.

### Mixed payment

```
Payment                    — money moved: how much, which method
  └─ PaymentAllocation[]   — what that money settled (a sale, or a debt)
```

The architecture's worked example, and a test:

| | |
|---|---|
| Sale total | 450,000 |
| `payment` CASH | 200,000 → `allocation` → sale |
| `payment` CARD | 150,000 → `allocation` → sale |
| `customer_receivable` | 100,000, `OPEN` |

`paid_amount + credit_amount = total_amount` is a **database CHECK**, not a
convention. So is `total = subtotal − order_discount + tax + rounding`, and so
is `net_amount = gross − line_discount − allocated_order_discount` per line. A
sale whose own figures disagree cannot be persisted, whatever a future code
path does.

A debt payment in Sprint 6 uses the same two tables. No debt-specific payment
table, and no second copy of the cash-drawer logic.

`payment_allocation` is append-only, enforced by trigger — an allocation that
can be edited is a payment history that can be rewritten.

### Idempotency

`Idempotency-Key: <uuid v4>` is **required** on checkout; missing → 400. Not
optional-with-a-fallback: a server-generated key makes every request unique,
which is exactly the property idempotency exists to remove.

```
INSERT idempotency_record (IN_PROGRESS)  ── in the same transaction as the sale
   conflict? ─ hash differs      → 409 IDEMPOTENCY_KEY_REUSED
             ─ still IN_PROGRESS → 409 REQUEST_IN_PROGRESS
             ─ COMPLETED         → replay the stored response
```

The record commits **with the sale**, so "the sale committed but the record did
not" is not a reachable state. It is implemented as a service the handler calls
rather than the interceptor the architecture sketched, because an interceptor
sits outside the handler's transaction and could not make that guarantee.

Rollback gives §26.2's "failure → delete the record" for free: a checkout that
fails on stock takes its `IN_PROGRESS` row with it, and the same key can be
retried. A test asserts exactly that.

**Second layer.** Keys are client cooperation, and a client that regenerates
one defeats them. So the money paths carry natural keys too, as database
constraints: `sale.client_id` and `payment.client_id` are unique per
organization, and `customer_receivable.sale_id` is unique, so one sale can
never spawn two debts.

### Cancellation

A completed sale is never deleted and its figures are never rewritten.

```
status → CANCELLED (+ reason, mandatory)
stock  → a compensating RETURN movement
money  → an opposite-direction payment, allocated to the same sale
debt   → written off, never deleted
```

The claim is a conditional `UPDATE … WHERE status = 'COMPLETED'`, the same
shape as the stock guard, so two cancellations of one sale cannot both restore
the stock. A sale that has already been returned against is refused: two
mechanisms undoing the same money is how a refund gets paid twice.

### What is deliberately not here

- **Cash register shifts.** `sale.cash_register_shift_id` is in the
  architecture and is not in this schema. Shifts are their own sprint, and a
  nullable UUID column with no table behind it is a lie in the schema; adding
  the column later is a one-line migration.
- **Customer CRUD.** Sprint 5 creates the `customer` table and the foreign key
  because a credit sale needs somebody to owe the money. The screens are
  Sprint 6's, which owns that domain.
- **Drafts / held carts.** `SaleStatus.DRAFT` exists in the enum; nothing
  writes it. The fast path is a single `POST /sales/checkout`, and a parked
  cart is a screen nobody has asked for yet.
- **Promotions and loyalty.** `LOYALTY` tender is rejected with a 422 naming
  the sprint that will support it, rather than accepted and silently ignored.

### Endpoints

| Method | Path | Permission |
|---|---|---|
| `POST` | `/sales/checkout` | `sales.create` + `Idempotency-Key` |
| `GET` | `/sales` | `sales.read` |
| `GET` | `/sales/:id` | `sales.read` |
| `GET` | `/sales/:id/receipt` | `sales.read` |
| `POST` | `/sales/:id/cancel` | `sales.cancel` |

POS product lookup is already the catalog's: `GET /products/lookup?barcode=…`
is a single index hit, and `GET /products?q=…` searches name, SKU and barcode.
No second search endpoint.

```bash
# A cash sale
curl -s -X POST "$API/sales/checkout" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"items":[{"variantId":"'$V'","quantity":"3.000"}],
       "payments":[{"method":"CASH","amount":72000}]}'

# Mixed: cash + card + credit
curl -s -X POST "$API/sales/checkout" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"items":[{"variantId":"'$V'","quantity":"10.000"}],
       "payments":[{"method":"CASH","amount":200000},
                   {"method":"CARD","amount":150000}],
       "creditAmount":100000,"customerId":"'$C'"}'

# The day's takings
curl -s "$API/sales?dateFrom=2026-09-21T00:00:00Z&limit=50" \
  -H "Authorization: Bearer $TOKEN"

# Receipt, built entirely from stored values
curl -s "$API/sales/$SALE/receipt" -H "Authorization: Bearer $TOKEN"
```

---

## Customers and debt

**No debt may disappear, and no payment may disappear.** Everything below
follows from that.

There is no `customer.debt` column and there never will be. A customer's
balance is `SUM(original − paid − written_off)` over their open receivables,
computed every time it is asked for. A mutable balance is a number that drifts
from the documents it summarises, and the transaction that forgets to update it
is the one nobody notices.

If that aggregate ever becomes slow it becomes a materialized view, not a
column.

### The receivable

One document per debt, never a running total:

| Column | |
|---|---|
| `original_amount` | what was owed. Never rewritten. |
| `paid_amount` | sum of this debt's payment allocations |
| `written_off_amount` | a loss. Never netted into `paid_amount`. |
| `status` | `OPEN` → `PARTIALLY_PAID` → `PAID` / `WRITTEN_OFF` |

`remaining_amount` is deliberately **not** a column. The architecture proposed
a `GENERATED ALWAYS … STORED` column because it could not then drift from its
inputs; not storing it at all achieves the same thing more simply, and
`CHECK (paid + written_off <= original)` makes over-payment impossible at the
database level rather than merely unlikely.

A sale's debt is born inside the checkout transaction, where it commits with
the sale that caused it. `customer_receivable.sale_id` is UNIQUE, so one sale
can never spawn two debts — whatever a retrying client does.

### `OVERDUE` is not a status

It is `remaining > 0 AND due_date < CURRENT_DATE`, evaluated in the query.

Making it a status would need a nightly job to flip rows, and every row would
be lying from midnight until that job ran. The filters the UI needs are all
predicates, and all served by one partial index:

| `?filter=` | Predicate |
|---|---|
| `overdue` | open **and** `due_date < today` |
| `due_today` | open **and** `due_date = today` |
| `due_soon` | open **and** due within 7 days |
| `unpaid` / `partially_paid` / `paid` / `written_off` | the stored status |

The customer list applies the same predicates as aggregates, so `?overdue=true`
and `?sort=debt:desc` are one query rather than a page of customers plus a debt
query per row.

### Collecting

```
Payment (IN, 100,000, CASH)
  └─ PaymentAllocation → receivable   (one per debt it settled)
```

The same two tables a sale payment uses. No debt-specific payment table, and no
second copy of the cash-drawer logic.

Unspecified targets are paid **oldest due first** — what a shopkeeper does by
hand, and the ordering that minimises how long anything stays overdue. Explicit
`receivableIds` override it.

Each allocation is applied with a conditional `UPDATE`:

```sql
UPDATE customer_receivable
   SET paid_amount = paid_amount + $part, status = CASE … END
 WHERE id = $id
   AND paid_amount + written_off_amount + $part <= original_amount;
```

Two cashiers collecting against the same debt at the same moment cannot
together push it past `original_amount`: one matches zero rows and gets a 409.
The same shape as the stock guard, for the same reason.

**Over-payment is rejected, not absorbed** (*§12.5*). A payment larger than the
outstanding debt returns `409 RECEIVABLE_OVERPAYMENT` with the excess in the
payload, and **nothing is written** — not even the part that would have fitted.
Store credit is the other reasonable answer and needs a credit balance, a
redemption tender and an expiry policy, none of which the design has.

Debt payments are idempotent: `Idempotency-Key` is required, and the record
commits with the payment.

### Write-off

`POST /debts/:id/write-off` requires `debt.write_off` and a reason — mandatory
in the DTO *and* in the database.

A write-off is **never** added to `paid_amount`. A write-off is a loss and a
collection is revenue; a report that conflates them is a report that hides the
losses. Both are kept, and the balance endpoint returns `lifetimePaid` and
`lifetimeWrittenOff` separately.

### Groups and notes

A customer belongs to at most one **group** (VIP, Ulgurji, Doimiy), which
carries a discount percentage — read by Sprint 9 — and a credit limit. Credit
resolves customer → group → unlimited, and the customer card states which one
applied, because a cashier refused at the counter needs to know what stopped
them.

Groups rather than free-form tags: the design shows one badge per customer, and
a group carries numbers a tag could not. A many-to-many tag table would serve a
screen that does not exist.

**Notes are an append-only log**, enforced by trigger. "Called, promised
Friday" is worth having precisely when the promise is not kept, and a single
editable text field would let it be rewritten by the person who broke it.

### Archiving

A customer is archived, never deleted — their sales and receivables name them
forever. **A customer who still owes money cannot be archived**: hiding a
debtor is how a debt stops being collected without anybody deciding to stop
collecting it.

### Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` `POST` | `/customers` | `customers.read` / `customers.create` |
| `GET` `PATCH` | `/customers/:id` | `customers.read` / `customers.update` |
| `GET` | `/customers/:id/balance` `…/debts` `…/payments` | `debt.read` |
| `GET` | `/customers/:id/sales` | `customers.read` |
| `POST` | `/customers/:id/notes` | `customers.update` |
| `PATCH` | `/customers/:id/archive` `…/restore` | `customers.delete` / `.update` |
| `GET` `POST` `PATCH` | `/customer-groups` | `customers.read` / `customers.update` |
| `GET` | `/debts`, `/debts/:id` | `debt.read` |
| `POST` | `/debts` | `debt.create` |
| `POST` | `/debts/payments` | `debt.pay` + `Idempotency-Key` |
| `POST` | `/debts/:id/write-off` | `debt.write_off` |

```bash
# Who owes money, most first
curl -s "$API/customers?hasDebt=true&sort=debt:desc" -H "Authorization: Bearer $TOKEN"

# The collections list
curl -s "$API/debts?filter=overdue&sort=dueDate:asc" -H "Authorization: Bearer $TOKEN"

# Collect 100,000 - spread over the oldest debts first
curl -s -X POST "$API/debts/payments" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"customerId":"CUSTOMER_ID","amount":100000,"method":"CASH"}'

# Give up on the rest, with a reason that stays in the audit log
curl -s -X POST "$API/debts/DEBT_ID/write-off" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"Mijoz bilan kelishildi"}'
```

---

## Suppliers and purchases

Receiving is the only path in the system that creates stock out of nothing, so
it is the one guarded hardest.

### Lifecycle

```
DRAFT ──order──▶ ORDERED ──receive──▶ PARTIALLY_RECEIVED ──receive──▶ RECEIVED
  └───────────────┴── cancel, only while nothing received and nothing paid
```

`order: true` on creation skips DRAFT, because a shopkeeper phoning an order in
has no use for a draft. Lines are editable only in DRAFT — an order already
sent to the supplier is a commitment, not a scratchpad.

**Payment state is separate from receipt state.** A purchase can be `RECEIVED`
and unpaid, or paid and not yet delivered. Conflating them into one status is
why so many systems cannot answer "what do we owe".

### Receiving

`POST /purchases/:id/receive` is **repeatable** — three deliveries against one
order produce three calls and three sets of movements. Omit `items` and
everything still outstanding is taken as delivered, which is the common case.

Per line, in one transaction:

```sql
UPDATE purchase_item
   SET received_quantity = received_quantity + $qty
 WHERE id = $id
   AND received_quantity + $qty <= ordered_quantity;   -- BR-16
```

Zero rows → **409 `OVER_RECEIPT`**, with the outstanding quantity in the
payload. Two clerks booking in the same pallet cannot together exceed the
order: one of them loses.

Over-receipt is refused rather than silently accepted. A delivery larger than
the order is a real event, but it is a *purchase amendment* — treating it as an
automatic quantity bump is how phantom stock appears.

Stock then moves through `InventoryService.apply()` like everything else, so a
receipt is an ordinary `PURCHASE` entry in the ledger rather than a special
case, and §9.7's reconciliation still returns nothing afterwards. The unit cost
travels with the receipt, which is what rolls the level's moving average
forward (*§8.6*) — and `unitCost` may be corrected at receipt time when the
invoice disagrees with the order.

**`Idempotency-Key` is required.** Receiving the same delivery twice adds real
stock that does not exist; it is the second-most expensive duplicate in the
system after a double refund.

### Costing

`purchase_item.unit_cost` is the supplier's unit price. `shipping_amount` and
`discount_amount` sit at the purchase header and are **not** allocated into
unit costs. Landed cost is a real feature, but it needs an allocation basis —
by value, by weight, by quantity — that nobody has specified. When it arrives,
`allocate()` does the work and only the receiving code changes.

The database checks the arithmetic:
`total = subtotal − discount + shipping`, and `paid <= total`.

### Payables

A supplier's balance is **derived, never stored**:

```
payable = Σ(total − paid) over committed purchases − unapplied on-account payments
```

There is no `supplier.balance` column, for the same reason there is no
`customer.debt` column.

`supplier_payment.purchase_id` is nullable:

- **set** — settles that invoice under `paid + $amount <= total`; zero rows →
  **409 `SUPPLIER_OVERPAYMENT`**. Two managers settling one invoice cannot
  together overpay it.
- **null** — a payment on account. It reduces the net payable and shows as
  **unapplied credit** rather than being silently absorbed, because a
  shopkeeper who has paid in advance should be able to see that they have.

Partial payment is the normal case: pay 800,000 against 1,250,000 and the
remaining 450,000 stays outstanding while the purchase remains `RECEIVED`.

`supplier_payment` is **append-only**, enforced by trigger. Money that has left
the business is not editable; a payment recorded wrongly is corrected by
another payment, exactly as in the customer ledger.

> There is deliberately no "apply this on-account payment to that invoice
> later" endpoint, which §16.2 sketches. Applying it would mean rewriting a
> payment record, and the statement already shows both sides. Bookkeeping the
> design does not ask for.

### Statement

`GET /suppliers/:id/statement?from=&to=` merges purchases (debits) and payments
(credits) chronologically with a running balance, from one `UNION ALL`. No
table backs it.

```
2026-09-22  PURCHASE  PO-000001   debit 1 250 000                → 1 250 000
2026-09-22  PAYMENT   TP-4412                    credit 800 000 →   450 000
```

### Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` `POST` | `/suppliers` | `suppliers.read` / `suppliers.create` |
| `GET` `PATCH` | `/suppliers/:id` | `suppliers.read` / `suppliers.update` |
| `GET` | `/suppliers/:id/balance` | `suppliers.read` |
| `GET` | `/suppliers/:id/purchases` `…/payments` `…/statement` | `purchases.read` |
| `PATCH` | `/suppliers/:id/archive` `…/restore` | `suppliers.update` |
| `POST` | `/suppliers/payments` | `purchases.pay` + `Idempotency-Key` |
| `GET` `POST` | `/purchases` | `purchases.read` / `purchases.create` |
| `GET` `PATCH` | `/purchases/:id` | `purchases.read` / `purchases.create` |
| `POST` | `/purchases/:id/order` | `purchases.create` |
| `POST` | `/purchases/:id/receive` | `purchases.receive` + `Idempotency-Key` |
| `POST` | `/purchases/:id/cancel` | `purchases.cancel` |

A supplier we still owe cannot be archived — the same rule as a customer who
owes us, for the same reason.

**Role change:** `purchases.cancel` was added to MANAGER in this sprint. A
manager who may raise a purchase order but not cancel their own unreceived one
has to ask an administrator to undo a typo, and cancellation is already
guarded: impossible once anything has been received or paid.

```bash
# Order 100 units, straight to the supplier
curl -s -X POST "$API/purchases" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"supplierId":"SUP","items":[{"variantId":"V","quantity":"100.000","unitCost":12000}],
       "shippingAmount":50000,"order":true}'

# 60 arrive today
curl -s -X POST "$API/purchases/$PO/receive" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"items":[{"variantId":"V","quantity":"60.000"}],"supplierInvoiceNumber":"INV-5521"}'

# the other 40 next week - no body needed
curl -s -X POST "$API/purchases/$PO/receive" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d '{}'

# Pay part of the invoice
curl -s -X POST "$API/suppliers/payments" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"supplierId":"SUP","purchaseId":"PO","amount":800000,"method":"TRANSFER","reference":"TP-4412"}'

# Who do we owe, most first
curl -s "$API/suppliers?hasPayable=true&sort=payable:desc" -H "Authorization: Bearer $TOKEN"
```

---

## Returns and exchanges

A return is a **compensating transaction**. The original sale is never deleted
and its figures are never rewritten — only `refunded_amount` and
`return_status` move, and both are derived from the returns that reference it.
A receipt reprinted next year still says what it said on the day.

### The quantity guard

```
returnable = sale_item.quantity − sale_item.returned_quantity
```

Enforced as a conditional `UPDATE`, in the same transaction as everything else:

```sql
UPDATE sale_item
   SET returned_quantity = returned_quantity + $qty,
       refunded_amount   = refunded_amount   + $refund
 WHERE id = $saleItemId
   AND returned_quantity + $qty <= quantity;
```

Zero rows → **409 `RETURN_QUANTITY_EXCEEDED`**, carrying the actual returnable
quantity so the client can correct itself. Sold 10, returned 3, asked for 8:
refused, with `returnable: "7.000"` in the payload. Two parallel returns of the
last unit: exactly one succeeds.

`CHECK (returned_quantity <= quantity)` is the backstop if a future code path
forgets the guard — it turns a data-corruption bug into a failed transaction.

`GET /returns/returnable/:saleId` gives the POS the per-line numbers before it
draws the screen, so the cashier never types a quantity the server will reject.

### The refund, and the rounding trap

The refund reflects the line's **net** amount — after its own discount *and*
its share of the order discount. A customer who bought at a discount is
refunded at that discount, not at the list price.

```
unit_refund = roundHalfUp(sale_item.net_amount × return_qty, sale_item.quantity)
```

That drifts. Three returns of 1 unit from a line of 3 at net 100,000 give
33,333 × 3 = 99,999, leaving one soʻm the customer never gets back.

**On the return that closes the line**, the refund is the exact remainder:

```
unit_refund = sale_item.net_amount − sale_item.refunded_amount
```

The last return sweeps up the residue and the line always reconciles to zero.
Same technique as `allocate()`, applied over time instead of across lines — and
there is a test that returns 1, 1, 1 from a line of 3 and asserts the three
refunds sum to exactly the line's net.

### Restock

| `restock` | `condition` | Effect |
|---|---|---|
| `true` | `SELLABLE` | `RETURN` movement, `+qty`, into the return's warehouse |
| `false` | any | no movement |
| any | `DAMAGED` | no movement — and the database enforces it |

Damaged goods never re-enter sellable stock. If they physically came back and
are being scrapped, the operator records a separate `DAMAGE` movement:
"returned" and "written off" are different facts, and merging them hides
shrinkage.

### Where the money goes

Decided by the sale's payment state, in this order (*§13.5*):

1. **An open receivable on the sale is offset first.** Refunding cash to
   somebody who still owes you money is a mistake the system should not make on
   its own. The offset is a `Payment IN` allocated to the receivable, so its
   `paid_amount` rises through the same guarded `UPDATE` as any other
   collection. `written_off_amount` is **not** touched — that column means bad
   debt, and a return is not bad debt.
2. **Whatever exceeds the debt** becomes a `Payment OUT` allocated to the
   return.

Return 3 of 5 on a sale that was 400,000 cash + 100,000 credit: 100,000 clears
the debt, 200,000 comes back as cash, and the balance lands on zero — never
below it.

### Return window

`organization_settings.return_window_days`, default 14, zero means no limit.
Outside the window a return needs `sales.refund_expired` and always leaves an
audit trail. A manager holds `sales.refund` but not `sales.refund_expired`, so
an old return is an explicit escalation rather than something that quietly
works.

### Idempotency

Mandatory. A double-tapped refund button that pays a customer twice is the
single most expensive bug a POS can ship.

### Exchanges

An exchange is **a return and a sale that happen together**, linked by one
`Exchange` row. Modelling it as a third kind of line-item document would
duplicate the stock logic, the refund logic and the debt logic that both
already implement with their guards.

```
net_amount = replacement_value − returned_value
```

| Case | `net` | Settlement |
|---|---|---|
| return 500,000 → take 650,000 | +150,000 | `CUSTOMER_PAID` |
| return 500,000 → take 500,000 | 0 | `EVEN` |
| return 650,000 → take 500,000 | −150,000 | `REFUNDED` |
| return 500,000 → take 650,000, on credit | +150,000 | `CREDITED_TO_DEBT` |

A `CHECK` ties the settlement to the sign of the net, so an `EVEN` exchange
that owes money cannot be persisted.

**Only the net moves as money.** Recording 500,000 out and 650,000 in would
double-count the day's revenue, make the drawer expect 500,000 that never left
it, and ask the cashier to handle cash they never touched.

> The goods handed back still have to settle the replacement sale, which must
> satisfy `paid + credit = total`. They are recorded as an allocation of method
> `OTHER` — a **trade-in**, neither cash nor credit. The only `CASH` row is the
> net that actually crossed the counter, so the drawer stays honest while the
> sale still reconciles against its own allocations. This is not in §14.4,
> which describes the cash movement only; without it the replacement sale's
> arithmetic has no legal value.

Both stock legs are ordinary movements: `RETURN +1` of the old variant,
`SALE −1` of the new one with its normal insufficient-stock guard. **If the
replacement is out of stock the whole exchange fails and nothing is written** —
which comes free from running both legs in one transaction.

### Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` | `/returns` | `sales.read` |
| `GET` | `/returns/returnable/:saleId` | `sales.read` |
| `GET` | `/returns/:id` | `sales.read` |
| `POST` | `/returns` | `sales.refund` + `Idempotency-Key` |
| `POST` | `/exchanges` | `sales.refund` + `Idempotency-Key` |

A cashier may sell but not refund. A sale that has been returned against can no
longer be cancelled: two mechanisms undoing the same money is how a refund gets
paid twice.

```bash
# What can still come back
curl -s "$API/returns/returnable/$SALE" -H "Authorization: Bearer $TOKEN"

# Return 1 of 3, damaged - money back, goods stay off the shelf
curl -s -X POST "$API/returns" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"saleId":"SALE","items":[{"saleItemId":"LINE","quantity":"1.000","condition":"DAMAGED"}],
       "reason":"DEFECTIVE"}'

# Swap it for something dearer - the customer pays only the difference
curl -s -X POST "$API/exchanges" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"saleId":"SALE","returnItems":[{"saleItemId":"LINE","quantity":"1.000"}],
       "replacementItems":[{"variantId":"V2","quantity":"1.000"}],"reason":"WRONG_ITEM"}'
```

---

## Discounts, promotions and loyalty

### Two levels, one winner each

| Level | Stored on | Set by |
|---|---|---|
| Item | `sale_item.line_discount_amount` | manual line discount, or an `ITEM` promotion |
| Order | `sale.order_discount_amount`, allocated per line | manual order discount, a customer group's standing percent, or an `ORDER` promotion |

Both are stored as **money amounts**, never percentages. A percentage is an
input; the resolved amount is the fact. Storing the percent means every read
recomputes, and the recomputation drifts the moment a rounding rule changes.

### Promotions do not stack

At each level exactly one wins, by `priority DESC, value DESC`. A manual
discount beats a promotion only if it is larger.

Stacking needs a combinability matrix, an application order, and an answer for
what "20% off plus 10,000 off" means applied the other way round. None of that
is specified, and inventing it produces a system where the cashier cannot
predict the price. Non-stacking is explicit, testable and reversible.

The resolution lives in [promotions.ts](src/sales/promotions.ts) — pure
functions, no database and no clock, so every rule is testable in a
millisecond. The service that owns the rows is separate and only reads them.

### Calculation order — normative

```
1.  gross      = roundHalfUp(unit_price × quantity)              per line
2.  line_disc  = max(best ITEM promotion, manual line discount)  capped at gross
3.  subtotal₀  = Σ (gross − line_disc)
4.  order_disc = best of { manual, ORDER promotion, group % }    capped at subtotal₀
5.  allocate(order_disc, weights = gross − line_disc)            sums exactly
6.  net        = gross − line_disc − allocated_order_discount    per line
7.  subtotal   = Σ (gross − line_disc)          ← the pre-order-discount figure
8.  tax        = 0                                               reserved
9.  rounding   = cash rounding, cash tenders only
10. total      = subtotal − order_disc + tax + rounding
11. loyalty redemption applies HERE, as a payment — not as a discount
```

An item promotion then an order promotion: 100,000 − 10% line = 90,000, then
− 10% order = **81,000**. Applying both to the gross would have given 80,000,
and a later partial return would refund the wrong amount.

A percentage can carry a `maxDiscount`, so "50% off" on a large basket does not
become an unbounded giveaway. Nothing can take a line below zero.

### Targeting and eligibility

| | |
|---|---|
| `appliesTo` | `ALL`, `CATEGORY` (+ `categoryIds`), `PRODUCT` (+ `productIds`) |
| `customerGroupIds` | empty = everybody; populated = only those groups, **never a walk-in** |
| `startsAt` / `endsAt` | the window; `endsAt` null means open-ended |
| `minSubtotal` | for `ORDER`, checked against the subtotal **after** line discounts |
| `maxUses` / `usedCount` | a campaign that has run out stops applying |

A `CHECK` refuses a targeted promotion that targets nothing — "CATEGORY, no
categories" silently means "nothing", so the campaign never fires while the
screen looks entirely correct.

A promotion is **deactivated, never deleted**: sales reference the campaign
that priced them, and one nobody can look up afterwards is a discount nobody
can explain.

### Loyalty

```
LoyaltyAccount.points_balance   CACHE — convenient, never authoritative
  └── LoyaltyTransaction[]      APPEND-ONLY — the truth
        EARN | SPEND | ADJUSTMENT | EXPIRY
```

The same projection-plus-ledger shape as inventory, for the same reason. The
cache is only ever written inside the transaction that writes the ledger row,
so `points_balance = SUM(points_delta)` (BR-10) is assertable at any moment —
and the suite asserts it.

Points move through one method that mirrors `InventoryService.apply()`: a
conditional `UPDATE` that both mutates and guards, then the ledger row carrying
the balance that resulted. Zero rows means the balance would have gone
negative: **points that were never earned cannot be spent**, and two tills
cannot redeem the same points.

| Setting | |
|---|---|
| `loyalty_earn_percent` | percent of the sale's subtotal earned as points |
| `loyalty_point_value` | money minor units one point redeems for |

Points are earned on the **subtotal** — the net of discounts — so cash rounding
does not leak into loyalty and a discounted sale does not also generate full
points.

### Redemption is a payment, not a discount

This is the distinction the whole module turns on.

A discount reduces revenue. A redemption settles revenue with a liability the
store already recognised when the points were earned. Treating redemption as a
discount understates revenue, corrupts margin, and makes the outstanding points
liability invisible.

So `{ "method": "LOYALTY", "amount": 5000 }` is an ordinary tender in
`payments[]`, it creates a `Payment` of method `LOYALTY` allocated to the sale,
and `subtotal_amount` does not move:

```
sale total     100,000      ← unchanged
payments       LOYALTY 5,000 + CASH 95,000
points          −5,000 SPEND, then +1,000 EARN on this sale
```

### Returns reverse the points

Proportionally to the returned value, **clamped at the balance**. If the
customer has already spent them, the shortfall is recorded in `reason` rather
than driving the balance negative — clawing back points somebody already used
is a policy decision, not a default.

### What is deliberately not here

- **`BUY_X_GET_Y`** — needs a free-item line, its own returns behaviour and a
  stock effect, none of which the design specifies. `PERCENT_OFF` and
  `FIXED_OFF` cover every screen that exists.
- **Point expiry** — the `expires_at` column exists and nothing writes it.
  Expiry needs a policy (rolling window? calendar year? per-transaction FIFO?)
  that has not been specified. When it arrives it is a cron job inserting
  `EXPIRY` rows; the column is there so the ledger never needs migrating.
- **A discount ceiling per role** — `max_discount_percent` is a natural next
  step and no screen specifies it.

### Endpoints

| Method | Path | Permission |
|---|---|---|
| `GET` | `/promotions`, `/promotions/:id` | `promotions.read` |
| `POST` `PATCH` | `/promotions`, `/promotions/:id`, `…/deactivate` | `promotions.manage` |
| `GET` | `/loyalty/:customerId`, `…/history` | `loyalty.read` |
| `POST` | `/loyalty/:customerId/adjust` | `loyalty.adjust` |

```bash
# 15% off one product, from yesterday, no end date
curl -s -X POST "$API/promotions" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Kuzgi 15%","type":"PERCENT_OFF","scope":"ITEM","value":15,
       "appliesTo":"PRODUCT","productIds":["PRODUCT_ID"],"startsAt":"2026-09-21T00:00:00Z"}'

# Pay partly with points - a tender, not a discount
curl -s -X POST "$API/sales/checkout" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"items":[{"variantId":"V","quantity":"1.000"}],
       "payments":[{"method":"LOYALTY","amount":153},{"method":"CASH","amount":15147}],
       "customerId":"CUSTOMER_ID"}'

# The ledger behind the balance
curl -s "$API/loyalty/$CUSTOMER/history" -H "Authorization: Bearer $TOKEN"
```

---

## Foundation behaviour worth knowing

**API versioning.** URI-based: every route lives under `/api/v1/...`. The
version is in the path, not a header, so a URL in a log or a bug report is
unambiguous.

**Validation.** Global `ValidationPipe` with `whitelist`,
`forbidNonWhitelisted` and `transform`. An unknown field is a **400**, not a
silent drop — an unexpected field means the client and server disagree about
the contract, and failing loudly finds that in development.

**Errors.** RFC 9457 shaped (*§23.2*):

```jsonc
{
  "type": "https://docs.retailos.uz/errors/validation-failed",
  "title": "Validation failed",
  "status": 400,
  "code": "VALIDATION_FAILED",
  "detail": "One or more fields are invalid.",
  "traceId": "0192f3c1-8a4e-7c3d-b1e2-5f6a7b8c9d0e",
  "timestamp": "2026-09-17T10:00:00.000Z",
  "errors": [{ "field": "name", "code": "VALIDATION_FAILED", "message": "name must be a string" }]
}
```

Branch on `code` — it is stable forever. `title` and `detail` are for humans
and may be reworded. Only deliberately-constructed errors describe themselves;
anything unexpected is logged in full and returned as a bare `500` carrying
nothing but a `traceId`, in **every** environment including development.

**Correlation id.** Every request gets one. A client-supplied `X-Request-Id` is
honoured *only if it is a valid UUID* — an unvalidated inbound header is a
log-injection vector. The id is returned in the `X-Request-Id` response header,
appears in every log line, and is the `traceId` in any error body.

**Money.** A `bigint` count of the organization currency's minor units. UZS has
exponent 0, so `450000` means 450,000 so'm. Money is serialized as a JSON
integer. There is no `Money` class — a `bigint` *is* the type, so
`price * 1.2` is a `TypeError` rather than a silent float (*§8*).

**Idempotency.** `Idempotency-Key: <uuid v4>` is required on any endpoint that
moves money or stock and could plausibly be submitted twice. The record is
written in the same transaction as the work, so a replay is exact and a failure
frees the key (*§26*).

**Quantities.** A decimal string with three decimal places (`"1.500"`), in
requests as well as responses. Stock is `NUMERIC(14,3)` — 1.5 kg of rice is a
real quantity — and a string keeps the parsing decision in the one place that
knows the scale. The client here is a Flutter app whose `double` loses
`0.1 + 0.2` exactly as JavaScript's does.

**Security baseline.** Helmet (HSTS in production, `X-Frame-Options: DENY`,
`no-referrer`), an explicit CORS allow-list, a 1 MB body limit, and global rate
limiting. Health probes skip the throttle so monitoring cannot trip it.

---

## Roadmap

Sprint 1 is the foundation. Phases follow *§33 Implementation order*:

| Sprint | Contents | Gate |
|---|---|---|
| **1 ✅** | Foundation: config, Prisma, errors, logging, health, Docker, tests | `docker compose up` serves `/health`; money tests green |
| **2 ✅** | Tenancy & auth: Organization, Store, Warehouse, User, Role, StoreMembership, JWT + refresh rotation, guard chain, Prisma tenant extension, audit service | the tenant-isolation suite passes |
| **3 ✅** | Catalog: Category, Product, ProductVariant, barcode lookup, search | the catalog suite passes |
| **4 ✅** | Inventory: levels, the movement ledger, the single `apply()` write path, warehouses, counts, transfers | the projection equals the ledger under parallel load |
| **5 ✅** | Sales / POS: pricing pipeline, checkout transaction, mixed payments, idempotency, cancellation | a sale's own figures cannot disagree — the database checks them |
| **6 ✅** | Customers & debt: groups, notes, receivables, FIFO collection, write-off | no debt and no payment can disappear; over-payment is refused |
| **7 ✅** | Procurement: suppliers, purchase orders, partial receiving, payables | over-receipt and over-payment are both refused by the database |
| **8 ✅** | Returns & exchanges: quantity guard, net refunds, debt offset, net settlement | a line can never be over-returned, and a partial return strands no soʻm |
| **9 ✅** | Discounts, promotions and loyalty: one winner per level, points as a tender | a balance always equals its own ledger, and promotions never stack |
| 10+ | Cash register and shifts, reporting, notifications |

---

## Known issues

**`npm audit` reports 4 high advisories** in `mysql2` and `deepmerge-ts`. Both
are transitive dependencies of the **Prisma CLI**, which is a `devDependency`
and is excluded from the runtime image by `npm prune --omit=dev`. `mysql2` is
never loaded — the datasource is PostgreSQL — and `deepmerge-ts` only merges
our own `prisma.config.ts`. `npm audit fix --force` would downgrade Prisma to
v6, a major regression, so the advisories are accepted and tracked rather than
"fixed". Re-check on each Prisma release.
