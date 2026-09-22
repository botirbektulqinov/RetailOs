import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { nextDocumentNumber } from '../common/document-number';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { priceTimesQuantity, quantityToMilli } from '../common/money/money';
import { formatQuantity, parseQuantity, toNumber } from '../common/quantity';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { Tx } from '../database/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import type {
  CancelPurchaseDto,
  CreatePurchaseDto,
  ListPurchasesDto,
  ReceivePurchaseDto,
  UpdatePurchaseDto,
} from './dto/purchase.dto';

/** Statuses whose lines may still be edited. */
const EDITABLE = ['DRAFT'] as const;
/** Statuses goods may still arrive against. */
const RECEIVABLE = ['ORDERED', 'PARTIALLY_RECEIVED'] as const;

const SORT: Record<string, Prisma.PurchaseOrderByWithRelationInput> = {
  'createdAt:desc': { createdAt: 'desc' },
  'createdAt:asc': { createdAt: 'asc' },
  'total:desc': { totalAmount: 'desc' },
  'total:asc': { totalAmount: 'asc' },
  'purchaseNumber:asc': { purchaseNumber: 'asc' },
};

/**
 * Purchases and receiving — docs/ARCHITECTURE.md §15.
 *
 * ```
 * DRAFT ──order──▶ ORDERED ──receive──▶ PARTIALLY_RECEIVED ──▶ RECEIVED
 *   └────────────────┴── cancel, while nothing has been received
 * ```
 *
 * Payment state is deliberately separate from receipt state. A purchase can be
 * RECEIVED and unpaid, or paid and not yet delivered; conflating them into one
 * status is why so many systems cannot answer "what do we owe".
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListPurchasesDto) {
    const where: Prisma.PurchaseWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.unpaid
        ? {
            status: { in: ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'] },
            // Prisma cannot compare two columns, so the payable filter is the
            // one place this list reaches for raw SQL.
            AND: [{ NOT: { paidAmount: { equals: this.prisma.db.purchase.fields.totalAmount } } }],
          }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            createdAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { purchaseNumber: { contains: query.q, mode: 'insensitive' } },
              { supplierInvoiceNumber: { contains: query.q, mode: 'insensitive' } },
              { supplier: { name: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total, sums] = await Promise.all([
      this.prisma.db.purchase.findMany({
        where,
        select: {
          id: true,
          purchaseNumber: true,
          status: true,
          supplierInvoiceNumber: true,
          totalAmount: true,
          paidAmount: true,
          orderedAt: true,
          expectedAt: true,
          receivedAt: true,
          createdAt: true,
          supplier: { select: { id: true, name: true } },
          _count: { select: { items: true } },
        },
        orderBy: SORT[query.sort ?? 'createdAt:desc'] ?? { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.purchase.count({ where }),
      this.prisma.db.purchase.aggregate({
        where,
        _sum: { totalAmount: true, paidAmount: true },
      }),
    ]);

    return {
      data: rows.map(({ _count, ...p }) => ({
        ...p,
        totalAmount: p.totalAmount.toString(),
        paidAmount: p.paidAmount.toString(),
        remainingAmount: (p.totalAmount - p.paidAmount).toString(),
        lineCount: _count.items,
      })),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
      summary: {
        purchased: (sums._sum.totalAmount ?? 0n).toString(),
        paid: (sums._sum.paidAmount ?? 0n).toString(),
        payable: ((sums._sum.totalAmount ?? 0n) - (sums._sum.paidAmount ?? 0n)).toString(),
      },
    };
  }

  async findOne(purchaseId: string) {
    return this.load(this.prisma.db, purchaseId);
  }

  /**
   * Creates a purchase order.
   *
   * `order: true` skips DRAFT and commits to the supplier immediately, because
   * a shopkeeper phoning an order in has no use for a draft.
   */
  async create(dto: CreatePurchaseDto, tenant: TenantContext) {
    const supplier = await this.requireSupplier(dto.supplierId);
    const warehouse = await this.resolveWarehouse(dto.warehouseId, tenant.storeId);

    const lines = this.priceLines(dto.items);
    await this.inventory.requireVariants(lines.map((l) => l.variantId));

    const totals = this.totals(lines, dto.discountAmount, dto.shippingAmount);

    const purchase = await this.prisma.db.$transaction(async (tx) => {
      const purchaseNumber = await nextDocumentNumber(tx, {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        documentType: 'PURCHASE',
        prefix: 'PO',
      });

      return tx.purchase.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          warehouseId: warehouse.id,
          supplierId: supplier.id,
          purchaseNumber,
          status: dto.order ? 'ORDERED' : 'DRAFT',
          orderedAt: dto.order ? new Date() : null,
          expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : null,
          supplierInvoiceNumber: dto.supplierInvoiceNumber ?? null,
          ...totals,
          note: dto.note ?? null,
          createdBy: tenant.userId,
          items: {
            createMany: {
              data: lines.map((line) => ({
                organizationId: tenant.organizationId,
                productVariantId: line.variantId,
                orderedQuantity: line.quantity,
                unitCost: line.unitCost,
                lineAmount: line.lineAmount,
              })),
            },
          },
        },
        select: { id: true, purchaseNumber: true },
      });
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: dto.order ? 'purchase.ordered' : 'purchase.created',
      entityType: 'purchase',
      entityId: purchase.id,
      metadata: {
        purchaseNumber: purchase.purchaseNumber,
        supplierId: supplier.id,
        total: totals.totalAmount.toString(),
        lines: lines.length,
      },
    });

    return this.findOne(purchase.id);
  }

  /** Lines may be edited only while the order has not gone to the supplier. */
  async update(purchaseId: string, dto: UpdatePurchaseDto, tenant: TenantContext) {
    const existing = await this.requireStatus(purchaseId, EDITABLE, ErrorCode.PURCHASE_NOT_DRAFT);

    const lines = dto.items ? this.priceLines(dto.items) : null;
    if (lines) await this.inventory.requireVariants(lines.map((l) => l.variantId));

    await this.prisma.db.$transaction(async (tx) => {
      if (lines) {
        // Replaced wholesale rather than diffed: a draft has no history worth
        // preserving, and a diff would be a lot of code for an edit screen
        // that rewrites the whole basket anyway.
        await tx.purchaseItem.deleteMany({ where: { purchaseId } });
        await tx.purchaseItem.createMany({
          data: lines.map((line) => ({
            organizationId: tenant.organizationId,
            purchaseId,
            productVariantId: line.variantId,
            orderedQuantity: line.quantity,
            unitCost: line.unitCost,
            lineAmount: line.lineAmount,
          })),
        });
      }

      const current = lines ?? (await this.currentLines(tx, purchaseId));
      const totals = this.totals(
        current,
        dto.discountAmount ?? Number(existing.discountAmount),
        dto.shippingAmount ?? Number(existing.shippingAmount),
      );

      await tx.purchase.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: purchaseId } },
        data: {
          ...totals,
          ...(dto.supplierInvoiceNumber !== undefined
            ? { supplierInvoiceNumber: dto.supplierInvoiceNumber }
            : {}),
          ...(dto.expectedAt !== undefined ? { expectedAt: new Date(dto.expectedAt) } : {}),
          ...(dto.note !== undefined ? { note: dto.note } : {}),
        },
      });
    });

    return this.findOne(purchaseId);
  }

  /** DRAFT → ORDERED. Committed to the supplier; still no stock. */
  async order(purchaseId: string, tenant: TenantContext) {
    const purchase = await this.requireStatus(purchaseId, EDITABLE, ErrorCode.PURCHASE_NOT_DRAFT);

    const claimed = await this.prisma.db.$executeRaw`
      UPDATE purchase
         SET status = 'ORDERED'::"PurchaseStatus", ordered_at = now(), updated_at = now()
       WHERE id = ${purchaseId}::uuid
         AND organization_id = ${tenant.organizationId}::uuid
         AND status = 'DRAFT'
    `;
    if (claimed === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.PURCHASE_NOT_DRAFT,
        detail: 'Bu buyurtma allaqachon yuborilgan.',
      });
    }

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'purchase.ordered',
      entityType: 'purchase',
      entityId: purchaseId,
      metadata: { purchaseNumber: purchase.purchaseNumber },
    });

    return this.findOne(purchaseId);
  }

  /**
   * Receives goods — docs/ARCHITECTURE.md §15.2.
   *
   * Repeatable: three deliveries against one order produce three receive calls
   * and three sets of movements. Idempotent, because receiving the same
   * delivery twice adds real stock that does not exist — the second-most
   * expensive duplicate in the system after a double refund.
   *
   * Over-receipt is refused rather than silently accepted. A delivery larger
   * than the order is a real event, but it is a purchase amendment, and
   * treating it as an automatic quantity bump is how phantom stock appears.
   */
  async receive(
    purchaseId: string,
    dto: ReceivePurchaseDto,
    tenant: TenantContext,
    idempotencyKey: string,
  ) {
    // Existence only. The status check lives INSIDE the transaction, because
    // checking it out here would reject the replay of a receipt that already
    // completed — the purchase is RECEIVED by then, which is exactly the
    // state a correct replay has to tolerate.
    const purchase = await this.prisma.db.purchase.findFirst({
      where: { id: purchaseId },
      select: { id: true, purchaseNumber: true },
    });
    if (!purchase) throw BusinessRuleException.notFound('Xarid', purchaseId);

    const { result, replayed } = await this.idempotency.run(
      {
        organizationId: tenant.organizationId,
        key: idempotencyKey,
        endpoint: `POST /purchases/${purchaseId}/receive`,
        body: dto,
        status: HttpStatus.CREATED,
      },
      (tx) => this.writeReceipt(tx, purchaseId, dto, tenant),
    );

    if (!replayed) {
      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'purchase.received',
        entityType: 'purchase',
        entityId: purchaseId,
        metadata: {
          purchaseNumber: purchase.purchaseNumber,
          status: result.status,
          received: result.received,
        },
      });
    }

    return { ...result, replayed };
  }

  private async writeReceipt(
    tx: Tx,
    purchaseId: string,
    dto: ReceivePurchaseDto,
    tenant: TenantContext,
  ) {
    const purchase = await tx.purchase.findFirstOrThrow({
      where: { id: purchaseId },
      select: {
        id: true,
        status: true,
        warehouseId: true,
        purchaseNumber: true,
        items: {
          select: {
            id: true,
            productVariantId: true,
            orderedQuantity: true,
            receivedQuantity: true,
            unitCost: true,
          },
        },
      },
    });
    if (!RECEIVABLE.includes(purchase.status as (typeof RECEIVABLE)[number])) {
      throw new BusinessRuleException({
        code: ErrorCode.PURCHASE_NOT_RECEIVABLE,
        detail: "Bu buyurtmaga tovar qabul qilib bo'lmaydi.",
      });
    }

    const declared = new Map(
      (dto.items ?? []).map((i, index) => [
        i.variantId,
        {
          quantity: parseQuantity(i.quantity, `items[${index}].quantity`),
          unitCost: i.unitCost === undefined ? null : BigInt(i.unitCost),
        },
      ]),
    );

    for (const variantId of declared.keys()) {
      if (!purchase.items.some((i) => i.productVariantId === variantId)) {
        throw BusinessRuleException.notFound('Buyurtma qatori', variantId);
      }
    }

    // No lines given means "everything still outstanding arrived" — the
    // common case for a single full delivery, and one nobody should retype.
    const receipts = purchase.items
      .map((item) => {
        const outstanding = toNumber(item.orderedQuantity) - toNumber(item.receivedQuantity);
        const entry = declared.get(item.productVariantId);
        const quantity = entry ? entry.quantity : dto.items ? 0 : outstanding;
        return {
          item,
          quantity: Math.round(quantity * 1000) / 1000,
          outstanding,
          unitCost: entry?.unitCost ?? item.unitCost,
        };
      })
      .filter((r) => r.quantity > 0);

    if (receipts.length === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.NOTHING_TO_RECEIVE,
        detail: 'Qabul qilinadigan miqdor yo‘q.',
      });
    }

    for (const receipt of receipts) {
      // BR-16, as a conditional UPDATE. Two clerks booking in the same pallet
      // cannot together exceed the order: one matches zero rows.
      const applied = await tx.$executeRaw`
        UPDATE purchase_item
           SET received_quantity = received_quantity + ${receipt.quantity.toFixed(3)}::numeric
         WHERE id = ${receipt.item.id}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND received_quantity + ${receipt.quantity.toFixed(3)}::numeric <= ordered_quantity
      `;

      if (applied === 0) {
        throw new BusinessRuleException({
          code: ErrorCode.OVER_RECEIPT,
          detail: `Buyurtmadan ko'p qabul qilib bo'lmaydi: qolgan ${receipt.outstanding}.`,
          errors: [
            {
              code: ErrorCode.OVER_RECEIPT,
              message: receipt.item.productVariantId,
              meta: {
                variantId: receipt.item.productVariantId,
                outstanding: formatQuantity(receipt.outstanding),
                attempted: formatQuantity(receipt.quantity),
              },
            },
          ],
        });
      }

      // The stock, through the one write path. This also rolls the level's
      // moving average cost forward (§8.6), which is the whole reason the
      // unit cost travels with the receipt.
      await this.inventory.apply(tx, {
        organizationId: tenant.organizationId,
        warehouseId: purchase.warehouseId,
        variantId: receipt.item.productVariantId,
        type: 'PURCHASE',
        delta: receipt.quantity,
        unitCost: receipt.unitCost,
        sourceType: 'purchase',
        sourceId: purchaseId,
        note: dto.note ?? null,
        actorId: tenant.userId,
      });
    }

    // Status follows the lines, not the caller's intent.
    const after = await tx.purchaseItem.findMany({
      where: { purchaseId },
      select: { orderedQuantity: true, receivedQuantity: true },
    });
    const complete = after.every(
      (i) => toNumber(i.receivedQuantity) >= toNumber(i.orderedQuantity),
    );

    await tx.purchase.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: purchaseId } },
      data: {
        status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
        receivedAt: complete ? new Date() : null,
        receivedBy: tenant.userId,
        ...(dto.supplierInvoiceNumber ? { supplierInvoiceNumber: dto.supplierInvoiceNumber } : {}),
      },
    });

    const loaded = await this.load(tx, purchaseId);
    return {
      ...loaded,
      received: receipts.map((r) => ({
        variantId: r.item.productVariantId,
        quantity: formatQuantity(r.quantity),
        unitCost: r.unitCost.toString(),
      })),
    };
  }

  /**
   * Cancels a purchase — only while nothing has been received.
   *
   * Once goods have arrived, cancelling would mean either leaving phantom
   * stock or silently removing real stock. The correct move then is a return
   * to the supplier, which is its own document.
   */
  async cancel(purchaseId: string, dto: CancelPurchaseDto, tenant: TenantContext) {
    const purchase = await this.prisma.db.purchase.findFirst({
      where: { id: purchaseId },
      select: {
        id: true,
        status: true,
        purchaseNumber: true,
        paidAmount: true,
        items: { select: { receivedQuantity: true } },
      },
    });
    if (!purchase) throw BusinessRuleException.notFound('Xarid', purchaseId);

    if (purchase.items.some((i) => toNumber(i.receivedQuantity) > 0)) {
      throw new BusinessRuleException({
        code: ErrorCode.PURCHASE_HAS_RECEIPTS,
        detail:
          "Tovar qabul qilingan buyurtma bekor qilinmaydi — ta'minotchiga qaytarish " +
          "alohida hujjat bo'ladi.",
      });
    }
    if (purchase.paidAmount > 0n) {
      throw new BusinessRuleException({
        code: ErrorCode.PURCHASE_HAS_PAYMENTS,
        detail: "To'lov qilingan buyurtma bekor qilinmaydi.",
      });
    }

    const claimed = await this.prisma.db.$executeRaw`
      UPDATE purchase
         SET status = 'CANCELLED'::"PurchaseStatus",
             cancelled_at = now(),
             cancel_reason = ${dto.reason},
             updated_at = now()
       WHERE id = ${purchaseId}::uuid
         AND organization_id = ${tenant.organizationId}::uuid
         AND status IN ('DRAFT', 'ORDERED')
    `;
    if (claimed === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.PURCHASE_NOT_RECEIVABLE,
        detail: 'Bu buyurtma endi bekor qilinmaydi.',
      });
    }

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'purchase.cancelled',
      entityType: 'purchase',
      entityId: purchaseId,
      metadata: { purchaseNumber: purchase.purchaseNumber, reason: dto.reason },
    });

    return this.findOne(purchaseId);
  }

  // ────────────────────────────────────────────────────────────────────────

  /** Line amounts, rounded once each — the same rule the sale pipeline uses. */
  private priceLines(items: readonly { variantId: string; quantity: string; unitCost: number }[]) {
    const seen = new Set<string>();
    return items.map((item, index) => {
      if (seen.has(item.variantId)) {
        throw new BusinessRuleException({
          code: ErrorCode.DUPLICATE_RESOURCE,
          detail: 'Bir variant ikki marta kiritilgan.',
        });
      }
      seen.add(item.variantId);

      const quantity = parseQuantity(item.quantity, `items[${index}].quantity`);
      if (quantity <= 0) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail: "Miqdor musbat bo'lishi kerak.",
        });
      }

      const unitCost = BigInt(item.unitCost);
      return {
        variantId: item.variantId,
        quantity: formatQuantity(quantity),
        unitCost,
        lineAmount: priceTimesQuantity(unitCost, quantityToMilli(formatQuantity(quantity))),
      };
    });
  }

  private totals(
    lines: readonly { lineAmount: bigint }[],
    discount: number | undefined,
    shipping: number | undefined,
  ) {
    const subtotalAmount = lines.reduce((sum, l) => sum + l.lineAmount, 0n);
    const discountAmount = BigInt(discount ?? 0);
    const shippingAmount = BigInt(shipping ?? 0);

    if (discountAmount > subtotalAmount + shippingAmount) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: "Chegirma jami summadan ko'p bo'la olmaydi.",
      });
    }

    return {
      subtotalAmount,
      discountAmount,
      shippingAmount,
      // ck_purchase_total_adds_up checks this same equation in the database.
      totalAmount: subtotalAmount - discountAmount + shippingAmount,
    };
  }

  private async currentLines(tx: Tx, purchaseId: string) {
    const rows = await tx.purchaseItem.findMany({
      where: { purchaseId },
      select: { lineAmount: true },
    });
    return rows;
  }

  private async load(client: Tx | PrismaService['db'], purchaseId: string) {
    const purchase = await client.purchase.findFirst({
      where: { id: purchaseId },
      select: {
        id: true,
        purchaseNumber: true,
        status: true,
        storeId: true,
        warehouseId: true,
        supplierInvoiceNumber: true,
        subtotalAmount: true,
        discountAmount: true,
        shippingAmount: true,
        totalAmount: true,
        paidAmount: true,
        orderedAt: true,
        expectedAt: true,
        receivedAt: true,
        cancelledAt: true,
        cancelReason: true,
        note: true,
        createdBy: true,
        receivedBy: true,
        createdAt: true,
        supplier: { select: { id: true, name: true, phone: true, paymentTermDays: true } },
        items: {
          select: {
            id: true,
            productVariantId: true,
            orderedQuantity: true,
            receivedQuantity: true,
            unitCost: true,
            lineAmount: true,
            variant: {
              select: {
                sku: true,
                name: true,
                unit: true,
                product: { select: { id: true, name: true } },
              },
            },
          },
          orderBy: { variant: { sku: 'asc' } },
        },
        payments: {
          select: {
            id: true,
            amount: true,
            method: true,
            reference: true,
            paidAt: true,
            createdBy: true,
          },
          orderBy: { paidAt: 'asc' },
        },
      },
    });
    if (!purchase) throw BusinessRuleException.notFound('Xarid', purchaseId);

    const { items, payments, ...rest } = purchase;

    return {
      ...serializeMoney(rest),
      // Derived, never stored — the same reasoning as the customer receivable.
      remainingAmount: (purchase.totalAmount - purchase.paidAmount).toString(),
      items: items.map((item) => {
        const ordered = toNumber(item.orderedQuantity);
        const received = toNumber(item.receivedQuantity);
        return {
          id: item.id,
          variantId: item.productVariantId,
          sku: item.variant.sku,
          variantName: item.variant.name,
          unit: item.variant.unit,
          product: item.variant.product,
          orderedQuantity: formatQuantity(ordered),
          receivedQuantity: formatQuantity(received),
          outstandingQuantity: formatQuantity(ordered - received),
          unitCost: item.unitCost.toString(),
          lineAmount: item.lineAmount.toString(),
        };
      }),
      payments: payments.map((p) => ({ ...serializeMoney(p) })),
    };
  }

  private async requireStatus(purchaseId: string, allowed: readonly string[], code: string) {
    const purchase = await this.prisma.db.purchase.findFirst({
      where: { id: purchaseId },
      select: {
        id: true,
        status: true,
        purchaseNumber: true,
        discountAmount: true,
        shippingAmount: true,
      },
    });
    if (!purchase) throw BusinessRuleException.notFound('Xarid', purchaseId);
    if (!allowed.includes(purchase.status)) {
      throw new BusinessRuleException({
        code,
        detail: `Bu amal ${purchase.status} holatidagi buyurtmada bajarilmaydi.`,
        errors: [{ code, message: purchase.purchaseNumber, meta: { status: purchase.status } }],
      });
    }
    return purchase;
  }

  private async requireSupplier(supplierId: string) {
    const supplier = await this.prisma.db.supplier.findFirst({
      where: { id: supplierId, archivedAt: null },
      select: { id: true, name: true },
    });
    if (!supplier) throw BusinessRuleException.notFound("Ta'minotchi", supplierId);
    return supplier;
  }

  private async resolveWarehouse(warehouseId: string | undefined, storeId: string) {
    if (warehouseId) return this.inventory.requireWarehouse(warehouseId);

    const fallback = await this.prisma.db.warehouse.findFirst({
      where: { storeId, archivedAt: null },
      orderBy: { isDefault: 'desc' },
      select: { id: true },
    });
    if (!fallback) {
      throw new BusinessRuleException({
        code: ErrorCode.RESOURCE_NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
        detail: "Bu do'kon uchun ombor topilmadi.",
      });
    }
    return fallback;
  }
}

function serializeMoney<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return out as T;
}
