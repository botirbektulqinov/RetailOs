/**
 * Machine-readable error codes — docs/ARCHITECTURE.md §23.3.
 *
 * `code` is the contract clients branch on and is stable forever. `title` and
 * `detail` are for humans and may be reworded or localized freely.
 *
 * Sprint 1 declares only the foundation codes. Domain codes (INSUFFICIENT_STOCK,
 * RECEIVABLE_OVERPAYMENT, ...) are added by the sprint that implements the rule
 * they guard, so an unreachable code never sits here pretending to be supported.
 */
export const ErrorCode = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',

  // 401
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',

  // 403
  FORBIDDEN: 'FORBIDDEN',

  // 404
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  // 409
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',

  // 413 / 429
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** One field-level problem inside a validation or business error. */
export interface ErrorDetail {
  field?: string;
  code: string;
  message: string;
  meta?: Record<string, unknown>;
}

/** The response body every error produces — RFC 9457 shaped. */
export interface ErrorResponseBody {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  traceId: string;
  timestamp: string;
  errors?: ErrorDetail[];
}
