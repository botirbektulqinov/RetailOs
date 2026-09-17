import {
  allocate,
  cashRoundingAdjustment,
  milliToQuantity,
  percentOf,
  priceTimesQuantity,
  quantityToMilli,
  roundHalfUp,
} from './money';

describe('roundHalfUp', () => {
  it.each([
    [5n, 2n, 3n], // 2.5 -> 3
    [3n, 2n, 2n], // 1.5 -> 2
    [1n, 2n, 1n], // 0.5 -> 1
    [1n, 3n, 0n], // 0.33 -> 0
    [2n, 3n, 1n], // 0.67 -> 1
    [0n, 7n, 0n],
  ])('rounds %s/%s to %s', (numerator, denominator, expected) => {
    expect(roundHalfUp(numerator, denominator)).toBe(expected);
  });

  it('rounds away from zero for negatives, mirroring the positive case', () => {
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
    expect(roundHalfUp(-1n, 2n)).toBe(-1n);
    expect(roundHalfUp(5n, -2n)).toBe(-3n);
  });

  it('rejects division by zero rather than returning a wrong amount', () => {
    expect(() => roundHalfUp(1n, 0n)).toThrow(RangeError);
  });
});

describe('priceTimesQuantity', () => {
  it('multiplies whole quantities exactly', () => {
    expect(priceTimesQuantity(45_000n, 2_000n)).toBe(90_000n);
  });

  it('rounds a fractional quantity once', () => {
    // 12,500 x 1.333 = 16,662.5 -> 16,663
    expect(priceTimesQuantity(12_500n, 1_333n)).toBe(16_663n);
  });

  it('handles a zero quantity', () => {
    expect(priceTimesQuantity(45_000n, 0n)).toBe(0n);
  });
});

describe('percentOf', () => {
  it('computes a whole percentage exactly', () => {
    expect(percentOf(450_000n, 1_000n)).toBe(45_000n); // 10%
  });

  it('rounds a fractional percentage once', () => {
    // 3.33% of 450,000 = 14,985
    expect(percentOf(450_000n, 333n)).toBe(14_985n);
  });

  it('computes the architecture example: 1% loyalty earn on 450,000', () => {
    expect(percentOf(450_000n, 100n)).toBe(4_500n);
  });
});

describe('allocate', () => {
  it('splits an indivisible total without losing a minor unit', () => {
    const parts = allocate(40_000n, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(40_000n);
    expect(parts).toEqual([13_334n, 13_333n, 13_333n]);
  });

  it('weights proportionally', () => {
    expect(allocate(100n, [50n, 30n, 20n])).toEqual([50n, 30n, 20n]);
  });

  it('puts the whole total on the first part when every weight is zero', () => {
    expect(allocate(500n, [0n, 0n])).toEqual([500n, 0n]);
  });

  it('returns an empty allocation for an empty, zero-valued split', () => {
    expect(allocate(0n, [])).toEqual([]);
  });

  it('refuses to lose a total that has nowhere to go', () => {
    expect(() => allocate(100n, [])).toThrow(RangeError);
  });

  it('rejects negative weights', () => {
    expect(() => allocate(100n, [10n, -1n])).toThrow(RangeError);
  });

  it('allocates a negative total (a reversal) without drift', () => {
    const parts = allocate(-40_000n, [1n, 1n, 1n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(-40_000n);
  });

  // BR-12: the invariant the whole discount and refund model depends on.
  it('always sums exactly to the total (property test, 2000 random cases)', () => {
    for (let run = 0; run < 2000; run += 1) {
      const total = BigInt(Math.floor(Math.random() * 10_000_000));
      const count = 1 + Math.floor(Math.random() * 12);
      const weights = Array.from({ length: count }, () =>
        BigInt(Math.floor(Math.random() * 500_000)),
      );

      const parts = allocate(total, weights);
      const sum = parts.reduce((a, b) => a + b, 0n);

      expect(sum).toBe(total);
      expect(parts).toHaveLength(count);
    }
  });
});

describe('cashRoundingAdjustment', () => {
  it('is disabled when the unit is zero', () => {
    expect(cashRoundingAdjustment(450_137n, 0n)).toBe(0n);
  });

  it('rounds down to the nearest 100 and reports a negative adjustment', () => {
    expect(cashRoundingAdjustment(450_137n, 100n)).toBe(-37n);
  });

  it('rounds up to the nearest 100 and reports a positive adjustment', () => {
    expect(cashRoundingAdjustment(450_190n, 100n)).toBe(10n);
  });

  it('rounds to the nearest 1000', () => {
    expect(cashRoundingAdjustment(450_600n, 1_000n)).toBe(400n);
    expect(450_600n + cashRoundingAdjustment(450_600n, 1_000n)).toBe(451_000n);
  });

  it('leaves an already-round total untouched', () => {
    expect(cashRoundingAdjustment(450_000n, 1_000n)).toBe(0n);
  });
});

describe('quantity conversion', () => {
  it.each([
    ['1', 1_000n],
    ['1.5', 1_500n],
    ['1.500', 1_500n],
    ['0.001', 1n],
    ['12.345', 12_345n],
    ['-2.500', -2_500n],
  ])('parses %s', (input, expected) => {
    expect(quantityToMilli(input)).toBe(expected);
  });

  it.each([
    [1_500n, '1.500'],
    [1n, '0.001'],
    [-2_500n, '-2.500'],
  ])('formats %s', (input, expected) => {
    expect(milliToQuantity(input)).toBe(expected);
  });

  it('round-trips', () => {
    for (const value of ['0.000', '1.000', '99.999', '12345.678']) {
      expect(milliToQuantity(quantityToMilli(value))).toBe(value);
    }
  });

  it('rejects more than three decimals rather than silently truncating', () => {
    expect(() => quantityToMilli('1.2345')).toThrow(RangeError);
    expect(() => quantityToMilli('abc')).toThrow(RangeError);
  });
});
