import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { nextDocumentNumber } from '../common/document-number';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { priceTimesQuantity } from '../common/money/money';
import { formatQuantity, parseQuantity, toNumber } from '../common/quantity';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { Tx } from '../database/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { PromotionsService } from '../loyalty/promotions.service';
import type { CancelSaleDto, CheckoutDto, ListSalesDto } from './dto/sale.dto';
import { priceSale } from './pricing';
import { bestItemDiscount, bestOrderDiscount, groupDiscount } from './promotions';

const SORTABLE: Record<string, Prisma.SaleOrderByWithRelationInput> = {
  'completedAt:desc': { completedAt: 'desc' },
  'completedAt:asc': { completedAt: 'asc' },
  'total:desc': { totalAmount: 'desc' },
  'total:asc': { totalAmount: 'asc' },
  'saleNumber:asc': { saleNumber: 'asc' },
  'saleNumber:desc': { saleNumber: 'desc' },
};

/**
 * Sales and checkout — docs/ARCHITECTURE.md §10 and §11.
 *
 * The rule that shapes everything here: the server recalculates every
 * financial figure. The request says what the customer wants and how they
 * paid; it never says what anything costs. A client-supplied total is not
 * validated against the server's — it is ignored, because a field nobody reads
 * cannot be tampered with.
 */
