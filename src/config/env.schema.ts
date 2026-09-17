import { z } from 'zod';

/**
 * Environment contract.
 *
 * The application fails to start when anything here is missing or malformed
 * (docs/ARCHITECTURE.md §29.8). Discovering a bad secret at boot is cheap;
 * discovering it on the first request that needs it is not.
 */

/**
 * Comma-separated list -> trimmed, de-duplicated string array.
 *
 * The default sits on the *input* side of the transform so an unset variable
 * still flows through the same parsing path as a set one.
 */
const csv = z
  .string()
  .default('')
  .transform((value) =>
    Array.from(
      new Set(
        value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      ),
    ),
  );

const DEV_SECRET_MARKER = 'dev-only';

/**
 * A secret must be long enough to matter and must not be the value shipped in
 * .env.example. Both checks are startup assertions rather than review items.
 */
const secret = (name: string) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters`)
    .refine(
      (value) => process.env['NODE_ENV'] !== 'production' || !value.includes(DEV_SECRET_MARKER),
      `${name} still holds the development placeholder — set a real secret in production`,
    );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_PREFIX: z.string().default('api'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  JWT_SECRET: secret('JWT_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  CORS_ORIGINS: csv,
  TRUST_PROXY: z.stringbool().default(false),
  BODY_LIMIT: z.string().default('1mb'),

  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_LIMIT: z.coerce.number().int().min(1).default(600),

  /**
   * The credential endpoints get their own, far tighter budget. Declared here
   * so it is validated and documented like everything else, but read directly
   * from process.env at the decorator (see auth.controller.ts) because
   * @Throttle takes compile-time constants.
   */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(5),
  AUTH_RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().min(1).default(900),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SWAGGER_ENABLED: z.stringbool().default(false),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `process.env` and returns the typed, defaulted configuration.
 * Throws a single readable error listing every problem at once — fixing one
 * variable per restart is a miserable way to set up a project.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  if (result.data.NODE_ENV === 'production' && result.data.CORS_ORIGINS.length === 0) {
    throw new Error(
      'Invalid environment configuration:\n  - CORS_ORIGINS: must list at least one origin in production',
    );
  }

  return result.data;
}
