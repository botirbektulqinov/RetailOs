import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { CashService } from '../cash/cash.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { Tx } from '../database/prisma.service';
import type { CreateDebtDto, DebtPaymentDto, ListDebtsDto, WriteOffDto } from './dto/customer.dto';

/** The two statuses that still owe money. */
const OPEN_STATUSES = ['OPEN', 'PARTIALLY_PAID'] as const;

const DEBT_SORT: Record<string, Prisma.CustomerReceivableOrderByWithRelationInput> = {
  'dueDate:asc': { dueDate: 'asc' },
  'dueDate:desc': { dueDate: 'desc' },
  'amount:desc': { originalAmount: 'desc' },
  'amount:asc': { originalAmount: 'asc' },
  'createdAt:desc': { createdAt: 'desc' },
};

/**
 * Receivables — docs/ARCHITECTURE.md §12.
 *
 * Debt is a stack of documents, never a running balance. Each receivable
 * records what was owed, what has been paid and what has been written off; the
 * remaining amount is the subtraction, computed wherever it is needed and
 * bounded by a CHECK. There is no `customer.debt` column to drift.
 *
 * `OVERDUE` is deliberately not a status. It is `remaining > 0 AND due_date <
 * today`, evaluated in the query — making it a status would need a nightly job
 * to flip rows, and every row would be lying until that job ran.
 */
