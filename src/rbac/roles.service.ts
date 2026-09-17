import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { CreateRoleDto, UpdateRolePermissionsDto } from './dto/role.dto';
import { ALL_PERMISSIONS, expandPermissions, isKnownPermission } from './permissions';
import { isImmutableRole } from './system-roles';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The roles screen: name, one-line description, and the employee count each
   * role carries ("3 xodim").
   */
  async list() {
    const roles = await this.prisma.db.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        permissions: true,
        isSystem: true,
        permissionVersion: true,
        // One query, not N: counting memberships per role in a loop is the
        // obvious way to make a four-row screen cost twenty queries.
        _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
      },
    });

    return roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      editable: !isImmutableRole(role.code),
      employeeCount: role._count.memberships,
      permissionCount: expandPermissions(role.permissions).length,
    }));
  }

  /**
   * The permissions screen for one role: every catalogue entry with its
   * current on/off state, grouped for rendering.
   */
  async getPermissions(roleId: string) {
    const role = await this.findRole(roleId);
    const granted = new Set(expandPermissions(role.permissions));

    return {
      role: {
        id: role.id,
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        editable: !isImmutableRole(role.code),
        employeeCount: role._count.memberships,
      },
      permissions: ALL_PERMISSIONS.map((permission) => ({
        key: permission.key,
        group: permission.group,
        groupLabel: permission.groupLabel,
        label: permission.label,
        sensitive: permission.sensitive,
        enabled: granted.has(permission.key),
      })),
    };
  }

  /** "O'zgarishlarni saqlash" on the permissions screen. */
  async updatePermissions(roleId: string, dto: UpdateRolePermissionsDto, tenant: TenantContext) {
    const role = await this.findRole(roleId);

    if (isImmutableRole(role.code)) {
      // An organization that can strip permissions from its administrator can
      // lock itself out, and support cannot fix that from inside the product.
      throw new BusinessRuleException({
        code: ErrorCode.ROLE_IMMUTABLE,
        status: HttpStatus.CONFLICT,
        detail: "Administrator rolining ruxsatlarini o'zgartirib bo'lmaydi.",
      });
    }

    const unknown = dto.permissions.filter((p) => !isKnownPermission(p));
    if (unknown.length > 0) {
      throw new BusinessRuleException({
        code: ErrorCode.UNKNOWN_PERMISSION,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: "Noma'lum ruxsat yuborildi.",
        errors: unknown.map((permission) => ({
          field: 'permissions',
          code: ErrorCode.UNKNOWN_PERMISSION,
          message: permission,
        })),
      });
    }

    const next = [...new Set(dto.permissions)].sort();
    const previous = [...role.permissions].sort();

    const updated = await this.prisma.db.role.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: roleId } },
      data: {
        permissions: next,
        // Bumping the version changes the permission cache key and invalidates
        // every access token minted against the old set, so a revoked
        // permission stops working on the very next request rather than in 15
        // minutes (docs/ARCHITECTURE.md §20.3).
        permissionVersion: { increment: 1 },
        version: { increment: 1 },
      },
      select: { id: true, code: true, name: true, permissions: true, permissionVersion: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'role.permissions_changed',
      entityType: 'role',
      entityId: roleId,
      metadata: {
        roleCode: role.code,
        added: next.filter((p) => !previous.includes(p)),
        removed: previous.filter((p) => !next.includes(p)),
      },
    });

    return {
      id: updated.id,
      code: updated.code,
      name: updated.name,
      permissions: updated.permissions,
    };
  }

  /** "Yangi rol yaratish" on the roles screen. */
  async create(dto: CreateRoleDto, tenant: TenantContext) {
    const unknown = dto.permissions.filter((p) => !isKnownPermission(p));
    if (unknown.length > 0) {
      throw new BusinessRuleException({
        code: ErrorCode.UNKNOWN_PERMISSION,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: "Noma'lum ruxsat yuborildi.",
        errors: unknown.map((p) => ({
          field: 'permissions',
          code: ErrorCode.UNKNOWN_PERMISSION,
          message: p,
        })),
      });
    }

    const code = slugify(dto.name);
    const existing = await this.prisma.db.role.findFirst({ where: { code } });
    if (existing) {
      throw new BusinessRuleException({
        code: ErrorCode.DUPLICATE_RESOURCE,
        status: HttpStatus.CONFLICT,
        detail: 'Bu nomdagi rol allaqachon mavjud.',
      });
    }

    const role = await this.prisma.db.role.create({
      data: {
        // Passed explicitly so the type checker sees it too. The tenant
        // extension would inject the same value; that stays as a backstop for
        // the call site that forgets.
        organizationId: tenant.organizationId,
        code,
        name: dto.name,
        description: dto.description ?? null,
        permissions: [...new Set(dto.permissions)].sort(),
        isSystem: false,
      },
      select: { id: true, code: true, name: true, description: true, permissions: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'role.created',
      entityType: 'role',
      entityId: role.id,
      metadata: { code: role.code, name: role.name, permissionCount: role.permissions.length },
    });

    return role;
  }

  async remove(roleId: string, tenant: TenantContext): Promise<void> {
    const role = await this.findRole(roleId);

    if (role.isSystem) {
      throw new BusinessRuleException({
        code: ErrorCode.ROLE_IMMUTABLE,
        status: HttpStatus.CONFLICT,
        detail: "Standart rolni o'chirib bo'lmaydi.",
      });
    }

    if (role._count.memberships > 0) {
      // Deleting a role out from under its holders would silently strip their
      // access; make the caller reassign first.
      throw new BusinessRuleException({
        code: ErrorCode.ROLE_IN_USE,
        status: HttpStatus.CONFLICT,
        detail: `Bu rol ${role._count.memberships} ta xodimga biriktirilgan. Avval ularni boshqa rolga o'tkazing.`,
      });
    }

    await this.prisma.db.role.delete({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: roleId } },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorUserId: tenant.userId,
      action: 'role.deleted',
      entityType: 'role',
      entityId: roleId,
      metadata: { code: role.code },
    });
  }

  /** The full catalogue, for building a role editor. */
  catalogue() {
    return {
      permissions: ALL_PERMISSIONS,
      groups: [...new Set(ALL_PERMISSIONS.map((p) => p.group))].map((group) => ({
        key: group,
        label: ALL_PERMISSIONS.find((p) => p.group === group)!.groupLabel,
      })),
    };
  }

  private async findRole(roleId: string) {
    const role = await this.prisma.db.role.findFirst({
      where: { id: roleId },
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        permissions: true,
        isSystem: true,
        _count: { select: { memberships: { where: { status: 'ACTIVE' } } } },
      },
    });

    // The tenant extension already scoped this query, so a role from another
    // organization simply is not found — the caller learns nothing about it.
    if (!role) throw BusinessRuleException.notFound('Rol', roleId);
    return role;
  }
}

function slugify(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
