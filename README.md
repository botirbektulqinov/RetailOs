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
  common/
    money/                 Money primitives: bigint minor units (§8)
    dto/                   ListQueryDto, PagedResult (§27)
    exceptions/            BusinessRuleException + the error-code catalogue (§23)
    filters/               AllExceptionsFilter — the only place an error becomes a response
    http/                  request/correlation id
    logging/               pino options + redaction
prisma/
  schema.prisma            foundation only — no domain models yet
  schema.draft.prisma      the full 40-model draft, promoted sprint by sprint
  migrations/
  seed.ts
test/
  foundation.e2e-spec.ts
docs/
  ARCHITECTURE.md          the source of truth
```

Future feature modules (`auth/`, `catalog/`, `inventory/`, `sales/`, …) are
**not** scaffolded as empty folders. They are created by the sprint that
implements them — see *§30* for the planned layout and the module boundary
rules.

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
| **3 ✅** | Catalog: Category, Product, ProductVariant, barcode lookup, search |
| **4** | Inventory core: levels, movements, the single `apply()` write path |
| 5 | Cash register: registers, shifts, movements |
| 6 | Sales / POS: pricing pipeline, checkout transaction, payments, idempotency |
| 7+ | Customers & debt, returns & exchanges, procurement, counts & transfers, loyalty, reporting |

---

## Known issues

**`npm audit` reports 4 high advisories** in `mysql2` and `deepmerge-ts`. Both
are transitive dependencies of the **Prisma CLI**, which is a `devDependency`
and is excluded from the runtime image by `npm prune --omit=dev`. `mysql2` is
never loaded — the datasource is PostgreSQL — and `deepmerge-ts` only merges
our own `prisma.config.ts`. `npm audit fix --force` would downgrade Prisma to
v6, a major regression, so the advisories are accepted and tracked rather than
"fixed". Re-check on each Prisma release.
