import { HttpException, HttpStatus } from '@nestjs/common';

import type { ErrorDetail } from './error-codes';
import { ErrorCode } from './error-codes';

export interface BusinessRuleOptions {
  /** Stable machine code clients branch on. */
  code: string;
  /** HTTP status; business-rule violations are 409 or 422. */
  status?: HttpStatus;
  /** Human-readable summary. Safe to reword. */
  detail?: string;
  /** Field-level problems, e.g. which line had insufficient stock. */
  errors?: ErrorDetail[];
}

/**
 * The only exception type that is allowed to render a 4xx body with detail.
 *
 * Everything else — Prisma errors, unexpected throws — is scrubbed to a bare
 * 500 by the global filter (docs/ARCHITECTURE.md §23.4). Throwing this is a
 * deliberate statement that the message is safe to show a client.
 */
export class BusinessRuleException extends HttpException {
  readonly code: string;
  readonly errors: ErrorDetail[] | undefined;

  constructor({ code, status = HttpStatus.CONFLICT, detail, errors }: BusinessRuleOptions) {
    super(detail ?? code, status);
    this.code = code;
    this.errors = errors;
  }

  static notFound(resource: string, id?: string): BusinessRuleException {
    return new BusinessRuleException({
      code: ErrorCode.RESOURCE_NOT_FOUND,
      status: HttpStatus.NOT_FOUND,
      detail: `${resource} was not found.`,
      errors: id ? [{ code: ErrorCode.RESOURCE_NOT_FOUND, message: resource, meta: { id } }] : [],
    });
  }
}
