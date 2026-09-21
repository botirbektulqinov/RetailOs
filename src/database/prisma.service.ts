import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { createTenantExtension } from '../common/tenant/tenant-extension';
import { AppConfig } from '../config/config.module';

/** The tenant-scoped client type, inferred from the extension. */
export type ScopedPrismaClient = ReturnType<PrismaClient['$extends']> extends infer T ? T : never;

/**
 * The transaction client every write path receives.
 *
 * Spelled out rather than imported from Prisma's internals: it is exactly
 * `ITXClientDenyList` applied to our extended client. `Prisma.TransactionClient`
 * is the UNextended type and an extended client is not assignable to it, which
 * is the error anyone typing a `tx` parameter hits first.
 */
export type Tx = Omit<
  PrismaService['db'],
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * The single PrismaClient for the process.
 *
 * Prisma 7 requires a driver adapter — the connection URL no longer lives in
 * schema.prisma — so the pg Pool is built here from validated config.
 *
 * The Pool is constructed explicitly rather than letting PrismaPg create one,
 * so shutdown can close it deterministically. Leaving it to the adapter left
 * sockets open and hung both app.close() in tests and SIGTERM in Docker.
 *
 * Deliberately NOT here: any migration behaviour. The application never runs
 * `migrate` at boot (docs/ARCHITECTURE.md §32.4) — two replicas racing to
 * migrate is a bad first production incident.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

  /**
   * The client every feature module must use.
   *
   * It applies the tenant isolation extension (§4.3): organization scoping is
   * injected into reads and creates, and a single-row operation targeted by
   * bare id is refused outright.
   */
  readonly db: ReturnType<typeof this.buildScopedClient>;

  constructor(config: AppConfig) {
    const pool = new Pool({
      connectionString: config.get('DATABASE_URL'),
      max: config.get('DATABASE_POOL_SIZE'),
      // Keep a failing database a fast failure rather than a hung request.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });

    super({ adapter: new PrismaPg(pool) });

    this.pool = pool;
    // An idle-client error (database restarted, network dropped) is emitted on
    // the pool, not on a query. Unhandled, it takes the process down.
    this.pool.on('error', (error: Error) => {
      this.logger.error(`Idle database client error: ${error.message}`);
    });

    this.db = this.buildScopedClient();
  }

  private buildScopedClient() {
    return this.$extends(createTenantExtension());
  }

  /**
   * The raw, UNSCOPED client. Every call site is a deliberate cross-tenant
   * operation and must say why in a comment.
   *
   * Legitimate uses: resolving a login by phone (the tenant is not known until
   * the user is found), seeding, and platform-level maintenance. Using it to
   * "make a query work" is how tenant isolation is lost, so it is named to be
   * obvious in review and greppable in CI.
   */
  asSystem(): PrismaClient {
    return this;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
    this.logger.log('Database connection closed');
  }

  /**
   * Cheap liveness probe for the health endpoint.
   *
   * `$queryRaw` with a tagged template, never `$queryRawUnsafe` — the unsafe
   * variant is banned project-wide (docs/ARCHITECTURE.md §29.6).
   */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
