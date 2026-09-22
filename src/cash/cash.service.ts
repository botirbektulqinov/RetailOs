import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { nextDocumentNumber } from '../common/document-number';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { Tx } from '../database/prisma.service';
import type {
  CashMovementDto,
  CloseShiftDto,
  CreateRegisterDto,
  ListShiftsDto,
  OpenShiftDto,
  UpdateRegisterDto,
} from './dto/cash.dto';

const REGISTER_FIELDS = {
  id: true,
  storeId: true,
  code: true,
  name: true,
  status: true,
  archivedAt: true,
  createdAt: true,
} as const;

interface Breakdown {
  opening: bigint;
  cashIn: bigint;
  cashOut: bigint;
  movementsIn: bigint;
  movementsOut: bigint;
  supplierPaid: bigint;
  expected: bigint;
}

/**
 * The cash drawer — docs/ARCHITECTURE.md §19.
 *
 * The drawer is not a stored number. It is the arithmetic over a shift's own
 * payments and movements, computed when asked:
 *
 * ```
 * expected = opening
 *          + cash payments IN  − cash payments OUT
 *          + cash movements IN − cash movements OUT
 *          − cash supplier payments
 * ```
 *
 * The same reasoning as stock, debt and points: a running balance is a number
 * that drifts from the events it summarises. The one exception is at close,
 * where the figure IS stored — a Z-report reprinted next month must show what
 * the cashier was asked to sign for, not what a later correction would now
 * produce. A CHECK keeps the stored difference consistent with its inputs.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Registers
  // ────────────────────────────────────────────────────────────────────────

  async listRegisters(storeId?: string) {
    const where: Prisma.CashRegisterWhereInput = {
      archivedAt: null,
      ...(storeId ? { storeId } : {}),
    };

    const rows = await this.prisma.db.cashRegister.findMany({
      where,
      select: {
        ...REGISTER_FIELDS,
        store: { select: { id: true, code: true, name: true } },
        shifts: {
          where: { status: 'OPEN' },
          select: { id: true, shiftNumber: true, openedBy: true, openedAt: true },
          take: 1,
        },
      },
      orderBy: { code: 'asc' },
    });

    return {
      data: rows.map(({ shifts, ...register }) => ({
        ...register,
        // The one thing a POS needs to know before it can sell for cash.
        openShift: shifts[0] ?? null,
      })),
    };
  }

  async createRegister(dto: CreateRegisterDto, tenant: TenantContext) {
    await this.requireStore(dto.storeId ?? tenant.storeId);

    const created = await this.prisma.db.cashRegister
      .create({
        data: {
          organizationId: tenant.organizationId,
          storeId: dto.storeId ?? tenant.storeId,
          code: dto.code.trim().toUpperCase(),
          name: dto.name.trim(),
        },
        select: REGISTER_FIELDS,
      })
      .catch(rethrowDuplicate);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'cash_register.created',
      entityType: 'cash_register',
      entityId: created.id,
      metadata: { code: created.code, name: created.name, storeId: created.storeId },
    });

    return created;
  }

  async updateRegister(registerId: string, dto: UpdateRegisterDto, tenant: TenantContext) {
    await this.requireRegister(registerId);

    return this.prisma.db.cashRegister
      .update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: registerId } },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.trim().toUpperCase() } : {}),
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        },
        select: REGISTER_FIELDS,
      })
      .catch(rethrowDuplicate);
  }

  /**
   * Archived, never deleted: every shift ever opened names this register.
   * A register with a shift still open cannot be archived — the drawer would
   * become unreachable with money notionally in it.
   */
  async archiveRegister(registerId: string, tenant: TenantContext) {
    const register = await this.requireRegister(registerId);

    const open = await this.prisma.db.cashRegisterShift.count({
      where: { cashRegisterId: registerId, status: 'OPEN' },
    });
    if (open > 0) {
      throw new BusinessRuleException({
        code: ErrorCode.SHIFT_STILL_OPEN,
        detail: "Ochiq smenasi bor kassani arxivlab bo'lmaydi.",
      });
    }

    const archived = await this.prisma.db.cashRegister.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: registerId } },
      data: { archivedAt: new Date(), status: 'INACTIVE' },
      select: REGISTER_FIELDS,
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'cash_register.archived',
      entityType: 'cash_register',
      entityId: registerId,
      metadata: { code: register.code },
    });

    return archived;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shifts
  // ────────────────────────────────────────────────────────────────────────

  async listShifts(query: ListShiftsDto) {
    const where: Prisma.CashRegisterShiftWhereInput = {
      ...(query.registerId ? { cashRegisterId: query.registerId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.openedBy ? { openedBy: query.openedBy } : {}),
      ...(query.dateFrom || query.dateTo
        ? {
            openedAt: {
              ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
              ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.db.cashRegisterShift.findMany({
        where,
        select: {
          id: true,
          shiftNumber: true,
          status: true,
          storeId: true,
          openingAmount: true,
          expectedCashAmount: true,
          countedCashAmount: true,
          differenceAmount: true,
          openedBy: true,
          openedAt: true,
          closedBy: true,
          closedAt: true,
          register: { select: { id: true, code: true, name: true } },
        },
        orderBy: { openedAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.db.cashRegisterShift.count({ where }),
    ]);

    return {
      data: rows.map(serializeShift),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  /**
   * Opens a shift.
   *
   * The concurrency control is `uq_one_open_shift_per_register`, not a check
   * in this method: two cashiers tapping "open" at once both pass any
   * application-level test, and only the index stops the second.
   */
  async open(dto: OpenShiftDto, tenant: TenantContext) {
    const register = await this.requireRegister(dto.registerId);

    const shift = await this.prisma.db
      .$transaction(async (tx) => {
        const shiftNumber = await nextDocumentNumber(tx, {
          organizationId: tenant.organizationId,
          storeId: register.storeId,
          documentType: 'SHIFT',
          prefix: 'SH',
        });

        return tx.cashRegisterShift.create({
          data: {
            organizationId: tenant.organizationId,
            storeId: register.storeId,
            cashRegisterId: register.id,
            shiftNumber,
            status: 'OPEN',
            openingAmount: BigInt(dto.openingAmount),
            openedBy: tenant.userId,
            note: dto.note ?? null,
          },
          select: { id: true, shiftNumber: true },
        });
      })
      .catch(rethrowOpenShift);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: register.storeId,
      actorUserId: tenant.userId,
      action: 'shift.opened',
      entityType: 'cash_register_shift',
      entityId: shift.id,
      metadata: {
        shiftNumber: shift.shiftNumber,
        registerId: register.id,
        openingAmount: dto.openingAmount,
      },
    });

    return this.report(shift.id);
  }

  /**
   * Records a manual drawer movement.
   *
   * Sales, refunds and debt collections are NOT recorded here — they are
   * `payment` rows and the expected-cash arithmetic already reads them.
   * Recording them twice would double-count every soʻm.
   */
  async movement(shiftId: string, dto: CashMovementDto, tenant: TenantContext) {
    const shift = await this.requireOpenShift(shiftId);

    const amount = BigInt(dto.amount);

    // A payout cannot take more than the drawer holds. The check reads the
    // live figure rather than a cached one, because the drawer moves with
    // every sale.
    if (dto.direction === 'OUT') {
      const { expected } = await this.breakdown(this.prisma.db, shiftId, shift.openingAmount);
      if (amount > expected) {
        throw new BusinessRuleException({
          code: ErrorCode.INSUFFICIENT_CASH_IN_DRAWER,
          detail: `Kassada yetarli naqd yo'q: mavjud ${expected}, so'ralgan ${amount}.`,
          errors: [
            {
              code: ErrorCode.INSUFFICIENT_CASH_IN_DRAWER,
              message: shift.shiftNumber,
              meta: { available: expected.toString(), requested: amount.toString() },
            },
          ],
        });
      }
    }

    const created = await this.prisma.db.cashMovement.create({
      data: {
        organizationId: tenant.organizationId,
        storeId: shift.storeId,
        cashRegisterShiftId: shiftId,
        direction: dto.direction,
        type: dto.type,
        amount,
        reason: dto.reason.trim(),
        createdBy: tenant.userId,
      },
      select: {
        id: true,
        direction: true,
        type: true,
        amount: true,
        reason: true,
        createdAt: true,
      },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: shift.storeId,
      actorUserId: tenant.userId,
      action: 'cash.movement_recorded',
      entityType: 'cash_movement',
      entityId: created.id,
      metadata: {
        shiftNumber: shift.shiftNumber,
        direction: dto.direction,
        type: dto.type,
        amount: dto.amount,
        reason: dto.reason,
      },
    });

    return { ...created, amount: created.amount.toString() };
  }

  /**
   * Closes a shift — docs/ARCHITECTURE.md §19.4.
   *
   * `FOR UPDATE` rather than a conditional UPDATE, which is what every other
   * state transition in this system uses. The close has to read a large
   * aggregate and then write a consistent snapshot of it; a conditional update
   * could claim the row but not stop the aggregate moving underneath it. The
   * row lock holds for the few milliseconds the arithmetic takes, and shift
   * closes are rare — this is the one place where a pessimistic lock is the
   * simpler correct answer.
   */
  async close(shiftId: string, dto: CloseShiftDto, tenant: TenantContext) {
    const result = await this.prisma.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          opening_amount: bigint;
          shift_number: string;
          store_id: string;
        }>
      >`
        SELECT id, status, opening_amount, shift_number, store_id
          FROM cash_register_shift
         WHERE id = ${shiftId}::uuid
           AND organization_id = ${tenant.organizationId}::uuid
         FOR UPDATE
      `;

      const shift = locked[0];
      if (!shift) throw BusinessRuleException.notFound('Smena', shiftId);
      if (shift.status !== 'OPEN') {
        throw new BusinessRuleException({
          code: ErrorCode.SHIFT_ALREADY_CLOSED,
          detail: 'Bu smena allaqachon yopilgan.',
        });
      }

      // A draft left on the shift means money the Z-report cannot account for.
      const drafts = await tx.sale.count({
        where: { cashRegisterShiftId: shiftId, status: 'DRAFT' },
      });
      if (drafts > 0) {
        throw new BusinessRuleException({
          code: ErrorCode.OPEN_DRAFTS_EXIST,
          detail: `Smenada ${drafts} ta yakunlanmagan savdo bor.`,
        });
      }

      const breakdown = await this.breakdown(tx, shiftId, shift.opening_amount);
      const counted = BigInt(dto.countedCashAmount);
      const difference = counted - breakdown.expected;

      await tx.cashRegisterShift.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: shiftId } },
        data: {
          status: 'CLOSED',
          expectedCashAmount: breakdown.expected,
          countedCashAmount: counted,
          differenceAmount: difference,
          closedBy: tenant.userId,
          closedAt: new Date(),
          ...(dto.note ? { note: dto.note } : {}),
        },
      });

      return { shift, breakdown, counted, difference };
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: result.shift.store_id,
      actorUserId: tenant.userId,
      action: 'shift.closed',
      entityType: 'cash_register_shift',
      entityId: shiftId,
      // The whole breakdown, so the close is reproducible from the audit trail
      // alone even if the shift row is later read with different code.
      metadata: {
        shiftNumber: result.shift.shift_number,
        opening: result.breakdown.opening.toString(),
        cashIn: result.breakdown.cashIn.toString(),
        cashOut: result.breakdown.cashOut.toString(),
        movementsIn: result.breakdown.movementsIn.toString(),
        movementsOut: result.breakdown.movementsOut.toString(),
        supplierPaid: result.breakdown.supplierPaid.toString(),
        expected: result.breakdown.expected.toString(),
        counted: result.counted.toString(),
        difference: result.difference.toString(),
      },
    });

    return this.report(shiftId);
  }

  /**
   * The Z-report — §19.5.
   *
   * Every number is a query over the shift's own payments, sales and
   * movements. Nothing is precomputed: a shift's data is small, and a stale
   * report is worse than a slow one.
   */
  async report(shiftId: string) {
    const shift = await this.prisma.db.cashRegisterShift.findFirst({
      where: { id: shiftId },
      select: {
        id: true,
        shiftNumber: true,
        status: true,
        storeId: true,
        openingAmount: true,
        expectedCashAmount: true,
        countedCashAmount: true,
        differenceAmount: true,
        openedBy: true,
        openedAt: true,
        closedBy: true,
        closedAt: true,
        note: true,
        register: { select: { id: true, code: true, name: true } },
      },
    });
    if (!shift) throw BusinessRuleException.notFound('Smena', shiftId);

    const [sales, tenders, movements, breakdown] = await Promise.all([
      this.prisma.db.sale.aggregate({
        where: { cashRegisterShiftId: shiftId, status: 'COMPLETED' },
        _count: { _all: true },
        _sum: { totalAmount: true, creditAmount: true, costAmount: true },
      }),
      this.prisma.db.payment.groupBy({
        by: ['method', 'direction'],
        where: { cashRegisterShiftId: shiftId, status: 'COMPLETED' },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.db.cashMovement.findMany({
        where: { cashRegisterShiftId: shiftId },
        select: {
          id: true,
          direction: true,
          type: true,
          amount: true,
          reason: true,
          createdBy: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.breakdown(this.prisma.db, shiftId, shift.openingAmount),
    ]);

    return {
      ...serializeShift(shift),
      note: shift.note,
      sales: {
        count: sales._count._all,
        gross: (sales._sum.totalAmount ?? 0n).toString(),
        credit: (sales._sum.creditAmount ?? 0n).toString(),
        cost: (sales._sum.costAmount ?? 0n).toString(),
        margin: ((sales._sum.totalAmount ?? 0n) - (sales._sum.costAmount ?? 0n)).toString(),
      },
      // Every method, not only cash: the card total is exactly what the
      // manager reconciles against the terminal's own end-of-day.
      tenders: tenders.map((t) => ({
        method: t.method,
        direction: t.direction,
        count: t._count._all,
        amount: (t._sum.amount ?? 0n).toString(),
      })),
      movements: movements.map((m) => ({ ...m, amount: m.amount.toString() })),
      drawer: {
        opening: breakdown.opening.toString(),
        cashSales: breakdown.cashIn.toString(),
        cashRefunds: breakdown.cashOut.toString(),
        cashIn: breakdown.movementsIn.toString(),
        cashOut: breakdown.movementsOut.toString(),
        supplierPaid: breakdown.supplierPaid.toString(),
        // Live while the shift is open; the stored figure once it is closed,
        // because that is the number the cashier signed for.
        expected: (shift.expectedCashAmount ?? breakdown.expected).toString(),
        counted: shift.countedCashAmount?.toString() ?? null,
        difference: shift.differenceAmount?.toString() ?? null,
      },
    };
  }

  /** The open shift for a store, if any — the POS asks before it sells. */
  async currentShift(storeId: string) {
    const shift = await this.prisma.db.cashRegisterShift.findFirst({
      where: { storeId, status: 'OPEN' },
      select: { id: true },
      orderBy: { openedAt: 'desc' },
    });
    return shift ? this.report(shift.id) : null;
  }

  /**
   * Resolves the shift a sale or payment should be attached to.
   *
   * Called by checkout and by debt collection. Returns null when the store
   * runs no shift, which is allowed: a shop that does not open a till still
   * sells, and the Z-report is then about the shifts that did happen.
   */
  async openShiftIdFor(tx: Tx, storeId: string): Promise<string | null> {
    const shift = await tx.cashRegisterShift.findFirst({
      where: { storeId, status: 'OPEN' },
      select: { id: true },
      orderBy: { openedAt: 'desc' },
    });
    return shift?.id ?? null;
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * Expected cash — §19.3, in one round trip.
   *
   * Five aggregates in one statement rather than five queries: this runs on
   * every drawer read and at every close, and the query planner does the same
   * work either way.
   *
   * Every sum is cast to `::bigint`. PostgreSQL widens SUM() over a BIGINT
   * column to NUMERIC, which the driver hands back as a STRING — and
   * `200000n + "0"` is not 200000n, it is the string "2000000". Without the
   * cast every drawer figure would be silently wrong by a factor of ten per
   * term, which is exactly what the first run of this suite reported.
   */
  private async breakdown(
    client: Tx | PrismaService['db'],
    shiftId: string,
    opening: bigint,
  ): Promise<Breakdown> {
    const [row] = await client.$queryRaw<
      Array<{
        cash_in: bigint;
        cash_out: bigint;
        movements_in: bigint;
        movements_out: bigint;
        supplier_paid: bigint;
      }>
    >`
      SELECT
        COALESCE((SELECT SUM(amount) FROM payment
                   WHERE cash_register_shift_id = ${shiftId}::uuid
                     AND method = 'CASH' AND direction = 'IN'
                     AND status = 'COMPLETED'), 0)::bigint AS cash_in,
        COALESCE((SELECT SUM(amount) FROM payment
                   WHERE cash_register_shift_id = ${shiftId}::uuid
                     AND method = 'CASH' AND direction = 'OUT'
                     AND status = 'COMPLETED'), 0)::bigint AS cash_out,
        COALESCE((SELECT SUM(amount) FROM cash_movement
                   WHERE cash_register_shift_id = ${shiftId}::uuid
                     AND direction = 'IN'), 0)::bigint AS movements_in,
        COALESCE((SELECT SUM(amount) FROM cash_movement
                   WHERE cash_register_shift_id = ${shiftId}::uuid
                     AND direction = 'OUT'), 0)::bigint AS movements_out,
        COALESCE((SELECT SUM(amount) FROM supplier_payment
                   WHERE cash_register_shift_id = ${shiftId}::uuid
                     AND method = 'CASH'), 0)::bigint AS supplier_paid
    `;

    const cashIn = row?.cash_in ?? 0n;
    const cashOut = row?.cash_out ?? 0n;
    const movementsIn = row?.movements_in ?? 0n;
    const movementsOut = row?.movements_out ?? 0n;
    const supplierPaid = row?.supplier_paid ?? 0n;

    return {
      opening,
      cashIn,
      cashOut,
      movementsIn,
      movementsOut,
      supplierPaid,
      expected: opening + cashIn - cashOut + movementsIn - movementsOut - supplierPaid,
    };
  }

  private async requireRegister(registerId: string) {
    const register = await this.prisma.db.cashRegister.findFirst({
      where: { id: registerId },
      select: { id: true, code: true, storeId: true, archivedAt: true },
    });
    if (!register) throw BusinessRuleException.notFound('Kassa', registerId);
    if (register.archivedAt) {
      throw new BusinessRuleException({
        code: ErrorCode.REGISTER_ARCHIVED,
        detail: 'Arxivlangan kassada smena ochilmaydi.',
      });
    }
    return register;
  }

  private async requireOpenShift(shiftId: string) {
    const shift = await this.prisma.db.cashRegisterShift.findFirst({
      where: { id: shiftId },
      select: {
        id: true,
        status: true,
        storeId: true,
        shiftNumber: true,
        openingAmount: true,
      },
    });
    if (!shift) throw BusinessRuleException.notFound('Smena', shiftId);
    if (shift.status !== 'OPEN') {
      throw new BusinessRuleException({
        code: ErrorCode.SHIFT_ALREADY_CLOSED,
        detail: 'Bu smena yopilgan.',
      });
    }
    return shift;
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

interface ShiftRow {
  openingAmount: bigint;
  expectedCashAmount: bigint | null;
  countedCashAmount: bigint | null;
  differenceAmount: bigint | null;
  [key: string]: unknown;
}

function serializeShift(row: ShiftRow) {
  return {
    ...row,
    openingAmount: row.openingAmount.toString(),
    expectedCashAmount: row.expectedCashAmount?.toString() ?? null,
    countedCashAmount: row.countedCashAmount?.toString() ?? null,
    differenceAmount: row.differenceAmount?.toString() ?? null,
  };
}

/** uq_one_open_shift_per_register — the database refused, and it was right. */
function rethrowOpenShift(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.SHIFT_ALREADY_OPEN,
      status: HttpStatus.CONFLICT,
      detail: 'Bu kassada ochiq smena allaqachon bor.',
    });
  }
  throw error;
}

function rethrowDuplicate(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new BusinessRuleException({
      code: ErrorCode.DUPLICATE_RESOURCE,
      detail: 'Bu kod bilan kassa allaqachon mavjud.',
    });
  }
  throw error;
}
