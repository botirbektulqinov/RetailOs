# RetailOS — Backend

Retail management platform for small stores, designed to grow into a
multi-tenant SaaS without a rewrite. NestJS modular monolith on PostgreSQL.

**Current state: Sprint 1 — engineering foundation.** No business endpoints
exist yet; see [Roadmap](#roadmap).

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
npm run seed                  # verifies the schema is reachable

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
| **2** | Tenancy & auth: Organization, Store, Warehouse, User, Role, StoreMembership, JWT + refresh rotation, guard chain, Prisma tenant extension, audit service | **the tenant-isolation suite passes** — nothing proceeds until it does |
| 3 | Catalog: Category, Product, ProductVariant, barcode lookup, search |
| 4 | Inventory core: levels, movements, the single `apply()` write path |
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
