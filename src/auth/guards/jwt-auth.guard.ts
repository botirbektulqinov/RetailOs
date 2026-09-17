import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { BusinessRuleException } from '../../common/exceptions/business-rule.exception';
import { ErrorCode } from '../../common/exceptions/error-codes';
import { setTenantContext } from '../../common/tenant/tenant-context';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SessionService } from '../session.service';
import { TokenService } from '../token.service';

/**
 * Verifies the access token and establishes the tenant context.
 *
 * Registered globally: every route is protected unless it carries @Public().
 *
 * A valid signature is necessary but not sufficient. The guard re-reads the
 * membership, so a token minted before a password change or a deactivation is
 * rejected on its next request rather than living out its remaining minutes,
 * and a token minted before a permission edit silently picks up the new set.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(request);

    if (!token) {
      throw new BusinessRuleException({
        code: ErrorCode.TOKEN_INVALID,
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Avtorizatsiya talab qilinadi.',
      });
    }

    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch (error) {
      // Distinguish expiry from invalidity: a client must know to refresh
      // rather than to send the user back to the login screen.
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new BusinessRuleException({
        code: expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.TOKEN_INVALID,
        status: HttpStatus.UNAUTHORIZED,
        detail: expired ? 'Sessiya muddati tugadi.' : 'Avtorizatsiya tokeni yaroqsiz.',
      });
    }

    // Resolves the membership and re-validates every version marker, org
    // status, store status and user status against the database.
    const principal = await this.sessions.resolvePrincipal(claims);

    setTenantContext({
      userId: principal.userId,
      organizationId: principal.organizationId,
      storeId: principal.storeId,
      roleId: principal.roleId,
      roleCode: principal.roleCode,
      permissions: principal.permissions,
      sessionId: claims.sid,
    });

    return true;
  }
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : null;
}
