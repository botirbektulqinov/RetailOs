import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { requestIdMiddleware } from './common/http/request-context';
import { AppConfig } from './config/config.module';

/**
 * Money is a `bigint` count of minor units (docs/ARCHITECTURE.md §8.3), and
 * JSON.stringify throws on BigInt. Patch it once, here, rather than mapping
 * every money field by hand in every DTO.
 *
 * JSON integers are exact to 2^53. The largest realistic UZS total is ~1e12 —
 * four orders of magnitude of headroom — and the assertion is the guard, so a
 * value that would silently lose precision becomes a loud failure instead.
 */
export function installBigIntSerializer(): void {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): number {
      const asNumber = Number(this);
      if (!Number.isSafeInteger(asNumber)) {
        throw new Error(`Money value ${this.toString()} exceeds JSON safe integer range`);
      }
      return asNumber;
    },
    writable: true,
    configurable: true,
  });
}

export interface GlobalSetupOptions {
  /** Mount Swagger. Off in tests, where it only slows startup. */
  swagger?: boolean;
}

/**
 * Every global concern, in one function.
 *
 * main.ts and the e2e suite both call this, so a test can never pass against a
 * pipeline that differs from the one production runs — the classic way a
 * validation or CORS regression ships green.
 */
export function applyGlobalSetup(app: INestApplication, options: GlobalSetupOptions = {}): void {
  // Installed here rather than in main.ts so no entry point can forget it —
  // an e2e run that serialized money differently from production would be
  // exactly the kind of green test that ships a bug.
  installBigIntSerializer();

  const expressApp = app as NestExpressApplication;
  const config = app.get(AppConfig);
  const swaggerEnabled = options.swagger ?? config.get('SWAGGER_ENABLED');

  // Must run before pino-http so both use the same correlation id.
  expressApp.use(requestIdMiddleware);

  if (config.get('TRUST_PROXY')) {
    // Without this, every client IP in the audit log is the reverse proxy's.
    expressApp.set('trust proxy', 1);
  }

  expressApp.use(
    helmet({
      // The only HTML this API serves is the Swagger page, which needs inline
      // styles and its own bundle; the default CSP blocks both.
      contentSecurityPolicy: swaggerEnabled ? false : undefined,
      hsts: config.isProduction
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
        : false,
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  const bodyLimit = config.get('BODY_LIMIT');
  expressApp.useBodyParser('json', { limit: bodyLimit });
  expressApp.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  const corsOrigins = config.get('CORS_ORIGINS');
  expressApp.enableCors({
    // Never `origin: '*'` and never `origin: true` — the latter reflects any
    // origin, which is `*` with extra steps.
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'Idempotency-Replayed'],
    maxAge: 86_400,
  });

  app.setGlobalPrefix(config.get('API_PREFIX'));
  // URI versioning: /api/v1/... (docs/ARCHITECTURE.md §22.1 — the version is in
  // the path, not a header, so a URL in a log or a bug report is unambiguous).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // An unknown field means the client and server disagree about the
      // contract. Failing loudly finds that in development instead of silently
      // dropping a field someone believed was being saved.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
      // 400 VALIDATION_FAILED (docs/ARCHITECTURE.md §23.3). The global filter
      // turns this string[] into the structured `errors` array.
      exceptionFactory: (errors) => {
        const messages = errors.flatMap((error) =>
          Object.values(error.constraints ?? { unknown: `${error.property} is invalid` }),
        );
        return new BadRequestException({ message: messages });
      },
    }),
  );

  app.enableShutdownHooks();

  if (swaggerEnabled) {
    setupSwagger(app, config);
  }
}

function setupSwagger(app: INestApplication, config: AppConfig): void {
  const prefix = config.get('API_PREFIX');

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('RetailOS API')
      .setDescription(
        'Retail management platform backend.\n\n' +
          '- **Money** is a JSON integer in the organization currency minor units ' +
          "(UZS has exponent 0, so `450000` means 450,000 so'm).\n" +
          '- **Quantities** are decimal strings with 3 decimal places (`"1.500"`).\n' +
          '- **Errors** follow RFC 9457; branch on `code`, not on `title` or `detail`.\n' +
          '- **Correlation**: every response carries `X-Request-Id`, echoed as `traceId` in errors.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
      .addServer(`/${prefix}/v1`)
      .build(),
  );

  SwaggerModule.setup(`${prefix}/docs`, app, document, {
    swaggerOptions: { persistAuthorization: true },
    jsonDocumentUrl: `${prefix}/docs/json`,
  });
}
