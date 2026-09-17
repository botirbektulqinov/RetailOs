import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BusinessRuleException } from '../../common/exceptions/business-rule.exception';
import { ErrorCode } from '../../common/exceptions/error-codes';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { hasPermission } from '../../rbac/permissions';
import type { Permission } from '../../rbac/permissions';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';

/**
 * Enforces @RequirePermissions — docs/ARCHITECTURE.md §20.3.
 *
 * Role NAMES are never checked, anywhere. `if (role === 'MANAGER')` makes
 * custom roles unusable and hides authorization logic from the one place that
 * is audited; review rejects it.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) return true;

    const tenant = getTenantContext();
    if (!tenant) {
      // A handler that requires a permission but is reachable without auth is
      // a wiring mistake, not a client error. Fail closed and loudly.
      throw new BusinessRuleException({
        code: ErrorCode.TOKEN_INVALID,
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Avtorizatsiya talab qilinadi.',
      });
    }

    // AND semantics: every listed permission must be held.
    const missing = required.filter((p) => !hasPermission(tenant.permissions, p));
    if (missing.length === 0) return true;

    throw new BusinessRuleException({
      code: ErrorCode.FORBIDDEN,
      status: HttpStatus.FORBIDDEN,
      detail: 'Bu amal uchun ruxsatingiz yo\u2018q.',
      // The permission name is not a secret; hiding it only makes support
      // harder and gives the client nothing to explain to the user.
      errors: missing.map((permission) => ({
        code: ErrorCode.FORBIDDEN,
        message: `Talab qilinadi: ${permission}`,
        meta: { permission },
      })),
    });
  }
}
