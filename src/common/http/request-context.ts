import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** A request id we generated or accepted, attached to the Express request. */
declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

/**
 * Only a UUID is accepted from the client. An unvalidated inbound header is a
 * log-injection and cache-poisoning vector, and an id that is not a uuid is
 * useless for correlation anyway.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveRequestId(inbound: unknown): string {
  return typeof inbound === 'string' && UUID_PATTERN.test(inbound) ? inbound : randomUUID();
}

/**
 * Assigns a correlation id to every request and echoes it back.
 *
 * The same id appears in the response header, in every log line for the request,
 * in the `traceId` of any error body, and (from Sprint 2) in `audit_log.request_id`.
 * One id ties an HTTP response to its logs and to a permanent audit row, which
 * is the whole observability requirement for a system this size
 * (docs/ARCHITECTURE.md Appendix C.1).
 *
 * Registered ahead of pino-http so the logger reuses this id rather than
 * minting a second, unrelated one.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
