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
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  USER_INACTIVE: 'USER_INACTIVE',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',
  STORE_ACCESS_DENIED: 'STORE_ACCESS_DENIED',
  NO_STORE_ACCESS: 'NO_STORE_ACCESS',

  // 404
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  // 409
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  PHONE_ALREADY_USED: 'PHONE_ALREADY_USED',
  SKU_ALREADY_USED: 'SKU_ALREADY_USED',
  BARCODE_ALREADY_USED: 'BARCODE_ALREADY_USED',
  CATEGORY_NAME_TAKEN: 'CATEGORY_NAME_TAKEN',
  CATEGORY_HAS_CHILDREN: 'CATEGORY_HAS_CHILDREN',
  CATEGORY_HAS_PRODUCTS: 'CATEGORY_HAS_PRODUCTS',
  CATEGORY_CYCLE: 'CATEGORY_CYCLE',
  CATEGORY_TOO_DEEP: 'CATEGORY_TOO_DEEP',
  PRODUCT_ARCHIVED: 'PRODUCT_ARCHIVED',
  LAST_VARIANT: 'LAST_VARIANT',
  SEAT_LIMIT_REACHED: 'SEAT_LIMIT_REACHED',
  ROLE_IN_USE: 'ROLE_IN_USE',
  ROLE_IMMUTABLE: 'ROLE_IMMUTABLE',
  LAST_ADMIN: 'LAST_ADMIN',

  // 422
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  UNKNOWN_PERMISSION: 'UNKNOWN_PERMISSION',

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
