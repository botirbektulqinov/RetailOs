import { HttpStatus, Injectable } from '@nestjs/common';

import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { PrismaService } from '../database/prisma.service';
import { expandPermissions } from '../rbac/permissions';
import type { AccessTokenClaims } from './token.service';

export interface Principal {
  userId: string;
  organizationId: string;
  storeId: string;
  roleId: string;
  roleCode: string;
  permissions: ReadonlySet<string>;
}

interface CachedRole {
  code: string;
  permissions: ReadonlySet<string>;
}

/**
 * Turns verified token claims into a principal, re-checking everything that
 * could have changed since the token was minted.
 *
 * This runs on every authenticated request, so it is deliberately one query
 * plus an in-process cache lookup — not a chain of relation loads.
 */
@Injectable()
export class SessionService {
  /**
   * Permission cache keyed by `roleId:permissionVersion`.
   *
   * Editing a role bumps permissionVersion, which changes the key, so there is
   * no eviction protocol and no window in which a revoked permission is still
   * granted (docs/ARCHITECTURE.md §20.3). In-process is correct for the
   * single-instance MVP; the key design survives a move to Redis unchanged.
   */
  private readonly roleCache = new Map<string, CachedRole>();
  private static readonly ROLE_CACHE_LIMIT = 500;

  constructor(private readonly prisma: PrismaService) {}

  async resolvePrincipal(claims: AccessTokenClaims): Promise<Principal> {
    // Cross-tenant by necessity: the tenant context does not exist yet, and
    // this query is what establishes it. Every claim below is re-validated.
    const membership = await this.prisma.asSystem().storeMembership.findFirst({
      where: {
        userId: claims.sub,
        storeId: claims.store,
        organizationId: claims.org,
      },
      select: {
        id: true,
        status: true,
        roleId: true,
        organizationId: true,
        storeId: true,
        role: { select: { id: true, code: true, permissions: true, permissionVersion: true } },
        store: { select: { status: true, archivedAt: true } },
        user: { select: { id: true, status: true, tokenVersion: true } },
        organization: { select: { status: true } },
      },
    });

    // A revoked membership, a deleted store or a tampered claim all land here.
    // One generic message: which of them failed is not the client's business.
    if (!membership) throw unauthorized('Sessiya yaroqsiz.');

    if (membership.user.tokenVersion !== claims.tv) {
      // Password changed, account deactivated, or the session was force-revoked.
      throw unauthorized('Sessiya bekor qilingan. Qaytadan kiring.');
    }

    if (membership.user.status !== 'ACTIVE') {
      throw forbidden(
        membership.user.status === 'SUSPENDED'
          ? 'Hisobingiz vaqtincha bloklangan.'
          : 'Hisobingiz faol emas.',
      );
    }

    if (membership.organization.status !== 'ACTIVE') {
      throw forbidden('Tashkilot vaqtincha to‘xtatilgan.');
    }

    if (membership.status !== 'ACTIVE') {
      throw forbidden("Bu do'konga kirish huquqingiz to'xtatilgan.");
    }

    if (membership.store.status !== 'ACTIVE' || membership.store.archivedAt !== null) {
      throw forbidden("Do'kon faol emas.");
    }

    // The role may have been swapped since the token was issued; trust the
    // membership row, not the `role` claim.
    const role = this.resolveRole(
      membership.role.id,
      membership.role.permissionVersion,
      membership.role.code,
      membership.role.permissions,
    );

    return {
      userId: membership.user.id,
      organizationId: membership.organizationId,
      storeId: membership.storeId,
      roleId: membership.role.id,
      roleCode: role.code,
      permissions: role.permissions,
    };
  }

  private resolveRole(
    roleId: string,
    version: number,
    code: string,
    permissions: string[],
  ): CachedRole {
    const key = `${roleId}:${version}`;
    const cached = this.roleCache.get(key);
    if (cached) return cached;

    // Expanded once, here, so `hasPermission` never has to interpret wildcards
    // and /auth/me can return a concrete list a client can render.
    const entry: CachedRole = { code, permissions: new Set(expandPermissions(permissions)) };

    // Crude bound rather than a real LRU: entries are tiny, keys rotate on
    // every role edit, and a shop has a handful of roles.
    if (this.roleCache.size >= SessionService.ROLE_CACHE_LIMIT) this.roleCache.clear();
    this.roleCache.set(key, entry);

    return entry;
  }
}

function unauthorized(detail: string): BusinessRuleException {
  return new BusinessRuleException({
    code: ErrorCode.TOKEN_INVALID,
    status: HttpStatus.UNAUTHORIZED,
    detail,
  });
}

function forbidden(detail: string): BusinessRuleException {
  return new BusinessRuleException({
    code: ErrorCode.FORBIDDEN,
    status: HttpStatus.FORBIDDEN,
    detail,
  });
}
