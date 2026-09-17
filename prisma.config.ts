import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 CLI configuration.
 *
 * The datasource URL lives here rather than in schema.prisma (Prisma 7 removed
 * `url` from the schema). The application itself never reads this file — it
 * connects through the pg driver adapter in src/database/prisma.service.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
