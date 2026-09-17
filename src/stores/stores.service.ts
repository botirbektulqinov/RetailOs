import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { UpdateStoreDto } from './dto/store.dto';

const STORE_FIELDS = {
  id: true,
  code: true,
  name: true,
  address: true,
  phone: true,
  legalName: true,
  taxId: true,
  workingHours: true,
  timezone: true,
  status: true,
  createdAt: true,
} as const;

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Only the stores the caller is actually a member of.
   *
   * Tenant scoping alone is not enough here: a cashier at one branch of a
   * five-branch chain must not enumerate the other four.
   */
  async listForUser(tenant: TenantContext) {
    const memberships = await this.prisma.db.storeMembership.findMany({
      where: { userId: tenant.userId, status: 'ACTIVE', store: { archivedAt: null } },
      select: {
        isPrimary: true,
        store: { select: STORE_FIELDS },
        role: { select: { id: true, code: true, name: true } },
      },
      orderBy: { isPrimary: 'desc' },
    });

    return memberships.map((m) => ({
      ...m.store,
      isPrimary: m.isPrimary,
      isActive: m.store.id === tenant.storeId,
      role: m.role,
    }));
  }

  async findOne(storeId: string, tenant: TenantContext) {
    // Membership check, not just tenant scope — see listForUser.
    const membership = await this.prisma.db.storeMembership.findFirst({
      where: { userId: tenant.userId, storeId, status: 'ACTIVE' },
      select: {
        store: { select: STORE_FIELDS },
        role: { select: { id: true, code: true, name: true } },
      },
    });

    if (!membership) throw BusinessRuleException.notFound("Do'kon", storeId);

    return { ...membership.store, role: membership.role };
  }

  async update(storeId: string, dto: UpdateStoreDto, tenant: TenantContext) {
    // Resolves through the membership, so a foreign store id cannot be edited
    // even by a caller who holds stores.manage in their own organization.
    await this.findOne(storeId, tenant);

    const updated = await this.prisma.db.store.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: storeId } },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.legalName !== undefined ? { legalName: dto.legalName } : {}),
        ...(dto.taxId !== undefined ? { taxId: dto.taxId } : {}),
        ...(dto.workingHours !== undefined ? { workingHours: dto.workingHours } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
      },
      select: STORE_FIELDS,
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId,
      actorUserId: tenant.userId,
      action: 'store.updated',
      entityType: 'store',
      entityId: storeId,
      metadata: { fields: Object.keys(dto) },
    });

    return updated;
  }
}
