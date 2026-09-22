import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { PromotionRule } from '../sales/promotions';
import type { CreatePromotionDto, ListPromotionsDto, UpdatePromotionDto } from './dto/loyalty.dto';

const PROMOTION_FIELDS = {
  id: true,
  name: true,
  description: true,
  type: true,
  scope: true,
  value: true,
  minSubtotal: true,
  maxDiscount: true,
  appliesTo: true,
  categoryIds: true,
  productIds: true,
  customerGroupIds: true,
  startsAt: true,
  endsAt: true,
  isActive: true,
  priority: true,
  maxUses: true,
  usedCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Promotion management — docs/ARCHITECTURE.md §18.
 *
 * This service owns the rules. *Applying* them is `src/sales/promotions.ts`,
 * which is pure: a rule set in, a single winning discount out, no database and
 * no clock. Keeping the two apart is what makes every pricing decision
 * testable without a fixture.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListPromotionsDto) {
    const now = new Date();
    const where: Prisma.PromotionWhereInput = {
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.activeNow
        ? {
            isActive: true,
            startsAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          }
        : {}),
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.promotion.findMany({
        where,
        select: PROMOTION_FIELDS,
        orderBy: [{ priority: 'desc' }, { startsAt: 'desc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.promotion.count({ where }),
    ]);

    return {
      data: rows.map(serialize),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  async findOne(promotionId: string) {
    const promotion = await this.prisma.db.promotion.findFirst({
      where: { id: promotionId },
      select: PROMOTION_FIELDS,
    });
    if (!promotion) throw BusinessRuleException.notFound('Aksiya', promotionId);
    return serialize(promotion);
  }

  /**
   * The rules a checkout needs, narrowed in the database.
   *
   * One query per checkout, and only for campaigns live at that moment — an
   * expired promotion should never reach the pricing code at all.
   */
  async activeRules(at: Date): Promise<PromotionRule[]> {
    const rows = await this.prisma.db.promotion.findMany({
      where: {
        isActive: true,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      },
      select: {
        id: true,
        name: true,
        type: true,
        scope: true,
        value: true,
        minSubtotal: true,
        maxDiscount: true,
        appliesTo: true,
        categoryIds: true,
        productIds: true,
        customerGroupIds: true,
        startsAt: true,
        endsAt: true,
        isActive: true,
        priority: true,
        maxUses: true,
        usedCount: true,
      },
      orderBy: { priority: 'desc' },
    });

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      scope: r.scope,
      // A percentage arrives as NUMERIC(14,2); the pure resolver works in
      // hundredths of a percent, which is what percentOf() takes.
      value: r.type === 'PERCENT_OFF' ? toCentis(r.value) : toMinorUnits(r.value),
      minSubtotal: r.minSubtotal,
      maxDiscount: r.maxDiscount,
      appliesTo: r.appliesTo,
      categoryIds: r.categoryIds,
      productIds: r.productIds,
      customerGroupIds: r.customerGroupIds,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      isActive: r.isActive,
      priority: r.priority,
      maxUses: r.maxUses,
      usedCount: r.usedCount,
    }));
  }

  async create(dto: CreatePromotionDto, tenant: TenantContext) {
    this.assertValid({
      type: dto.type,
      value: dto.value,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt ?? null,
    });
    this.assertTargetPopulated({
      appliesTo: dto.appliesTo ?? 'ALL',
      categoryIds: dto.categoryIds,
      productIds: dto.productIds,
    });

    const created = await this.prisma.db.promotion
      .create({
        data: {
          organizationId: tenant.organizationId,
          name: dto.name.trim(),
          description: dto.description ?? null,
          type: dto.type,
          scope: dto.scope,
          value: dto.value.toFixed(2),
          minSubtotal: dto.minSubtotal === undefined ? null : BigInt(dto.minSubtotal),
          maxDiscount: dto.maxDiscount === undefined ? null : BigInt(dto.maxDiscount),
          appliesTo: dto.appliesTo ?? 'ALL',
          categoryIds: dto.categoryIds ?? [],
          productIds: dto.productIds ?? [],
          customerGroupIds: dto.customerGroupIds ?? [],
          startsAt: new Date(dto.startsAt),
          endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
          priority: dto.priority ?? 0,
          maxUses: dto.maxUses ?? null,
          isActive: dto.isActive ?? true,
          createdBy: tenant.userId,
        },
        select: PROMOTION_FIELDS,
      })
      .catch(rethrowDuplicate);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'promotion.created',
      entityType: 'promotion',
      entityId: created.id,
      metadata: { name: created.name, type: dto.type, scope: dto.scope, value: dto.value },
    });

    return serialize(created);
  }

  async update(promotionId: string, dto: UpdatePromotionDto, tenant: TenantContext) {
    const existing = await this.prisma.db.promotion.findFirst({
      where: { id: promotionId },
      select: {
        id: true,
        type: true,
        appliesTo: true,
        categoryIds: true,
        productIds: true,
        startsAt: true,
        endsAt: true,
      },
    });
    if (!existing) throw BusinessRuleException.notFound('Aksiya', promotionId);

    this.assertValid({
      type: dto.type ?? existing.type,
      value: dto.value,
      startsAt: dto.startsAt ?? existing.startsAt.toISOString(),
      endsAt: dto.endsAt ?? existing.endsAt?.toISOString() ?? null,
    });
    this.assertTargetPopulated({
      appliesTo: dto.appliesTo ?? existing.appliesTo,
      categoryIds: dto.categoryIds ?? existing.categoryIds,
      productIds: dto.productIds ?? existing.productIds,
    });

    const updated = await this.prisma.db.promotion
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: promotionId } },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.type !== undefined ? { type: dto.type } : {}),
          ...(dto.scope !== undefined ? { scope: dto.scope } : {}),
          ...(dto.value !== undefined ? { value: dto.value.toFixed(2) } : {}),
          ...(dto.minSubtotal !== undefined ? { minSubtotal: BigInt(dto.minSubtotal) } : {}),
          ...(dto.maxDiscount !== undefined ? { maxDiscount: BigInt(dto.maxDiscount) } : {}),
          ...(dto.appliesTo !== undefined ? { appliesTo: dto.appliesTo } : {}),
          ...(dto.categoryIds !== undefined ? { categoryIds: dto.categoryIds } : {}),
          ...(dto.productIds !== undefined ? { productIds: dto.productIds } : {}),
          ...(dto.customerGroupIds !== undefined ? { customerGroupIds: dto.customerGroupIds } : {}),
          ...(dto.startsAt !== undefined ? { startsAt: new Date(dto.startsAt) } : {}),
          ...(dto.endsAt !== undefined ? { endsAt: dto.endsAt ? new Date(dto.endsAt) : null } : {}),
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          ...(dto.maxUses !== undefined ? { maxUses: dto.maxUses } : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          version: { increment: 1 },
        },
        select: PROMOTION_FIELDS,
      })
      .catch(rethrowDuplicate);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'promotion.updated',
      entityType: 'promotion',
      entityId: promotionId,
      metadata: { changed: Object.keys(dto) },
    });

    return serialize(updated);
  }

  /**
   * Deactivated, never deleted.
   *
   * Sales reference the promotion that priced them, and a campaign nobody can
   * look up afterwards is a discount nobody can explain.
   */
  async deactivate(promotionId: string, tenant: TenantContext) {
    const promotion = await this.prisma.db.promotion.findFirst({
      where: { id: promotionId },
      select: { id: true, name: true },
    });
    if (!promotion) throw BusinessRuleException.notFound('Aksiya', promotionId);

    const updated = await this.prisma.db.promotion.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: promotionId } },
      data: { isActive: false },
      select: PROMOTION_FIELDS,
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'promotion.deactivated',
      entityType: 'promotion',
      entityId: promotionId,
      metadata: { name: promotion.name },
    });

    return serialize(updated);
  }

  /**
   * The rules the database also enforces, checked here so the client gets a
   * usable error rather than a 500 carrying a constraint name.
   *
   * Each of these has a CHECK behind it. The CHECK is the guarantee; this is
   * the message.
   */
  private assertValid(input: {
    type?: string;
    value?: number;
    startsAt?: string;
    endsAt?: string | null;
  }) {
    if (input.type === 'PERCENT_OFF' && input.value !== undefined && input.value > 100) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'Foizli chegirma 100 dan oshmasligi kerak.',
      });
    }
    if (input.startsAt && input.endsAt) {
      if (new Date(input.endsAt) <= new Date(input.startsAt)) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          detail: "Tugash vaqti boshlanish vaqtidan keyin bo'lishi kerak.",
        });
      }
    }
  }

  /**
   * A targeted promotion must say what it targets.
   *
   * "CATEGORY, no categories" silently means "nothing", so the campaign never
   * fires while the screen looks entirely correct. The database checks this
   * too; this produces a usable message instead of a constraint violation.
   */
  private assertTargetPopulated(input: {
    appliesTo: string;
    categoryIds?: readonly string[];
    productIds?: readonly string[];
  }) {
    if (input.appliesTo === 'CATEGORY' && !input.categoryIds?.length) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'appliesTo=CATEGORY uchun kamida bitta kategoriya kerak.',
      });
    }
    if (input.appliesTo === 'PRODUCT' && !input.productIds?.length) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'appliesTo=PRODUCT uchun kamida bitta mahsulot kerak.',
      });
    }
  }
}

interface PromotionRow {
  value: Prisma.Decimal;
  minSubtotal: bigint | null;
  maxDiscount: bigint | null;
  [key: string]: unknown;
}

function serialize(row: PromotionRow) {
  return {
    ...row,
    // Always two decimals. Prisma's Decimal drops trailing zeros, so a 15%
    // promotion would render as "15" while 12.5% rendered as "12.5" — a
    // client formatting either one has to guess the scale.
    value: Number(row.value.toString()).toFixed(2),
    minSubtotal: row.minSubtotal?.toString() ?? null,
    maxDiscount: row.maxDiscount?.toString() ?? null,
  };
}

/** 12.50% → 1250 hundredths of a percent, which is what percentOf() takes. */
function toCentis(value: Prisma.Decimal): bigint {
  return BigInt(Math.round(Number(value.toString()) * 100));
}

/** A FIXED_OFF value is already money; its decimal places are always zero. */
function toMinorUnits(value: Prisma.Decimal): bigint {
  return BigInt(Math.round(Number(value.toString())));
}

function rethrowDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.DUPLICATE_RESOURCE,
      detail: 'Bu nom bilan faol aksiya allaqachon mavjud.',
    });
  }
  throw error;
}
