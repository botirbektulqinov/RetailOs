import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InventoryMovementType } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import {
  formatQuantity,
  parseQuantity,
  stockStatus,
  toNumber,
  toNumericString,
} from '../common/quantity';
import { requireTenant } from '../common/tenant/tenant-context';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import { writeStockMovement } from './stock-writer';
import type { AdjustStockDto, ListMovementsDto, ListStockDto } from './dto/inventory.dto';

/**
 * The transaction client every write path receives.
 *
 * Spelled out rather than imported from Prisma's internals: it is exactly
 * `ITXClientDenyList` applied to our extended client, and writing it here
 * costs one line and survives a Prisma upgrade moving that type around.
 */
export type Tx = Omit<
  PrismaService['db'],
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * A single stock change. Signed: `delta` carries the direction, and the
 * database rejects a sign that contradicts `type` (ck_movement_sign).
 *
 * `warehouseId` and `variantId` are assumed already resolved within the
 * caller's tenant — apply() is not a validation boundary, it is the write
 * path. The composite foreign keys are the backstop if a caller gets that
 * wrong: the transaction aborts rather than writing another tenant's stock.
 */
export interface ApplyCommand {
  organizationId: string;
  warehouseId: string;
  variantId: string;
  type: InventoryMovementType;
  delta: number;
  /** Required for PURCHASE and INITIAL; feeds the moving average (§8.6). */
  unitCost?: bigint | null;
  /** The document that caused this: 'sale', 'stock_transfer', 'adjustment'… */
  sourceType: string;
  sourceId?: string | null;
  /** Mandatory for ADJUSTMENT, DAMAGE and WRITE_OFF (ck_movement_reason_required). */
  reason?: string | null;
  note?: string | null;
  actorId?: string | null;
}

export interface AppliedMovement {
  movementId: string;
  variantId: string;
  warehouseId: string;
  quantityAfter: number;
  avgCost: bigint;
}

