import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Params } from 'nestjs-pino';

import type { Env } from '../../config/env.schema';
import { REQUEST_ID_HEADER } from '../http/request-context';

/**
 * Fields that must never reach a log line — docs/ARCHITECTURE.md §29.9.
 *
 * Redaction is configured here, once, rather than left to each caller to
 * remember. `remove: true` drops the key entirely instead of writing
 * "[Redacted]", so a log scraper cannot even infer that a token was present.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'jwt',
  'secret',
  'providerMeta',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
];

/** Health probes would otherwise dominate the log at one line every few seconds. */
const QUIET_PATHS = new Set(['/api/v1/health', '/api/v1/health/ready', '/metrics', '/favicon.ico']);

function canResolve(moduleName: string): boolean {
  try {
    require.resolve(moduleName);
    return true;
  } catch {
    return false;
  }
}

export function buildLoggerOptions(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): Params {
  // Pretty printing runs in a pino-pretty worker thread. That is right for a
  // developer's terminal and wrong everywhere else: in tests the worker keeps
  // the event loop alive and hangs app.close(), and in CI it makes logs
  // unparseable. JSON everywhere except local development.
  //
  // The resolve check matters: pino-pretty is a devDependency, so a production
  // image that is handed NODE_ENV=development by mistake would otherwise crash
  // on boot. A logging transport must never be able to take the service down.
  const pretty = env.NODE_ENV === 'development' && canResolve('pino-pretty');

  return {
    pinoHttp: {
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      // Reuse the id assigned by requestIdMiddleware so one request never
      // produces two different correlation ids.
      genReqId: (req: IncomingMessage) =>
        (req as IncomingMessage & { requestId?: string }).requestId ??
        (req.headers[REQUEST_ID_HEADER] as string | undefined) ??
        '',
      redact: { paths: REDACTED_PATHS, remove: true },
      autoLogging: {
        ignore: (req: IncomingMessage) => QUIET_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
      },
      customProps: (req: IncomingMessage) => ({
        requestId: (req as IncomingMessage & { requestId?: string }).requestId,
      }),
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // The default serializers log entire header and body objects. Log the
      // fields that help debugging and nothing else.
      serializers: {
        req: (req: IncomingMessage & { id?: string; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      },
      ...(pretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: true,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname,req.id',
              },
            },
          }
        : {}),
    },
  };
}
