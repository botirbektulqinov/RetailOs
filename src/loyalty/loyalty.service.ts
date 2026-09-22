import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import { roundHalfUp } from '../common/money/money';
import type { Money } from '../common/money/money';
import type { TenantContext } from '../common/tenant/tenant-context';
import { PrismaService } from '../database/prisma.service';
import type { Tx } from '../database/prisma.service';
import type { AdjustPointsDto } from './dto/loyalty.dto';

/** Percent is stored with two decimals, so 1.00% is 100 hundredths of a percent. */
const PERCENT_SCALE = 10_000n;

export interface EarnInput {
  organizationId: string;
  customerId: string;
  saleId: string;
  /** Points are earned on the subtotal — the net of discounts (§17.2). */
  subtotal: Money;
  earnPercent: bigint;
  actorId: string;
}

export interface RedeemInput {
  organizationId: string;
  customerId: string;
  points: bigint;
  pointValue: bigint;
  actorId: string;
}

/**
 * Loyalty — docs/ARCHITECTURE.md §17.
 *
 * ```
 * LoyaltyAccount.points_balance   CACHE — convenient, never authoritative
 *   └── LoyaltyTransaction[]      APPEND-ONLY — the truth
 * ```
 *
 * The same projection-plus-ledger shape as inventory, for the same reason: a
 * balance nothing explains is a balance nobody can defend. The cache is only
 * ever written inside the transaction that writes the ledger row, so the two
 * cannot disagree, and `points_balance = SUM(points_delta)` is assertable at
 * any moment.
 *
 * **Redemption is a payment, not a discount** (§17.3). A discount reduces
 * revenue; a redemption settles revenue with a liability the store already
 * recognised when the points were earned. Treating it as a discount
 * understates revenue, corrupts margin, and hides the outstanding points
 * liability entirely.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────────────────────

  async balance(customerId: string) {
    await this.requireCustomer(customerId);

    const account = await this.prisma.db.loyaltyAccount.findFirst({
      where: { customerId },
      select: {
        id: true,
        pointsBalance: true,
        lifetimeEarned: true,
        lifetimeSpent: true,
        updatedAt: true,
      },
    });

    const settings = await this.prisma.db.organizationSettings.findFirst({
      where: {},
      select: { loyaltyEarnPercent: true, loyaltyPointValue: true },
    });

    const points = account?.pointsBalance ?? 0n;
    const pointValue = settings?.loyaltyPointValue ?? 1n;

    return {
      customerId,
      points: points.toString(),
      // What those points are worth at the till, so the POS can offer it
      // without knowing the conversion rule.
      redeemableAmount: (points * pointValue).toString(),
      lifetimeEarned: (account?.lifetimeEarned ?? 0n).toString(),
      lifetimeSpent: (account?.lifetimeSpent ?? 0n).toString(),
      earnPercent: (settings?.loyaltyEarnPercent ?? 0).toString(),
      pointValue: pointValue.toString(),
      updatedAt: account?.updatedAt ?? null,
    };
  }

  async history(customerId: string, limit: number, offset: number) {
    await this.requireCustomer(customerId);

    const account = await this.prisma.db.loyaltyAccount.findFirst({
      where: { customerId },
      select: { id: true },
    });
    if (!account) {
      return { data: [], page: { limit, offset, total: 0, hasMore: false } };
    }

    const where = { loyaltyAccountId: account.id };
    const [rows, total] = await Promise.all([
      this.prisma.db.loyaltyTransaction.findMany({
        where,
        select: {
          id: true,
          type: true,
          pointsDelta: true,
          balanceAfter: true,
          saleId: true,
          returnId: true,
          reason: true,
          createdBy: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.db.loyaltyTransaction.count({ where }),
    ]);

    return {
      data: rows.map((t) => ({
        ...t,
        pointsDelta: t.pointsDelta.toString(),
        balanceAfter: t.balanceAfter.toString(),
      })),
      page: { limit, offset, total, hasMore: offset + rows.length < total },
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // The write path
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Awards points for a completed sale.
   *
   * On `subtotal_amount` — the net of discounts — so cash rounding does not
   * leak into loyalty and a discounted sale does not also generate full points
   * (§17.2).
   *
   * Returns null when the organization earns nothing, so the caller writes no
   * row rather than a zero one the CHECK would reject anyway.
   */
  async earn(tx: Tx, input: EarnInput): Promise<bigint | null> {
    if (input.earnPercent <= 0n || input.subtotal <= 0n) return null;

    const points = roundHalfUp(input.subtotal * input.earnPercent, PERCENT_SCALE);
    if (points <= 0n) return null;

    await this.post(tx, {
      organizationId: input.organizationId,
      customerId: input.customerId,
      type: 'EARN',
      delta: points,
      saleId: input.saleId,
      actorId: input.actorId,
    });

    return points;
  }

  /**
   * Spends points. The caller records the matching `Payment` of method
   * `LOYALTY` — this method only moves the points.
   *
   * The guard is a conditional UPDATE bounded by the balance, so two tills
   * redeeming the same points at the same moment cannot both succeed.
   */
  async redeem(tx: Tx, input: RedeemInput): Promise<Money> {
    if (input.points <= 0n) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: "Ball miqdori musbat bo'lishi kerak.",
      });
    }

    await this.post(tx, {
      organizationId: input.organizationId,
      customerId: input.customerId,
      type: 'SPEND',
      delta: -input.points,
      actorId: input.actorId,
    });

    return input.points * input.pointValue;
  }

  /**
   * Claws back the points a returned sale earned, proportionally.
   *
   * Clamped at the balance: if the customer has already spent them, the
   * shortfall is recorded in `reason` rather than driving the balance
   * negative. Taking back points somebody already used is a policy decision,
   * not a default (§17.4).
   */
  async reverseForReturn(
    tx: Tx,
    input: {
      organizationId: string;
      customerId: string;
      saleId: string;
      returnId: string;
      /** The share of the sale's subtotal being returned. */
      refundShare: Money;
      saleSubtotal: Money;
      actorId: string;
    },
  ): Promise<bigint | null> {
    if (input.refundShare <= 0n || input.saleSubtotal <= 0n) return null;

    const earned = await tx.loyaltyTransaction.findFirst({
      where: { saleId: input.saleId, type: 'EARN' },
      select: { pointsDelta: true, loyaltyAccountId: true },
    });
    if (!earned) return null;

    const toReverse = roundHalfUp(earned.pointsDelta * input.refundShare, input.saleSubtotal);
    if (toReverse <= 0n) return null;

    const account = await tx.loyaltyAccount.findFirst({
      where: { id: earned.loyaltyAccountId },
      select: { id: true, pointsBalance: true },
    });
    if (!account) return null;

    const clamped = toReverse > account.pointsBalance ? account.pointsBalance : toReverse;
    if (clamped <= 0n) return null;

    const shortfall = toReverse - clamped;
    await this.post(tx, {
      organizationId: input.organizationId,
      customerId: input.customerId,
      type: 'ADJUSTMENT',
      delta: -clamped,
      returnId: input.returnId,
      reason:
        shortfall > 0n
          ? `Qaytarish uchun ballar qaytarildi; ${shortfall} ball allaqachon sarflangan`
          : 'Qaytarish uchun ballar qaytarildi',
      actorId: input.actorId,
    });

    return clamped;
  }

  /** A manual correction. Requires `loyalty.adjust` and a reason. */
  async adjust(customerId: string, dto: AdjustPointsDto, tenant: TenantContext) {
    await this.requireCustomer(customerId);

    const delta = BigInt(dto.points);
    if (delta === 0n) {
      throw new BusinessRuleException({
        code: ErrorCode.VALIDATION_FAILED,
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: 'Nol ballni tuzatib bo‘lmaydi.',
      });
    }

    await this.prisma.db.$transaction((tx) =>
      this.post(tx, {
        organizationId: tenant.organizationId,
        customerId,
        type: 'ADJUSTMENT',
        delta,
        reason: dto.reason,
        actorId: tenant.userId,
      }),
    );

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'loyalty.adjusted',
      entityType: 'loyalty_account',
      entityId: customerId,
      metadata: { customerId, points: dto.points, reason: dto.reason },
    });

    return this.balance(customerId);
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * The single write path for points.
   *
   * Mirrors `InventoryService.apply()`: one conditional UPDATE that both
   * mutates the cached balance and guards it, then one append-only ledger row
   * carrying the balance that resulted. Zero rows affected means the balance
   * would have gone negative — points that were never earned cannot be spent.
   */
  private async post(
    tx: Tx,
    cmd: {
      organizationId: string;
      customerId: string;
      type: 'EARN' | 'SPEND' | 'ADJUSTMENT' | 'EXPIRY';
      delta: bigint;
      saleId?: string;
      returnId?: string;
      reason?: string;
      actorId: string;
    },
  ): Promise<bigint> {
    // Ensure the account exists, at zero. ON CONFLICT DO NOTHING rather than
    // read-then-insert, so two first-ever earns cannot race on the index.
    await tx.$executeRaw`
      INSERT INTO loyalty_account
        (id, organization_id, customer_id, points_balance, lifetime_earned, lifetime_spent,
         created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${cmd.organizationId}::uuid, ${cmd.customerId}::uuid, 0, 0, 0,
         now(), now())
      ON CONFLICT (customer_id) DO NOTHING
    `;

    const updated = await tx.$queryRaw<Array<{ id: string; points_balance: bigint }>>`
      UPDATE loyalty_account
         SET points_balance  = points_balance + ${cmd.delta}::bigint,
             lifetime_earned = lifetime_earned
               + CASE WHEN ${cmd.delta}::bigint > 0 THEN ${cmd.delta}::bigint ELSE 0 END,
             lifetime_spent  = lifetime_spent
               + CASE WHEN ${cmd.delta}::bigint < 0 THEN -${cmd.delta}::bigint ELSE 0 END,
             updated_at      = now()
       WHERE customer_id = ${cmd.customerId}::uuid
         AND organization_id = ${cmd.organizationId}::uuid
         AND points_balance + ${cmd.delta}::bigint >= 0
      RETURNING id, points_balance
    `;

    const account = updated[0];
    if (!account) {
      const current = await tx.loyaltyAccount.findFirst({
        where: { customerId: cmd.customerId },
        select: { pointsBalance: true },
      });
      throw new BusinessRuleException({
        code: ErrorCode.INSUFFICIENT_POINTS,
        detail: `Ball yetarli emas: mavjud ${current?.pointsBalance ?? 0n}, so'ralgan ${-cmd.delta}.`,
        errors: [
          {
            code: ErrorCode.INSUFFICIENT_POINTS,
            message: cmd.customerId,
            meta: {
              available: (current?.pointsBalance ?? 0n).toString(),
              requested: (-cmd.delta).toString(),
            },
          },
        ],
      });
    }

    await tx.loyaltyTransaction.create({
      data: {
        organizationId: cmd.organizationId,
        loyaltyAccountId: account.id,
        type: cmd.type,
        pointsDelta: cmd.delta,
        balanceAfter: account.points_balance,
        saleId: cmd.saleId ?? null,
        returnId: cmd.returnId ?? null,
        reason: cmd.reason ?? null,
        createdBy: cmd.actorId,
      },
    });

    return account.points_balance;
  }

  private async requireCustomer(customerId: string) {
    const customer = await this.prisma.db.customer.findFirst({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw BusinessRuleException.notFound('Mijoz', customerId);
    return customer;
  }
}