/** Reasons the UI offers for a manual adjustment. */
export const ADJUSTMENT_REASONS = ['CORRECTION', 'DAMAGE', 'WRITE_OFF', 'OTHER'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

/**
 * A reason maps to a movement type, because "damaged" and "miscounted" are
 * different events in a stock report even though both reduce the number.
 * CORRECTION and OTHER stay ADJUSTMENT — the only two types that may move in
 * either direction.
 */
function movementTypeFor(reason: AdjustmentReason, delta: number): InventoryMovementType {
  if (delta > 0) return 'ADJUSTMENT';
  if (reason === 'DAMAGE') return 'DAMAGE';
  if (reason === 'WRITE_OFF') return 'WRITE_OFF';
  return 'ADJUSTMENT';
}

const SORTABLE = {
  name: 'product_name',
  sku: 'sku',
  quantity: 'quantity',
  value: 'stock_value',
  updatedAt: 'updated_at',
} as const;

interface StockRow {
  variant_id: string;
  sku: string;
  barcode: string | null;
  variant_name: string | null;
  unit: string;
  min_stock: string;
  selling_price: bigint;
  purchase_price: bigint;
  product_id: string;
  product_name: string;
  brand: string | null;
  category_id: string | null;
  category_name: string | null;
  quantity: string;
  avg_cost: string | null;
  stock_value: string;
  warehouse_count: number;
  updated_at: Date | null;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // The single write path — docs/ARCHITECTURE.md §9.2
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Moves stock and records why, atomically.
   *
   * There is no second way to touch `inventory_level`. Every sale, purchase,
   * return, transfer, count correction and manual adjustment in the system
   * lands here, which is what makes "the ledger explains every number" a
   * structural property rather than a convention someone has to remember.
   *
   * It never opens its own transaction. Receiving one is what makes "the sale
   * and its stock movements commit or fail together" true by construction.
   */
  async apply(tx: Tx, cmd: ApplyCommand): Promise<AppliedMovement> {
    if (cmd.delta === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: 'A movement must change the quantity.',
      });
    }

    const delta = toNumericString(cmd.delta, 'delta');

    // The two statements live in stock-writer.ts so there is exactly one copy
    // of them in the repository — the seed writes opening balances and has no
    // Nest container to resolve this service from.
    const written = await writeStockMovement(tx, {
      organizationId: cmd.organizationId,
      warehouseId: cmd.warehouseId,
      productVariantId: cmd.variantId,
      type: cmd.type,
      delta,
      unitCost: cmd.unitCost ?? null,
      sourceType: cmd.sourceType,
      sourceId: cmd.sourceId ?? null,
      reason: cmd.reason ?? null,
      note: cmd.note ?? null,
      createdBy: cmd.actorId ?? null,
    });

    // null means the guard rejected it. Read the level for the payload — this
    // is the error path, so an extra query costs nothing that matters.
    if (!written) throw await this.insufficientStock(tx, cmd);

    return {
      movementId: written.movementId,
      variantId: cmd.variantId,
      warehouseId: cmd.warehouseId,
      quantityAfter: toNumber(written.quantity),
      avgCost: written.avgCost,
    };
  }

  /**
   * Several lines in one transaction, ordered to make deadlock impossible.
   *
   * Two multi-line documents touching the same two variants would otherwise
   * be able to lock them in opposite orders and wait on each other forever.
   * Sorting by variant id means every caller in the system takes those locks
   * in the same sequence (§9.3).
   */
  async applyMany(tx: Tx, commands: readonly ApplyCommand[]): Promise<AppliedMovement[]> {
    const ordered = [...commands].sort(
      (a, b) =>
        a.warehouseId.localeCompare(b.warehouseId) || a.variantId.localeCompare(b.variantId),
    );

    const out: AppliedMovement[] = [];
    for (const cmd of ordered) out.push(await this.apply(tx, cmd));
    return out;
  }

  private async insufficientStock(tx: Tx, cmd: ApplyCommand): Promise<BusinessRuleException> {
    const level = await tx.inventoryLevel.findFirst({
      where: { warehouseId: cmd.warehouseId, productVariantId: cmd.variantId },
      select: { quantity: true },
    });
    const variant = await tx.productVariant.findFirst({
      where: { id: cmd.variantId },
      select: { sku: true, product: { select: { name: true } } },
    });

    const available = toNumber(level?.quantity);
    return new BusinessRuleException({
      code: ErrorCode.INSUFFICIENT_STOCK,
      status: HttpStatus.CONFLICT,
      detail: `Yetarli qoldiq yo'q: ${variant?.product.name ?? cmd.variantId} — mavjud ${available}, so'ralgan ${Math.abs(cmd.delta)}.`,
      errors: [
        {
          code: ErrorCode.INSUFFICIENT_STOCK,
          message: variant?.sku ?? cmd.variantId,
          meta: {
            variantId: cmd.variantId,
            warehouseId: cmd.warehouseId,
            available: formatQuantity(available),
            requested: formatQuantity(Math.abs(cmd.delta)),
          },
        },
      ],
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Stock per variant, optionally narrowed to one warehouse or one store.
   *
   * Driven from `product_variant` with a LEFT JOIN onto levels, not the other
   * way round: a product that has never been stocked has no level row, and it
   * is exactly the row an out-of-stock report must show. Starting from levels
   * would produce a report that silently omits everything most in need of
   * ordering.
   *
   * Every filter — including LOW_STOCK, which compares two columns — is
   * evaluated in the database. LOW_STOCK is why this is raw SQL: Prisma
   * cannot express `quantity <= variant.min_stock`.
   */
  async list(query: ListStockDto) {
    const tenant = this.tenant();
    const scope = this.stockScope(query, tenant.organizationId);
    const having = this.statusPredicate(query);
    const order = this.stockOrder(query);

    const rows = await this.prisma.db.$queryRaw<StockRow[]>`
      SELECT v.id                                        AS variant_id,
             v.sku, v.barcode,
             v.name                                      AS variant_name,
             v.unit::text                                AS unit,
             v.min_stock::text                           AS min_stock,
             v.selling_price, v.purchase_price,
             p.id                                        AS product_id,
             p.name                                      AS product_name,
             p.brand,
             c.id                                        AS category_id,
             c.name                                      AS category_name,
             COALESCE(SUM(l.quantity), 0)::text          AS quantity,
             CASE WHEN SUM(l.quantity) > 0
                  THEN round(SUM(l.quantity * l.avg_cost) / SUM(l.quantity))::text
                  ELSE NULL END                          AS avg_cost,
             COALESCE(SUM(l.quantity * l.avg_cost), 0)::text AS stock_value,
             count(l.id) FILTER (WHERE l.quantity <> 0)::int AS warehouse_count,
             max(l.updated_at)                           AS updated_at
        FROM product_variant v
        JOIN product p ON p.id = v.product_id
        LEFT JOIN category c ON c.id = p.category_id
        LEFT JOIN inventory_level l
               ON l.product_variant_id = v.id
              ${scope.levelJoin}
       WHERE v.organization_id = ${tenant.organizationId}::uuid
         AND v.archived_at IS NULL
         AND p.archived_at IS NULL
         ${scope.variantFilter}
       GROUP BY v.id, p.id, c.id
      ${having}
      ${order}
       LIMIT ${query.limit} OFFSET ${query.offset}
    `;

    const totals = await this.prisma.db.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total FROM (
        SELECT v.id
          FROM product_variant v
          JOIN product p ON p.id = v.product_id
          LEFT JOIN inventory_level l
                 ON l.product_variant_id = v.id
                ${scope.levelJoin}
         WHERE v.organization_id = ${tenant.organizationId}::uuid
           AND v.archived_at IS NULL
           AND p.archived_at IS NULL
           ${scope.variantFilter}
         GROUP BY v.id, p.id
        ${having}
      ) t
    `;

    const total = totals[0]?.total ?? 0;
    const summary = await this.summary(scope, tenant.organizationId);

    return {
      data: rows.map(toStockItem),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
      summary,
    };
  }

  /** One variant's stock, broken down by warehouse. */
  async findOne(variantId: string) {
    const variant = await this.prisma.db.productVariant.findFirst({
      where: { id: variantId },
      select: {
        id: true,
        sku: true,
        barcode: true,
        name: true,
        unit: true,
        minStock: true,
        sellingPrice: true,
        purchasePrice: true,
        product: { select: { id: true, name: true, brand: true } },
      },
    });
    if (!variant) throw BusinessRuleException.notFound('Mahsulot varianti', variantId);

    const levels = await this.prisma.db.inventoryLevel.findMany({
      where: { productVariantId: variantId },
      select: {
        warehouseId: true,
        quantity: true,
        avgCost: true,
        updatedAt: true,
        warehouse: { select: { code: true, name: true, storeId: true, archivedAt: true } },
      },
      orderBy: { warehouse: { code: 'asc' } },
    });

    const minStock = toNumber(variant.minStock);
    const total = levels.reduce((sum, l) => sum + toNumber(l.quantity), 0);

    return {
      variantId: variant.id,
      sku: variant.sku,
      barcode: variant.barcode,
      variantName: variant.name,
      unit: variant.unit,
      product: variant.product,
      minStock: formatQuantity(minStock),
      sellingPrice: variant.sellingPrice.toString(),
      purchasePrice: variant.purchasePrice.toString(),
      totalQuantity: formatQuantity(total),
      status: stockStatus(total, minStock),
      warehouses: levels.map((l) => {
        const quantity = toNumber(l.quantity);
        return {
          warehouseId: l.warehouseId,
          code: l.warehouse.code,
          name: l.warehouse.name,
          storeId: l.warehouse.storeId,
          archived: l.warehouse.archivedAt !== null,
          quantity: formatQuantity(quantity),
          avgCost: l.avgCost.toString(),
          status: stockStatus(quantity, minStock),
          updatedAt: l.updatedAt,
        };
      }),
    };
  }

  /** The stock card: every movement, newest first. */
  async movements(query: ListMovementsDto) {
    const where: Prisma.InventoryMovementWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.variantId ? { productVariantId: query.variantId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.sourceType ? { sourceType: query.sourceType } : {}),
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.productId ? { variant: { productId: query.productId } } : {}),
      ...(query.storeId ? { warehouse: { storeId: query.storeId } } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.inventoryMovement.findMany({
        where,
        select: {
          id: true,
          type: true,
          quantityDelta: true,
          quantityAfter: true,
          unitCost: true,
          sourceType: true,
          sourceId: true,
          reason: true,
          note: true,
          createdBy: true,
          createdAt: true,
          warehouse: { select: { id: true, code: true, name: true } },
          variant: {
            select: {
              id: true,
              sku: true,
              name: true,
              product: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.inventoryMovement.count({ where }),
    ]);

    return {
      data: rows.map((m) => ({
        id: m.id,
        type: m.type,
        quantityDelta: formatQuantity(m.quantityDelta),
        quantityAfter: formatQuantity(m.quantityAfter),
        unitCost: m.unitCost?.toString() ?? null,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        reason: m.reason,
        note: m.note,
        createdBy: m.createdBy,
        createdAt: m.createdAt,
        warehouse: m.warehouse,
        variant: {
          id: m.variant.id,
          sku: m.variant.sku,
          name: m.variant.name,
          product: m.variant.product,
        },
      })),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Manual adjustment
  // ────────────────────────────────────────────────────────────────────────

  /**
   * One or more manual corrections, all or nothing.
   *
   * A stocktake that finds three broken jars and two miscounted ones is a
   * single decision by a single person; splitting it into two requests means
   * one can succeed while the other fails and nobody can tell afterwards
   * which half happened.
   */
  async adjust(dto: AdjustStockDto, tenant: TenantContext) {
    const warehouse = await this.requireWarehouse(dto.warehouseId);
    const variantIds = dto.lines.map((l) => l.variantId);
    const variants = await this.requireVariants(variantIds);

    const applied = await this.prisma.db.$transaction(async (tx) =>
      this.applyMany(
        tx,
        dto.lines.map((line, index) => ({
          organizationId: tenant.organizationId,
          warehouseId: warehouse.id,
          variantId: line.variantId,
          type: movementTypeFor(line.reason, parseQuantity(line.quantity, `lines[${index}]`)),
          delta: parseQuantity(line.quantity, `lines[${index}].quantity`),
          // The reason is on the row because the database insists
          // (ck_movement_reason_required) — "where did those three go" is the
          // question this table exists to answer.
          reason: line.reason,
          note: line.note ?? dto.note ?? null,
          sourceType: 'adjustment',
          sourceId: null,
          actorId: tenant.userId,
        })),
      ),
    );

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'inventory.adjusted',
      entityType: 'inventory_level',
      entityId: warehouse.id,
      metadata: {
        warehouseId: warehouse.id,
        warehouseCode: warehouse.code,
        note: dto.note ?? null,
        lines: dto.lines.map((line, i) => ({
          variantId: line.variantId,
          sku: variants.get(line.variantId)?.sku ?? null,
          quantity: line.quantity,
          reason: line.reason,
          quantityAfter: formatQuantity(
            applied.find((a) => a.variantId === line.variantId)?.quantityAfter ?? 0,
          ),
          movementId: applied[i]?.movementId ?? null,
        })),
      },
    });

    return {
      warehouseId: warehouse.id,
      movements: applied.map((a) => ({
        movementId: a.movementId,
        variantId: a.variantId,
        sku: variants.get(a.variantId)?.sku ?? null,
        quantityAfter: formatQuantity(a.quantityAfter),
      })),
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shared lookups — used by counts and transfers too
  // ────────────────────────────────────────────────────────────────────────

  async requireWarehouse(warehouseId: string) {
    const warehouse = await this.prisma.db.warehouse.findFirst({
      where: { id: warehouseId },
      select: { id: true, code: true, name: true, storeId: true, archivedAt: true },
    });
    if (!warehouse) throw BusinessRuleException.notFound('Ombor', warehouseId);
    if (warehouse.archivedAt) {
      throw new BusinessRuleException({
        code: ErrorCode.WAREHOUSE_ARCHIVED,
        detail: "Arxivlangan omborda qoldiq o'zgartirib bo'lmaydi.",
      });
    }
    return warehouse;
  }

  /**
   * Resolves every variant id in one query and fails on the first unknown.
   *
   * One query rather than one per line: a fifty-line adjustment should not be
   * fifty round trips, and a partial resolution that throws halfway leaves the
   * caller unable to say which lines were valid.
   */
  async requireVariants(variantIds: readonly string[]) {
    const unique = [...new Set(variantIds)];
    const rows = await this.prisma.db.productVariant.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        sku: true,
        name: true,
        minStock: true,
        purchasePrice: true,
        archivedAt: true,
        product: { select: { id: true, name: true } },
      },
    });

    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of unique) {
      const row = found.get(id);
      // Scoped by the tenant extension, so another organization's variant is
      // simply not found — the caller learns nothing about whether it exists.
      if (!row) throw BusinessRuleException.notFound('Mahsulot varianti', id);
      if (row.archivedAt) {
        throw new BusinessRuleException({
          code: ErrorCode.VARIANT_ARCHIVED,
          detail: `Arxivlangan variant: ${row.sku}.`,
        });
      }
    }
    return found;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Query building
  // ────────────────────────────────────────────────────────────────────────

  /**
   * The raw-SQL reads below filter on organization_id themselves.
   *
   * The Prisma tenant extension never sees a $queryRaw, so relying on it here
   * would be relying on a guard that is not running — the one place in this
   * codebase where the organization has to be named explicitly.
   */
  private tenant(): TenantContext {
    return requireTenant();
  }

  private stockScope(query: ListStockDto, organizationId: string) {
    // The warehouse narrowing belongs in the JOIN, not the WHERE: in the
    // WHERE it would drop variants that have no level row in that warehouse,
    // which are precisely the ones with nothing left to sell.
    const levelJoin = query.warehouseId
      ? Prisma.sql`AND l.warehouse_id = ${query.warehouseId}::uuid`
      : query.storeId
        ? Prisma.sql`AND l.warehouse_id IN (
            SELECT w.id FROM warehouse w
             WHERE w.organization_id = ${organizationId}::uuid
               AND w.store_id = ${query.storeId}::uuid)`
        : Prisma.empty;

    const filters: Prisma.Sql[] = [];
    if (query.categoryId) filters.push(Prisma.sql`AND p.category_id = ${query.categoryId}::uuid`);
    if (query.productId) filters.push(Prisma.sql`AND p.id = ${query.productId}::uuid`);
    if (query.variantId) filters.push(Prisma.sql`AND v.id = ${query.variantId}::uuid`);
    if (query.q) {
      const like = `%${query.q.trim()}%`;
      filters.push(
        Prisma.sql`AND (p.name ILIKE ${like} OR v.sku ILIKE ${like}
                        OR v.barcode ILIKE ${like} OR p.brand ILIKE ${like})`,
      );
    }

    return {
      levelJoin,
      variantFilter: filters.length ? Prisma.join(filters, ' ') : Prisma.empty,
    };
  }

  /**
   * The status filter, applied in HAVING because it reads the summed quantity.
   *
   * `minStock = 0` means no minimum is configured, so such a variant is never
   * LOW_STOCK — otherwise every product in the shop would be "low" the moment
   * it ran out, which is what OUT_OF_STOCK already says.
   */
  private statusPredicate(query: ListStockDto): Prisma.Sql {
    const status = query.lowStock ? 'NEEDS_ATTENTION' : query.status;
    switch (status) {
      case 'OUT_OF_STOCK':
        return Prisma.sql`HAVING COALESCE(SUM(l.quantity), 0) <= 0`;
      case 'LOW_STOCK':
        return Prisma.sql`HAVING COALESCE(SUM(l.quantity), 0) > 0
                            AND v.min_stock > 0
                            AND COALESCE(SUM(l.quantity), 0) <= v.min_stock`;
      case 'IN_STOCK':
        return Prisma.sql`HAVING COALESCE(SUM(l.quantity), 0) > 0
                            AND (v.min_stock = 0 OR COALESCE(SUM(l.quantity), 0) > v.min_stock)`;
      // The re-order list: out of stock, or at/below the minimum. One filter,
      // because "what do I need to buy" is one question.
      case 'NEEDS_ATTENTION':
        return Prisma.sql`HAVING COALESCE(SUM(l.quantity), 0) <= 0
                            OR (v.min_stock > 0 AND COALESCE(SUM(l.quantity), 0) <= v.min_stock)`;
      default:
        return Prisma.empty;
    }
  }

  private stockOrder(query: ListStockDto): Prisma.Sql {
    const [field = 'name', direction = 'asc'] = (query.sort ?? 'name:asc').split(':');
    const column = SORTABLE[field as keyof typeof SORTABLE] ?? SORTABLE.name;
    const desc = direction.toLowerCase() === 'desc';

    // Whitelisted column names interpolated as raw SQL; the values they are
    // chosen from are the only ones that ever reach here.
    switch (column) {
      case 'product_name':
        return desc ? Prisma.sql`ORDER BY p.name DESC` : Prisma.sql`ORDER BY p.name ASC`;
      case 'sku':
        return desc ? Prisma.sql`ORDER BY v.sku DESC` : Prisma.sql`ORDER BY v.sku ASC`;
      case 'quantity':
        return desc
          ? Prisma.sql`ORDER BY COALESCE(SUM(l.quantity), 0) DESC`
          : Prisma.sql`ORDER BY COALESCE(SUM(l.quantity), 0) ASC`;
      case 'stock_value':
        return desc
          ? Prisma.sql`ORDER BY COALESCE(SUM(l.quantity * l.avg_cost), 0) DESC`
          : Prisma.sql`ORDER BY COALESCE(SUM(l.quantity * l.avg_cost), 0) ASC`;
      default:
        return desc
          ? Prisma.sql`ORDER BY max(l.updated_at) DESC NULLS LAST`
          : Prisma.sql`ORDER BY max(l.updated_at) ASC NULLS FIRST`;
    }
  }

  /** The header counts: "12 kam qoldiq · 3 tugagan". */
  private async summary(
    scope: { levelJoin: Prisma.Sql; variantFilter: Prisma.Sql },
    organizationId: string,
  ) {
    const [row] = await this.prisma.db.$queryRaw<
      Array<{ tracked: number; out_of_stock: number; low_stock: number; stock_value: string }>
    >`
      SELECT count(*)::int AS tracked,
             count(*) FILTER (WHERE qty <= 0)::int AS out_of_stock,
             count(*) FILTER (WHERE qty > 0 AND min_stock > 0 AND qty <= min_stock)::int
               AS low_stock,
             COALESCE(SUM(value), 0)::text AS stock_value
        FROM (
          SELECT COALESCE(SUM(l.quantity), 0) AS qty,
                 v.min_stock,
                 COALESCE(SUM(l.quantity * l.avg_cost), 0) AS value
            FROM product_variant v
            JOIN product p ON p.id = v.product_id
            LEFT JOIN inventory_level l
                   ON l.product_variant_id = v.id
                  ${scope.levelJoin}
           WHERE v.organization_id = ${organizationId}::uuid
             AND v.archived_at IS NULL
             AND p.archived_at IS NULL
             ${scope.variantFilter}
           GROUP BY v.id, v.min_stock
        ) t
    `;

    return {
      tracked: row?.tracked ?? 0,
      outOfStock: row?.out_of_stock ?? 0,
      lowStock: row?.low_stock ?? 0,
      stockValue: row?.stock_value ?? '0',
    };
  }
}

function toStockItem(row: StockRow) {
  const quantity = toNumber(row.quantity);
  const minStock = toNumber(row.min_stock);

  return {
    variantId: row.variant_id,
    sku: row.sku,
    barcode: row.barcode,
    variantName: row.variant_name,
    unit: row.unit,
    product: { id: row.product_id, name: row.product_name, brand: row.brand },
    category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
    quantity: formatQuantity(quantity),
    minStock: formatQuantity(minStock),
    status: stockStatus(quantity, minStock),
    avgCost: row.avg_cost,
    stockValue: row.stock_value,
    sellingPrice: row.selling_price.toString(),
    purchasePrice: row.purchase_price.toString(),
    warehouseCount: row.warehouse_count,
    updatedAt: row.updated_at,
  };
}