@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly idempotency: IdempotencyService,
    private readonly promotions: PromotionsService,
    private readonly loyalty: LoyaltyService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Checkout
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Creates and completes a sale in one transaction — docs/ARCHITECTURE.md §10.4.
   *
   * Sale, lines, stock movements, payments, allocations and the receivable all
   * commit together or none of them do. There is no window in which the stock
   * has moved but the money has not been recorded, because there is no second
   * transaction.
   *
   * The whole thing runs inside `idempotency.run`, so the record that says
   * "this key already produced a sale" commits with the sale itself.
   */
  async checkout(dto: CheckoutDto, tenant: TenantContext, idempotencyKey: string) {
    // Resolution happens before the transaction: reading the catalogue,
    // settings and warehouse does not need to be serialized with the write,
    // and holding a transaction open across those round trips would widen the
    // lock window on the document counter for no benefit.
    const context = await this.resolveCheckout(dto, tenant);

    const { result, replayed } = await this.idempotency.run(
      {
        organizationId: tenant.organizationId,
        key: idempotencyKey,
        endpoint: 'POST /sales/checkout',
        body: dto,
        status: HttpStatus.CREATED,
        resourceId: (sale: { id: string }) => sale.id,
      },
      (tx) => this.writeSale(tx, dto, tenant, context),
    );

    if (!replayed) {
      // After commit. Nothing here may fail the sale: a Telegram outage must
      // never cost a store a transaction (§10.4).
      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'sale.completed',
        entityType: 'sale',
        entityId: result.id,
        metadata: {
          saleNumber: result.saleNumber,
          total: result.totalAmount,
          paid: result.paidAmount,
          credit: result.creditAmount,
          lines: result.items.length,
          customerId: dto.customerId ?? null,
          methods: dto.payments.map((p) => p.method),
        },
      });
    }

    return { ...result, replayed };
  }

  /**
   * Everything the transaction needs, resolved and validated up front.
   *
   * Prices come from the catalogue, costs from the inventory level. The
   * request's own numbers are used for exactly two things: which variant, and
   * how many.
   */
  private async resolveCheckout(dto: CheckoutDto, tenant: TenantContext) {
    if (dto.items.length === 0) {
      throw new BusinessRuleException({ code: ErrorCode.EMPTY_SALE, detail: "Savdo bo'sh." });
    }

    const warehouse = await this.resolveWarehouse(dto.warehouseId, tenant.storeId);
    const customer = dto.customerId ? await this.requireCustomer(dto.customerId) : null;

    // A LOYALTY tender is a redemption, and a redemption needs an account to
    // redeem from (§17.3). It is a payment, not a discount: a discount reduces
    // revenue, while a redemption settles revenue with a liability the store
    // recognised when the points were earned.
    const loyaltyTender = dto.payments
      .filter((p) => p.method === 'LOYALTY')
      .reduce((sum, p) => sum + BigInt(p.amount), 0n);
    if (loyaltyTender > 0n && !dto.customerId) {
      throw new BusinessRuleException({
        code: ErrorCode.CREDIT_WITHOUT_CUSTOMER,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: "Ball bilan to'lash uchun mijoz ko'rsatilishi shart.",
      });
    }

    const creditAmount = BigInt(dto.creditAmount ?? 0);
    if (creditAmount > 0n && !customer) {
      throw new BusinessRuleException({
        code: ErrorCode.CREDIT_WITHOUT_CUSTOMER,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: "Qarzga savdo uchun mijoz ko'rsatilishi shart — qarzni kimdir olishi kerak.",
      });
    }
    if (
      creditAmount > 0n &&
      !tenant.permissions.has('debt.create') &&
      !tenant.permissions.has('*')
    ) {
      throw new BusinessRuleException({
        code: ErrorCode.FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
        detail: 'Qarzga savdo uchun debt.create ruxsati kerak.',
      });
    }

    // Permission gates on the two things a cashier can use to change what the
    // customer pays. Checked before any work, so a forbidden request costs one
    // query rather than a transaction.
    const wantsOverride = dto.items.some((i) => i.unitPrice !== undefined);
    if (wantsOverride && !this.can(tenant, 'sales.override_price')) {
      throw new BusinessRuleException({
        code: ErrorCode.PRICE_OVERRIDE_FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
        detail: "Narxni o'zgartirish uchun sales.override_price ruxsati kerak.",
      });
    }
    const wantsLineDiscount = dto.items.some((i) => (i.discountAmount ?? 0) > 0);
    if (wantsLineDiscount && !this.can(tenant, 'sales.discount_item')) {
      throw new BusinessRuleException({
        code: ErrorCode.DISCOUNT_FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
        detail: 'Satrga chegirma uchun sales.discount_item ruxsati kerak.',
      });
    }
    if ((dto.orderDiscountAmount ?? 0) > 0 && !this.can(tenant, 'sales.discount_order')) {
      throw new BusinessRuleException({
        code: ErrorCode.DISCOUNT_FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
        detail: 'Chekka chegirma uchun sales.discount_order ruxsati kerak.',
      });
    }

    const variantIds = dto.items.map((i) => i.variantId);
    const variants = await this.inventory.requireVariants(variantIds);

    // Prices and costs, read from the server's own tables. This is the step
    // that makes price tampering structurally impossible rather than merely
    // detected: the client's unitPrice is only consulted when an override was
    // explicitly permitted above.
    const priced = await this.prisma.db.productVariant.findMany({
      where: { id: { in: [...new Set(variantIds)] } },
      select: {
        id: true,
        sku: true,
        name: true,
        sellingPrice: true,
        product: { select: { id: true, name: true, categoryId: true } },
      },
    });
    const catalogue = new Map(priced.map((v) => [v.id, v]));

    const costs = await this.prisma.db.inventoryLevel.findMany({
      where: { warehouseId: warehouse.id, productVariantId: { in: [...new Set(variantIds)] } },
      select: { productVariantId: true, avgCost: true },
    });
    const costByVariant = new Map(costs.map((c) => [c.productVariantId, c.avgCost]));

    const settings = await this.prisma.db.organizationSettings.findFirst({
      where: { organizationId: tenant.organizationId },
      select: {
        cashRoundingUnit: true,
        defaultDebtTermDays: true,
        loyaltyEarnPercent: true,
        loyaltyPointValue: true,
      },
    });

    // Promotions, from one snapshot taken for this checkout. The rules are
    // read here; deciding which one wins is the pure code in
    // sales/promotions.ts, so every pricing decision is testable on its own.
    const now = new Date();
    const rules = await this.promotions.activeRules(now);
    const promotionContext = { customerGroupId: customer?.customerGroupId ?? null, at: now };

    const lines = dto.items.map((item, index) => {
      const variant = catalogue.get(item.variantId)!;
      const quantity = parseQuantity(item.quantity, `items[${index}].quantity`);
      if (quantity <= 0) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail: "Miqdor musbat bo'lishi kerak.",
        });
      }

      const unitPrice =
        item.unitPrice !== undefined ? BigInt(item.unitPrice) : variant.sellingPrice;
      const gross = priceTimesQuantity(unitPrice, BigInt(Math.round(quantity * 1000)));

      const promotion = bestItemDiscount(
        rules,
        { productId: variant.product.id, categoryId: variant.product.categoryId, gross },
        promotionContext,
      );

      return {
        variantId: item.variantId,
        // The receipt's own words, frozen. A product renamed next month must
        // not change what last month's receipt says.
        nameSnapshot: variant.name
          ? `${variant.product.name} · ${variant.name}`
          : variant.product.name,
        skuSnapshot: variant.sku,
        quantity: formatQuantity(quantity),
        unitPrice,
        gross,
        unitCost: costByVariant.get(item.variantId) ?? 0n,
        lineDiscount: BigInt(item.discountAmount ?? 0),
        promotionDiscount: promotion?.amount ?? 0n,
        ...(promotion ? { promotionId: promotion.promotionId } : {}),
      };
    });

    // The order-level candidates share one base: the subtotal after line
    // discounts, which is what the customer is actually about to spend.
    const subtotalAfterLines = lines.reduce((sum, l) => {
      const applied = l.lineDiscount >= l.promotionDiscount ? l.lineDiscount : l.promotionDiscount;
      return sum + l.gross - (applied > l.gross ? l.gross : applied);
    }, 0n);

    const orderPromotion = bestOrderDiscount(rules, subtotalAfterLines, promotionContext);
    const group = customer?.group
      ? groupDiscount(
          BigInt(Math.round(Number(customer.group.discountPercent.toString()) * 100)),
          subtotalAfterLines,
          customer.group.name,
        )
      : null;

    // One winner between the campaign and the standing group percentage: a VIP
    // who also catches a promotion gets the better of the two, not both.
    const orderCandidate =
      orderPromotion && group
        ? orderPromotion.amount >= group.amount
          ? orderPromotion
          : group
        : (orderPromotion ?? group);

    const tenderIsAllCash =
      dto.payments.length > 0 && dto.payments.every((p) => p.method === 'CASH');

    const pricing = priceSale({
      lines,
      orderDiscount: BigInt(dto.orderDiscountAmount ?? 0),
      orderPromotionDiscount: orderCandidate?.amount ?? 0n,
      orderPromotionId: orderCandidate?.promotionId || null,
      cashRoundingUnit: settings?.cashRoundingUnit ?? 0n,
      // Rounding a mixed tender would mean rounding a card amount the terminal
      // never saw, so credit counts against "all cash" too.
      tenderIsAllCash: tenderIsAllCash && creditAmount === 0n,
    });

    // BR-2: payments plus credit must equal the total, exactly. Not "at
    // least" — an over-tender is change the client computes and the drawer
    // never sees (§11.4), and an under-tender with no credit is a sale that
    // does not balance.
    const paidAmount = dto.payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
    if (paidAmount + creditAmount !== pricing.totalAmount) {
      throw new BusinessRuleException({
        code: ErrorCode.PAYMENT_MISMATCH,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: `To'lov jami mos emas: kutilgan ${pricing.totalAmount}, kelgan ${paidAmount + creditAmount}.`,
        errors: [
          {
            code: ErrorCode.PAYMENT_MISMATCH,
            message: 'payments',
            meta: {
              expected: pricing.totalAmount.toString(),
              paid: paidAmount.toString(),
              credit: creditAmount.toString(),
            },
          },
        ],
      });
    }

    if (creditAmount > 0n && customer) {
      await this.assertWithinCreditLimit(customer, creditAmount);
    }

    return {
      warehouse,
      customer,
      pricing,
      paidAmount,
      creditAmount,
      variants,
      earnPercent: BigInt(Math.round(Number((settings?.loyaltyEarnPercent ?? 0).toString()) * 100)),
      pointValue: settings?.loyaltyPointValue ?? 1n,
      loyaltyTender,
      dueDate: this.resolveDueDate(dto.dueDate, settings?.defaultDebtTermDays ?? 30),
    };
  }

  /** The transaction itself — §10.4, in that order. */
  private async writeSale(
    tx: Tx,
    dto: CheckoutDto,
    tenant: TenantContext,
    context: Awaited<ReturnType<SalesService['resolveCheckout']>>,
  ) {
    const { pricing, warehouse, customer, paidAmount, creditAmount } = context;

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
        warehouseId: warehouse.id,
        customerId: customer?.id ?? null,
        saleNumber,
        // Written as COMPLETED directly. A two-step insert-then-update would
        // leave a DRAFT visible to a concurrent reader for the length of the
        // transaction, and the CHECK constraints are written for the final
        // state anyway.
        status: 'COMPLETED',
        subtotalAmount: pricing.subtotalAmount,
        orderDiscountAmount: pricing.orderDiscountAmount,
        taxAmount: pricing.taxAmount,
        roundingAdjustment: pricing.roundingAdjustment,
        totalAmount: pricing.totalAmount,
        paidAmount,
        creditAmount,
        costAmount: pricing.costAmount,
        promotionId: pricing.orderPromotionId,
        discountReason: dto.discountReason ?? null,
        note: dto.note ?? null,
        createdBy: tenant.userId,
        completedAt: new Date(),
        clientId: dto.clientId ?? null,
        clientCreatedAt: dto.clientCreatedAt ? new Date(dto.clientCreatedAt) : null,
        items: {
          createMany: {
            data: pricing.lines.map((line) => ({
              organizationId: tenant.organizationId,
              productVariantId: line.variantId,
              nameSnapshot: line.nameSnapshot,
              skuSnapshot: line.skuSnapshot,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              grossAmount: line.grossAmount,
              lineDiscountAmount: line.lineDiscountAmount,
              allocatedOrderDiscount: line.allocatedOrderDiscount,
              netAmount: line.netAmount,
              unitCost: line.unitCost,
              promotionId: line.promotionId,
              position: line.position,
            })),
          },
        },
      },
      select: { id: true, saleNumber: true },
    });

    // Stock. applyMany sorts by variant, so two sales touching the same two
    // products take their row locks in the same order and cannot deadlock.
    // A line the shop cannot cover throws INSUFFICIENT_STOCK and the whole
    // sale — including the money — rolls back.
    await this.inventory.applyMany(
      tx,
      pricing.lines.map((line) => ({
        organizationId: tenant.organizationId,
        warehouseId: warehouse.id,
        variantId: line.variantId,
        type: 'SALE' as const,
        delta: -parseQuantity(line.quantity),
        unitCost: line.unitCost,
        sourceType: 'sale',
        sourceId: sale.id,
        actorId: tenant.userId,
      })),
    );

    // Payments and what they settled. Two tables, so a debt payment later is
    // the same shape as a sale payment now.
    for (const payment of dto.payments) {
      const created = await tx.payment.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          customerId: customer?.id ?? null,
          direction: 'IN',
          method: payment.method,
          amount: BigInt(payment.amount),
          providerRef: payment.providerRef ?? null,
          receivedBy: tenant.userId,
          note: payment.note ?? null,
          clientId: payment.clientId ?? null,
        },
        select: { id: true },
      });

      await tx.paymentAllocation.create({
        data: {
          organizationId: tenant.organizationId,
          paymentId: created.id,
          saleId: sale.id,
          amount: BigInt(payment.amount),
        },
      });
    }

    // Redemption — §17.3. The payment row above already records the tender;
    // this moves the points, under a guard that cannot take the balance below
    // zero. Two tills redeeming the same points cannot both succeed.
    if (context.loyaltyTender > 0n && customer) {
      const pointValue = context.pointValue > 0n ? context.pointValue : 1n;
      if (context.loyaltyTender % pointValue !== 0n) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail: `Ball summasi ${pointValue} ga bo'linishi kerak.`,
        });
      }
      await this.loyalty.redeem(tx, {
        organizationId: tenant.organizationId,
        customerId: customer.id,
        points: context.loyaltyTender / pointValue,
        pointValue,
        actorId: tenant.userId,
      });
    }

    // Earning — on subtotal_amount, the net of discounts, so cash rounding
    // does not leak into loyalty and a discounted sale does not also generate
    // full points (§17.2).
    if (customer) {
      await this.loyalty.earn(tx, {
        organizationId: tenant.organizationId,
        customerId: customer.id,
        saleId: sale.id,
        subtotal: pricing.subtotalAmount - pricing.orderDiscountAmount,
        earnPercent: context.earnPercent,
        actorId: tenant.userId,
      });
    }

    // The debt, if any. customer_receivable.sale_id is UNIQUE, so one sale can
    // never spawn two debts however a retrying client misbehaves (§26.4).
    if (creditAmount > 0n && customer) {
      await tx.customerReceivable.create({
        data: {
          organizationId: tenant.organizationId,
          storeId: tenant.storeId,
          customerId: customer.id,
          saleId: sale.id,
          origin: 'SALE',
          originalAmount: creditAmount,
          status: 'OPEN',
          issuedAt: new Date(),
          dueDate: context.dueDate,
          createdBy: tenant.userId,
        },
      });
    }

    return this.load(tx, sale.id);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────────────────────

  async list(query: ListSalesDto) {
    const where: Prisma.SaleWhereInput = {
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.cashierId ? { createdBy: query.cashierId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.onCredit === 'true' ? { creditAmount: { gt: 0 } } : {}),
      ...(query.paymentMethod
        ? { allocations: { some: { payment: { method: query.paymentMethod } } } }
        : {}),
      ...(query.minAmount !== undefined || query.maxAmount !== undefined
        ? {
            totalAmount: {
              ...(query.minAmount !== undefined ? { gte: BigInt(query.minAmount) } : {}),
              ...(query.maxAmount !== undefined ? { lte: BigInt(query.maxAmount) } : {}),
            },
          }
        : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            completedAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { saleNumber: { contains: query.q, mode: 'insensitive' } },
              { customer: { fullName: { contains: query.q, mode: 'insensitive' } } },
              { customer: { phone: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [rows, total, totals] = await Promise.all([
      this.prisma.db.sale.findMany({
        where,
        select: {
          id: true,
          saleNumber: true,
          status: true,
          returnStatus: true,
          totalAmount: true,
          paidAmount: true,
          creditAmount: true,
          refundedAmount: true,
          completedAt: true,
          createdAt: true,
          createdBy: true,
          storeId: true,
          customer: { select: { id: true, fullName: true, phone: true } },
          _count: { select: { items: true } },
        },
        orderBy: SORTABLE[query.sort ?? 'completedAt:desc'] ?? { completedAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.sale.count({ where }),
      this.prisma.db.sale.aggregate({
        where: { ...where, status: 'COMPLETED' },
        _sum: { totalAmount: true, creditAmount: true, costAmount: true },
      }),
    ]);

    return {
      data: rows.map(({ _count, ...sale }) => ({
        ...serializeMoney(sale),
        lineCount: _count.items,
      })),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
      summary: {
        // The day's header: "34 savdo · 4 120 000 so'm".
        revenue: (totals._sum.totalAmount ?? 0n).toString(),
        credit: (totals._sum.creditAmount ?? 0n).toString(),
        cost: (totals._sum.costAmount ?? 0n).toString(),
        margin: ((totals._sum.totalAmount ?? 0n) - (totals._sum.costAmount ?? 0n)).toString(),
      },
    };
  }

  async findOne(saleId: string) {
    return this.load(this.prisma.db, saleId);
  }

  /**
   * The receipt.
   *
   * Built entirely from what the sale stored, never from the catalogue: a
   * receipt reprinted next year must say what it said on the day, whatever has
   * happened to prices and product names since.
   */
  async receipt(saleId: string) {
    const sale = await this.load(this.prisma.db, saleId);
    const store = await this.prisma.db.store.findFirst({
      where: { id: sale.storeId },
      select: { name: true, code: true, address: true, phone: true, legalName: true, taxId: true },
    });

    return {
      saleNumber: sale.saleNumber,
      date: sale.completedAt ?? sale.createdAt,
      status: sale.status,
      store,
      customer: sale.customer,
      items: sale.items.map((item) => ({
        name: item.nameSnapshot,
        sku: item.skuSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: (
          BigInt(item.lineDiscountAmount) + BigInt(item.allocatedOrderDiscount)
        ).toString(),
        total: item.netAmount,
      })),
      subtotal: sale.subtotalAmount,
      orderDiscount: sale.orderDiscountAmount,
      rounding: sale.roundingAdjustment,
      total: sale.totalAmount,
      payments: sale.payments,
      credit: sale.creditAmount,
      note: sale.note,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Cancellation
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Cancels a completed sale — docs/ARCHITECTURE.md §7.4.
   *
   * The sale is never deleted and its figures are never rewritten. Status
   * moves to CANCELLED, the stock comes back as a compensating RETURN
   * movement, and the payments are voided with an opposite-direction payment
   * so the money trail stays symmetric.
   *
   * A sale that has already been returned against is refused: two mechanisms
   * undoing the same money is how a refund gets paid twice.
   */
  async cancel(saleId: string, dto: CancelSaleDto, tenant: TenantContext) {
    const existing = await this.prisma.db.sale.findFirst({
      where: { id: saleId },
      select: {
        id: true,
        status: true,
        saleNumber: true,
        warehouseId: true,
        returnStatus: true,
        totalAmount: true,
        creditAmount: true,
        items: { select: { productVariantId: true, quantity: true, unitCost: true } },
      },
    });
    if (!existing) throw BusinessRuleException.notFound('Savdo', saleId);

    if (existing.status === 'CANCELLED') {
      throw new BusinessRuleException({
        code: ErrorCode.SALE_ALREADY_CANCELLED,
        detail: 'Bu savdo allaqachon bekor qilingan.',
      });
    }
    if (existing.status !== 'COMPLETED') {
      throw new BusinessRuleException({
        code: ErrorCode.SALE_NOT_COMPLETED,
        detail: 'Faqat yakunlangan savdo bekor qilinadi.',
      });
    }
    if (existing.returnStatus !== 'NONE') {
      throw new BusinessRuleException({
        code: ErrorCode.SALE_HAS_RETURNS,
        detail: 'Qaytarish qilingan savdo bekor qilinmaydi — qaytarishni bekor qiling.',
      });
    }

    await this.prisma.db.$transaction(async (tx) => {
      // Conditional claim, the same shape as the inventory guard: two
      // cancellations of one sale must not both restore the stock.
      const claimed = await tx.$executeRaw`
        UPDATE sale
           SET status        = 'CANCELLED'::"SaleStatus",
               cancelled_at  = now(),
               cancelled_by  = ${tenant.userId}::uuid,
               cancel_reason = ${dto.reason},
               updated_at    = now()
         WHERE id = ${saleId}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND status = 'COMPLETED'
      `;
      if (claimed === 0) {
        throw new BusinessRuleException({
          code: ErrorCode.SALE_ALREADY_CANCELLED,
          detail: 'Bu savdo allaqachon bekor qilingan.',
        });
      }

      await this.inventory.applyMany(
        tx,
        existing.items.map((item) => ({
          organizationId: tenant.organizationId,
          warehouseId: existing.warehouseId,
          variantId: item.productVariantId,
          type: 'RETURN' as const,
          delta: toNumber(item.quantity),
          unitCost: item.unitCost,
          sourceType: 'sale_cancellation',
          sourceId: saleId,
          note: dto.reason,
          actorId: tenant.userId,
        })),
      );

      // Money out, mirroring what came in. The original payments are left
      // untouched: a voided payment that still shows COMPLETED in the drawer
      // report is a reconciliation problem, and rewriting history is worse.
      const payments = await tx.paymentAllocation.findMany({
        where: { saleId },
        select: { amount: true, payment: { select: { id: true, method: true, customerId: true } } },
      });

      for (const allocation of payments) {
        const reversal = await tx.payment.create({
          data: {
            organizationId: tenant.organizationId,
            storeId: tenant.storeId,
            customerId: allocation.payment.customerId,
            direction: 'OUT',
            method: allocation.payment.method,
            amount: allocation.amount,
            receivedBy: tenant.userId,
            note: `Savdo bekor qilindi: ${existing.saleNumber}`,
          },
          select: { id: true },
        });
        await tx.paymentAllocation.create({
          data: {
            organizationId: tenant.organizationId,
            paymentId: reversal.id,
            saleId,
            amount: allocation.amount,
          },
        });
        await tx.payment.update({
          where: {
            organizationId_id: { organizationId: tenant.organizationId, id: allocation.payment.id },
          },
          data: { status: 'VOIDED' },
        });
      }

      // The debt goes with it. Writing it off rather than deleting keeps the
      // ledger's promise that no receivable ever disappears.
      if (existing.creditAmount > 0n) {
        await tx.customerReceivable.updateMany({
          where: { saleId, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
          data: {
            status: 'WRITTEN_OFF',
            writtenOffAmount: existing.creditAmount,
            closedAt: new Date(),
            note: `Savdo bekor qilindi: ${dto.reason}`,
          },
        });
      }
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'sale.cancelled',
      entityType: 'sale',
      entityId: saleId,
      metadata: {
        saleNumber: existing.saleNumber,
        reason: dto.reason,
        total: existing.totalAmount.toString(),
        restockedLines: existing.items.length,
      },
    });

    return this.findOne(saleId);
  }

  // ────────────────────────────────────────────────────────────────────────

  private async load(client: Tx | PrismaService['db'], saleId: string) {
    const sale = await client.sale.findFirst({
      where: { id: saleId },
      select: {
        id: true,
        saleNumber: true,
        storeId: true,
        warehouseId: true,
        status: true,
        returnStatus: true,
        subtotalAmount: true,
        orderDiscountAmount: true,
        taxAmount: true,
        roundingAdjustment: true,
        totalAmount: true,
        paidAmount: true,
        creditAmount: true,
        refundedAmount: true,
        costAmount: true,
        discountReason: true,
        note: true,
        createdBy: true,
        completedAt: true,
        cancelledAt: true,
        cancelReason: true,
        clientId: true,
        createdAt: true,
        customer: { select: { id: true, fullName: true, phone: true } },
        items: {
          select: {
            id: true,
            productVariantId: true,
            nameSnapshot: true,
            skuSnapshot: true,
            quantity: true,
            unitPrice: true,
            grossAmount: true,
            lineDiscountAmount: true,
            allocatedOrderDiscount: true,
            netAmount: true,
            unitCost: true,
            returnedQuantity: true,
            promotionId: true,
            position: true,
          },
          orderBy: { position: 'asc' },
        },
        allocations: {
          select: {
            amount: true,
            payment: {
              select: {
                id: true,
                method: true,
                direction: true,
                status: true,
                providerRef: true,
                createdAt: true,
              },
            },
          },
        },
        receivable: {
          select: {
            id: true,
            originalAmount: true,
            paidAmount: true,
            writtenOffAmount: true,
            status: true,
            dueDate: true,
          },
        },
      },
    });
    if (!sale) throw BusinessRuleException.notFound('Savdo', saleId);

    const { allocations, items, receivable, ...rest } = sale;

    return {
      ...serializeMoney(rest),
      items: items.map((item) => ({
        ...serializeMoney(item),
        quantity: formatQuantity(item.quantity),
        returnedQuantity: formatQuantity(item.returnedQuantity),
      })),
      payments: allocations.map((a) => ({
        paymentId: a.payment.id,
        method: a.payment.method,
        direction: a.payment.direction,
        status: a.payment.status,
        amount: a.amount.toString(),
        providerRef: a.payment.providerRef,
        createdAt: a.payment.createdAt,
      })),
      receivable: receivable
        ? {
            ...serializeMoney(receivable),
            // Derived, never stored — nothing stored is nothing that can drift.
            remainingAmount: (
              receivable.originalAmount -
              receivable.paidAmount -
              receivable.writtenOffAmount
            ).toString(),
          }
        : null,
    };
  }

  private can(tenant: TenantContext, permission: string): boolean {
    return tenant.permissions.has(permission) || tenant.permissions.has('*');
  }

  private async resolveWarehouse(warehouseId: string | undefined, storeId: string) {
    if (warehouseId) return this.inventory.requireWarehouse(warehouseId);

    const fallback = await this.prisma.db.warehouse.findFirst({
      where: { storeId, archivedAt: null },
      orderBy: { isDefault: 'desc' },
      select: { id: true, code: true, name: true, storeId: true, archivedAt: true },
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

  private async requireCustomer(customerId: string) {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id: customerId, archivedAt: null },
      select: {
        id: true,
        fullName: true,
        creditLimit: true,
        customerGroupId: true,
        group: { select: { name: true, discountPercent: true, creditLimit: true } },
      },
    });
    if (!customer) throw BusinessRuleException.notFound('Mijoz', customerId);
    return customer;
  }

  /**
   * BR-9 credit eligibility.
   *
   * The limit is checked against what the customer already owes plus what this
   * sale would add. Sprint 6 adds the group-level fallback; a null limit here
   * means unlimited, which is the sensible default for a shop that knows its
   * regulars.
   */
  private async assertWithinCreditLimit(
    customer: {
      id: string;
      fullName: string;
      creditLimit: bigint | null;
      group?: { creditLimit: bigint | null } | null;
    },
    creditAmount: bigint,
  ) {
    // Resolution order: the customer's own limit, else the group's, else
    // unlimited — the same order the customer card reports.
    const limit = customer.creditLimit ?? customer.group?.creditLimit ?? null;
    if (limit === null) return;

    const open = await this.prisma.db.customerReceivable.aggregate({
      where: { customerId: customer.id, status: { in: ['OPEN', 'PARTIALLY_PAID'] } },
      _sum: { originalAmount: true, paidAmount: true, writtenOffAmount: true },
    });
    const outstanding =
      (open._sum.originalAmount ?? 0n) -
      (open._sum.paidAmount ?? 0n) -
      (open._sum.writtenOffAmount ?? 0n);

    if (outstanding + creditAmount > limit) {
      throw new BusinessRuleException({
        code: ErrorCode.CREDIT_LIMIT_EXCEEDED,
        detail: `${customer.fullName} uchun qarz chegarasi oshib ketadi.`,
        errors: [
          {
            code: ErrorCode.CREDIT_LIMIT_EXCEEDED,
            message: customer.fullName,
            meta: {
              limit: limit.toString(),
              outstanding: outstanding.toString(),
              requested: creditAmount.toString(),
            },
          },
        ],
      });
    }
  }

  private resolveDueDate(requested: string | undefined, defaultDays: number): Date {
    if (requested) {
      const date = new Date(requested);
      if (Number.isNaN(date.getTime())) {
        throw new BusinessRuleException({
          code: ErrorCode.VALIDATION_FAILED,
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          detail: "Qarz muddati noto'g'ri.",
        });
      }
      return date;
    }
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + defaultDays);
    return due;
  }
}

/**
 * bigint columns become strings in the response.
 *
 * Money is BIGINT minor units and JSON has no bigint; emitting it as a JSON
 * number would silently lose precision above 2^53, which for soʻm is a real
 * total rather than a theoretical one.
 */
function serializeMoney<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return out as T;
}
