import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { formatPhone, normalizePhone } from '../auth/phone';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import { SYSTEM_ROLE } from '../rbac/system-roles';
import type { CreateEmployeeDto, ListEmployeesDto, UpdateEmployeeDto } from './dto/employee.dto';

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The employees screen: search by name or phone, the active count in the
   * header ("8 faol") and the seat counter ("8 / 10 foydalanuvchi band").
   */
  async list(query: ListEmployeesDto, tenant: TenantContext) {
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { fullName: { contains: query.q, mode: 'insensitive' } },
              // Normalise before matching so "90 123" finds +998901234567.
              { phone: { contains: query.q.replace(/[^\d+]/g, '') } },
            ],
          }
        : {}),
      ...(query.storeId ? { memberships: { some: { storeId: query.storeId } } } : {}),
    };

    const [rows, total, activeCount, organization] = await Promise.all([
      this.prisma.db.user.findMany({
        where,
        skip: query.offset,
        take: query.limit,
        orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          status: true,
          lastLoginAt: true,
          memberships: {
            where: { status: 'ACTIVE' },
            select: {
              storeId: true,
              isPrimary: true,
              store: { select: { id: true, name: true } },
              role: { select: { id: true, code: true, name: true } },
            },
            orderBy: { isPrimary: 'desc' },
          },
        },
      }),
      this.prisma.db.user.count({ where }),
      this.prisma.db.user.count({ where: { status: 'ACTIVE' } }),
      this.prisma.db.organization.findUnique({
        where: { id: tenant.organizationId },
        select: { maxUsers: true },
      }),
    ]);

    const seatsUsed = await this.prisma.db.user.count({
      where: { status: { not: 'INACTIVE' } },
    });

    return {
      data: rows.map((user) => toEmployee(user)),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
      summary: {
        activeCount,
        seatsUsed,
        seatLimit: organization?.maxUsers ?? 0,
      },
    };
  }

  async findOne(userId: string, _tenant: TenantContext) {
    const user = await this.prisma.db.user.findFirst({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        status: true,
        lastLoginAt: true,
        passwordChangedAt: true,
        twoFactorEnabled: true,
        createdAt: true,
        memberships: {
          where: { status: 'ACTIVE' },
          select: {
            storeId: true,
            isPrimary: true,
            store: { select: { id: true, name: true } },
            role: { select: { id: true, code: true, name: true } },
          },
          orderBy: { isPrimary: 'desc' },
        },
      },
    });

    // Scoped by the tenant extension: another organization's user is simply
    // not found, which tells the caller nothing about whether it exists.
    if (!user) throw BusinessRuleException.notFound('Xodim', userId);

    return {
      ...toEmployee(user),
      passwordChangedAt: user.passwordChangedAt,
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt,
    };
  }

  /** "Xodim qo'shish" on the employees screen. */
  async create(dto: CreateEmployeeDto, tenant: TenantContext) {
    const phone = normalizePhone(dto.phone);
    if (!phone) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        status: HttpStatus.BAD_REQUEST,
        detail: "Telefon raqami noto'g'ri formatda.",
        errors: [{ field: 'phone', code: ErrorCode.VALIDATION_FAILED, message: dto.phone }],
      });
    }

    const passwordCheck = this.passwords.check(dto.password);
    if (!passwordCheck.valid) {
      throw new BusinessRuleException({
        code: ErrorCode.WEAK_PASSWORD,
        status: HttpStatus.BAD_REQUEST,
        detail: 'Parol talablarga javob bermaydi.',
        errors: passwordCheck.errors.map((message) => ({
          field: 'password',
          code: ErrorCode.WEAK_PASSWORD,
          message,
        })),
      });
    }

    // The store and the role are both resolved through the tenant-scoped
    // client, so a foreign storeId or roleId cannot be smuggled in — it simply
    // does not resolve. The composite foreign keys in the migration are the
    // second line of defence if this check is ever removed.
    const [store, role, organization, seatsUsed] = await Promise.all([
      this.prisma.db.store.findFirst({
        where: { id: dto.storeId, archivedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.db.role.findFirst({
        where: { id: dto.roleId },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.db.organization.findUnique({
        where: { id: tenant.organizationId },
        select: { maxUsers: true },
      }),
      this.prisma.db.user.count({ where: { status: { not: 'INACTIVE' } } }),
    ]);

    if (!store) throw BusinessRuleException.notFound("Do'kon", dto.storeId);
    if (!role) throw BusinessRuleException.notFound('Rol', dto.roleId);

    if (organization && seatsUsed >= organization.maxUsers) {
      throw new BusinessRuleException({
        code: ErrorCode.SEAT_LIMIT_REACHED,
        status: HttpStatus.CONFLICT,
        detail: `Tarifingizda ${organization.maxUsers} ta foydalanuvchi mumkin. Tarifni kengaytiring yoki faol bo'lmagan xodimni o'chiring.`,
      });
    }

    // Phone is globally unique, so this must be checked without tenant scope —
    // otherwise the create would fail on a constraint with a confusing error.
    const phoneTaken = await this.prisma.asSystem().user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (phoneTaken) {
      throw new BusinessRuleException({
        code: ErrorCode.PHONE_ALREADY_USED,
        status: HttpStatus.CONFLICT,
        detail: "Bu telefon raqami allaqachon ro'yxatdan o'tgan.",
        errors: [
          { field: 'phone', code: ErrorCode.PHONE_ALREADY_USED, message: formatPhone(phone) },
        ],
      });
    }

    const passwordHash = await this.passwords.hash(dto.password);

    // One transaction: a user without a membership cannot log in (they would
    // hit NO_STORE_ACCESS), so a half-created employee is a broken account.
    const created = await this.prisma.asSystem().$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          organizationId: tenant.organizationId,
          phone,
          email: dto.email ?? null,
          fullName: dto.fullName,
          passwordHash,
          status: 'ACTIVE',
        },
        select: { id: true, fullName: true, phone: true, email: true, status: true },
      });

      await tx.storeMembership.create({
        data: {
          organizationId: tenant.organizationId,
          userId: user.id,
          storeId: store.id,
          roleId: role.id,
          isPrimary: true,
          status: 'ACTIVE',
        },
      });

      return user;
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: store.id,
      actorUserId: tenant.userId,
      action: 'employee.created',
      entityType: 'user',
      entityId: created.id,
      // Names the role, as the audit screen renders "Sevara Tursunova · Menejer".
      metadata: {
        fullName: created.fullName,
        roleCode: role.code,
        roleName: role.name,
        storeId: store.id,
      },
    });

    return this.findOne(created.id, tenant);
  }

  async update(userId: string, dto: UpdateEmployeeDto, tenant: TenantContext) {
    const existing = await this.prisma.db.user.findFirst({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        status: true,
        memberships: {
          select: { id: true, storeId: true, roleId: true, role: { select: { code: true } } },
        },
      },
    });
    if (!existing) throw BusinessRuleException.notFound('Xodim', userId);

    const changes: Record<string, unknown> = {};

    if (dto.roleId) {
      const role = await this.prisma.db.role.findFirst({
        where: { id: dto.roleId },
        select: { id: true, code: true, name: true },
      });
      if (!role) throw BusinessRuleException.notFound('Rol', dto.roleId);

      const membership = existing.memberships[0];
      if (membership && membership.roleId !== role.id) {
        if (membership.role.code === SYSTEM_ROLE.ADMIN) {
          await this.assertNotLastAdmin(userId, tenant);
        }
        await this.prisma.db.storeMembership.update({
          where: {
            organizationId_id: { organizationId: tenant.organizationId, id: membership.id },
          },
          data: { roleId: role.id },
        });
        changes['roleCode'] = role.code;
      }
    }

    if (dto.status && dto.status !== existing.status) {
      if (existing.status === 'ACTIVE' && dto.status !== 'ACTIVE') {
        // Deactivating the only administrator locks the organization out with
        // no way back in from the product.
        const isAdmin = existing.memberships.some((m) => m.role.code === SYSTEM_ROLE.ADMIN);
        if (isAdmin) await this.assertNotLastAdmin(userId, tenant);
      }
      changes['status'] = dto.status;
    }

    const updated = await this.prisma.db.user.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: userId } },
      data: {
        ...(dto.fullName ? { fullName: dto.fullName } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        // Deactivation must take effect immediately, not when the access token
        // happens to expire.
        ...(dto.status && dto.status !== 'ACTIVE' ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: { id: true },
    });

    if (dto.status && dto.status !== 'ACTIVE') {
      await this.prisma.asSystem().refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: `status_${dto.status.toLowerCase()}` },
      });
    }

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action:
        dto.status && dto.status !== existing.status
          ? 'employee.status_changed'
          : 'employee.updated',
      entityType: 'user',
      entityId: userId,
      metadata: { ...changes, fullName: dto.fullName ?? existing.fullName },
    });

    return this.findOne(updated.id, tenant);
  }

  /**
   * Deactivate rather than delete. Transactional rows will reference this user
   * forever — a sale needs to name the cashier who rang it years later.
   */
  async deactivate(userId: string, tenant: TenantContext): Promise<void> {
    if (userId === tenant.userId) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        status: HttpStatus.CONFLICT,
        detail: "O'zingizni o'chira olmaysiz.",
      });
    }

    await this.update(userId, { status: 'INACTIVE' }, tenant);
  }

  /** Refuses to leave an organization without an active administrator. */
  private async assertNotLastAdmin(userId: string, tenant: TenantContext): Promise<void> {
    const otherAdmins = await this.prisma.db.storeMembership.count({
      where: {
        status: 'ACTIVE',
        role: { code: SYSTEM_ROLE.ADMIN },
        userId: { not: userId },
        user: { status: 'ACTIVE' },
      },
    });

    if (otherAdmins === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.LAST_ADMIN,
        status: HttpStatus.CONFLICT,
        detail:
          'Tashkilotda kamida bitta faol administrator qolishi kerak. Avval boshqa xodimga administrator rolini bering.',
      });
    }
    void tenant;
  }
}

interface EmployeeRow {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  status: string;
  lastLoginAt: Date | null;
  memberships: {
    storeId: string;
    isPrimary: boolean;
    store: { id: string; name: string };
    role: { id: string; code: string; name: string };
  }[];
}

function toEmployee(user: EmployeeRow) {
  const primary = user.memberships[0];
  return {
    id: user.id,
    fullName: user.fullName,
    // Initials drive the avatar circles on the employees screen ("DK", "MA").
    initials: initialsOf(user.fullName),
    phone: user.phone,
    phoneFormatted: formatPhone(user.phone),
    email: user.email,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    role: primary ? primary.role : null,
    stores: user.memberships.map((m) => ({
      id: m.store.id,
      name: m.store.name,
      roleCode: m.role.code,
      roleName: m.role.name,
      isPrimary: m.isPrimary,
    })),
  };
}

function initialsOf(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
