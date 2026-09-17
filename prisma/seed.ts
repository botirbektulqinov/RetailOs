// Loaded explicitly: `npm run seed` invokes tsx directly and, unlike the Nest
// bootstrap, nothing else reads .env for it.
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

/**
 * Seed entry point.
 *
 * Two rules, both load-bearing:
 *
 *  1. **Idempotent.** Every seed step must be safe to run twice. Seeds get run
 *     against a database that already has data far more often than anyone
 *     plans for.
 *  2. **Never destructive.** Nothing here truncates, drops or resets. Wiping a
 *     database is `prisma migrate reset`, an explicit and separate command.
 *
 * Sprint 1 has no domain models, so the only work is verifying that the
 * migrated schema is reachable. Sprint 2 adds `seedSystemRoles()` — the five
 * system roles and their permission arrays (docs/ARCHITECTURE.md §20.2) — which
 * is the first seed that is safe to run in production.
 */

type SeedStep = {
  name: string;
  /** true when the step may run against a production database. */
  productionSafe: boolean;
  run: (prisma: PrismaClient) => Promise<string>;
};

const steps: SeedStep[] = [
  {
    name: 'verify-schema',
    productionSafe: true,
    run: async (prisma) => {
      const rows = await prisma.$queryRaw<{ applied: bigint }[]>`
        SELECT count(*)::bigint AS applied
          FROM _prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `;
      const applied = rows[0]?.applied ?? 0n;

      const extensions = await prisma.$queryRaw<{ extname: string }[]>`
        SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm', 'pgcrypto')
        ORDER BY extname
      `;

      return `${applied} migration(s) applied; extensions: ${extensions
        .map((e) => e.extname)
        .join(', ')}`;
    },
  },
];

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const isProduction = process.env['NODE_ENV'] === 'production';
  const pool = new Pool({ connectionString, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    for (const step of steps) {
      if (isProduction && !step.productionSafe) {
        console.info(`  - ${step.name}: skipped (not production-safe)`);
        continue;
      }
      const result = await step.run(prisma);
      console.info(`  - ${step.name}: ${result}`);
    }
    console.info('Seed complete.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
