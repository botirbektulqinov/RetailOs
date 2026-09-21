import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type {
  AddNoteDto,
  CreateCustomerDto,
  CreateGroupDto,
  ListCustomersDto,
  UpdateCustomerDto,
  UpdateGroupDto,
} from './dto/customer.dto';

const CUSTOMER_FIELDS = {
  id: true,
  customerGroupId: true,
  fullName: true,
  phone: true,
  email: true,
  address: true,
  birthDate: true,
  creditLimit: true,
  status: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface CustomerRow {
  customer_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  birth_date: Date | null;
  credit_limit: string | null;
  group_id: string | null;
  group_name: string | null;
  group_credit_limit: string | null;
  archived_at: Date | null;
  created_at: Date;
  outstanding: string;
  overdue_amount: string;
  open_debts: number;
  sales_count: number;
  sales_total: string;
  last_sale_at: Date | null;
}

/**
 * Customers and groups — docs/ARCHITECTURE.md §5.8.
 *
 * The list is hand-written SQL for one reason: a customer's debt is
 * `SUM(remaining)` over their open receivables, and sorting or filtering by it
 * means the aggregate has to happen in the database. Fetching a page of
 * customers and then a debt per customer is the N+1 that turns a 50-row screen
 * into 51 queries, and it cannot sort by debt at all.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListCustomersDto, tenant: TenantContext) {
    const filters: Prisma.Sql[] = [];
    if (!query.includeArchived) filters.push(Prisma.sql`AND c.archived_at IS NULL`);
    if (query.customerGroupId)
      filters.push(Prisma.sql`AND c.customer_group_id = ${query.customerGroupId}::uuid`);
    if (query.q) {
      const like = `%${query.q.trim()}%`;
      filters.push(Prisma.sql`AND (c.full_name ILIKE ${like} OR c.phone ILIKE ${like})`);
    }
    const where = filters.length ? Prisma.join(filters, ' ') : Prisma.empty;

    const having = query.overdue
      ? Prisma.sql`HAVING COALESCE(SUM(r.original_amount - r.paid_amount - r.written_off_amount)
                     FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')
                               AND r.due_date < CURRENT_DATE), 0) > 0`
      : query.hasDebt
        ? Prisma.sql`HAVING COALESCE(SUM(r.original_amount - r.paid_amount - r.written_off_amount)
                       FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')), 0) > 0`
        : Prisma.empty;

    const [field = 'name', direction = 'asc'] = (query.sort ?? 'name:asc').split(':');
    const desc = direction.toLowerCase() === 'desc';
    const order =
      // By the numeric expression, not the `outstanding` alias: that alias is
      // cast to text for the JSON response, and ordering text puts "90000"
      // above "150000".
      field === 'debt'
        ? desc
          ? Prisma.sql`ORDER BY COALESCE(SUM(r.original_amount - r.paid_amount
              - r.written_off_amount) FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')), 0) DESC`
          : Prisma.sql`ORDER BY COALESCE(SUM(r.original_amount - r.paid_amount
              - r.written_off_amount) FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')), 0) ASC`
        : field === 'createdAt'
          ? desc
            ? Prisma.sql`ORDER BY c.created_at DESC`
            : Prisma.sql`ORDER BY c.created_at ASC`
          : desc
            ? Prisma.sql`ORDER BY c.full_name DESC`
            : Prisma.sql`ORDER BY c.full_name ASC`;

    const rows = await this.prisma.db.$queryRaw<CustomerRow[]>`
      SELECT c.id                    AS customer_id,
             c.full_name, c.phone, c.email, c.address, c.birth_date,
             c.credit_limit::text    AS credit_limit,
             c.archived_at, c.created_at,
             g.id                    AS group_id,
             g.name                  AS group_name,
             g.credit_limit::text    AS group_credit_limit,
             COALESCE(SUM(r.original_amount - r.paid_amount - r.written_off_amount)
               FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')), 0)::text AS outstanding,
             COALESCE(SUM(r.original_amount - r.paid_amount - r.written_off_amount)
               FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')
                         AND r.due_date < CURRENT_DATE), 0)::text             AS overdue_amount,
             count(r.id) FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID'))::int AS open_debts,
             COALESCE(s.sales_count, 0)::int  AS sales_count,
             COALESCE(s.sales_total, 0)::text AS sales_total,
             s.last_sale_at
        FROM customer c
        LEFT JOIN customer_group g ON g.id = c.customer_group_id
        LEFT JOIN customer_receivable r ON r.customer_id = c.id
        LEFT JOIN LATERAL (
          SELECT count(*) AS sales_count,
                 SUM(sa.total_amount) AS sales_total,
                 max(sa.completed_at) AS last_sale_at
            FROM sale sa
           WHERE sa.customer_id = c.id AND sa.status = 'COMPLETED'
        ) s ON true
       WHERE c.organization_id = ${tenant.organizationId}::uuid
         ${where}
       GROUP BY c.id, g.id, s.sales_count, s.sales_total, s.last_sale_at
      ${having}
      ${order}
       LIMIT ${query.limit} OFFSET ${query.offset}
    `;

    const counted = await this.prisma.db.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total FROM (
        SELECT c.id
          FROM customer c
          LEFT JOIN customer_receivable r ON r.customer_id = c.id
         WHERE c.organization_id = ${tenant.organizationId}::uuid
           ${where}
         GROUP BY c.id
        ${having}
      ) t
    `;

    const totals = await this.prisma.db.$queryRaw<
      Array<{ customers: number; outstanding: string; overdue: string }>
    >`
      SELECT count(DISTINCT c.id)::int AS customers,
             COALESCE(SUM(r.original_amount - r.paid_amount - r.written_off_amount)
               FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')), 0)::text AS outstanding,
             COALESCE(SUM(r.original_amount - r.paid_amount - r.written_off_amount)
               FILTER (WHERE r.status IN ('OPEN','PARTIALLY_PAID')
                         AND r.due_date < CURRENT_DATE), 0)::text             AS overdue
        FROM customer c
        LEFT JOIN customer_receivable r ON r.customer_id = c.id
       WHERE c.organization_id = ${tenant.organizationId}::uuid
         AND c.archived_at IS NULL
    `;

    const total = counted[0]?.total ?? 0;

    return {
      data: rows.map(toCustomerListItem),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
      summary: {
        customers: totals[0]?.customers ?? 0,
        outstanding: totals[0]?.outstanding ?? '0',
        overdue: totals[0]?.overdue ?? '0',
      },
    };
  }

  /** The customer card: profile, effective credit limit, balance and notes. */
  async findOne(customerId: string) {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id: customerId },
      select: {
        ...CUSTOMER_FIELDS,
        group: { select: { id: true, name: true, discountPercent: true, creditLimit: true } },
        notes: {
          select: { id: true, body: true, createdBy: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!customer) throw BusinessRuleException.notFound('Mijoz', customerId);

    const balance = await this.balanceOf(customerId);
    const { notes, group, ...rest } = customer;

    return {
      ...rest,
      creditLimit: customer.creditLimit?.toString() ?? null,
      group: group
        ? {
            id: group.id,
            name: group.name,
            discountPercent: group.discountPercent.toString(),
            creditLimit: group.creditLimit?.toString() ?? null,
          }
        : null,
      // Resolution order: the customer's own limit, else the group's, else
      // unlimited. Stated on the response because a cashier refused at the
      // counter needs to know which number stopped them.
      effectiveCreditLimit: (customer.creditLimit ?? group?.creditLimit)?.toString() ?? null,
      balance,
      notes,
    };
  }

  /**
   * The balance, derived from the receivables every time.
   *
   * There is no cached total. If this ever becomes slow it becomes a
   * materialized view, not a mutable column — a column would need updating in
   * every transaction that touches a debt, and the one that forgets is the one
   * nobody notices.
   */
  async balanceOf(customerId: string) {
    const [row] = await this.prisma.db.$queryRaw<
      Array<{
        outstanding: string;
        overdue: string;
        original: string;
        paid: string;
        written_off: string;
        open_debts: number;
        overdue_debts: number;
        next_due: Date | null;
      }>
    >`
      SELECT COALESCE(SUM(original_amount - paid_amount - written_off_amount)
               FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID')), 0)::text AS outstanding,
             COALESCE(SUM(original_amount - paid_amount - written_off_amount)
               FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID')
                         AND due_date < CURRENT_DATE), 0)::text             AS overdue,
             COALESCE(SUM(original_amount), 0)::text                        AS original,
             COALESCE(SUM(paid_amount), 0)::text                            AS paid,
             COALESCE(SUM(written_off_amount), 0)::text                     AS written_off,
             count(*) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID'))::int AS open_debts,
             count(*) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID')
                                AND due_date < CURRENT_DATE)::int            AS overdue_debts,
             min(due_date) FILTER (WHERE status IN ('OPEN','PARTIALLY_PAID')) AS next_due
        FROM customer_receivable
       WHERE customer_id = ${customerId}::uuid
    `;

    return {
      outstanding: row?.outstanding ?? '0',
      overdue: row?.overdue ?? '0',
      lifetimeDebt: row?.original ?? '0',
      lifetimePaid: row?.paid ?? '0',
      lifetimeWrittenOff: row?.written_off ?? '0',
      openDebts: row?.open_debts ?? 0,
      overdueDebts: row?.overdue_debts ?? 0,
      nextDueDate: row?.next_due ?? null,
    };
  }

  /** What this customer bought. Paged, because a regular has hundreds. */
  async sales(customerId: string, limit: number, offset: number) {
    await this.requireCustomer(customerId);

    const where: Prisma.SaleWhereInput = { customerId };
    const [rows, total] = await Promise.all([
      this.prisma.db.sale.findMany({
        where,
        select: {
          id: true,
          saleNumber: true,
          status: true,
          totalAmount: true,
          paidAmount: true,
          creditAmount: true,
          completedAt: true,
          _count: { select: { items: true } },
        },
        orderBy: { completedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.db.sale.count({ where }),
    ]);

    return {
      data: rows.map(({ _count, ...sale }) => ({
        ...sale,
        totalAmount: sale.totalAmount.toString(),
        paidAmount: sale.paidAmount.toString(),
        creditAmount: sale.creditAmount.toString(),
        lineCount: _count.items,
      })),
      page: { limit, offset, total, hasMore: offset + rows.length < total },
    };
  }

  /** Every payment this customer has made, whatever it settled. */
  async payments(customerId: string, limit: number, offset: number) {
    await this.requireCustomer(customerId);

    const where: Prisma.PaymentWhereInput = { customerId };
    const [rows, total] = await Promise.all([
      this.prisma.db.payment.findMany({
        where,
        select: {
          id: true,
          direction: true,
          method: true,
          amount: true,
          status: true,
          note: true,
          createdAt: true,
          allocations: {
            select: { amount: true, saleId: true, receivableId: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.db.payment.count({ where }),
    ]);

    return {
      data: rows.map((p) => ({
        id: p.id,
        direction: p.direction,
        method: p.method,
        amount: p.amount.toString(),
        status: p.status,
        note: p.note,
        createdAt: p.createdAt,
        settled: p.allocations.map((a) => ({
          amount: a.amount.toString(),
          saleId: a.saleId,
          receivableId: a.receivableId,
        })),
      })),
      page: { limit, offset, total, hasMore: offset + rows.length < total },
    };
  }

  async create(dto: CreateCustomerDto, tenant: TenantContext) {
    if (dto.customerGroupId) await this.requireGroup(dto.customerGroupId);

    const created = await this.prisma.db.customer
      .create({
        data: {
          organizationId: tenant.organizationId,
          customerGroupId: dto.customerGroupId ?? null,
          fullName: dto.fullName.trim(),
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          address: dto.address ?? null,
          birthDate: dto.birthDate ? new Date(dto.birthDate) : null,
          creditLimit: dto.creditLimit === undefined ? null : BigInt(dto.creditLimit),
          createdBy: tenant.userId,
          ...(dto.note
            ? {
                notes: {
                  create: {
                    organizationId: tenant.organizationId,
                    body: dto.note,
                    createdBy: tenant.userId,
                  },
                },
              }
            : {}),
        },
        select: { id: true, fullName: true, phone: true },
      })
      .catch(rethrowDuplicatePhone);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'customer.created',
      entityType: 'customer',
      entityId: created.id,
      metadata: { fullName: created.fullName, phone: created.phone },
    });

    return this.findOne(created.id);
  }

  async update(customerId: string, dto: UpdateCustomerDto, tenant: TenantContext) {
    await this.requireCustomer(customerId);
    if (dto.customerGroupId) await this.requireGroup(dto.customerGroupId);

    await this.prisma.db.customer
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: customerId } },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName.trim() } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.birthDate !== undefined
            ? { birthDate: dto.birthDate ? new Date(dto.birthDate) : null }
            : {}),
          ...(dto.customerGroupId !== undefined ? { customerGroupId: dto.customerGroupId } : {}),
          ...(dto.creditLimit !== undefined
            ? { creditLimit: dto.creditLimit === null ? null : BigInt(dto.creditLimit) }
            : {}),
        },
      })
      .catch(rethrowDuplicatePhone);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'customer.updated',
      entityType: 'customer',
      entityId: customerId,
      metadata: { changed: Object.keys(dto) },
    });

    return this.findOne(customerId);
  }

  /**
   * Archived, never deleted: their sales and receivables name them forever,
   * and those foreign keys are ON DELETE RESTRICT.
   *
   * A customer who still owes money cannot be archived. Hiding a debtor is how
   * a debt stops being collected without anybody deciding to stop collecting.
   */
  async archive(customerId: string, tenant: TenantContext) {
    const customer = await this.requireCustomer(customerId);
    const balance = await this.balanceOf(customerId);

    if (BigInt(balance.outstanding) > 0n) {
      throw new BusinessRuleException({
        code: ErrorCode.CUSTOMER_HAS_DEBT,
        detail: `${customer.fullName} hali ${balance.outstanding} so'm qarzdor. Avval qarzni yoping yoki hisobdan chiqaring.`,
        errors: [
          {
            code: ErrorCode.CUSTOMER_HAS_DEBT,
            message: customer.fullName,
            meta: { outstanding: balance.outstanding, openDebts: balance.openDebts },
          },
        ],
      });
    }

    await this.prisma.db.customer.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: customerId } },
      data: { archivedAt: new Date(), status: 'INACTIVE' },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'customer.archived',
      entityType: 'customer',
      entityId: customerId,
      metadata: { fullName: customer.fullName },
    });

    return this.findOne(customerId);
  }

  async restore(customerId: string, tenant: TenantContext) {
    await this.requireCustomer(customerId);

    await this.prisma.db.customer
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: customerId } },
        data: { archivedAt: null, status: 'ACTIVE' },
      })
      .catch(rethrowDuplicatePhone);

    return this.findOne(customerId);
  }

  async addNote(customerId: string, dto: AddNoteDto, tenant: TenantContext) {
    await this.requireCustomer(customerId);

    const note = await this.prisma.db.customerNote.create({
      data: {
        organizationId: tenant.organizationId,
        customerId,
        body: dto.body.trim(),
        createdBy: tenant.userId,
      },
      select: { id: true, body: true, createdBy: true, createdAt: true },
    });

    return note;
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  async listGroups() {
    const rows = await this.prisma.db.customerGroup.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        description: true,
        discountPercent: true,
        creditLimit: true,
        createdAt: true,
        _count: { select: { customers: true } },
      },
      orderBy: { name: 'asc' },
    });

    return {
      data: rows.map(({ _count, ...g }) => ({
        ...g,
        discountPercent: g.discountPercent.toString(),
        creditLimit: g.creditLimit?.toString() ?? null,
        customerCount: _count.customers,
      })),
    };
  }

  async createGroup(dto: CreateGroupDto, tenant: TenantContext) {
    const created = await this.prisma.db.customerGroup
      .create({
        data: {
          organizationId: tenant.organizationId,
          name: dto.name.trim(),
          description: dto.description ?? null,
          discountPercent: (dto.discountPercent ?? 0).toFixed(2),
          creditLimit: dto.creditLimit === undefined ? null : BigInt(dto.creditLimit),
        },
        select: { id: true, name: true },
      })
      .catch(rethrowDuplicateGroup);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'customer_group.created',
      entityType: 'customer_group',
      entityId: created.id,
      metadata: { name: created.name, discountPercent: dto.discountPercent ?? 0 },
    });

    return created;
  }

  async updateGroup(groupId: string, dto: UpdateGroupDto, tenant: TenantContext) {
    await this.requireGroup(groupId);

    const updated = await this.prisma.db.customerGroup
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: groupId } },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.discountPercent !== undefined
            ? { discountPercent: dto.discountPercent.toFixed(2) }
            : {}),
          ...(dto.creditLimit !== undefined
            ? { creditLimit: dto.creditLimit === null ? null : BigInt(dto.creditLimit) }
            : {}),
        },
        select: { id: true, name: true, discountPercent: true, creditLimit: true },
      })
      .catch(rethrowDuplicateGroup);

    return {
      ...updated,
      discountPercent: updated.discountPercent.toString(),
      creditLimit: updated.creditLimit?.toString() ?? null,
    };
  }

  // ────────────────────────────────────────────────────────────────────────

  private async requireCustomer(customerId: string) {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id: customerId },
      select: { id: true, fullName: true, archivedAt: true },
    });
    if (!customer) throw BusinessRuleException.notFound('Mijoz', customerId);
    return customer;
  }

  private async requireGroup(groupId: string) {
    const group = await this.prisma.db.customerGroup.findFirst({
      where: { id: groupId, archivedAt: null },
      select: { id: true },
    });
    if (!group) throw BusinessRuleException.notFound('Mijozlar guruhi', groupId);
    return group;
  }
}

function toCustomerListItem(row: CustomerRow) {
  return {
    id: row.customer_id,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    birthDate: row.birth_date,
    creditLimit: row.credit_limit,
    effectiveCreditLimit: row.credit_limit ?? row.group_credit_limit,
    group: row.group_id ? { id: row.group_id, name: row.group_name } : null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    balance: {
      outstanding: row.outstanding,
      overdue: row.overdue_amount,
      openDebts: row.open_debts,
    },
    history: {
      salesCount: row.sales_count,
      salesTotal: row.sales_total,
      lastSaleAt: row.last_sale_at,
    },
  };
}

function rethrowDuplicatePhone(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.PHONE_ALREADY_USED,
      detail: 'Bu telefon raqami bilan mijoz allaqachon mavjud.',
    });
  }
  throw error;
}

function rethrowDuplicateGroup(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.DUPLICATE_RESOURCE,
      detail: 'Bu nom bilan guruh allaqachon mavjud.',
    });
  }
  throw error;
}
