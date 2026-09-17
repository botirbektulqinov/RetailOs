/**
 * Money primitives — docs/ARCHITECTURE.md §8.
 *
 * Money is a `bigint` count of the organization's currency minor units. For UZS
 * the exponent is 0, so one unit is one so'm. There is no Money class and no
 * Currency object: a `bigint` *is* the money type, which means the language
 * itself rejects `price * 1.2` (bigint/number mixing is a TypeError) instead of
 * silently producing a float. That is cheaper than a lint rule and a review.
 *
 * Rules, applied without exception:
 *   1. Addition and subtraction are exact.
 *   2. Multiplication by a quantity rounds once, at the line.
 *   3. Percentages round once, at the point of application.
 *   4. Rounding is always half-up, away from zero.
 *   5. Every rounded result is persisted; nothing is recomputed at read time.
 *   6. Division only ever happens through allocate().
 */

/** An amount in minor units of the organization's currency. */
export type Money = bigint;

/** Quantities carry 3 decimal places; `qtyMilli` is quantity x 1000. */
export const QUANTITY_SCALE = 1000n;

/** Percentages carry 2 decimal places; 12.5% is 1250. */
export const PERCENT_SCALE = 10_000n;

/**
 * Divides, rounding half away from zero.
 *
 * Half-up is chosen over banker's rounding because retail receipts are checked
 * by hand: a cashier expects 0.5 to go up, every time, and a rule that depends
 * on the preceding digit's parity is impossible to defend at the counter.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): Money {
  if (denominator === 0n) {
    throw new RangeError('roundHalfUp: division by zero');
  }

  // Normalise the sign onto the numerator so the half-up offset is always
  // applied away from zero.
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const magnitude = (absNumerator * 2n + absDenominator) / (absDenominator * 2n);
  return negative ? -magnitude : magnitude;
}

/**
 * unit price x quantity, rounded once.
 *
 * @param unitPrice minor units
 * @param qtyMilli  quantity x 1000 (so "1.500" arrives as 1500n)
 */
export function priceTimesQuantity(unitPrice: Money, qtyMilli: bigint): Money {
  return roundHalfUp(unitPrice * qtyMilli, QUANTITY_SCALE);
}

/**
 * A percentage of a base amount, rounded once.
 *
 * @param percentCentis percent x 100 (so 12.5% arrives as 1250n)
 */
export function percentOf(base: Money, percentCentis: bigint): Money {
  return roundHalfUp(base * percentCentis, PERCENT_SCALE);
}

/**
 * Splits `total` across `weights` so the parts sum to `total` EXACTLY.
 *
 * Proportional rounding does not: 40,000 over three equal lines gives
 * 13,333 x 3 = 39,999 and one so'm vanishes. Largest-remainder hands each
 * leftover minor unit to the part with the biggest fractional remainder,
 * breaking ties by index so the result is deterministic.
 *
 * Used for order-discount-to-lines, refund-to-returned-units, and (later)
 * tax-to-lines. The property `sum(allocate(t, w)) === t` is under test.
 */
export function allocate(total: Money, weights: readonly Money[]): Money[] {
  if (weights.length === 0) {
    if (total !== 0n) {
      throw new RangeError('allocate: cannot distribute a non-zero total across zero weights');
    }
    return [];
  }

  if (weights.some((weight) => weight < 0n)) {
    throw new RangeError('allocate: weights must not be negative');
  }

  const weightSum = weights.reduce((sum, weight) => sum + weight, 0n);

  // Nothing to weigh by: put everything on the first part rather than silently
  // dropping it, so the caller's total is never lost.
  if (weightSum === 0n) {
    const parts = weights.map(() => 0n);
    parts[0] = total;
    return parts;
  }

  const parts = weights.map((weight) => (total * weight) / weightSum);
  const distributed = parts.reduce((sum, part) => sum + part, 0n);
  const remainder = total - distributed;

  if (remainder === 0n) {
    return parts;
  }

  const step = remainder > 0n ? 1n : -1n;
  let outstanding = remainder > 0n ? remainder : -remainder;

  const byRemainder = weights
    .map((weight, index) => {
      const fraction = (total * weight) % weightSum;
      // Compare magnitudes, so a negative total (a reversal) distributes its
      // leftover units to the same parts a positive one would.
      return { index, fraction: fraction < 0n ? -fraction : fraction };
    })
    .sort((a, b) => {
      // Largest fractional remainder first; ties resolved by original position.
      if (a.fraction === b.fraction) return a.index - b.index;
      return a.fraction > b.fraction ? -1 : 1;
    });

  for (let i = 0; outstanding > 0n; i += 1, outstanding -= 1n) {
    const target = byRemainder[i % byRemainder.length];
    // `byRemainder` is derived from a non-empty array, so this is always defined;
    // the guard exists because noUncheckedIndexedAccess cannot know that.
    if (target === undefined) break;
    parts[target.index] = (parts[target.index] ?? 0n) + step;
  }

  return parts;
}

/**
 * Rounds a total to the nearest cash denomination.
 *
 * Uzbekistan has no circulating coin below 100 so'm, so a cash total is rounded
 * and the difference is stored on the sale as `rounding_adjustment` — never
 * absorbed silently, so the daily report can show exactly what rounding cost.
 *
 * @param unit 0 disables rounding (the default)
 * @returns the adjustment to add to `total`, which may be negative
 */
export function cashRoundingAdjustment(total: Money, unit: bigint): Money {
  if (unit <= 0n) return 0n;
  return roundHalfUp(total, unit) * unit - total;
}

/** Parses a decimal quantity string such as "1.500" into quantity x 1000. */
export function quantityToMilli(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) {
    throw new RangeError(`quantityToMilli: "${value}" is not a quantity with up to 3 decimals`);
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  const milli = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(3, '0'));
  return sign === '-' ? -milli : milli;
}

/** Formats quantity x 1000 back into a decimal string such as "1.500". */
export function milliToQuantity(qtyMilli: bigint): string {
  const negative = qtyMilli < 0n;
  const absolute = negative ? -qtyMilli : qtyMilli;
  const whole = absolute / QUANTITY_SCALE;
  const fraction = (absolute % QUANTITY_SCALE).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
