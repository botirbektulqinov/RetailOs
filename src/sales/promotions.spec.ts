import {
  bestItemDiscount,
  bestOf,
  bestOrderDiscount,
  groupDiscount,
  isEligible,
  matchesLine,
  valueOf,
} from './promotions';
import type { PromotionContext, PromotionRule } from './promotions';

const NOW = new Date('2026-06-15T10:00:00Z');
const CONTEXT: PromotionContext = { customerGroupId: null, at: NOW };

const rule = (over: Partial<PromotionRule> = {}): PromotionRule => ({
  id: 'p1',
  name: 'Yozgi aksiya',
  type: 'PERCENT_OFF',
  scope: 'ITEM',
  value: 1000n, // 10.00%
  minSubtotal: null,
  maxDiscount: null,
  appliesTo: 'ALL',
  categoryIds: [],
  productIds: [],
  customerGroupIds: [],
  startsAt: new Date('2026-06-01T00:00:00Z'),
  endsAt: new Date('2026-07-01T00:00:00Z'),
  isActive: true,
  priority: 0,
  maxUses: null,
  usedCount: 0,
  ...over,
});

describe('isEligible', () => {
  it('accepts a live promotion inside its window', () => {
    expect(isEligible(rule(), CONTEXT)).toBe(true);
  });

  it('rejects one that has not started, has ended, or is switched off', () => {
    expect(isEligible(rule({ startsAt: new Date('2026-07-01T00:00:00Z') }), CONTEXT)).toBe(false);
    expect(isEligible(rule({ endsAt: new Date('2026-06-01T00:00:00Z') }), CONTEXT)).toBe(false);
    expect(isEligible(rule({ isActive: false }), CONTEXT)).toBe(false);
  });

  it('treats a null end date as open-ended', () => {
    expect(isEligible(rule({ endsAt: null }), CONTEXT)).toBe(true);
  });

  it('rejects one that has run out of uses', () => {
    expect(isEligible(rule({ maxUses: 100, usedCount: 100 }), CONTEXT)).toBe(false);
    expect(isEligible(rule({ maxUses: 100, usedCount: 99 }), CONTEXT)).toBe(true);
  });

  it('keeps a group promotion away from walk-ins and from other groups', () => {
    const vipOnly = rule({ customerGroupIds: ['vip'] });
    expect(isEligible(vipOnly, CONTEXT)).toBe(false);
    expect(isEligible(vipOnly, { customerGroupId: 'regular', at: NOW })).toBe(false);
    expect(isEligible(vipOnly, { customerGroupId: 'vip', at: NOW })).toBe(true);
  });
});

describe('matchesLine', () => {
  const line = { productId: 'prod', categoryId: 'cat', gross: 100_000n };

  it('ALL matches anything', () => {
    expect(matchesLine(rule(), line)).toBe(true);
  });

  it('CATEGORY matches only its categories', () => {
    expect(matchesLine(rule({ appliesTo: 'CATEGORY', categoryIds: ['cat'] }), line)).toBe(true);
    expect(matchesLine(rule({ appliesTo: 'CATEGORY', categoryIds: ['other'] }), line)).toBe(false);
  });

  it('CATEGORY never matches an uncategorised product', () => {
    expect(
      matchesLine(rule({ appliesTo: 'CATEGORY', categoryIds: ['cat'] }), {
        ...line,
        categoryId: null,
      }),
    ).toBe(false);
  });

  it('PRODUCT matches only its products', () => {
    expect(matchesLine(rule({ appliesTo: 'PRODUCT', productIds: ['prod'] }), line)).toBe(true);
    expect(matchesLine(rule({ appliesTo: 'PRODUCT', productIds: ['nope'] }), line)).toBe(false);
  });
});

describe('valueOf', () => {
  it('rounds a percentage once', () => {
    expect(valueOf(rule({ value: 1250n }), 99_999n)).toBe(12_500n);
  });

  it('caps a percentage at maxDiscount', () => {
    expect(valueOf(rule({ value: 2000n, maxDiscount: 5_000n }), 100_000n)).toBe(5_000n);
  });

  it('caps any discount at the base — never negative', () => {
    expect(valueOf(rule({ type: 'FIXED_OFF', value: 999_000n }), 10_000n)).toBe(10_000n);
  });

  it('is zero against a base of zero', () => {
    expect(valueOf(rule(), 0n)).toBe(0n);
  });
});

describe('bestOf — promotions do not stack', () => {
  it('picks the higher priority even when it is worth less', () => {
    const winner = bestOf([
      { rule: rule({ id: 'low', priority: 0 }), amount: 50_000n },
      { rule: rule({ id: 'high', priority: 5 }), amount: 10_000n },
    ]);
    expect(winner!.promotionId).toBe('high');
  });

  it('breaks a priority tie on the larger amount', () => {
    const winner = bestOf([
      { rule: rule({ id: 'small', priority: 1 }), amount: 10_000n },
      { rule: rule({ id: 'big', priority: 1 }), amount: 40_000n },
    ]);
    expect(winner!.promotionId).toBe('big');
  });

  it('ignores candidates worth nothing', () => {
    expect(bestOf([{ rule: rule(), amount: 0n }])).toBeNull();
    expect(bestOf([])).toBeNull();
  });
});

describe('bestItemDiscount', () => {
  const line = { productId: 'prod', categoryId: 'cat', gross: 100_000n };

  it('finds the best applicable ITEM promotion', () => {
    const result = bestItemDiscount(
      [
        rule({ id: 'a', value: 1000n }),
        rule({ id: 'b', value: 2500n }),
        rule({ id: 'order', scope: 'ORDER', value: 9000n }),
        rule({ id: 'expired', value: 9000n, isActive: false }),
      ],
      line,
      CONTEXT,
    );
    expect(result).toMatchObject({ promotionId: 'b', amount: 25_000n });
  });

  it('returns null when nothing applies', () => {
    expect(
      bestItemDiscount([rule({ appliesTo: 'PRODUCT', productIds: ['other'] })], line, CONTEXT),
    ).toBeNull();
  });
});

describe('bestOrderDiscount', () => {
  it('respects minSubtotal against the post-line-discount subtotal', () => {
    const rules = [rule({ scope: 'ORDER', minSubtotal: 500_000n, value: 1000n })];
    expect(bestOrderDiscount(rules, 400_000n, CONTEXT)).toBeNull();
    expect(bestOrderDiscount(rules, 500_000n, CONTEXT)).toMatchObject({ amount: 50_000n });
  });
});

describe('groupDiscount', () => {
  it('turns a standing percentage into an order-level candidate', () => {
    expect(groupDiscount(1000n, 200_000n, 'VIP')).toMatchObject({ amount: 20_000n });
  });

  it('is null when the group has no discount', () => {
    expect(groupDiscount(0n, 200_000n, 'Doimiy')).toBeNull();
  });
});
