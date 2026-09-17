import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

import { requireTenant } from '../../common/tenant/tenant-context';
import type { TenantContext } from '../../common/tenant/tenant-context';

/**
 * The verified caller.
 *
 * Read from the tenant context rather than from the request object, so there
 * is exactly one place identity can come from and a handler cannot be handed a
 * user id the client supplied.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof TenantContext | undefined, _ctx: ExecutionContext) => {
    const context = requireTenant();
    return field ? context[field] : context;
  },
);
