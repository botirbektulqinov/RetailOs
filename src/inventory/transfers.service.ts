import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { nextDocumentNumber } from '../common/document-number';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { formatQuantity, parseQuantity, toNumber } from '../common/quantity';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { CreateTransferDto, ListTransfersDto, ReceiveTransferDto } from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

/**
 * Stock transfers — docs/ARCHITECTURE.md §9.6.
 *
 *   DRAFT     lines editable, no stock effect
 *   SENT      TRANSFER_OUT applied at the source; goods are in transit and
 *             belong to neither warehouse's sellable stock
 *   RECEIVED  TRANSFER_IN applied at the destination for what actually arrived
 *
 * Stock leaves at send rather than at receive because the van is not a
 * warehouse: a branch that can still sell goods already loaded onto a truck
 * will oversell them.
 *
 * Both legs carry `source_type='stock_transfer'` and the same `source_id`, so
 * the pair — and any shortfall between them — is one query away.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListTransfersDto) {
    const warehouseFilter: Prisma.StockTransferWhereInput = query.warehouseId
      ? query.direction === 'OUT'
        ? { fromWarehouseId: query.warehouseId }
        : query.direction === 'IN'
          ? { toWarehouseId: query.warehouseId }
          : {
              OR: [{ fromWarehouseId: query.warehouseId }, { toWarehouseId: query.warehouseId }],
            }
      : {};

    const where: Prisma.StockTransferWhereInput = {
      ...warehouseFilter,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { transferNumber: { contains: query.q, mode: 'insensitive' } } : {}),
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
      this.prisma.db.stockTransfer.findMany({
        where,
        select: {
          id: true,
          transferNumber: true,
          status: true,
          sentAt: true,
          receivedAt: true,
          createdBy: true,
          sentBy: true,
          receivedBy: true,
          note: true,
          createdAt: true,
          fromWarehouse: { select: { id: true, code: true, name: true } },
          toWarehouse: { select: { id: true, code: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.stockTransfer.count({ where }),
    ]);

    return {
      data: rows.map(({ _count, ...t }) => ({ ...t, lineCount: _count.items })),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  async findOne(transferId: string) {
    const transfer = await this.prisma.db.stockTransfer.findFirst({
      where: { id: transferId },
      select: {
        id: true,
        transferNumber: true,
        status: true,
        sentAt: true,
        receivedAt: true,
        cancelledAt: true,
        createdBy: true,
        sentBy: true,
        receivedBy: true,
        note: true,
        createdAt: true,
        updatedAt: true,
        fromWarehouse: { select: { id: true, code: true, name: true } },
        toWarehouse: { select: { id: true, code: true, name: true } },
        items: {
          select: {
            id: true,
            productVariantId: true,
            quantity: true,
            receivedQuantity: true,
            unitCost: true,
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
    if (!transfer) throw BusinessRuleException.notFound('Transfer', transferId);

    const items = transfer.items.map((item) => {
      const sent = toNumber(item.quantity);
      const received = toNumber(item.receivedQuantity);
      return {
        id: item.id,
        variantId: item.productVariantId,
        sku: item.variant.sku,
        barcode: item.variant.barcode,
        variantName: item.variant.name,
        unit: item.variant.unit,
        product: item.variant.product,
        quantity: formatQuantity(sent),
        receivedQuantity: formatQuantity(received),
        // Only meaningful once received; before that everything is "missing".
        shortfall: formatQuantity(transfer.status === 'RECEIVED' ? sent - received : 0),
        unitCost: item.unitCost.toString(),
      };
    });

    return {
      ...transfer,
      items,
      summary: {
        lines: items.length,
        quantitySent: formatQuantity(transfer.items.reduce((s, i) => s + toNumber(i.quantity), 0)),
        quantityReceived: formatQuantity(
          transfer.items.reduce((s, i) => s + toNumber(i.receivedQuantity), 0),
        ),
        shortfall: formatQuantity(
          transfer.status === 'RECEIVED'
            ? transfer.items.reduce(
                (s, i) => s + toNumber(i.quantity) - toNumber(i.receivedQuantity),
                0,
              )
            : 0,
        ),
      },
    };
  }

  /**
   * Creates a transfer and sends it in one step.
   *
   * A DRAFT that nobody sends is a to-do list, not a document, and the design
   * has no screen for editing one. Stock leaves immediately, so the source's
   * availability is honest from the moment the van is loaded. Cancelling
   * before receipt returns it (see `cancel`).
   */
  async create(dto: CreateTransferDto, tenant: TenantContext) {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new BusinessRuleException({
        code: ErrorCode.TRANSFER_SAME_WAREHOUSE,
        detail: "Manba va qabul qiluvchi ombor bir xil bo'la olmaydi.",
      });
    }

    const [from, to] = await Promise.all([
      this.inventory.requireWarehouse(dto.fromWarehouseId),
      this.inventory.requireWarehouse(dto.toWarehouseId),
    ]);

    // Duplicate variant lines would each try to insert the same
    // (transfer, variant) pair and trip the unique index halfway through the
    // transaction; catching it here says something useful instead.
    const seen = new Set<string>();
    for (const line of dto.items) {
      if (seen.has(line.variantId)) {
        throw new BusinessRuleException({
          code: ErrorCode.DUPLICATE_RESOURCE,
          detail: 'Bir variant ikki marta kiritilgan.',
          errors: [
            {
              code: ErrorCode.DUPLICATE_RESOURCE,
              message: line.variantId,
              meta: { variantId: line.variantId },
            },
          ],
        });
      }
      seen.add(line.variantId);
    }

    const variants = await this.inventory.requireVariants(dto.items.map((i) => i.variantId));

    // Parsed once, at the boundary. Everything below this line is numbers.
    const lines = dto.items.map((item, index) => ({
      variantId: item.variantId,
      quantity: parseQuantity(item.quantity, `items[${index}].quantity`),
    }));
    if (lines.some((l) => l.quantity <= 0)) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: 'Transfer miqdori musbat bo‘lishi kerak.',
      });
    }

    const transfer = await this.prisma.db.$transaction(async (tx) => {
      const transferNumber = await nextDocumentNumber(tx, {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        documentType: 'STOCK_TRANSFER',
        prefix: 'TRF',
      });

      // Cost travels with the goods (§8.6), so the destination's moving
      // average is not polluted by a zero-cost arrival. Read before the
      // TRANSFER_OUT, because that is the cost the stock left at.
      const costs = await tx.inventoryLevel.findMany({
        where: {
          warehouseId: from.id,
          productVariantId: { in: lines.map((i) => i.variantId) },
        },
        select: { productVariantId: true, avgCost: true },
      });
      const costByVariant = new Map(costs.map((c) => [c.productVariantId, c.avgCost]));

      const created = await tx.stockTransfer.create({
        data: {
          organizationId: tenant.organizationId,
          transferNumber,
          fromWarehouseId: from.id,
          toWarehouseId: to.id,
          status: 'SENT',
          sentAt: new Date(),
          createdBy: tenant.userId,
          sentBy: tenant.userId,
          note: dto.note ?? null,
          items: {
            createMany: {
              data: lines.map((line) => ({
                organizationId: tenant.organizationId,
                productVariantId: line.variantId,
                quantity: line.quantity.toFixed(3),
                // A zero average means the stock arrived without a costed
                // receipt, not that it was free. Shipping that zero onward
                // would quietly destroy every margin report at the
                // destination, so the catalogue's purchase price stands in —
                // the same fallback the count snapshot uses.
                unitCost:
                  costByVariant.get(line.variantId) ||
                  variants.get(line.variantId)?.purchasePrice ||
                  0n,
              })),
            },
          },
        },
        select: { id: true, transferNumber: true },
      });

      // The guard inside apply() is what prevents transferring more than the
      // source holds. Checking availability up front instead would be a
      // check-then-act with a window in it.
      await this.inventory.applyMany(
        tx,
        lines.map((line) => ({
          organizationId: tenant.organizationId,
          warehouseId: from.id,
          variantId: line.variantId,
          type: 'TRANSFER_OUT' as const,
          delta: -line.quantity,
          unitCost: costByVariant.get(line.variantId) || null,
          sourceType: 'stock_transfer',
          sourceId: created.id,
          note: dto.note ?? null,
          actorId: tenant.userId,
        })),
      );

      return created;
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'stock_transfer.sent',
      entityType: 'stock_transfer',
      entityId: transfer.id,
      metadata: {
        transferNumber: transfer.transferNumber,
        fromWarehouseId: from.id,
        toWarehouseId: to.id,
        lines: lines.length,
        quantity: formatQuantity(lines.reduce((s, i) => s + i.quantity, 0)),
      },
    });

    return this.findOne(transfer.id);
  }

  /**
   * Receives the goods at the destination.
   *
   * Received may be less than sent — shrinkage in transit is real. The
   * shortfall is NOT written off again at the source: the source already gave
   * up the full quantity at send time, so a second deduction would take stock
   * from a warehouse that no longer has it.
   *
   * (docs/ARCHITECTURE.md §9.6 prescribes a WRITE_OFF at the source for the
   * difference. Followed literally that double-counts the loss. The shortfall
   * is instead documented on the transfer line — `quantity` versus
   * `received_quantity` — with a mandatory note, and it is already visible in
   * the ledger as the gap between the TRANSFER_OUT and TRANSFER_IN legs of
   * the same `source_id`. The loss is recorded exactly once.)
   */
  async receive(transferId: string, dto: ReceiveTransferDto, tenant: TenantContext) {
    const transfer = await this.prisma.db.stockTransfer.findFirst({
      where: { id: transferId },
      select: {
        id: true,
        status: true,
        transferNumber: true,
        toWarehouseId: true,
        fromWarehouseId: true,
        items: {
          select: { id: true, productVariantId: true, quantity: true, unitCost: true },
        },
      },
    });
    if (!transfer) throw BusinessRuleException.notFound('Transfer', transferId);
    if (transfer.status !== 'SENT') {
      throw new BusinessRuleException({
        code: ErrorCode.TRANSFER_NOT_SENT,
        detail:
          transfer.status === 'RECEIVED'
            ? 'Bu transfer allaqachon qabul qilingan.'
            : 'Faqat yuborilgan transfer qabul qilinadi.',
        errors: [
          {
            code: ErrorCode.TRANSFER_NOT_SENT,
            message: transfer.transferNumber,
            meta: { status: transfer.status },
          },
        ],
      });
    }

    const declared = new Map(
      (dto.items ?? []).map((i, index) => [
        i.variantId,
        parseQuantity(i.receivedQuantity, `items[${index}].receivedQuantity`),
      ]),
    );
    for (const variantId of declared.keys()) {
      if (!transfer.items.some((i) => i.productVariantId === variantId)) {
        throw BusinessRuleException.notFound('Transfer qatori', variantId);
      }
    }

    // No lines given means everything arrived — the common case, and one the
    // receiving clerk should not have to retype.
    const lines = transfer.items.map((item) => {
      const sent = toNumber(item.quantity);
      const received = declared.has(item.productVariantId)
        ? declared.get(item.productVariantId)!
        : sent;
      if (received > sent) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          detail: 'Yuborilgandan ko‘p qabul qilib bo‘lmaydi.',
          errors: [
            {
              code: ErrorCode.VALIDATION_FAILED,
              message: item.productVariantId,
              meta: { sent: formatQuantity(sent), received: formatQuantity(received) },
            },
          ],
        });
      }
      return { item, sent, received };
    });

    const shortfall = lines.filter((l) => l.received < l.sent);
    if (shortfall.length > 0 && !dto.note?.trim()) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        detail: "Kam kelgan tovar uchun izoh majburiy — yo'qolgan qoldiq tushuntirilishi kerak.",
        errors: shortfall.map((l) => ({
          code: ErrorCode.VALIDATION_FAILED,
          message: l.item.productVariantId,
          meta: { sent: formatQuantity(l.sent), received: formatQuantity(l.received) },
        })),
      });
    }

    await this.prisma.db.$transaction(async (tx) => {
      // Claim the transfer FIRST, with a conditional UPDATE.
      //
      // Re-reading the status and checking it in TypeScript does not work: in
      // READ COMMITTED two clerks scanning the same pallet both read 'SENT',
      // both pass the check, and the stock arrives twice. This statement takes
      // the row lock and re-evaluates against the committed row, so the second
      // one matches zero rows — the same shape as the stock guard in §9.3.
      const claimed = await tx.$executeRaw`
        UPDATE stock_transfer
           SET status      = 'RECEIVED'::"StockTransferStatus",
               received_at = now(),
               received_by = ${tenant.userId}::uuid,
               note        = COALESCE(${dto.note ?? null}, note),
               updated_at  = now()
         WHERE id = ${transferId}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND status = 'SENT'
      `;
      if (claimed === 0) {
        throw new BusinessRuleException({
          code: ErrorCode.TRANSFER_NOT_SENT,
          detail: 'Bu transfer allaqachon qabul qilingan.',
        });
      }

      for (const line of lines) {
        await tx.stockTransferItem.update({
          where: { organizationId_id: { organizationId: tenant.organizationId, id: line.item.id } },
          data: { receivedQuantity: line.received.toFixed(3) },
        });
      }

      await this.inventory.applyMany(
        tx,
        lines
          .filter((l) => l.received > 0)
          .map((l) => ({
            organizationId: tenant.organizationId,
            warehouseId: transfer.toWarehouseId,
            variantId: l.item.productVariantId,
            type: 'TRANSFER_IN' as const,
            delta: l.received,
            unitCost: l.item.unitCost,
            sourceType: 'stock_transfer',
            sourceId: transfer.id,
            note: dto.note ?? null,
            actorId: tenant.userId,
          })),
      );
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'stock_transfer.received',
      entityType: 'stock_transfer',
      entityId: transferId,
      metadata: {
        transferNumber: transfer.transferNumber,
        toWarehouseId: transfer.toWarehouseId,
        note: dto.note ?? null,
        shortfall: shortfall.map((l) => ({
          variantId: l.item.productVariantId,
          sent: formatQuantity(l.sent),
          received: formatQuantity(l.received),
          missing: formatQuantity(l.sent - l.received),
        })),
      },
    });

    return this.findOne(transferId);
  }

  /**
   * Cancels a transfer still in transit and returns the goods to the source.
   *
   * The return is a TRANSFER_IN at the source warehouse rather than a deletion
   * of the TRANSFER_OUT: the ledger is append-only, and "it went out and came
   * back" is what actually happened.
   */
  async cancel(transferId: string, tenant: TenantContext) {
    const transfer = await this.prisma.db.stockTransfer.findFirst({
      where: { id: transferId },
      select: {
        id: true,
        status: true,
        transferNumber: true,
        fromWarehouseId: true,
        items: { select: { productVariantId: true, quantity: true, unitCost: true } },
      },
    });
    if (!transfer) throw BusinessRuleException.notFound('Transfer', transferId);
    if (transfer.status === 'RECEIVED' || transfer.status === 'CANCELLED') {
      throw new BusinessRuleException({
        code: ErrorCode.TRANSFER_NOT_SENT,
        detail: 'Qabul qilingan yoki bekor qilingan transfer bekor qilinmaydi.',
        errors: [
          {
            code: ErrorCode.TRANSFER_NOT_SENT,
            message: transfer.transferNumber,
            meta: { status: transfer.status },
          },
        ],
      });
    }

    await this.prisma.db.$transaction(async (tx) => {
      // Same conditional claim as receive(): cancelling a transfer another
      // request is receiving must lose the race, not double the stock.
      const claimed = await tx.$executeRaw`
        UPDATE stock_transfer
           SET status       = 'CANCELLED'::"StockTransferStatus",
               cancelled_at = now(),
               updated_at   = now()
         WHERE id = ${transferId}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND status = 'SENT'
      `;
      if (claimed === 0) {
        throw new BusinessRuleException({
          code: ErrorCode.TRANSFER_NOT_SENT,
          detail: 'Bu transfer endi bekor qilinmaydi.',
        });
      }

      await this.inventory.applyMany(
        tx,
        transfer.items.map((item) => ({
          organizationId: tenant.organizationId,
          warehouseId: transfer.fromWarehouseId,
          variantId: item.productVariantId,
          type: 'TRANSFER_IN' as const,
          delta: toNumber(item.quantity),
          unitCost: item.unitCost,
          sourceType: 'stock_transfer',
          sourceId: transfer.id,
          note: 'Transfer bekor qilindi',
          actorId: tenant.userId,
        })),
      );
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'stock_transfer.cancelled',
      entityType: 'stock_transfer',
      entityId: transferId,
      metadata: {
        transferNumber: transfer.transferNumber,
        returnedTo: transfer.fromWarehouseId,
        lines: transfer.items.length,
      },
    });

    return this.findOne(transferId);
  }
}
