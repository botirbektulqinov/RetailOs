import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { AppConfig } from '../config/config.module';

/**
 * The single PrismaClient for the process.
 *
 * Prisma 7 requires a driver adapter — the connection URL no longer lives in
 * schema.prisma — so the pg Pool is built here from validated config.
 *
 * The Pool is constructed explicitly rather than letting PrismaPg create one,
 * so shutdown can close it deterministically. Leaving it to the adapter left
 * sockets open and hung both `app.close()` in tests and SIGTERM in Docker.
 *
 * Deliberately NOT here: any migration behaviour. The application never runs
 * `migrate` at boot (docs/ARCHITECTURE.md §32.4) — two replicas racing to
 * migrate is a bad first production incident.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly pool: Pool;

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
