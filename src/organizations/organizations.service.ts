import { Injectable } from '@nestjs/common';

import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * There is no `GET /organizations/:id`.
   *
   * A caller belongs to exactly one organization, which the token already
   * names, so an id parameter could only ever be their own or someone else's —
   * the first is redundant and the second is the attack. `current` removes the
   * question entirely.
   */
  async current(tenant: TenantContext) {
    const organization = await this.prisma.db.organization.findUnique({
      where: { id: tenant.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        currencyCode: true,
        status: true,
        maxUsers: true,
        createdAt: true,
        settings: {
          select: {
            currencyExponent: true,
            cashRoundingUnit: true,
            allowNegativeStock: true,
            defaultDebtTermDays: true,
            returnWindowDays: true,
            timezone: true,
            locale: true,
          },
        },
        _count: { select: { stores: { where: { archivedAt: null } } } },
      },
    });

    if (!organization) throw BusinessRuleException.notFound('Tashkilot', tenant.organizationId);

    const seatsUsed = await this.prisma.db.user.count({ where: { status: { not: 'INACTIVE' } } });

    const { _count, ...rest } = organization;
    return {
      ...rest,
      storeCount: _count.stores,
      seatsUsed,
    };
  }
}
