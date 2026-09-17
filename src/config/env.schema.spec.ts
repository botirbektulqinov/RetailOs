import { validateEnv } from './env.schema';

const VALID = {
  DATABASE_URL: 'postgresql://retailos:retailos@localhost:55432/retailos?schema=public',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

describe('validateEnv', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('applies defaults for everything optional', () => {
    const env = validateEnv(VALID);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      API_PREFIX: 'api',
      DATABASE_POOL_SIZE: 10,
      LOG_LEVEL: 'info',
      SWAGGER_ENABLED: false,
      TRUST_PROXY: false,
      BODY_LIMIT: '1mb',
    });
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('coerces numeric strings, because every env var arrives as a string', () => {
    const env = validateEnv({ ...VALID, PORT: '8080', DATABASE_POOL_SIZE: '25' });

    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_POOL_SIZE).toBe(25);
  });

  it('parses booleans from the strings people actually write', () => {
    expect(validateEnv({ ...VALID, SWAGGER_ENABLED: 'true' }).SWAGGER_ENABLED).toBe(true);
    expect(validateEnv({ ...VALID, SWAGGER_ENABLED: 'false' }).SWAGGER_ENABLED).toBe(false);
  });

  it('splits, trims and de-duplicates CORS_ORIGINS', () => {
    const env = validateEnv({
      ...VALID,
      CORS_ORIGINS: 'http://a.test,  http://b.test ,http://a.test,,',
    });

    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('reports every problem at once, not one per restart', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => validateEnv({ ...VALID, DATABASE_URL: 'mysql://x/y' })).toThrow(/DATABASE_URL/);
  });

  it('accepts both postgres:// and postgresql://', () => {
    expect(() => validateEnv({ ...VALID, DATABASE_URL: 'postgres://u:p@h:5432/d' })).not.toThrow();
  });

  it('rejects a secret shorter than 32 characters', () => {
    expect(() => validateEnv({ ...VALID, JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET must be at least 32 characters/,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnv({ ...VALID, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an unknown log level', () => {
    expect(() => validateEnv({ ...VALID, LOG_LEVEL: 'chatty' })).toThrow(/LOG_LEVEL/);
  });

  describe('production hardening', () => {
    const prod = {
      ...VALID,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example',
    };

    beforeEach(() => {
      // The placeholder check reads NODE_ENV directly, because the refinement
      // runs per-field and cannot see the parsed object.
      process.env['NODE_ENV'] = 'production';
    });

    it('accepts a properly configured production environment', () => {
      expect(() => validateEnv(prod)).not.toThrow();
    });

    it('rejects the .env.example placeholder secret', () => {
      expect(() =>
        validateEnv({ ...prod, JWT_SECRET: 'dev-only-jwt-secret-change-me-32-bytes-min' }),
      ).toThrow(/development placeholder/);
    });

    it('requires at least one CORS origin', () => {
      expect(() => validateEnv({ ...prod, CORS_ORIGINS: '' })).toThrow(
        /CORS_ORIGINS: must list at least one origin in production/,
      );
    });

    it('still allows the placeholder outside production', () => {
      process.env['NODE_ENV'] = 'development';
      expect(() =>
        validateEnv({ ...VALID, JWT_SECRET: 'dev-only-jwt-secret-change-me-32-bytes-min' }),
      ).not.toThrow();
    });
  });
});
