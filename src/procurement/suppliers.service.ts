import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { Tx } from '../database/prisma.service';
import type {
  CreateSupplierDto,
  ListSuppliersDto,
  SupplierPaymentDto,
  UpdateSupplierDto,
} from './dto/purchase.dto';

/** Statuses that represent a real commitment to pay. */
const PAYABLE_STATUSES = "('ORDERED','PARTIALLY_RECEIVED','RECEIVED')";

interface SupplierRow {
  supplier_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  payment_term_days: number;
  archived_at: Date | null;
  created_at: Date;
  invoiced: string;
  paid_on_invoices: string;
  unapplied: string;
  open_purchases: number;
}

/**
 * Suppliers and payables — docs/ARCHITECTURE.md §16.
 *
 * A supplier's balance is derived, never stored. It is
 * `SUM(total − paid)` over their committed purchases, less any payment made on
 * account that is not attached to an invoice. A mutable `supplier.balance`
 * column is a number that can silently disagree with its own history — the
 * same reasoning as customer debt.
 *
 * `SupplierPayment` is deliberately a different table from the customer
 * `Payment` (§15.4). They look symmetrical and are not: direction, targets,
 * till association, permissions, reporting and volume all differ, and unifying
 * them would cost four conditionals to avoid one small table.
 */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListSuppliersDto, tenant: TenantContext) {
    const filters: Prisma.Sql[] = [];
    if (!query.includeArchived) filters.push(Prisma.sql`AND s.archived_at IS NULL`);
    if (query.q) {
      const like = `%${query.q.trim()}%`;
      filters.push(
        Prisma.sql`AND (s.name ILIKE ${like} OR s.phone ILIKE ${like}
                        OR s.contact_name ILIKE ${like})`,
      );
    }
    const where = filters.length ? Prisma.join(filters, ' ') : Prisma.empty;

    const having = query.hasPayable
      ? Prisma.sql`HAVING COALESCE(SUM(p.total_amount - p.paid_amount)
                     FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}), 0)
                   - COALESCE(MAX(u.unapplied), 0) > 0`
      : Prisma.empty;

    const [field = 'name', direction = 'asc'] = (query.sort ?? 'name:asc').split(':');
    const desc = direction.toLowerCase() === 'desc';
    const order =
      field === 'payable'
        ? // By the numeric expression, not the text alias: ordering text would
          // put "900000" above "1500000". And by the SAME expression the
          // filter and the response use — subtracting the unapplied credit —
          // or a supplier we have paid in advance sorts as though we still
          // owed the full invoice.
          desc
          ? Prisma.sql`ORDER BY COALESCE(SUM(p.total_amount - p.paid_amount)
              FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}), 0)
              - COALESCE(MAX(u.unapplied), 0) DESC`
          : Prisma.sql`ORDER BY COALESCE(SUM(p.total_amount - p.paid_amount)
              FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}), 0)
              - COALESCE(MAX(u.unapplied), 0) ASC`
        : desc
          ? Prisma.sql`ORDER BY s.name DESC`
          : Prisma.sql`ORDER BY s.name ASC`;

    const rows = await this.prisma.db.$queryRaw<SupplierRow[]>`
      SELECT s.id AS supplier_id, s.name, s.contact_name, s.phone, s.email, s.address,
             s.payment_term_days, s.archived_at, s.created_at,
             COALESCE(SUM(p.total_amount)
               FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}), 0)::text AS invoiced,
             COALESCE(SUM(p.paid_amount)
               FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}), 0)::text
               AS paid_on_invoices,
             COALESCE(MAX(u.unapplied), 0)::text AS unapplied,
             count(p.id) FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}
                                   AND p.paid_amount < p.total_amount)::int AS open_purchases
        FROM supplier s
        LEFT JOIN purchase p ON p.supplier_id = s.id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(sp.amount), 0) AS unapplied
            FROM supplier_payment sp
           WHERE sp.supplier_id = s.id AND sp.purchase_id IS NULL
        ) u ON true
       WHERE s.organization_id = ${tenant.organizationId}::uuid
         ${where}
       GROUP BY s.id, u.unapplied
      ${having}
      ${order}
       LIMIT ${query.limit} OFFSET ${query.offset}
    `;

    const counted = await this.prisma.db.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total FROM (
        SELECT s.id
          FROM supplier s
          LEFT JOIN purchase p ON p.supplier_id = s.id
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(sp.amount), 0) AS unapplied
              FROM supplier_payment sp
             WHERE sp.supplier_id = s.id AND sp.purchase_id IS NULL
          ) u ON true
         WHERE s.organization_id = ${tenant.organizationId}::uuid
           ${where}
         GROUP BY s.id, u.unapplied
        ${having}
      ) t
    `;

    const total = counted[0]?.total ?? 0;

    return {
      data: rows.map(toSupplierListItem),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  async findOne(supplierId: string) {
    const supplier = await this.prisma.db.supplier.findFirst({
      where: { id: supplierId },
      select: {
        id: true,
        name: true,
        contactName: true,
        phone: true,
        email: true,
        address: true,
        notes: true,
        paymentTermDays: true,
        status: true,
        archivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!supplier) throw BusinessRuleException.notFound("Ta'minotchi", supplierId);

    return { ...supplier, balance: await this.balanceOf(supplierId) };
  }

  /**
   * What we owe this supplier.
   *
   * `invoiced − paidOnInvoices` is the outstanding on documents; an
   * on-account payment reduces the net payable without being attached to any
   * one of them, so it is subtracted separately and reported as unapplied
   * credit. A shopkeeper who has paid in advance should see that, not a
   * balance that silently absorbed it.
   */
  async balanceOf(supplierId: string) {
    const [row] = await this.prisma.db.$queryRaw<
      Array<{
        invoiced: string;
        paid_on_invoices: string;
        unapplied: string;
        open_purchases: number;
        lifetime_paid: string;
      }>
    >`
      SELECT COALESCE(SUM(p.total_amount)
               FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}), 0)::text AS invoiced,
             COALESCE(SUM(p.paid_amount)
               FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}), 0)::text
               AS paid_on_invoices,
             COALESCE((SELECT SUM(amount) FROM supplier_payment
                        WHERE supplier_id = ${supplierId}::uuid AND purchase_id IS NULL), 0)::text
               AS unapplied,
             count(p.id) FILTER (WHERE p.status IN ${Prisma.raw(PAYABLE_STATUSES)}
                                   AND p.paid_amount < p.total_amount)::int AS open_purchases,
             COALESCE((SELECT SUM(amount) FROM supplier_payment
                        WHERE supplier_id = ${supplierId}::uuid), 0)::text AS lifetime_paid
        FROM purchase p
       WHERE p.supplier_id = ${supplierId}::uuid
    `;

    const invoiced = BigInt(row?.invoiced ?? '0');
    const paid = BigInt(row?.paid_on_invoices ?? '0');
    const unapplied = BigInt(row?.unapplied ?? '0');

    return {
      invoiced: invoiced.toString(),
      paidOnInvoices: paid.toString(),
      unappliedCredit: unapplied.toString(),
      payable: (invoiced - paid - unapplied).toString(),
      openPurchases: row?.open_purchases ?? 0,
      lifetimePaid: row?.lifetime_paid ?? '0',
    };
  }

  /**
   * A chronological statement: purchases as debits, payments as credits, with
   * a running balance. Built on demand from one UNION ALL — no table backs it.
   */
  async statement(supplierId: string, from?: string, to?: string) {
    await this.requireSupplier(supplierId);

    const fromDate = from ? new Date(from) : new Date(0);
    const toDate = to ? new Date(to) : new Date('2999-12-31');

    const rows = await this.prisma.db.$queryRaw<
      Array<{
        at: Date;
        kind: string;
        reference: string;
        debit: string;
        credit: string;
        id: string;
      }>
    >`
      SELECT p.created_at AS at, 'PURCHASE' AS kind, p.purchase_number AS reference,
             p.total_amount::text AS debit, '0' AS credit, p.id::text AS id
        FROM purchase p
       WHERE p.supplier_id = ${supplierId}::uuid
         AND p.status IN ${Prisma.raw(PAYABLE_STATUSES)}
         AND p.created_at BETWEEN ${fromDate} AND ${toDate}
      UNION ALL
      SELECT sp.paid_at AS at, 'PAYMENT' AS kind,
             COALESCE(sp.reference, sp.method::text) AS reference,
             '0' AS debit, sp.amount::text AS credit, sp.id::text AS id
        FROM supplier_payment sp
       WHERE sp.supplier_id = ${supplierId}::uuid
         AND sp.paid_at BETWEEN ${fromDate} AND ${toDate}
       ORDER BY at ASC
    `;

    let running = 0n;
    const entries = rows.map((row) => {
      running += BigInt(row.debit) - BigInt(row.credit);
      return {
        id: row.id,
        at: row.at,
        kind: row.kind,
        reference: row.reference,
        debit: row.debit,
        credit: row.credit,
        balance: running.toString(),
      };
    });

    return {
      supplierId,
      from: from ?? null,
      to: to ?? null,
      entries,
      closingBalance: running.toString(),
    };
  }

  async create(dto: CreateSupplierDto, tenant: TenantContext) {
    const created = await this.prisma.db.supplier
      .create({
        data: {
          organizationId: tenant.organizationId,
          name: dto.name.trim(),
          contactName: dto.contactName ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          address: dto.address ?? null,
          notes: dto.notes ?? null,
          paymentTermDays: dto.paymentTermDays ?? 0,
          createdBy: tenant.userId,
        },
        select: { id: true, name: true },
      })
      .catch(rethrowDuplicateName);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'supplier.created',
      entityType: 'supplier',
      entityId: created.id,
      metadata: { name: created.name },
    });

    return this.findOne(created.id);
  }

  async update(supplierId: string, dto: UpdateSupplierDto, tenant: TenantContext) {
    await this.requireSupplier(supplierId);

    await this.prisma.db.supplier
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: supplierId } },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.contactName !== undefined ? { contactName: dto.contactName } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.paymentTermDays !== undefined ? { paymentTermDays: dto.paymentTermDays } : {}),
        },
      })
      .catch(rethrowDuplicateName);

    return this.findOne(supplierId);
  }

  /**
   * Archived, never deleted — every purchase names them.
   *
   * A supplier we still owe cannot be archived, for the same reason a customer
   * who owes us cannot: hiding the row is how an obligation stops being
   * tracked without anybody deciding to stop tracking it.
   */
  async archive(supplierId: string, tenant: TenantContext) {
    const supplier = await this.requireSupplier(supplierId);
    const balance = await this.balanceOf(supplierId);

    if (BigInt(balance.payable) > 0n) {
      throw new BusinessRuleException({
        code: ErrorCode.SUPPLIER_HAS_PAYABLE,
        detail: `${supplier.name} ga hali ${balance.payable} so'm qarzdormiz.`,
        errors: [
          {
            code: ErrorCode.SUPPLIER_HAS_PAYABLE,
            message: supplier.name,
            meta: { payable: balance.payable, openPurchases: balance.openPurchases },
          },
        ],
      });
    }

    await this.prisma.db.supplier.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: supplierId } },
      data: { archivedAt: new Date(), status: 'INACTIVE' },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'supplier.archived',
      entityType: 'supplier',
      entityId: supplierId,
      metadata: { name: supplier.name },
    });

    return this.findOne(supplierId);
  }

  async restore(supplierId: string, tenant: TenantContext) {
    await this.requireSupplier(supplierId);
    await this.prisma.db.supplier
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: supplierId } },
        data: { archivedAt: null, status: 'ACTIVE' },
      })
      .catch(rethrowDuplicateName);
    return this.findOne(supplierId);
  }

  /**
   * Records a payment to a supplier.
   *
   * With `purchaseId`, it settles that invoice under a guard bounded by its
   * total — two people paying the same invoice cannot together overpay it.
   * Without one, it is a payment on account: it reduces the net payable and is
   * reported as unapplied credit.
   *
   * There is deliberately no "apply this on-account payment to that invoice
   * later" endpoint. `supplier_payment` is append-only — money that has left
   * the business is not editable — so applying it would mean rewriting a
   * payment record. The statement already shows both sides; attaching them
   * afterwards is bookkeeping the design does not ask for.
   */
  async pay(dto: SupplierPaymentDto, tenant: TenantContext, idempotencyKey: string) {
    const supplier = await this.requireSupplier(dto.supplierId);

    const { result, replayed } = await this.idempotency.run(
      {
        organizationId: tenant.organizationId,
        key: idempotencyKey,
        endpoint: 'POST /suppliers/payments',
        body: dto,
        status: HttpStatus.CREATED,
      },
      (tx) => this.writePayment(tx, dto, tenant, supplier.id, idempotencyKey),
    );

    if (!replayed) {
      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'supplier.payment_recorded',
        entityType: 'supplier_payment',
        entityId: result.paymentId,
        metadata: {
          supplierId: supplier.id,
          supplierName: supplier.name,
          amount: dto.amount,
          method: dto.method,
          purchaseId: dto.purchaseId ?? null,
        },
      });
    }

    return { ...result, replayed };
  }

  private async writePayment(
    tx: Tx,
    dto: SupplierPaymentDto,
    tenant: TenantContext,
    supplierId: string,
    idempotencyKey: string,
  ) {
    const amount = BigInt(dto.amount);

    if (dto.purchaseId) {
      const purchase = await tx.purchase.findFirst({
        where: { id: dto.purchaseId, supplierId },
        select: { id: true, purchaseNumber: true, totalAmount: true, paidAmount: true },
      });
      if (!purchase) throw BusinessRuleException.notFound('Xarid', dto.purchaseId);

      // The conditional UPDATE is the concurrency control: two managers
      // settling the same invoice cannot together push it past its total.
      const applied = await tx.$executeRaw`
        UPDATE purchase
           SET paid_amount = paid_amount + ${amount}::bigint, updated_at = now()
         WHERE id = ${dto.purchaseId}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
           AND paid_amount + ${amount}::bigint <= total_amount
      `;

      if (applied === 0) {
        const remaining = purchase.totalAmount - purchase.paidAmount;
        throw new BusinessRuleException({
          code: ErrorCode.SUPPLIER_OVERPAYMENT,
          detail: `Xariddan ortiq to'lov: qolgan ${remaining}.`,
          errors: [
            {
              code: ErrorCode.SUPPLIER_OVERPAYMENT,
              message: purchase.purchaseNumber,
              meta: { remaining: remaining.toString(), attempted: amount.toString() },
            },
          ],
        });
      }
    }

    const payment = await tx.supplierPayment.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        supplierId,
        purchaseId: dto.purchaseId ?? null,
        method: dto.method,
        amount,
        reference: dto.reference ?? null,
        note: dto.note ?? null,
        createdBy: tenant.userId,
        idempotencyKey,
      },
      select: { id: true, paidAt: true },
    });

    return {
      paymentId: payment.id,
      supplierId,
      purchaseId: dto.purchaseId ?? null,
      amount: amount.toString(),
      method: dto.method,
      paidAt: payment.paidAt,
      applied: dto.purchaseId !== undefined,
    };
  }

  async payments(supplierId: string, limit: number, offset: number) {
    await this.requireSupplier(supplierId);

    const where = { supplierId };
    const [rows, total] = await Promise.all([
      this.prisma.db.supplierPayment.findMany({
        where,
        select: {
          id: true,
          amount: true,
          method: true,
          reference: true,
          note: true,
          paidAt: true,
          createdBy: true,
          purchase: { select: { id: true, purchaseNumber: true } },
        },
        orderBy: { paidAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.db.supplierPayment.count({ where }),
    ]);

    return {
      data: rows.map((p) => ({ ...p, amount: p.amount.toString() })),
      page: { limit, offset, total, hasMore: offset + rows.length < total },
    };
  }

  private async requireSupplier(supplierId: string) {
    const supplier = await this.prisma.db.supplier.findFirst({
      where: { id: supplierId },
      select: { id: true, name: true, archivedAt: true },
    });
    if (!supplier) throw BusinessRuleException.notFound("Ta'minotchi", supplierId);
    return supplier;
  }
}

function toSupplierListItem(row: SupplierRow) {
  const invoiced = BigInt(row.invoiced);
  const paid = BigInt(row.paid_on_invoices);
  const unapplied = BigInt(row.unapplied);

  return {
    id: row.supplier_id,
    name: row.name,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    paymentTermDays: row.payment_term_days,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    balance: {
      invoiced: invoiced.toString(),
      paidOnInvoices: paid.toString(),
      unappliedCredit: unapplied.toString(),
      payable: (invoiced - paid - unapplied).toString(),
      openPurchases: row.open_purchases,
    },
  };
}

function rethrowDuplicateName(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.DUPLICATE_RESOURCE,
      detail: "Bu nom bilan ta'minotchi allaqachon mavjud.",
    });
  }
  throw error;
}