@Injectable()
export class DebtsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly cash: CashService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListDebtsDto) {
    const where: Prisma.CustomerReceivableWhereInput = {
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...this.filterPredicate(query.filter),
      ...(query.dateFrom || query.dateTo
        ? {
            issuedAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { customer: { fullName: { contains: query.q, mode: 'insensitive' } } },
              { customer: { phone: { contains: query.q } } },
              { sale: { saleNumber: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [rows, total, sums] = await Promise.all([
      this.prisma.db.customerReceivable.findMany({
        where,
        select: RECEIVABLE_FIELDS,
        orderBy: DEBT_SORT[query.sort ?? 'dueDate:asc'] ?? { dueDate: 'asc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.customerReceivable.count({ where }),
      this.prisma.db.customerReceivable.aggregate({
        where,
        _sum: { originalAmount: true, paidAmount: true, writtenOffAmount: true },
      }),
    ]);

    const outstanding =
      (sums._sum.originalAmount ?? 0n) -
      (sums._sum.paidAmount ?? 0n) -
      (sums._sum.writtenOffAmount ?? 0n);

    return {
      data: rows.map(toReceivable),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
      summary: {
        original: (sums._sum.originalAmount ?? 0n).toString(),
        paid: (sums._sum.paidAmount ?? 0n).toString(),
        writtenOff: (sums._sum.writtenOffAmount ?? 0n).toString(),
        outstanding: outstanding.toString(),
      },
    };
  }

  async findOne(receivableId: string) {
    const receivable = await this.prisma.db.customerReceivable.findFirst({
      where: { id: receivableId },
      select: {
        ...RECEIVABLE_FIELDS,
        note: true,
        createdBy: true,
        allocations: {
          select: {
            amount: true,
            createdAt: true,
            payment: {
              select: {
                id: true,
                method: true,
                direction: true,
                receivedBy: true,
                providerRef: true,
                note: true,
                createdAt: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!receivable) throw BusinessRuleException.notFound('Qarz', receivableId);

    const { allocations, ...rest } = receivable;

    return {
      ...toReceivable(rest),
      note: receivable.note,
      // The immutable payment history. Nothing here is ever rewritten: a
      // payment that turns out to be wrong is corrected by another payment.
      payments: allocations.map((a) => ({
        paymentId: a.payment.id,
        amount: a.amount.toString(),
        method: a.payment.method,
        direction: a.payment.direction,
        receivedBy: a.payment.receivedBy,
        providerRef: a.payment.providerRef,
        note: a.payment.note,
        at: a.createdAt,
      })),
    };
  }

  /**
   * An opening balance or a manual debt.
   *
   * A sale's debt is NOT created here — it is born inside the checkout
   * transaction, where it commits with the sale that caused it. Allowing both
   * paths would mean two ways for a sale to acquire a debt and no way to be
   * sure a sale has exactly one.
   */
  async create(dto: CreateDebtDto, tenant: TenantContext) {
    const customer = await this.requireCustomer(dto.customerId);

    const settings = await this.prisma.db.organizationSettings.findFirst({
      where: { organizationId: tenant.organizationId },
      select: { defaultDebtTermDays: true },
    });

    const receivable = await this.prisma.db.customerReceivable.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        customerId: customer.id,
        origin: dto.origin ?? 'MANUAL',
        originalAmount: BigInt(dto.amount),
        status: 'OPEN',
        issuedAt: new Date(),
        dueDate: resolveDueDate(dto.dueDate, settings?.defaultDebtTermDays ?? 30),
        note: dto.note ?? null,
        createdBy: tenant.userId,
      },
      select: { id: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'debt.created',
      entityType: 'customer_receivable',
      entityId: receivable.id,
      metadata: {
        customerId: customer.id,
        amount: dto.amount,
        origin: dto.origin ?? 'MANUAL',
      },
    });

    return this.findOne(receivable.id);
  }

  /**
   * Records a payment against one or more debts — docs/ARCHITECTURE.md §12.4.
   *
   * One `payment` row and one `payment_allocation` per debt it settled, which
   * is the same shape a sale payment uses. No debt-specific payment table, and
   * no second copy of the cash-drawer logic.
   *
   * Unspecified targets are paid oldest-due first. FIFO by due date is what a
   * shopkeeper does by hand, and it is the ordering that minimises how long
   * anything stays overdue.
   */
  async pay(dto: DebtPaymentDto, tenant: TenantContext, idempotencyKey: string) {
    const customer = await this.requireCustomer(dto.customerId);

    const { result, replayed } = await this.idempotency.run(
      {
        organizationId: tenant.organizationId,
        key: idempotencyKey,
        endpoint: 'POST /debts/payments',
        body: dto,
        status: HttpStatus.CREATED,
      },
      (tx) => this.writePayment(tx, dto, tenant, customer.id),
    );

    if (!replayed) {
      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'debt.payment_recorded',
        entityType: 'payment',
        entityId: result.paymentId,
        metadata: {
          customerId: customer.id,
          amount: dto.amount,
          method: dto.method,
          settled: result.allocations,
        },
      });
    }

    return { ...result, replayed };
  }

  private async writePayment(
    tx: Tx,
    dto: DebtPaymentDto,
    tenant: TenantContext,
    customerId: string,
  ) {
    const targets = await this.resolveTargets(tx, dto, customerId);

    const payment = await tx.payment.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        customerId,
        // A cash collection lands in the open drawer, exactly as a cash sale
        // does — which is why there is no debt-specific drawer logic.
        cashRegisterShiftId: await this.cash.openShiftIdFor(tx, tenant.storeId),
        direction: 'IN',
        method: dto.method,
        amount: BigInt(dto.amount),
        providerRef: dto.providerRef ?? null,
        receivedBy: tenant.userId,
        note: dto.note ?? null,
      },
      select: { id: true },
    });

    let left = BigInt(dto.amount);
    const allocations: Array<{ receivableId: string; amount: string; status: string }> = [];

    for (const target of targets) {
      if (left === 0n) break;
      const part = target.remaining < left ? target.remaining : left;
      if (part <= 0n) continue;

      // The conditional UPDATE is doing the concurrency work: two cashiers
      // collecting against the same debt at the same moment cannot together
      // push it past original_amount. One of them matches zero rows.
      const applied = await tx.$executeRaw`
        UPDATE customer_receivable
           SET paid_amount = paid_amount + ${part}::bigint,
               status      = CASE
                 WHEN paid_amount + ${part}::bigint + written_off_amount >= original_amount
                   THEN 'PAID'::"ReceivableStatus"
                 ELSE 'PARTIALLY_PAID'::"ReceivableStatus"
               END,
               closed_at   = CASE
                 WHEN paid_amount + ${part}::bigint + written_off_amount >= original_amount
                   THEN now()
                 ELSE closed_at
               END,
               updated_at  = now()
         WHERE id = ${target.id}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND paid_amount + written_off_amount + ${part}::bigint <= original_amount
      `;

      if (applied === 0) {
        throw new BusinessRuleException({
          code: ErrorCode.RECEIVABLE_OVERPAYMENT,
          detail: "Qarzdan ortiq to'lov. Qolgan summa o'zgargan bo'lishi mumkin — qaytadan oching.",
          errors: [
            {
              code: ErrorCode.RECEIVABLE_OVERPAYMENT,
              message: target.id,
              meta: { receivableId: target.id, attempted: part.toString() },
            },
          ],
        });
      }

      await tx.paymentAllocation.create({
        data: {
          organizationId: tenant.organizationId,
          paymentId: payment.id,
          receivableId: target.id,
          amount: part,
        },
      });

      allocations.push({
        receivableId: target.id,
        amount: part.toString(),
        status: part >= target.remaining ? 'PAID' : 'PARTIALLY_PAID',
      });
      left -= part;
    }

    // Over-payment is rejected, not absorbed (§12.5). Store credit is the
    // other reasonable answer and needs a credit balance, a redemption tender
    // and an expiry policy — none of which the design has.
    if (left > 0n) {
      throw new BusinessRuleException({
        code: ErrorCode.RECEIVABLE_OVERPAYMENT,
        detail: `To'lov qarzdan ${left} so'mga ko'p.`,
        errors: [
          {
            code: ErrorCode.RECEIVABLE_OVERPAYMENT,
            message: 'amount',
            meta: { excess: left.toString(), paid: dto.amount.toString() },
          },
        ],
      });
    }

    return { paymentId: payment.id, customerId, amount: dto.amount.toString(), allocations };
  }

  /** Explicit targets, or every open debt oldest-due first. */
  private async resolveTargets(tx: Tx, dto: DebtPaymentDto, customerId: string) {
    const rows = await tx.customerReceivable.findMany({
      where: {
        customerId,
        status: { in: [...OPEN_STATUSES] },
        ...(dto.receivableIds?.length ? { id: { in: dto.receivableIds } } : {}),
      },
      select: {
        id: true,
        originalAmount: true,
        paidAmount: true,
        writtenOffAmount: true,
      },
      orderBy: [{ dueDate: 'asc' }, { issuedAt: 'asc' }],
    });

    if (dto.receivableIds?.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = dto.receivableIds.filter((id) => !found.has(id));
      if (missing.length) {
        throw BusinessRuleException.notFound('Ochiq qarz', missing[0]);
      }
    }

    if (rows.length === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.NO_OPEN_RECEIVABLE,
        detail: "Bu mijozda ochiq qarz yo'q.",
      });
    }

    return rows.map((r) => ({
      id: r.id,
      remaining: r.originalAmount - r.paidAmount - r.writtenOffAmount,
    }));
  }

  /**
   * Writes a debt off — docs/ARCHITECTURE.md §12.6.
   *
   * Never netted into `paid_amount`: a write-off is a loss and a collection is
   * revenue, and a report that conflates them is a report that hides the
   * losses. The reason is mandatory in the database as well as here.
   */
  async writeOff(receivableId: string, dto: WriteOffDto, tenant: TenantContext) {
    const receivable = await this.prisma.db.customerReceivable.findFirst({
      where: { id: receivableId },
      select: {
        id: true,
        customerId: true,
        status: true,
        originalAmount: true,
        paidAmount: true,
        writtenOffAmount: true,
        note: true,
      },
    });
    if (!receivable) throw BusinessRuleException.notFound('Qarz', receivableId);

    const remaining =
      receivable.originalAmount - receivable.paidAmount - receivable.writtenOffAmount;
    if (remaining <= 0n) {
      throw new BusinessRuleException({
        code: ErrorCode.RECEIVABLE_CLOSED,
        detail: 'Bu qarzda qoldiq yo‘q.',
      });
    }

    const amount = dto.amount === undefined ? remaining : BigInt(dto.amount);
    if (amount > remaining) {
      throw new BusinessRuleException({
        code: ErrorCode.RECEIVABLE_OVERPAYMENT,
        detail: `Qoldiqdan ko'p hisobdan chiqarib bo'lmaydi: qolgan ${remaining}.`,
      });
    }

    const note = `${receivable.note ? `${receivable.note}\n` : ''}Hisobdan chiqarildi: ${dto.reason}`;

    const applied = await this.prisma.db.$executeRaw`
      UPDATE customer_receivable
         SET written_off_amount = written_off_amount + ${amount}::bigint,
             note   = ${note},
             status = CASE
               WHEN paid_amount + written_off_amount + ${amount}::bigint >= original_amount
                 THEN 'WRITTEN_OFF'::"ReceivableStatus"
               ELSE status
             END,
             closed_at = CASE
               WHEN paid_amount + written_off_amount + ${amount}::bigint >= original_amount
                 THEN now()
               ELSE closed_at
             END,
             updated_at = now()
       WHERE id = ${receivableId}::uuid
         AND organization_id = ${tenant.organizationId}::uuid
         AND paid_amount + written_off_amount + ${amount}::bigint <= original_amount
    `;

    if (applied === 0) {
      throw new BusinessRuleException({
        code: ErrorCode.RECEIVABLE_OVERPAYMENT,
        detail: "Qoldiq o'zgargan — qaytadan oching.",
      });
    }

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'debt.written_off',
      entityType: 'customer_receivable',
      entityId: receivableId,
      metadata: {
        customerId: receivable.customerId,
        amount: amount.toString(),
        reason: dto.reason,
        remainingBefore: remaining.toString(),
      },
    });

    return this.findOne(receivableId);
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * The UI's filters, as predicates — §12.3.
   *
   * All of them are served by
   * `ix_receivable_due (organization_id, due_date) WHERE status IN (…)`.
   */
  private filterPredicate(filter: ListDebtsDto['filter']): Prisma.CustomerReceivableWhereInput {
    const today = startOfToday();

    switch (filter) {
      case 'overdue':
        return { status: { in: [...OPEN_STATUSES] }, dueDate: { lt: today } };
      case 'due_today':
        return { status: { in: [...OPEN_STATUSES] }, dueDate: today };
      case 'due_soon':
        return {
          status: { in: [...OPEN_STATUSES] },
          dueDate: { gt: today, lte: addDays(today, 7) },
        };
      case 'unpaid':
        return { status: 'OPEN' };
      case 'partially_paid':
        return { status: 'PARTIALLY_PAID' };
      case 'paid':
        return { status: 'PAID' };
      case 'written_off':
        return { status: 'WRITTEN_OFF' };
      default:
        return {};
    }
  }

  private async requireCustomer(customerId: string) {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id: customerId },
      select: { id: true, fullName: true, archivedAt: true },
    });
    if (!customer) throw BusinessRuleException.notFound('Mijoz', customerId);
    return customer;
  }
}

