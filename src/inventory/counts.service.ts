import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { nextDocumentNumber } from '../common/document-number';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { formatQuantity, parseQuantity, toNumber } from '../common/quantity';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type {
  CreateCountDto,
  FinalizeCountDto,
  ListCountsDto,
  SubmitCountDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

/** Statuses a count may still be edited in. */
const OPEN_STATUSES = ['DRAFT', 'COUNTING'] as const;

/**
 * Inventory counts — docs/ARCHITECTURE.md §9.5.
 *
 * Three phases, and only the third moves stock:
 *
 *   DRAFT     lines generated, `expected_quantity` snapshotted
 *   COUNTING  staff enter what they actually found; stock keeps moving
 *   FINALIZED corrections applied in one transaction
 *
 * The middle phase deliberately does not lock anything. A shop cannot stop
 * selling for the hours a stocktake takes, so the count is reconciled against
 * the stock as it stands at finalization, not as it stood when the sheet was
 * printed.
 */
@Injectable()
export class CountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListCountsDto) {
    const where: Prisma.InventoryCountWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { countNumber: { contains: query.q, mode: 'insensitive' } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.inventoryCount.findMany({
        where,
        select: {
          id: true,
          countNumber: true,
          status: true,
          scope: true,
          categoryId: true,
          startedAt: true,
          finalizedAt: true,
          createdBy: true,
          finalizedBy: true,
          note: true,
          createdAt: true,
          warehouse: { select: { id: true, code: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.inventoryCount.count({ where }),
    ]);

    return {
      data: rows.map(({ _count, ...c }) => ({ ...c, lineCount: _count.items })),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  async findOne(countId: string) {
    const count = await this.prisma.db.inventoryCount.findFirst({
      where: { id: countId },
      select: {
        id: true,
        countNumber: true,
        status: true,
        scope: true,
        categoryId: true,
        startedAt: true,
        finalizedAt: true,
        cancelledAt: true,
        createdBy: true,
        finalizedBy: true,
        note: true,
        createdAt: true,
        updatedAt: true,
        warehouse: { select: { id: true, code: true, name: true } },
        items: {
          select: {
            id: true,
            productVariantId: true,
            expectedQuantity: true,
            countedQuantity: true,
            unitCost: true,
            countedBy: true,
            countedAt: true,
            appliedDelta: true,
            variant: {
              select: {
                sku: true,
                barcode: true,
                name: true,
                unit: true,
                product: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { variant: { sku: 'asc' } },
        },
      },
    });
    if (!count) throw BusinessRuleException.notFound('Inventarizatsiya', countId);

    const items = count.items.map((item) => {
      const expected = toNumber(item.expectedQuantity);
      const counted = item.countedQuantity === null ? null : toNumber(item.countedQuantity);
      // The reported difference is against the snapshot, which is what the
      // person holding the sheet wants to see. The correction actually
      // applied is `appliedDelta`, computed at finalization against live
      // stock — the two differ whenever the shop sold something mid-count,
      // and that difference is the whole reason both are kept.
      const difference = counted === null ? null : counted - expected;

      return {
        id: item.id,
        variantId: item.productVariantId,
        sku: item.variant.sku,
        barcode: item.variant.barcode,
        variantName: item.variant.name,
        unit: item.variant.unit,
        product: item.variant.product,
        expectedQuantity: formatQuantity(expected),
        countedQuantity: counted === null ? null : formatQuantity(counted),
        difference: difference === null ? null : formatQuantity(difference),
        unitCost: item.unitCost?.toString() ?? null,
        differenceValue:
          difference === null || item.unitCost === null
            ? null
            : ((BigInt(Math.round(difference * 1000)) * item.unitCost) / 1000n).toString(),
        appliedDelta: item.appliedDelta === null ? null : formatQuantity(item.appliedDelta),
        countedBy: item.countedBy,
        countedAt: item.countedAt,
      };
    });

    // Recomputed from the rows rather than from the formatted output above:
    // a summary derived from display strings is a summary one reformat away
    // from being wrong.
    const numeric = count.items
      .filter((i) => i.countedQuantity !== null)
      .map((i) => toNumber(i.countedQuantity) - toNumber(i.expectedQuantity));

    return {
      ...count,
      items,
      summary: {
        lines: items.length,
        counted: numeric.length,
        pending: items.length - numeric.length,
        discrepancies: numeric.filter((d) => d !== 0).length,
        shortage: formatQuantity(numeric.reduce((s, d) => s + Math.min(d, 0), 0)),
        surplus: formatQuantity(numeric.reduce((s, d) => s + Math.max(d, 0), 0)),
      },
    };
  }

  /**
   * Opens a count and generates its lines.
   *
   * `uq_one_open_count_per_warehouse` makes a second open count of the same
   * warehouse impossible at the database level, which removes the race where
   * two stocktakes both snapshot the same expected quantities and the second
   * finalization silently undoes the first.
   */
  async create(dto: CreateCountDto, tenant: TenantContext) {
    const warehouse = await this.inventory.requireWarehouse(dto.warehouseId);
    const scope = dto.scope ?? 'FULL';

    if (scope === 'CATEGORY' && !dto.categoryId) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'scope=CATEGORY uchun categoryId majburiy.',
      });
    }
    if (scope === 'PARTIAL' && !dto.variantIds?.length) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'scope=PARTIAL uchun kamida bitta variant kerak.',
      });
    }
    if (dto.categoryId) await this.requireCategory(dto.categoryId);
    if (dto.variantIds?.length) await this.inventory.requireVariants(dto.variantIds);

    const lines = await this.snapshotLines(dto, scope, warehouse.id, tenant.organizationId);
    if (lines.length === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.COUNT_EMPTY,
        detail: 'Bu tanlov bo‘yicha sanaladigan variant topilmadi.',
      });
    }

    const created = await this.prisma.db
      .$transaction(async (tx) => {
        const countNumber = await nextDocumentNumber(tx, {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          documentType: 'INVENTORY_COUNT',
          prefix: 'INV',
        });

        return tx.inventoryCount.create({
          data: {
            organizationId: tenant.organizationId,
            warehouseId: warehouse.id,
            countNumber,
            status: 'COUNTING',
            scope,
            categoryId: dto.categoryId ?? null,
            startedAt: new Date(),
            createdBy: tenant.userId,
            note: dto.note ?? null,
            items: {
              createMany: {
                data: lines.map((line) => ({
                  organizationId: tenant.organizationId,
                  productVariantId: line.variantId,
                  expectedQuantity: line.quantity,
                  unitCost: line.unitCost,
                })),
              },
            },
          },
          select: { id: true, countNumber: true },
        });
      })
      .catch(rethrowOpenCount);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'inventory_count.opened',
      entityType: 'inventory_count',
      entityId: created.id,
      metadata: {
        countNumber: created.countNumber,
        warehouseId: warehouse.id,
        scope,
        lines: lines.length,
      },
    });

    return this.findOne(created.id);
  }

  /** Records what was found. Idempotent per line — re-entering a count overwrites it. */
  async submit(countId: string, dto: SubmitCountDto, tenant: TenantContext) {
    const count = await this.requireOpenCount(countId);

    const known = await this.prisma.db.inventoryCountItem.findMany({
      where: { inventoryCountId: countId },
      select: { id: true, productVariantId: true },
    });
    const byVariant = new Map(known.map((i) => [i.productVariantId, i.id]));

    const unknown = dto.items.filter((i) => !byVariant.has(i.variantId));
    if (unknown.length) {
      throw new BusinessRuleException({
        code: ErrorCode.RESOURCE_NOT_FOUND,
        detail: 'Bu variantlar sanoq ro‘yxatida yo‘q.',
        errors: unknown.map((u) => ({
          code: ErrorCode.RESOURCE_NOT_FOUND,
          message: u.variantId,
          meta: { variantId: u.variantId },
        })),
      });
    }

    const now = new Date();
    await this.prisma.db.$transaction(
      dto.items.map((entry, index) =>
        this.prisma.db.inventoryCountItem.update({
          where: {
            organizationId_id: {
              organizationId: tenant.organizationId,
              id: byVariant.get(entry.variantId)!,
            },
          },
          data: {
            countedQuantity: parseQuantity(
              entry.countedQuantity,
              `items[${index}].countedQuantity`,
            ).toFixed(3),
            countedBy: tenant.userId,
            countedAt: now,
          },
        }),
      ),
    );

    return this.findOne(count.id);
  }

  /**
   * Applies the corrections — docs/ARCHITECTURE.md §9.5.
   *
   * The delta is `counted − current`, deliberately NOT `counted − expected`.
   * The snapshot is minutes or hours old by now, and using it would silently
   * reverse every sale made while the count was open: a shop that counted 50,
   * sold 3, and finalized would end up back at 50 with three units it no
   * longer has.
   *
   * Lines never counted are skipped, not zeroed. Counting nothing is not the
   * same as counting zero, and conflating the two destroys inventory.
   */
  async finalize(countId: string, dto: FinalizeCountDto, tenant: TenantContext) {
    const count = await this.requireOpenCount(countId);

    const result = await this.prisma.db.$transaction(async (tx) => {
      // Claim the count FIRST, with a conditional UPDATE.
      //
      // Re-reading the status and then checking it in TypeScript does not
      // work: in READ COMMITTED both transactions read 'COUNTING', both pass
      // the check, and both apply their corrections. This statement takes the
      // row lock and re-evaluates `status` against the committed row, so the
      // second finalization matches zero rows and is rejected — the same
      // shape as the stock guard in §9.3, for the same reason.
      const claimed = await tx.$executeRaw`
        UPDATE inventory_count
           SET status      = 'FINALIZED'::"InventoryCountStatus",
               finalized_at = now(),
               finalized_by = ${tenant.userId}::uuid,
               note        = COALESCE(${dto.note ?? null}, note),
               updated_at  = now()
         WHERE id = ${countId}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND status IN ('DRAFT', 'COUNTING')
      `;
      if (claimed === 0) throw notOpen(countId);

      const fresh = await tx.inventoryCount.findFirstOrThrow({
        where: { id: countId },
        select: { id: true, status: true, warehouseId: true, countNumber: true },
      });

      const items = await tx.inventoryCountItem.findMany({
        where: { inventoryCountId: countId, countedQuantity: { not: null } },
        select: { id: true, productVariantId: true, countedQuantity: true, unitCost: true },
        orderBy: { productVariantId: 'asc' },
      });

      // Current stock for exactly those variants, read inside the same
      // transaction that is about to move it.
      const levels = await tx.inventoryLevel.findMany({
        where: {
          warehouseId: fresh.warehouseId,
          productVariantId: { in: items.map((i) => i.productVariantId) },
        },
        select: { productVariantId: true, quantity: true },
      });
      const current = new Map(levels.map((l) => [l.productVariantId, toNumber(l.quantity)]));

      let shrinkageValue = 0n;
      let corrected = 0;

      for (const item of items) {
        const counted = toNumber(item.countedQuantity);
        const live = current.get(item.productVariantId) ?? 0;
        // Round to the stored scale before comparing, or a float artefact
        // produces a "correction" of 0.0000000001.
        const delta = Math.round((counted - live) * 1000) / 1000;

        await tx.inventoryCountItem.update({
          where: { organizationId_id: { organizationId: tenant.organizationId, id: item.id } },
          data: { appliedDelta: delta.toFixed(3) },
        });

        if (delta === 0) continue;

        await this.inventory.apply(tx, {
          organizationId: tenant.organizationId,
          warehouseId: fresh.warehouseId,
          variantId: item.productVariantId,
          type: 'COUNT_CORRECTION',
          delta,
          sourceType: 'inventory_count',
          sourceId: countId,
          reason: 'COUNT_CORRECTION',
          note: dto.note ?? null,
          actorId: tenant.userId,
        });

        corrected += 1;
        if (item.unitCost !== null) {
          shrinkageValue += (BigInt(Math.round(delta * 1000)) * item.unitCost) / 1000n;
        }
      }

      return {
        countNumber: fresh.countNumber,
        linesCounted: items.length,
        corrected,
        shrinkageValue,
      };
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'inventory_count.finalized',
      entityType: 'inventory_count',
      entityId: count.id,
      metadata: {
        countNumber: result.countNumber,
        warehouseId: count.warehouseId,
        linesCounted: result.linesCounted,
        corrections: result.corrected,
        // Negative means stock was missing — the number a manager actually
        // asks for after a stocktake.
        shrinkageValue: result.shrinkageValue.toString(),
      },
    });

    return this.findOne(count.id);
  }

  async cancel(countId: string, tenant: TenantContext) {
    const count = await this.requireOpenCount(countId);

    // Conditional, for the same reason finalize() is: cancelling a count
    // another request is in the middle of finalizing must lose, not race.
    const claimed = await this.prisma.db.$executeRaw`
      UPDATE inventory_count
         SET status = 'CANCELLED'::"InventoryCountStatus",
             cancelled_at = now(),
             updated_at = now()
       WHERE id = ${countId}::uuid
         AND organization_id = ${tenant.organizationId}::uuid
         AND status IN ('DRAFT', 'COUNTING')
    `;
    if (claimed === 0) throw notOpen(countId);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'inventory_count.cancelled',
      entityType: 'inventory_count',
      entityId: countId,
      metadata: { countNumber: count.countNumber },
    });

    return this.findOne(countId);
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * The lines, with `expected_quantity` and `unit_cost` snapshotted.
   *
   * FULL takes every variant that has a level row in this warehouse —
   * including the zero ones, because "the shelf says zero and there are four"
   * is exactly what a stocktake is for. PARTIAL takes the named variants even
   * if they have never been stocked here, so a count can discover stock the
   * system does not know about at all.
   */
  private async snapshotLines(
    dto: CreateCountDto,
    scope: 'FULL' | 'PARTIAL' | 'CATEGORY',
    warehouseId: string,
    organizationId: string,
  ) {
    if (scope === 'PARTIAL') {
      const variantIds = dto.variantIds ?? [];
      const rows = await this.prisma.db.$queryRaw<
        Array<{ variant_id: string; quantity: string; unit_cost: bigint }>
      >`
        SELECT v.id                                     AS variant_id,
               COALESCE(l.quantity, 0)::text            AS quantity,
               COALESCE(l.avg_cost, v.purchase_price)   AS unit_cost
          FROM product_variant v
          LEFT JOIN inventory_level l
                 ON l.product_variant_id = v.id AND l.warehouse_id = ${warehouseId}::uuid
         WHERE v.organization_id = ${organizationId}::uuid
           AND v.archived_at IS NULL
           AND v.id IN (${Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`))})
      `;
      return rows.map((r) => ({
        variantId: r.variant_id,
        quantity: r.quantity,
        unitCost: r.unit_cost,
      }));
    }

    const categoryFilter = dto.categoryId
      ? Prisma.sql`AND p.category_id = ${dto.categoryId}::uuid`
      : Prisma.empty;

    const rows = await this.prisma.db.$queryRaw<
      Array<{ variant_id: string; quantity: string; unit_cost: bigint }>
    >`
      SELECT l.product_variant_id                     AS variant_id,
             l.quantity::text                         AS quantity,
             COALESCE(NULLIF(l.avg_cost, 0), v.purchase_price) AS unit_cost
        FROM inventory_level l
        JOIN product_variant v ON v.id = l.product_variant_id
        JOIN product p ON p.id = v.product_id
       WHERE l.organization_id = ${organizationId}::uuid
         AND l.warehouse_id = ${warehouseId}::uuid
         AND v.archived_at IS NULL
         AND p.archived_at IS NULL
         ${categoryFilter}
       ORDER BY v.sku
    `;

    return rows.map((r) => ({
      variantId: r.variant_id,
      quantity: r.quantity,
      unitCost: r.unit_cost,
    }));
  }

  private async requireOpenCount(countId: string) {
    const count = await this.prisma.db.inventoryCount.findFirst({
      where: { id: countId },
      select: { id: true, status: true, warehouseId: true, countNumber: true },
    });
    if (!count) throw BusinessRuleException.notFound('Inventarizatsiya', countId);
    if (!OPEN_STATUSES.includes(count.status as (typeof OPEN_STATUSES)[number])) {
      throw notOpen(countId, count.status);
    }
    return count;
  }

  private async requireCategory(categoryId: string) {
    const category = await this.prisma.db.category.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw BusinessRuleException.notFound('Kategoriya', categoryId);
  }
}

function notOpen(countId: string, status?: string): BusinessRuleException {
  return new BusinessRuleException({
    code: ErrorCode.COUNT_NOT_OPEN,
    detail:
      status === 'FINALIZED'
        ? "Yakunlangan inventarizatsiya o'zgartirilmaydi. Yangi sanoq oching."
        : 'Bu inventarizatsiya ochiq emas.',
    errors: [
      { code: ErrorCode.COUNT_NOT_OPEN, message: countId, meta: { status: status ?? null } },
    ],
  });
}

/** uq_one_open_count_per_warehouse — the database said no, and it was right. */
function rethrowOpenCount(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.COUNT_ALREADY_OPEN,
      detail:
        'Bu omborda ochiq inventarizatsiya allaqachon bor. Avval uni yakunlang yoki bekor qiling.',
    });
  }
  throw error;
}
