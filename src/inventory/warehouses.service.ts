import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { formatQuantity, toNumber } from '../common/quantity';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type {
  CreateWarehouseDto,
  ListWarehousesDto,
  UpdateWarehouseDto,
} from './dto/inventory.dto';

const WAREHOUSE_FIELDS = {
  id: true,
  storeId: true,
  code: true,
  name: true,
  isDefault: true,
  allowNegativeStock: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Warehouses — docs/ARCHITECTURE.md §5.2.
 *
 * A warehouse may belong to a store or to none (a central warehouse serving
 * several branches), which is why `store_id` is nullable. Stock never lives in
 * a store directly: a store is where people are, a warehouse is where goods
 * are, and a chain that discovers it needs a back room after going live would
 * otherwise have to migrate every movement ever written.
 *
 * Permissions reuse the existing catalogue rather than inventing a
 * `warehouses.*` group: reading a warehouse is `inventory.read`, because a
 * warehouse list with no stock in it is not a thing anyone asks for, and
 * creating one is `stores.manage`, because a warehouse is part of how a store
 * is structured. A new permission group would have to be granted to every
 * existing role before anyone could use the feature.
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListWarehousesDto) {
    const where: Prisma.WarehouseWhereInput = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { code: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.warehouse.findMany({
        where,
        select: {
          ...WAREHOUSE_FIELDS,
          store: { select: { id: true, code: true, name: true } },
          _count: { select: { levels: true } },
        },
        orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.warehouse.count({ where }),
    ]);

    return {
      data: rows.map(({ _count, ...w }) => ({ ...w, trackedVariants: _count.levels })),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  async findOne(warehouseId: string) {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id: warehouseId },
      select: {
        ...WAREHOUSE_FIELDS,
        store: { select: { id: true, code: true, name: true } },
      },
    });
    if (!warehouse) throw BusinessRuleException.notFound('Ombor', warehouseId);

    // One aggregate rather than a row per variant: this is a header, and the
    // stock list endpoint exists for the detail.
    const [totals] = await this.prisma.db.$queryRaw<
      Array<{ tracked: number; out_of_stock: number; stock_value: string }>
    >`
      SELECT count(*)::int                                       AS tracked,
             count(*) FILTER (WHERE quantity <= 0)::int          AS out_of_stock,
             COALESCE(SUM(quantity * avg_cost), 0)::text         AS stock_value
        FROM inventory_level
       WHERE warehouse_id = ${warehouseId}::uuid
    `;

    return {
      ...warehouse,
      stock: {
        trackedVariants: totals?.tracked ?? 0,
        outOfStock: totals?.out_of_stock ?? 0,
        stockValue: totals?.stock_value ?? '0',
      },
    };
  }

  async create(dto: CreateWarehouseDto, tenant: TenantContext) {
    if (dto.storeId) await this.requireStore(dto.storeId);

    const created = await this.prisma.db
      .$transaction(async (tx) => {
        // A second default would trip uq_default_warehouse_per_store, so the
        // incumbent steps down first. Inside the transaction, or a failure
        // halfway leaves a store with no default at all.
        if (dto.isDefault && dto.storeId) {
          await tx.warehouse.updateMany({
            where: { storeId: dto.storeId, isDefault: true, archivedAt: null },
            data: { isDefault: false },
          });
        }

        return tx.warehouse.create({
          data: {
            organizationId: tenant.organizationId,
            storeId: dto.storeId ?? null,
            code: dto.code.trim().toUpperCase(),
            name: dto.name.trim(),
            isDefault: dto.isDefault ?? false,
            allowNegativeStock: dto.allowNegativeStock ?? null,
          },
          select: WAREHOUSE_FIELDS,
        });
      })
      .catch(rethrowDuplicateCode);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'warehouse.created',
      entityType: 'warehouse',
      entityId: created.id,
      metadata: { code: created.code, name: created.name, storeId: created.storeId },
    });

    return created;
  }

  async update(warehouseId: string, dto: UpdateWarehouseDto, tenant: TenantContext) {
    const existing = await this.prisma.db.warehouse.findFirst({
      where: { id: warehouseId },
      select: { id: true, storeId: true, code: true, isDefault: true },
    });
    if (!existing) throw BusinessRuleException.notFound('Ombor', warehouseId);

    const updated = await this.prisma.db
      .$transaction(async (tx) => {
        if (dto.isDefault === true && existing.storeId) {
          await tx.warehouse.updateMany({
            where: {
              storeId: existing.storeId,
              isDefault: true,
              archivedAt: null,
              NOT: { id: warehouseId },
            },
            data: { isDefault: false },
          });
        }

        return tx.warehouse.update({
          where: { organizationId_id: { organizationId: tenant.organizationId, id: warehouseId } },
          data: {
            ...(dto.code !== undefined ? { code: dto.code.trim().toUpperCase() } : {}),
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
            ...(dto.allowNegativeStock !== undefined
              ? { allowNegativeStock: dto.allowNegativeStock }
              : {}),
          },
          select: WAREHOUSE_FIELDS,
        });
      })
      .catch(rethrowDuplicateCode);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'warehouse.updated',
      entityType: 'warehouse',
      entityId: warehouseId,
      metadata: { changed: Object.keys(dto) },
    });

    return updated;
  }

  /**
   * Archived, never deleted: every movement ever written names this warehouse
   * and those foreign keys are ON DELETE RESTRICT.
   *
   * A warehouse still holding stock cannot be archived. Allowing it would make
   * that stock invisible to every report while it still counts in the totals —
   * the worst of both, and impossible to notice until a stocktake.
   */
  async archive(warehouseId: string, tenant: TenantContext) {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id: warehouseId },
      select: { id: true, code: true, archivedAt: true },
    });
    if (!warehouse) throw BusinessRuleException.notFound('Ombor', warehouseId);

    const [remaining] = await this.prisma.db.$queryRaw<Array<{ qty: string; variants: number }>>`
      SELECT COALESCE(SUM(quantity), 0)::text          AS qty,
             count(*) FILTER (WHERE quantity <> 0)::int AS variants
        FROM inventory_level
       WHERE warehouse_id = ${warehouseId}::uuid
    `;

    if (remaining && toNumber(remaining.qty) !== 0) {
      throw new BusinessRuleException({
        code: ErrorCode.WAREHOUSE_HAS_STOCK,
        detail: `Omborda hali ${remaining.variants} ta variant bo'yicha qoldiq bor. Avval ko'chiring yoki hisobdan chiqaring.`,
        errors: [
          {
            code: ErrorCode.WAREHOUSE_HAS_STOCK,
            message: warehouse.code,
            meta: { quantity: formatQuantity(remaining.qty), variants: remaining.variants },
          },
        ],
      });
    }

    const archived = await this.prisma.db.warehouse.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: warehouseId } },
      data: { archivedAt: warehouse.archivedAt ?? new Date(), isDefault: false },
      select: WAREHOUSE_FIELDS,
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'warehouse.archived',
      entityType: 'warehouse',
      entityId: warehouseId,
      metadata: { code: warehouse.code },
    });

    return archived;
  }

  async restore(warehouseId: string, tenant: TenantContext) {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id: warehouseId },
      select: { id: true, code: true },
    });
    if (!warehouse) throw BusinessRuleException.notFound('Ombor', warehouseId);

    const restored = await this.prisma.db.warehouse
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: warehouseId } },
        data: { archivedAt: null },
        select: WAREHOUSE_FIELDS,
      })
      .catch(rethrowDuplicateCode);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'warehouse.restored',
      entityType: 'warehouse',
      entityId: warehouseId,
      metadata: { code: warehouse.code },
    });

    return restored;
  }

  private async requireStore(storeId: string) {
    const store = await this.prisma.db.store.findFirst({
      where: { id: storeId },
      select: { id: true },
    });
    if (!store) throw BusinessRuleException.notFound("Do'kon", storeId);
    return store;
  }
}

/**
 * P2002 on the warehouse code.
 *
 * Under Prisma 7's driver adapter the violated index name is not in
 * `meta.target` where the ORM used to put it — it arrives nested under the
 * adapter's own error. Both places are read, so this keeps working whichever
 * one a future version settles on.
 */
function rethrowDuplicateCode(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.DUPLICATE_RESOURCE,
      detail: 'Bu kod bilan ombor allaqachon mavjud.',
    });
  }
  throw error;
}
