import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { AssignStoreDto, ResetPasswordDto } from './dto/employee.dto';

/**
 * Store assignments, account actions and the activity summary —
 * docs/ARCHITECTURE.md §20.1 and §20.4.
 *
 * **A user's authority is per store.** The same person can be MANAGER at one
 * branch and CASHIER at another, which a `role` column on the user cannot
 * express and which becomes a painful migration once sales reference the role.
 * `StoreMembership` is that relation, and this service is where it is managed.
 *
 * Permission is necessary, not sufficient (§20.4). Three checks compose:
 * permission (the guard), tenant scope (the Prisma extension), and store scope
 * — this last one explicit, because only the service knows which store a row
 * belongs to.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Store scope — the third check of §20.4
  // ────────────────────────────────────────────────────────────────────────

  /**
   * The stores this user may act in.
   *
   * A wildcard holder sees every store in the organization: an owner is
   * org-wide and implicitly a member of all of them. Everybody else gets
   * exactly their memberships.
   */
  async storesFor(tenant: TenantContext): Promise<string[]> {
    if (tenant.permissions.has('*')) {
      const stores = await this.prisma.db.store.findMany({
        where: { archivedAt: null },
        select: { id: true },
      });
      return stores.map((s) => s.id);
    }

    const memberships = await this.prisma.db.storeMembership.findMany({
      where: { userId: tenant.userId, status: 'ACTIVE' },
      select: { storeId: true },
    });
    return memberships.map((m) => m.storeId);
  }

  /**
   * Refuses an operation aimed at a store the caller does not work in.
   *
   * A manager with `sales.read` still cannot read another branch's sales, and
   * this is the only place that says so — permission alone would let them.
   */
  async assertStoreAccess(tenant: TenantContext, storeId: string): Promise<void> {
    if (tenant.storeId === storeId) return;
    if (tenant.permissions.has('*')) return;

    const membership = await this.prisma.db.storeMembership.findFirst({
      where: { userId: tenant.userId, storeId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!membership) {
      throw new BusinessRuleException({
        code: ErrorCode.STORE_ACCESS_DENIED,
        status: 403,
        detail: "Siz bu do'konga biriktirilmagansiz.",
        errors: [{ code: ErrorCode.STORE_ACCESS_DENIED, message: storeId, meta: { storeId } }],
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Assignments
  // ────────────────────────────────────────────────────────────────────────

  async listAssignments(userId: string) {
    await this.requireUser(userId);

    const memberships = await this.prisma.db.storeMembership.findMany({
      where: { userId },
      select: {
        id: true,
        storeId: true,
        isPrimary: true,
        status: true,
        createdAt: true,
        store: { select: { id: true, code: true, name: true, archivedAt: true } },
        role: { select: { id: true, code: true, name: true, permissions: true } },
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    return {
      data: memberships.map((m) => ({
        id: m.id,
        storeId: m.storeId,
        store: m.store,
        role: { id: m.role.id, code: m.role.code, name: m.role.name },
        // The resolved set, so an administrator can see what this assignment
        // actually grants without opening the roles screen.
        permissionCount: m.role.permissions.length,
        isPrimary: m.isPrimary,
        status: m.status,
        createdAt: m.createdAt,
      })),
    };
  }

  /**
   * Assigns a user to a store, with a role.
   *
   * `UNIQUE (user_id, store_id)` means one membership per store, so this is an
   * upsert: re-assigning somebody who is already there changes their role
   * rather than failing, which is what the screen's "change role" button does.
   */
  async assign(userId: string, dto: AssignStoreDto, tenant: TenantContext) {
    const user = await this.requireUser(userId);
    const store = await this.requireStore(dto.storeId);
    const role = await this.requireRole(dto.roleId);

    await this.prisma.db.$transaction(async (tx) => {
      if (dto.isPrimary) {
        // The primary is where a fresh session lands. Exactly one.
        await tx.storeMembership.updateMany({
          where: { userId, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      const existing = await tx.storeMembership.findFirst({
        where: { userId, storeId: dto.storeId },
        select: { id: true },
      });

      if (existing) {
        await tx.storeMembership.update({
          where: {
            organizationId_id: { organizationId: tenant.organizationId, id: existing.id },
          },
          data: {
            roleId: role.id,
            status: 'ACTIVE',
            ...(dto.isPrimary !== undefined ? { isPrimary: dto.isPrimary } : {}),
          },
        });
      } else {
        await tx.storeMembership.create({
          data: {
            organizationId: tenant.organizationId,
            userId,
            storeId: dto.storeId,
            roleId: role.id,
            isPrimary: dto.isPrimary ?? false,
          },
        });
      }

      // Authority changed, so every token this user holds is stale. Bumping
      // the version rejects them on their next request rather than leaving
      // the old grant alive for the rest of the token's lifetime.
      await tx.user.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: userId } },
        data: { tokenVersion: { increment: 1 } },
      });
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'employee.store_assigned',
      entityType: 'store_membership',
      entityId: userId,
      metadata: {
        userId,
        fullName: user.fullName,
        storeId: store.id,
        storeCode: store.code,
        roleCode: role.code,
        isPrimary: dto.isPrimary ?? false,
      },
    });

    return this.listAssignments(userId);
  }

  /**
   * Removes a store assignment.
   *
   * The last one cannot go: a user with no membership can log in and reach
   * nothing, which looks like a broken account rather than a deliberate
   * change. Deactivate the employee instead.
   */
  async unassign(userId: string, storeId: string, tenant: TenantContext) {
    const user = await this.requireUser(userId);

    const memberships = await this.prisma.db.storeMembership.findMany({
      where: { userId },
      select: { id: true, storeId: true, isPrimary: true },
    });

    const target = memberships.find((m) => m.storeId === storeId);
    if (!target) throw BusinessRuleException.notFound("Do'kon biriktiruvi", storeId);

    if (memberships.length === 1) {
      throw new BusinessRuleException({
        code: ErrorCode.LAST_STORE_ASSIGNMENT,
        detail:
          "Oxirgi do'kon biriktiruvini olib tashlab bo'lmaydi — hech qayerga " +
          "kira olmaydigan hisob buzilgan hisobga o'xshaydi. Xodimni faolsizlantiring.",
      });
    }

    await this.prisma.db.$transaction(async (tx) => {
      await tx.storeMembership.delete({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: target.id } },
      });

      // If the primary went, promote another so a fresh session still lands
      // somewhere deterministic.
      if (target.isPrimary) {
        const next = memberships.find((m) => m.id !== target.id);
        if (next) {
          await tx.storeMembership.update({
            where: { organizationId_id: { organizationId: tenant.organizationId, id: next.id } },
            data: { isPrimary: true },
          });
        }
      }

      await tx.user.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: userId } },
        data: { tokenVersion: { increment: 1 } },
      });
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'employee.store_unassigned',
      entityType: 'store_membership',
      entityId: userId,
      metadata: { userId, fullName: user.fullName, storeId },
    });

    return this.listAssignments(userId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Account actions
  // ────────────────────────────────────────────────────────────────────────

  /** Puts a deactivated or suspended employee back to work. */
  async activate(userId: string, tenant: TenantContext) {
    const user = await this.requireUser(userId);

    if (user.status === 'ACTIVE') {
      return { userId, status: 'ACTIVE' as const, changed: false };
    }

    await this.prisma.db.user.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: userId } },
      data: { status: 'ACTIVE', tokenVersion: { increment: 1 } },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'employee.activated',
      entityType: 'app_user',
      entityId: userId,
      metadata: { userId, fullName: user.fullName, previousStatus: user.status },
    });

    return { userId, status: 'ACTIVE' as const, changed: true };
  }

  /**
   * Sets a new password on somebody else's account.
   *
   * The administrator supplies it and hands it over out of band; the response
   * never contains it, and neither does the audit entry. A generated password
   * returned in JSON ends up in a log, a proxy cache and a screenshot.
   *
   * Every session is revoked and the token version bumped, so a password
   * change takes effect immediately rather than after the current token
   * expires.
   */
  async resetPassword(userId: string, dto: ResetPasswordDto, tenant: TenantContext) {
    const user = await this.requireUser(userId);

    // The same strength rules the user sees on the security screen. An
    // administrator setting a colleague's password is not exempt from them.
    const check = this.passwords.check(dto.newPassword);
    if (!check.valid) {
      throw new BusinessRuleException({
        code: ErrorCode.WEAK_PASSWORD,
        status: 422,
        detail: check.errors.join('. '),
        errors: check.errors.map((message) => ({ code: ErrorCode.WEAK_PASSWORD, message })),
      });
    }

    const passwordHash = await this.passwords.hash(dto.newPassword);

    await this.prisma.db.$transaction(async (tx) => {
      await tx.user.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: userId } },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          tokenVersion: { increment: 1 },
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: tenant.userId },
      });
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'employee.password_reset',
      entityType: 'app_user',
      entityId: userId,
      // Explicitly constructed, and the password is not in it. That is the
      // whole point of not having a "log the DTO" convenience (§21.4).
      metadata: { userId, fullName: user.fullName, sessionsRevoked: true },
    });

    return { userId, passwordChanged: true, sessionsRevoked: true };
  }

  /**
   * Signs an employee out everywhere.
   *
   * Revoking refresh tokens alone would leave the current access token valid
   * for the rest of its life, so the token version is bumped too — which is
   * what makes "sign out everywhere" mean now rather than within fifteen
   * minutes.
   */
  async revokeSessions(userId: string, tenant: TenantContext) {
    const user = await this.requireUser(userId);

    const revoked = await this.prisma.db.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: tenant.userId },
      });
      await tx.user.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: userId } },
        data: { tokenVersion: { increment: 1 } },
      });
      return count;
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'employee.sessions_revoked',
      entityType: 'app_user',
      entityId: userId,
      metadata: { userId, fullName: user.fullName, sessionsRevoked: revoked },
    });

    return { userId, sessionsRevoked: revoked };
  }

  /**
   * What this employee has actually been doing.
   *
   * Aggregates, not a row dump: the question is "is this cashier selling" and
   * "how much did they discount", and both are one query each.
   */
  async activity(userId: string, from?: string, to?: string) {
    await this.requireUser(userId);

    const since = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
    const until = to ? new Date(to) : new Date();

    const [sales, refunds, shifts, adjustments, sessions] = await Promise.all([
      this.prisma.db.sale.aggregate({
        where: {
          createdBy: userId,
          status: 'COMPLETED',
          completedAt: { gte: since, lte: until },
        },
        _count: { _all: true },
        _sum: { totalAmount: true, orderDiscountAmount: true, costAmount: true },
      }),
      this.prisma.db.saleReturn.aggregate({
        where: { createdBy: userId, createdAt: { gte: since, lte: until } },
        _count: { _all: true },
        _sum: { refundAmount: true },
      }),
      this.prisma.db.cashRegisterShift.findMany({
        where: { openedBy: userId, openedAt: { gte: since, lte: until } },
        select: {
          id: true,
          shiftNumber: true,
          status: true,
          openedAt: true,
          closedAt: true,
          differenceAmount: true,
        },
        orderBy: { openedAt: 'desc' },
        take: 20,
      }),
      this.prisma.db.inventoryMovement.count({
        where: {
          createdBy: userId,
          sourceType: 'adjustment',
          createdAt: { gte: since, lte: until },
        },
      }),
      this.prisma.db.refreshToken.count({ where: { userId, revokedAt: null } }),
    ]);

    const revenue = sales._sum.totalAmount ?? 0n;
    const cost = sales._sum.costAmount ?? 0n;

    return {
      userId,
      from: since,
      to: until,
      sales: {
        count: sales._count._all,
        revenue: revenue.toString(),
        discountGiven: (sales._sum.orderDiscountAmount ?? 0n).toString(),
        margin: (revenue - cost).toString(),
        averageCheck:
          sales._count._all > 0 ? (revenue / BigInt(sales._count._all)).toString() : '0',
      },
      returns: {
        count: refunds._count._all,
        refunded: (refunds._sum.refundAmount ?? 0n).toString(),
      },
      shifts: shifts.map((s) => ({
        ...s,
        differenceAmount: s.differenceAmount?.toString() ?? null,
      })),
      inventoryAdjustments: adjustments,
      activeSessions: sessions,
    };
  }

  // ────────────────────────────────────────────────────────────────────────

  private async requireUser(userId: string) {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId },
      select: { id: true, fullName: true, status: true },
    });
    if (!user) throw BusinessRuleException.notFound('Xodim', userId);
    return user;
  }

  private async requireStore(storeId: string) {
    const store = await this.prisma.db.store.findFirst({
      where: { id: storeId, archivedAt: null },
      select: { id: true, code: true },
    });
    if (!store) throw BusinessRuleException.notFound("Do'kon", storeId);
    return store;
  }

  private async requireRole(roleId: string) {
    const role = await this.prisma.db.role.findFirst({
      where: { id: roleId },
      select: { id: true, code: true },
    });
    if (!role) throw BusinessRuleException.notFound('Rol', roleId);
    return role;
  }
}
