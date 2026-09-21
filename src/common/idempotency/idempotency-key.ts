import { BadRequestException } from '@nestjs/common';

import { BusinessRuleException } from '../exceptions/business-rule.exception';
import { ErrorCode } from '../exceptions/error-codes';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates the `Idempotency-Key` header — docs/ARCHITECTURE.md §26.2.
 *
 * Required rather than optional-with-a-fallback: a server-generated key makes
 * every request unique, which is exactly the property idempotency exists to
 * remove. A client that does not send one gets a 400 explaining why, not a
 * silently duplicated payment.
 *
 * Shared by every endpoint that moves money, so the rule is stated once.
 */
export function requireIdempotencyKey(key: string | undefined): string {
  if (!key?.trim()) {
    throw new BusinessRuleException({
      code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      status: 400,
      detail: 'Idempotency-Key sarlavhasi majburiy (UUID v4).',
    });
  }
  if (!UUID_V4.test(key.trim())) {
    throw new BadRequestException("Idempotency-Key UUID v4 bo'lishi kerak.");
  }
  return key.trim();
}
