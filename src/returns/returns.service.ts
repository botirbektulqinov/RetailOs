import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { CashService } from '../cash/cash.service';
import { nextDocumentNumber } from '../common/document-number';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { roundHalfUp } from '../common/money/money';
import { formatQuantity, parseQuantity, toNumber } from '../common/quantity';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { Tx } from '../database/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import type {
  CreateExchangeDto,
  ExchangeLineDto,
  ListReturnsDto,
  ReturnLineDto,
} from './dto/return.dto';

const SORT: Record<string, Prisma.SaleReturnOrderByWithRelationInput> = {
  'createdAt:desc': { createdAt: 'desc' },
  'createdAt:asc': { createdAt: 'asc' },
  'refund:desc': { refundAmount: 'desc' },
};

interface PreparedLine {
  saleItemId: string;
  variantId: string;
  quantity: number;
  refund: bigint;
  restock: boolean;
  condition: 'SELLABLE' | 'DAMAGED';
  closesLine: boolean;
}

/**
 * Returns and exchanges — docs/ARCHITECTURE.md §13 and §14.
 *
 * A return is a **compensating transaction**. The original sale is never
 * deleted and its figures are never rewritten; only `refunded_amount` and
 * `return_status` move, and both are derived from the returns that reference
 * it. A receipt reprinted next year still says what it said on the day.
 *
 * An exchange is a return and a sale that happen together, linked by one
 * `Exchange` row. Modelling it as a third kind of document would duplicate the
 * stock logic, the refund logic and the debt logic that both already implement
 * with their guards.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly idempotency: IdempotencyService,
    private readonly cash: CashService,
    private readonly loyalty: LoyaltyService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────────────────────

  /**
   * What is still returnable on a sale, per line.
   *
   * The POS calls this before showing the return screen, so the cashier never
   * gets to type a quantity the server will reject.
   */
  async returnable(saleId: string) {
    const sale = await this.prisma.db.sale.findFirst({
      where: { id: saleId },
      select: {
        id: true,
        saleNumber: true,
        status: true,
        returnStatus: true,
        completedAt: true,
        totalAmount: true,
        refundedAmount: true,
        customerId: true,
        warehouseId: true,
        items: {
          select: {
            id: true,
            productVariantId: true,
            nameSnapshot: true,
            skuSnapshot: true,
            quantity: true,
            returnedQuantity: true,
            netAmount: true,
            refundedAmount: true,
            position: true,
          },
          orderBy: { position: 'asc' },
        },
      },
    });
    if (!sale) throw BusinessRuleException.notFound('Savdo', saleId);

    const settings = await this.prisma.db.organizationSettings.findFirst({
      where: {},
      select: { returnWindowDays: true },
    });
    const windowDays = settings?.returnWindowDays ?? 14;

    return {
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      status: sale.status,
      returnStatus: sale.returnStatus,
      completedAt: sale.completedAt,
      totalAmount: sale.totalAmount.toString(),
      refundedAmount: sale.refundedAmount.toString(),
      refundableAmount: (sale.totalAmount - sale.refundedAmount).toString(),
      withinWindow: withinWindow(sale.completedAt, windowDays),
      windowDays,
      items: sale.items.map((item) => {
        const sold = toNumber(item.quantity);
        const returned = toNumber(item.returnedQuantity);
        return {
          saleItemId: item.id,
          variantId: item.productVariantId,
          name: item.nameSnapshot,
          sku: item.skuSnapshot,
          quantity: formatQuantity(sold),
          returnedQuantity: formatQuantity(returned),
          // The rule, stated once: sold minus already returned.
          returnableQuantity: formatQuantity(sold - returned),
          netAmount: item.netAmount.toString(),
          refundedAmount: item.refundedAmount.toString(),
          refundableAmount: (item.netAmount - item.refundedAmount).toString(),
        };
      }),
    };
  }

  async list(query: ListReturnsDto) {
    const where: Prisma.SaleReturnWhereInput = {
      ...(query.saleId ? { saleId: query.saleId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.reason ? { reason: query.reason } : {}),
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
              { returnNumber: { contains: query.q, mode: 'insensitive' } },
              { sale: { saleNumber: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total, sums] = await Promise.all([
      this.prisma.db.saleReturn.findMany({
        where,
        select: {
          id: true,
          returnNumber: true,
          reason: true,
          refundAmount: true,
          creditOffsetAmount: true,
          exchangeId: true,
          createdBy: true,
          createdAt: true,
          sale: { select: { id: true, saleNumber: true } },
          customer: { select: { id: true, fullName: true } },
          _count: { select: { items: true } },
        },
        orderBy: SORT[query.sort ?? 'createdAt:desc'] ?? { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.saleReturn.count({ where }),
      this.prisma.db.saleReturn.aggregate({
        where,
        _sum: { refundAmount: true, creditOffsetAmount: true },
      }),
    ]);

    return {
      data: rows.map(({ _count, ...r }) => ({
        ...r,
        refundAmount: r.refundAmount.toString(),
        creditOffsetAmount: r.creditOffsetAmount.toString(),
        lineCount: _count.items,
      })),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
      summary: {
        refunded: (sums._sum.refundAmount ?? 0n).toString(),
        creditOffset: (sums._sum.creditOffsetAmount ?? 0n).toString(),
      },
    };
  }

  async findOne(returnId: string) {
    return this.load(this.prisma.db, returnId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Returns
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Records a return — docs/ARCHITECTURE.md §13.6.
   *
   * Idempotency is mandatory. A double-tapped refund button that pays a
   * customer twice is the single most expensive bug a POS can ship.
   */
  async create(
    dto: {
      saleId: string;
      items: ReturnLineDto[];
      reason: string;
      reasonNote?: string;
      refundMethod?: string;
      warehouseId?: string;
      note?: string;
    },
    tenant: TenantContext,
    idempotencyKey: string,
  ) {
    const { result, replayed } = await this.idempotency.run(
      {
        organizationId: tenant.organizationId,
        key: idempotencyKey,
        endpoint: 'POST /returns',
        body: dto,
        status: HttpStatus.CREATED,
        resourceId: (r: { id: string }) => r.id,
      },
      (tx) => this.writeReturn(tx, dto, tenant),
    );

    if (!replayed) {
      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'return.created',
        entityType: 'sale_return',
        entityId: result.id,
        metadata: {
          returnNumber: result.returnNumber,
          saleId: dto.saleId,
          reason: dto.reason,
          refund: result.refundAmount,
          creditOffset: result.creditOffsetAmount,
          lines: result.items.length,
        },
      });
    }

    return { ...result, replayed };
  }

  /** The whole §13.6 sequence, inside the caller's transaction. */
  private async writeReturn(
    tx: Tx,
    dto: {
      saleId: string;
      items: ReturnLineDto[];
      reason: string;
      reasonNote?: string;
      refundMethod?: string;
      warehouseId?: string;
      note?: string;
    },
    tenant: TenantContext,
    exchange?: { suppressRefund: true },
  ) {
    const sale = await this.requireReturnableSale(tx, dto.saleId, tenant);
    const warehouseId = dto.warehouseId ?? sale.warehouseId;

    const lines = this.prepareLines(sale, dto.items);

    const returnNumber = await nextDocumentNumber(tx, {
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      documentType: 'RETURN',
      prefix: 'R',
    });

    const totalRefund = lines.reduce((sum, l) => sum + l.refund, 0n);

    // BR-7: a sale can never be refunded for more than it was worth. The
    // database checks this too (ck_sale_refund_within_total); this produces a
    // usable error instead of a constraint violation.
    if (sale.refundedAmount + totalRefund > sale.totalAmount) {
      throw new BusinessRuleException({
        code: ErrorCode.REFUND_EXCEEDS_SALE,
        detail: `Savdo qiymatidan ortiq qaytarib bo'lmaydi: qolgan ${sale.totalAmount - sale.refundedAmount}.`,
      });
    }

    const created = await tx.saleReturn.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        saleId: sale.id,
        warehouseId,
        customerId: sale.customerId,
        returnNumber,
        reason: dto.reason as 'OTHER',
        reasonNote: dto.reasonNote ?? dto.note ?? null,
        refundAmount: 0n,
        createdBy: tenant.userId,
        items: {
          createMany: {
            data: lines.map((line) => ({
              organizationId: tenant.organizationId,
              saleItemId: line.saleItemId,
              productVariantId: line.variantId,
              quantity: formatQuantity(line.quantity),
              unitRefundAmount:
                (roundHalfUp(line.refund, BigInt(Math.round(line.quantity * 1000))) * 1000n) /
                1000n,
              refundAmount: line.refund,
              restock: line.restock,
              condition: line.condition,
            })),
          },
        },
      },
      select: { id: true, returnNumber: true },
    });

    // The quantity guard, per line — §13.2. A conditional UPDATE, so two
    // returns of the last unit cannot both succeed.
    for (const line of lines) {
      const applied = await tx.$executeRaw`
        UPDATE sale_item
           SET returned_quantity = returned_quantity + ${line.quantity.toFixed(3)}::numeric,
               refunded_amount   = refunded_amount + ${line.refund}::bigint
         WHERE id = ${line.saleItemId}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND returned_quantity + ${line.quantity.toFixed(3)}::numeric <= quantity
      `;

      if (applied === 0) {
        const item = sale.items.find((i) => i.id === line.saleItemId);
        const returnable = item ? toNumber(item.quantity) - toNumber(item.returnedQuantity) : 0;
        throw new BusinessRuleException({
          code: ErrorCode.RETURN_QUANTITY_EXCEEDED,
          detail: `Sotilgandan ko'p qaytarib bo'lmaydi: qaytarish mumkin ${returnable}.`,
          errors: [
            {
              code: ErrorCode.RETURN_QUANTITY_EXCEEDED,
              message: line.saleItemId,
              meta: {
                saleItemId: line.saleItemId,
                returnable: formatQuantity(returnable),
                requested: formatQuantity(line.quantity),
              },
            },
          ],
        });
      }
    }

    // Stock, for the lines that come back sellable — §13.4. Damaged goods get
    // no RETURN movement: they never re-enter sellable stock, and recording
    // them as returned-then-written-off is two facts, not one.
    const restockable = lines.filter((l) => l.restock && l.condition === 'SELLABLE');
    if (restockable.length > 0) {
      await this.inventory.applyMany(
        tx,
        restockable.map((line) => ({
          organizationId: tenant.organizationId,
          warehouseId,
          variantId: line.variantId,
          type: 'RETURN' as const,
          delta: line.quantity,
          sourceType: 'sale_return',
          sourceId: created.id,
          note: dto.reasonNote ?? null,
          actorId: tenant.userId,
        })),
      );
    }

    // Refund destination — §13.5. An open receivable on the sale is offset
    // first: refunding cash to somebody who still owes you money is a mistake
    // the system should not make on its own.
    const offset = await this.offsetReceivable(tx, sale.id, totalRefund, tenant);
    const cashRefund = totalRefund - offset;

    if (cashRefund > 0n && !exchange) {
      const payment = await tx.payment.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          customerId: sale.customerId,
          cashRegisterShiftId: await this.cash.openShiftIdFor(tx, tenant.storeId),
          direction: 'OUT',
          method: (dto.refundMethod ?? 'CASH') as 'CASH',
          amount: cashRefund,
          receivedBy: tenant.userId,
          note: `Qaytarish ${created.returnNumber}`,
        },
        select: { id: true },
      });
      await tx.paymentAllocation.create({
        data: {
          organizationId: tenant.organizationId,
          paymentId: payment.id,
          returnId: created.id,
          amount: cashRefund,
        },
      });
    }

    await tx.saleReturn.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: created.id } },
      data: {
        refundAmount: exchange ? 0n : cashRefund,
        creditOffsetAmount: offset,
      },
    });

    // Points earned on the returned value are clawed back proportionally, and
    // clamped at the balance: taking back points a customer already spent is a
    // policy decision, not a default (§17.4).
    if (sale.customerId) {
      await this.loyalty.reverseForReturn(tx, {
        organizationId: tenant.organizationId,
        customerId: sale.customerId,
        saleId: sale.id,
        returnId: created.id,
        refundShare: totalRefund,
        saleSubtotal: sale.totalAmount,
        actorId: tenant.userId,
      });
    }

    // The sale's own totals. The figures that describe what was sold are
    // untouched; only what has since come back moves.
    const after = await tx.saleItem.findMany({
      where: { saleId: sale.id },
      select: { quantity: true, returnedQuantity: true },
    });
    const fullyReturned = after.every((i) => toNumber(i.returnedQuantity) >= toNumber(i.quantity));
    const anyReturned = after.some((i) => toNumber(i.returnedQuantity) > 0);

    await tx.sale.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: sale.id } },
      data: {
        refundedAmount: { increment: totalRefund },
        returnStatus: fullyReturned ? 'FULL' : anyReturned ? 'PARTIAL' : 'NONE',
      },
    });

    return { ...(await this.load(tx, created.id)), totalRefund: totalRefund.toString() };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Exchanges
  // ────────────────────────────────────────────────────────────────────────

  /**
   * A return and a replacement sale, in one transaction — §14.
   *
   * Only the **net** money moves (§14.4). Recording a gross refund followed by
   * a gross payment would double-count the day's revenue, make the drawer
   * expect money that never left it, and ask the cashier to handle cash they
   * never touched.
   *
   * If the replacement is out of stock the whole exchange fails and nothing is
   * written — which comes free from running both legs in one transaction.
   */
  async exchange(dto: CreateExchangeDto, tenant: TenantContext, idempotencyKey: string) {
    const { result, replayed } = await this.idempotency.run(
      {
        organizationId: tenant.organizationId,
        key: idempotencyKey,
        endpoint: 'POST /exchanges',
        body: dto,
        status: HttpStatus.CREATED,
        resourceId: (e: { id: string }) => e.id,
      },
      (tx) => this.writeExchange(tx, dto, tenant),
    );

    if (!replayed) {
      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'exchange.created',
        entityType: 'exchange',
        entityId: result.id,
        metadata: {
          exchangeNumber: result.exchangeNumber,
          returnedValue: result.returnedValue,
          replacementValue: result.replacementValue,
          netAmount: result.netAmount,
          settlement: result.settlement,
        },
      });
    }

    return { ...result, replayed };
  }

  private async writeExchange(tx: Tx, dto: CreateExchangeDto, tenant: TenantContext) {
    // Leg one: the goods coming back. `suppressRefund` stops it paying cash
    // out — the exchange settles the net at the end.
    const returned = await this.writeReturn(
      tx,
      {
        saleId: dto.saleId,
        items: dto.returnItems,
        reason: dto.reason,
        ...(dto.reasonNote !== undefined ? { reasonNote: dto.reasonNote } : {}),
        ...(dto.warehouseId !== undefined ? { warehouseId: dto.warehouseId } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
      },
      tenant,
      { suppressRefund: true },
    );

    const original = await tx.sale.findFirstOrThrow({
      where: { id: dto.saleId },
      select: { customerId: true, warehouseId: true },
    });

    // Leg two: the goods going out, priced by the server exactly as an
    // ordinary sale is.
    const replacement = await this.writeReplacementSale(tx, dto, tenant, original);

    const returnedValue = BigInt(returned.totalRefund);
    const replacementValue = replacement.totalAmount;
    const netAmount = replacementValue - returnedValue;

    const settlement =
      netAmount === 0n
        ? 'EVEN'
        : netAmount > 0n
          ? dto.onCredit
            ? 'CREDITED_TO_DEBT'
            : 'CUSTOMER_PAID'
          : 'REFUNDED';

    if (settlement === 'CREDITED_TO_DEBT' && !original.customerId) {
      throw new BusinessRuleException({
        code: ErrorCode.CREDIT_WITHOUT_CUSTOMER,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: "Farqni qarzga yozish uchun savdoda mijoz bo'lishi kerak.",
      });
    }

    const exchangeNumber = await nextDocumentNumber(tx, {
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      documentType: 'EXCHANGE',
      prefix: 'EX',
    });

    const created = await tx.exchange.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        exchangeNumber,
        returnId: returned.id,
        replacementSaleId: replacement.id,
        customerId: original.customerId,
        returnedValue,
        replacementValue,
        netAmount,
        settlement,
        createdBy: tenant.userId,
      },
      select: { id: true, exchangeNumber: true },
    });

    await tx.saleReturn.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: returned.id } },
      data: { exchangeId: created.id },
    });

    // Settlement.
    //
    // The replacement sale must satisfy `paid + credit = total`, and
    // `paid_amount` means "the sum of this sale's allocations". The goods
    // handed back ARE a settlement of that sale, so they are recorded as an
    // allocation of method OTHER — a trade-in, not cash and not credit.
    //
    // This is what keeps §14.4 true without lying to the constraints: the only
    // CASH row is the net that actually crossed the counter, so the drawer
    // never expects money it did not see, while the sale still reconciles
    // against its own allocations.
    const tradeIn = returnedValue < replacementValue ? returnedValue : replacementValue;

    if (tradeIn > 0n) {
      const payment = await tx.payment.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          customerId: original.customerId,
          direction: 'IN',
          method: 'OTHER',
          amount: tradeIn,
          receivedBy: tenant.userId,
          note: `exchange trade-in ${exchangeNumber}`,
        },
        select: { id: true },
      });
      await tx.paymentAllocation.create({
        data: {
          organizationId: tenant.organizationId,
          paymentId: payment.id,
          saleId: replacement.id,
          amount: tradeIn,
        },
      });
    }

    if (settlement === 'CUSTOMER_PAID') {
      // The only real money: the difference the customer actually handed over.
      const payment = await tx.payment.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          customerId: original.customerId,
          direction: 'IN',
          method: (dto.settlementMethod ?? 'CASH') as 'CASH',
          amount: netAmount,
          receivedBy: tenant.userId,
          note: `Almashtirish ${exchangeNumber}`,
        },
        select: { id: true },
      });
      await tx.paymentAllocation.create({
        data: {
          organizationId: tenant.organizationId,
          paymentId: payment.id,
          saleId: replacement.id,
          amount: netAmount,
        },
      });
      await tx.sale.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: replacement.id } },
        data: { paidAmount: replacementValue, creditAmount: 0n },
      });
    } else if (settlement === 'REFUNDED') {
      // The trade-in covered the whole replacement; the surplus goes back.
      const refund = -netAmount;
      const payment = await tx.payment.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          customerId: original.customerId,
          direction: 'OUT',
          method: (dto.settlementMethod ?? 'CASH') as 'CASH',
          amount: refund,
          receivedBy: tenant.userId,
          note: `Almashtirish ${exchangeNumber}`,
        },
        select: { id: true },
      });
      await tx.paymentAllocation.create({
        data: {
          organizationId: tenant.organizationId,
          paymentId: payment.id,
          returnId: returned.id,
          amount: refund,
        },
      });
      await tx.saleReturn.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: returned.id } },
        data: { refundAmount: refund },
      });
      await tx.sale.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: replacement.id } },
        data: { paidAmount: replacementValue, creditAmount: 0n },
      });
    } else if (settlement === 'CREDITED_TO_DEBT') {
      const settings = await tx.organizationSettings.findFirst({
        where: {},
        select: { defaultDebtTermDays: true },
      });
      const due = new Date();
      due.setUTCDate(due.getUTCDate() + (settings?.defaultDebtTermDays ?? 30));

      await tx.sale.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: replacement.id } },
        data: { paidAmount: tradeIn, creditAmount: netAmount },
      });
      await tx.customerReceivable.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          customerId: original.customerId!,
          saleId: replacement.id,
          origin: 'EXCHANGE',
          originalAmount: netAmount,
          status: 'OPEN',
          issuedAt: new Date(),
          dueDate: due,
          createdBy: tenant.userId,
        },
      });
    } else {
      // EVEN: the trade-in settled it exactly. No cash row at all.
      await tx.sale.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: replacement.id } },
        data: { paidAmount: replacementValue, creditAmount: 0n },
      });
    }

    return {
      id: created.id,
      exchangeNumber: created.exchangeNumber,
      settlement,
      returnedValue: returnedValue.toString(),
      replacementValue: replacementValue.toString(),
      netAmount: netAmount.toString(),
      return: await this.load(tx, returned.id),
      replacementSaleId: replacement.id,
    };
  }

  /**
   * The replacement sale.
   *
   * Written here rather than through SalesService.checkout because checkout
   * owns its own idempotency and payment balancing, and an exchange settles
   * the net rather than the gross. What matters — server-resolved prices, a
   * cost snapshot, the stock guard and the document counter — is identical.
   */
  private async writeReplacementSale(
    tx: Tx,
    dto: CreateExchangeDto,
    tenant: TenantContext,
    original: { customerId: string | null; warehouseId: string },
  ) {
    const warehouseId = dto.warehouseId ?? original.warehouseId;
    const variantIds = dto.replacementItems.map((i) => i.variantId);

    const variants = await tx.productVariant.findMany({
      where: { id: { in: [...new Set(variantIds)] }, archivedAt: null },
      select: {
        id: true,
        sku: true,
        name: true,
        sellingPrice: true,
        product: { select: { name: true } },
      },
    });
    const catalogue = new Map(variants.map((v) => [v.id, v]));
    for (const id of variantIds) {
      if (!catalogue.has(id)) throw BusinessRuleException.notFound('Mahsulot varianti', id);
    }

    const costs = await tx.inventoryLevel.findMany({
      where: { warehouseId, productVariantId: { in: [...new Set(variantIds)] } },
      select: { productVariantId: true, avgCost: true },
    });
    const costByVariant = new Map(costs.map((c) => [c.productVariantId, c.avgCost]));

    const canOverride =
      tenant.permissions.has('sales.override_price') || tenant.permissions.has('*');

    const lines = dto.replacementItems.map((item: ExchangeLineDto, index) => {
      if (item.unitPrice !== undefined && !canOverride) {
        throw new BusinessRuleException({
          code: ErrorCode.PRICE_OVERRIDE_FORBIDDEN,
          status: HttpStatus.FORBIDDEN,
          detail: "Narxni o'zgartirish uchun sales.override_price ruxsati kerak.",
        });
      }

      const variant = catalogue.get(item.variantId)!;
      const quantity = parseQuantity(item.quantity, `replacementItems[${index}].quantity`);
      if (quantity <= 0) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail: "Miqdor musbat bo'lishi kerak.",
        });
      }

      const unitPrice =
        item.unitPrice !== undefined ? BigInt(item.unitPrice) : variant.sellingPrice;
      const qtyMilli = BigInt(Math.round(quantity * 1000));
      const grossAmount = roundHalfUp(unitPrice * qtyMilli, 1000n);
      const unitCost = costByVariant.get(item.variantId) ?? 0n;

      return {
        variantId: item.variantId,
        nameSnapshot: variant.name
          ? `${variant.product.name} · ${variant.name}`
          : variant.product.name,
        skuSnapshot: variant.sku,
        quantity,
        unitPrice,
        grossAmount,
        unitCost,
        lineCost: roundHalfUp(unitCost * qtyMilli, 1000n),
        position: index + 1,
      };
    });

    const totalAmount = lines.reduce((sum, l) => sum + l.grossAmount, 0n);
    const costAmount = lines.reduce((sum, l) => sum + l.lineCost, 0n);

    const saleNumber = await nextDocumentNumber(tx, {
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      documentType: 'SALE',
      prefix: 'S',
    });

    const sale = await tx.sale.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        warehouseId,
        customerId: original.customerId,
        saleNumber,
        status: 'COMPLETED',
        subtotalAmount: totalAmount,
        totalAmount,
        // Settled below, once the exchange knows the net. The CHECK that
        // paid + credit = total holds because every branch sets both.
        paidAmount: totalAmount,
        creditAmount: 0n,
        costAmount,
        note: `Almashtirish o'rniga`,
        createdBy: tenant.userId,
        completedAt: new Date(),
        items: {
          createMany: {
            data: lines.map((line) => ({
              organizationId: tenant.organizationId,
              productVariantId: line.variantId,
              nameSnapshot: line.nameSnapshot,
              skuSnapshot: line.skuSnapshot,
              quantity: formatQuantity(line.quantity),
              unitPrice: line.unitPrice,
              grossAmount: line.grossAmount,
              netAmount: line.grossAmount,
              unitCost: line.unitCost,
              position: line.position,
            })),
          },
        },
      },
      select: { id: true, saleNumber: true },
    });

    // The ordinary stock guard. If the replacement is out of stock the whole
    // exchange fails, which is the correct behaviour.
    await this.inventory.applyMany(
      tx,
      lines.map((line) => ({
        organizationId: tenant.organizationId,
        warehouseId,
        variantId: line.variantId,
        type: 'SALE' as const,
        delta: -line.quantity,
        unitCost: line.unitCost,
        sourceType: 'sale',
        sourceId: sale.id,
        actorId: tenant.userId,
      })),
    );

    return { id: sale.id, saleNumber: sale.saleNumber, totalAmount };
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * The refund per line — §13.3, including the rounding sweep.
   *
   * The refund reflects the line's NET amount, after both the line discount
   * and its share of the order discount. A customer who bought at a discount
   * is refunded at that discount, not at the list price.
   *
   * On the return that CLOSES a line, the refund is the exact remainder rather
   * than another proportional slice. Three returns of 1 from a line of 3 at
   * net 100,000 would otherwise give 33,333 x 3 = 99,999 and leave one soʻm
   * the customer never gets back. The last return sweeps up the residue.
   */
  private prepareLines(
    sale: Awaited<ReturnType<ReturnsService['requireReturnableSale']>>,
    items: readonly ReturnLineDto[],
  ): PreparedLine[] {
    const seen = new Set<string>();

    return items.map((item, index) => {
      if (seen.has(item.saleItemId)) {
        throw new BusinessRuleException({
          code: ErrorCode.DUPLICATE_RESOURCE,
          detail: 'Bir qator ikki marta kiritilgan.',
        });
      }
      seen.add(item.saleItemId);

      const saleItem = sale.items.find((i) => i.id === item.saleItemId);
      if (!saleItem) throw BusinessRuleException.notFound('Savdo qatori', item.saleItemId);

      const quantity = parseQuantity(item.quantity, `items[${index}].quantity`);
      if (quantity <= 0) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail: "Miqdor musbat bo'lishi kerak.",
        });
      }

      const sold = toNumber(saleItem.quantity);
      const alreadyReturned = toNumber(saleItem.returnedQuantity);
      const closesLine = Math.round((alreadyReturned + quantity) * 1000) >= Math.round(sold * 1000);

      const refund = closesLine
        ? saleItem.netAmount - saleItem.refundedAmount
        : roundHalfUp(
            saleItem.netAmount * BigInt(Math.round(quantity * 1000)),
            BigInt(Math.round(sold * 1000)),
          );

      const condition = item.condition ?? 'SELLABLE';

      return {
        saleItemId: saleItem.id,
        variantId: saleItem.productVariantId,
        quantity,
        refund: refund < 0n ? 0n : refund,
        // Damaged goods never restock, whatever the caller asked for. The
        // database enforces it too.
        restock: condition === 'DAMAGED' ? false : (item.restock ?? true),
        condition,
        closesLine,
      };
    });
  }

  /**
   * Offsets an open receivable on the sale before any cash leaves — §13.5.
   *
   * The offset is a `Payment IN` allocated to the receivable, so its
   * `paid_amount` rises through the same guarded UPDATE as any other
   * collection and the arithmetic stays honest. `written_off_amount` is NOT
   * touched: that column means bad debt, and a return is not bad debt.
   */
  private async offsetReceivable(
    tx: Tx,
    saleId: string,
    refund: bigint,
    tenant: TenantContext,
  ): Promise<bigint> {
    if (refund <= 0n) return 0n;

    const receivable = await tx.customerReceivable.findFirst({
      where: { saleId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      select: {
        id: true,
        customerId: true,
        originalAmount: true,
        paidAmount: true,
        writtenOffAmount: true,
      },
    });
    if (!receivable) return 0n;

    const remaining =
      receivable.originalAmount - receivable.paidAmount - receivable.writtenOffAmount;
    const offset = remaining < refund ? remaining : refund;
    if (offset <= 0n) return 0n;

    const applied = await tx.$executeRaw`
      UPDATE customer_receivable
         SET paid_amount = paid_amount + ${offset}::bigint,
             status = CASE
               WHEN paid_amount + ${offset}::bigint + written_off_amount >= original_amount
                 THEN 'PAID'::"ReceivableStatus"
               ELSE 'PARTIALLY_PAID'::"ReceivableStatus"
             END,
             closed_at = CASE
               WHEN paid_amount + ${offset}::bigint + written_off_amount >= original_amount
                 THEN now()
               ELSE closed_at
             END,
             updated_at = now()
       WHERE id = ${receivable.id}::uuid
         AND organization_id = ${tenant.organizationId}::uuid
         AND paid_amount + written_off_amount + ${offset}::bigint <= original_amount
    `;
    if (applied === 0) return 0n;

    const payment = await tx.payment.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        customerId: receivable.customerId,
        direction: 'IN',
        method: 'OTHER',
        amount: offset,
        receivedBy: tenant.userId,
        note: 'return offset',
      },
      select: { id: true },
    });
    await tx.paymentAllocation.create({
      data: {
        organizationId: tenant.organizationId,
        paymentId: payment.id,
        receivableId: receivable.id,
        amount: offset,
      },
    });
    return offset;
  }

  private async requireReturnableSale(tx: Tx, saleId: string, tenant: TenantContext) {
    const sale = await tx.sale.findFirst({
      where: { id: saleId },
      select: {
        id: true,
        saleNumber: true,
        status: true,
        completedAt: true,
        totalAmount: true,
        refundedAmount: true,
        customerId: true,
        warehouseId: true,
        items: {
          select: {
            id: true,
            productVariantId: true,
            quantity: true,
            returnedQuantity: true,
            netAmount: true,
            refundedAmount: true,
          },
        },
      },
    });
    if (!sale) throw BusinessRuleException.notFound('Savdo', saleId);

    if (sale.status !== 'COMPLETED') {
      throw new BusinessRuleException({
        code: ErrorCode.SALE_NOT_COMPLETED,
        detail:
          sale.status === 'CANCELLED'
            ? "Bekor qilingan savdodan qaytarish bo'lmaydi — u allaqachon qaytarilgan."
            : 'Faqat yakunlangan savdodan qaytariladi.',
      });
    }

    // The return window — §7.5. Outside it, the return needs a permission and
    // always leaves an audit trail.
    const settings = await tx.organizationSettings.findFirst({
      where: {},
      select: { returnWindowDays: true },
    });
    const windowDays = settings?.returnWindowDays ?? 14;

    if (!withinWindow(sale.completedAt, windowDays)) {
      const allowed = tenant.permissions.has('sales.refund_expired') || tenant.permissions.has('*');
      if (!allowed) {
        throw new BusinessRuleException({
          code: ErrorCode.RETURN_WINDOW_EXPIRED,
          detail: `Qaytarish muddati o'tgan (${windowDays} kun). sales.refund_expired ruxsati kerak.`,
          errors: [
            {
              code: ErrorCode.RETURN_WINDOW_EXPIRED,
              message: sale.saleNumber,
              meta: { windowDays, completedAt: sale.completedAt },
            },
          ],
        });
      }
    }

    return sale;
  }

  private async load(client: Tx | PrismaService['db'], returnId: string) {
    const record = await client.saleReturn.findFirst({
      where: { id: returnId },
      select: {
        id: true,
        returnNumber: true,
        storeId: true,
        warehouseId: true,
        reason: true,
        reasonNote: true,
        refundAmount: true,
        creditOffsetAmount: true,
        exchangeId: true,
        createdBy: true,
        createdAt: true,
        sale: {
          select: {
            id: true,
            saleNumber: true,
            totalAmount: true,
            refundedAmount: true,
            returnStatus: true,
          },
        },
        customer: { select: { id: true, fullName: true, phone: true } },
        items: {
          select: {
            id: true,
            saleItemId: true,
            productVariantId: true,
            quantity: true,
            unitRefundAmount: true,
            refundAmount: true,
            restock: true,
            condition: true,
            saleItem: { select: { nameSnapshot: true, skuSnapshot: true } },
          },
        },
        allocations: {
          select: {
            amount: true,
            payment: { select: { id: true, method: true, direction: true, createdAt: true } },
          },
        },
      },
    });
    if (!record) throw BusinessRuleException.notFound('Qaytarish', returnId);

    const { items, allocations, sale, ...rest } = record;

    return {
      ...rest,
      refundAmount: record.refundAmount.toString(),
      creditOffsetAmount: record.creditOffsetAmount.toString(),
      sale: {
        ...sale,
        totalAmount: sale.totalAmount.toString(),
        refundedAmount: sale.refundedAmount.toString(),
      },
      items: items.map((item) => ({
        id: item.id,
        saleItemId: item.saleItemId,
        variantId: item.productVariantId,
        name: item.saleItem.nameSnapshot,
        sku: item.saleItem.skuSnapshot,
        quantity: formatQuantity(item.quantity),
        unitRefundAmount: item.unitRefundAmount.toString(),
        refundAmount: item.refundAmount.toString(),
        restock: item.restock,
        condition: item.condition,
      })),
      refunds: allocations.map((a) => ({
        paymentId: a.payment.id,
        method: a.payment.method,
        direction: a.payment.direction,
        amount: a.amount.toString(),
        at: a.payment.createdAt,
      })),
    };
  }
}

/** Zero means no limit (§7.5). */
function withinWindow(completedAt: Date | null, windowDays: number): boolean {
  if (windowDays <= 0 || !completedAt) return true;
  const age = Date.now() - completedAt.getTime();
  return age <= windowDays * 86_400_000;
}
