import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { BusinessRuleException } from '../src/common/exceptions/business-rule.exception';
import { ListQueryDto } from '../src/common/dto/list-query.dto';
import { applyGlobalSetup } from '../src/bootstrap';

/**
 * A probe module, mounted only in this test.
 *
 * Sprint 1 ships no business endpoints, but the global ValidationPipe and the
 * exception filter are foundation behaviour that must be verified against real
 * HTTP rather than asserted about in isolation. Shipping a fake endpoint in
 * src/ to make that possible would be worse than declaring one here.
 */
class ProbeDto {
  @IsString()
  name!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}

@Controller('probe')
class ProbeController {
  @Post()
  create(@Body() body: ProbeDto): { received: ProbeDto } {
    return { received: body };
  }

  @Get('list')
  list(@Query() query: ListQueryDto): ListQueryDto {
    return query;
  }

  @Get('business-error')
  businessError(): never {
    throw new BusinessRuleException({
      code: 'EXAMPLE_RULE_VIOLATED',
      detail: 'A safe, client-facing explanation.',
      errors: [{ field: 'quantity', code: 'EXAMPLE_RULE_VIOLATED', message: 'too many' }],
    });
  }

  @Get('boom')
  boom(): never {
    throw new Error('Connection string postgres://secret@db:5432 leaked into the message');
  }

  @Get('money')
  money(): { total: bigint } {
    return { total: 450_000n };
  }
}

@Module({ imports: [AppModule], controllers: [ProbeController] })
class TestAppModule {}

describe('Foundation (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // The exact same global setup main.ts applies, so these tests exercise the
    // real pipeline rather than a test-only approximation of it.
    applyGlobalSetup(app, { swagger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('health', () => {
    it('GET /api/v1/health reports the process is live', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(res.body).toMatchObject({ status: 'ok', environment: expect.any(String) });
      expect(res.body.uptimeSeconds).toBeGreaterThan(0);
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('GET /api/v1/health/ready checks the database and reports 200 when it is up', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health/ready');

      // 503 here means the database is genuinely unreachable — a real failure
      // of this test's environment, not a flake to be tolerated.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.database).toMatchObject({ status: 'up' });
      expect(res.body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('is reachable only under the versioned prefix', async () => {
      await request(app.getHttpServer()).get('/health').expect(404);
      await request(app.getHttpServer()).get('/api/health').expect(404);
    });
  });

  describe('request correlation', () => {
    it('generates an id and returns it', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('propagates a client-supplied uuid', async () => {
      const supplied = '0192f3c1-8a4e-7c3d-b1e2-5f6a7b8c9d0e';
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-Id', supplied)
        .expect(200);

      expect(res.headers['x-request-id']).toBe(supplied);
    });

    it('ignores a non-uuid id rather than echoing attacker-controlled text', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('X-Request-Id', 'not-a-uuid-attacker-controlled-text')
        .expect(200);

      expect(res.headers['x-request-id']).not.toContain('attacker');
    });
  });

  describe('global validation', () => {
    it('accepts a valid body', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/probe')
        .send({ name: 'tea pot', quantity: 3 })
        .expect(201);
    });

    it('rejects a missing field with a structured error', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe')
        .send({ quantity: 3 })
        .expect(400);

      expect(res.body).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        title: 'Validation failed',
      });
      expect(res.body.errors.some((e: { field?: string }) => e.field === 'name')).toBe(true);
      expect(res.body.traceId).toBe(res.headers['x-request-id']);
    });

    it('rejects an out-of-range value', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe')
        .send({ name: 'tea pot', quantity: 99 })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects unknown fields instead of silently dropping them', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/probe')
        .send({ name: 'tea pot', quantity: 3, isAdmin: true })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.errors)).toContain('isAdmin');
    });

    it('applies ListQueryDto defaults and caps the page limit', async () => {
      const defaults = await request(app.getHttpServer()).get('/api/v1/probe/list').expect(200);
      expect(defaults.body).toMatchObject({ limit: 50, offset: 0 });

      const tooLarge = await request(app.getHttpServer())
        .get('/api/v1/probe/list?limit=10000')
        .expect(400);
      expect(tooLarge.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('error handling', () => {
    it('renders a BusinessRuleException with its code and details', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe/business-error')
        .expect(409);

      expect(res.body).toMatchObject({
        status: 409,
        code: 'EXAMPLE_RULE_VIOLATED',
        detail: 'A safe, client-facing explanation.',
      });
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.type).toContain('example-rule-violated');
    });

    it('scrubs an unexpected error to a bare 500 with only a traceId', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/boom').expect(500);

      expect(res.body).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
      expect(res.body.traceId).toBeTruthy();

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('postgres://');
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('Connection string');
      expect(res.body.stack).toBeUndefined();
    });

    it('returns a structured 404 for an unknown route', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);

      expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
      expect(res.body.traceId).toBeTruthy();
    });
  });

  describe('security headers', () => {
    it('sets the helmet baseline', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('does not reflect an unlisted CORS origin', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/health')
        .set('Origin', 'https://evil.example')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('money serialization', () => {
    it('serializes a bigint money value as a JSON integer', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/probe/money').expect(200);

      expect(res.body.total).toBe(450000);
      expect(res.text).toContain('"total":450000');
    });
  });
});
