import { percentOf } from '../common/money/money';
import type { Money } from '../common/money/money';

/**
 * Promotion resolution — docs/ARCHITECTURE.md §18.2 and §18.3.
 *
 * Pure functions, like the pricing pipeline they feed. Nothing here reads a
 * database or a clock: eligibility is decided from a snapshot the caller
 * already loaded, so the whole rule set is testable in a millisecond.
 *
 * **Promotions do not stack.** At each level exactly one wins, chosen by
 * `priority DESC, computed value DESC`. Stacking needs a combinability matrix,
 * an application order, and an answer for what "20% off plus 10,000 off" means
 * applied the other way round — none of which is specified, and inventing it
 * produces a system where the cashier cannot predict the price.
 */

export interface PromotionRule {
  id: string;
  name: string;
  type: 'PERCENT_OFF' | 'FIXED_OFF';
  scope: 'ITEM' | 'ORDER';
  /** Percent x 100 for PERCENT_OFF (12.5% is 1250), minor units for FIXED_OFF. */
  value: bigint;
  minSubtotal: bigint | null;
  maxDiscount: bigint | null;
  appliesTo: 'ALL' | 'CATEGORY' | 'PRODUCT';
  categoryIds: readonly string[];
  productIds: readonly string[];
  customerGroupIds: readonly string[];
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  priority: number;
  maxUses: number | null;
  usedCount: number;
}

export interface PromotionContext {
  /** null for a walk-in. */
  customerGroupId: string | null;
  at: Date;
}

export interface LineTarget {
  productId: string;
  categoryId: string | null;
  /** The line's gross, which a PERCENT_OFF applies to. */
  gross: Money;
}

export interface ResolvedDiscount {
  promotionId: string;
  promotionName: string;
  amount: Money;
}

/**
 * Is this promotion live and available to this customer?
 *
 * The date window is checked against the caller's `at` rather than `new Date()`
 * so a checkout that spans midnight prices consistently, and so the rule is
 * testable without mocking the clock.
 */
export function isEligible(rule: PromotionRule, context: PromotionContext): boolean {
  if (!rule.isActive) return false;
  if (rule.startsAt > context.at) return false;
  if (rule.endsAt !== null && rule.endsAt <= context.at) return false;
  if (rule.maxUses !== null && rule.usedCount >= rule.maxUses) return false;

  // A promotion aimed at groups is not a promotion for walk-ins.
  if (rule.customerGroupIds.length > 0) {
    if (!context.customerGroupId) return false;
    if (!rule.customerGroupIds.includes(context.customerGroupId)) return false;
  }

  return true;
}

/** Does this promotion apply to this particular line? */
export function matchesLine(rule: PromotionRule, line: LineTarget): boolean {
  switch (rule.appliesTo) {
    case 'CATEGORY':
      return line.categoryId !== null && rule.categoryIds.includes(line.categoryId);
    case 'PRODUCT':
      return rule.productIds.includes(line.productId);
    default:
      return true;
  }
}

/**
 * What this promotion is worth against a base amount.
 *
 * A percentage rounds once, here, and is capped by `maxDiscount` — "20% off"
 * on a large basket should not become an unbounded giveaway. A fixed amount is
 * capped at the base, because a discount may take a line to zero and never
 * below it.
 */
export function valueOf(rule: PromotionRule, base: Money): Money {
  if (base <= 0n) return 0n;

  const raw = rule.type === 'PERCENT_OFF' ? percentOf(base, rule.value) : rule.value;
  const capped = rule.maxDiscount !== null && raw > rule.maxDiscount ? rule.maxDiscount : raw;
  return capped > base ? base : capped;
}

/**
 * The single winner among candidates — §18.3.
 *
 * `priority DESC, value DESC`. A deliberate tie-break on value means two
 * equal-priority campaigns resolve to the one the customer would prefer, which
 * is the only answer that does not need explaining at the counter.
 */
export function bestOf(
  candidates: readonly { rule: PromotionRule; amount: Money }[],
): ResolvedDiscount | null {
  let winner: { rule: PromotionRule; amount: Money } | null = null;

  for (const candidate of candidates) {
    if (candidate.amount <= 0n) continue;
    if (
      winner === null ||
      candidate.rule.priority > winner.rule.priority ||
      (candidate.rule.priority === winner.rule.priority && candidate.amount > winner.amount)
    ) {
      winner = candidate;
    }
  }

  return winner
    ? { promotionId: winner.rule.id, promotionName: winner.rule.name, amount: winner.amount }
    : null;
}

/**
 * The best ITEM promotion for one line, or null.
 *
 * A manual line discount competes with this and the larger wins (§18.2 step 2)
 * — resolved by the caller, which is the only place that knows whether the
 * cashier was allowed to grant one.
 */
export function bestItemDiscount(
  rules: readonly PromotionRule[],
  line: LineTarget,
  context: PromotionContext,
): ResolvedDiscount | null {
  return bestOf(
    rules
      .filter((r) => r.scope === 'ITEM' && isEligible(r, context) && matchesLine(r, line))
      .map((rule) => ({ rule, amount: valueOf(rule, line.gross) })),
  );
}

/**
 * The best ORDER promotion for the basket, or null.
 *
 * `minSubtotal` is checked against the subtotal AFTER line discounts, because
 * that is what the customer is actually spending.
 */
export function bestOrderDiscount(
  rules: readonly PromotionRule[],
  subtotal: Money,
  context: PromotionContext,
): ResolvedDiscount | null {
  return bestOf(
    rules
      .filter(
        (r) =>
          r.scope === 'ORDER' &&
          isEligible(r, context) &&
          (r.minSubtotal === null || subtotal >= r.minSubtotal),
      )
      .map((rule) => ({ rule, amount: valueOf(rule, subtotal) })),
  );
}

/**
 * The customer group's standing percentage, as an order-level candidate.
 *
 * It competes with ORDER promotions and the manual discount rather than
 * stacking on them, because a VIP who also gets a campaign should get the
 * better of the two and not both (§18.3).
 */
export function groupDiscount(
  percentCentis: bigint,
  subtotal: Money,
  groupName: string,
): ResolvedDiscount | null {
  if (percentCentis <= 0n || subtotal <= 0n) return null;
  const amount = percentOf(subtotal, percentCentis);
  return amount > 0n
    ? { promotionId: '', promotionName: `${groupName} guruh chegirmasi`, amount }
    : null;
}