const RECEIVABLE_FIELDS = {
  id: true,
  customerId: true,
  storeId: true,
  saleId: true,
  origin: true,
  originalAmount: true,
  paidAmount: true,
  writtenOffAmount: true,
  status: true,
  issuedAt: true,
  dueDate: true,
  closedAt: true,
  createdAt: true,
  customer: { select: { id: true, fullName: true, phone: true } },
  sale: { select: { id: true, saleNumber: true, completedAt: true } },
} as const;

interface ReceivableRow {
  originalAmount: bigint;
  paidAmount: bigint;
  writtenOffAmount: bigint;
  status: string;
  dueDate: Date;
  [key: string]: unknown;
}

/**
 * Serializes a receivable, deriving the two values that are not stored.
 *
 * `remainingAmount` is the subtraction, not a column — nothing stored is
 * nothing that can drift. `overdue` is likewise computed: it depends on
 * today's date, and a stored flag would be wrong every morning until some job
 * corrected it.
 */
function toReceivable(row: ReceivableRow) {
  const remaining = row.originalAmount - row.paidAmount - row.writtenOffAmount;
  const today = startOfToday();

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'bigint' ? value.toString() : value;
  }

  out['remainingAmount'] = remaining.toString();
  out['overdue'] = remaining > 0n && row.dueDate < today;
  out['daysOverdue'] =
    remaining > 0n && row.dueDate < today
      ? Math.floor((today.getTime() - row.dueDate.getTime()) / 86_400_000)
      : 0;

  return out;
}

/**
 * Midnight today, UTC.
 *
 * `due_date` is a DATE column, which PostgreSQL hands back as UTC midnight, so
 * the comparison has to be made against the same thing. Asia/Tashkent is
 * UTC+5 with no daylight saving, so "today" in the shop and "today" here
 * differ only between midnight and 05:00 — documented in §35 as the point to
 * revisit if a store ever trades through the night.
 */
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export function resolveDueDate(requested: string | undefined, defaultDays: number): Date {
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
  return addDays(startOfToday(), defaultDays);
}
