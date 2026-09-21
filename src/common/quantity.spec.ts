import {
  MAX_QUANTITY,
  QUANTITY_PATTERN,
  formatQuantity,
  fromMilli,
  parseQuantity,
  stockStatus,
  toMilli,
  toNumber,
  toNumericString,
} from './quantity';

describe('toNumericString', () => {
  it('renders at the stored scale', () => {
    expect(toNumericString(1)).toBe('1.000');
    expect(toNumericString(1.5)).toBe('1.500');
    expect(toNumericString(-3)).toBe('-3.000');
  });

  it('rounds to three decimals rather than handing PostgreSQL a float', () => {
    expect(toNumericString(0.0001)).toBe('0.000');
    expect(toNumericString(1.2345)).toBe('1.234');
    expect(toNumericString(1.2355)).toBe('1.236');
  });

  it('rejects what NUMERIC(14,3) cannot hold', () => {
    expect(() => toNumericString(MAX_QUANTITY + 1)).toThrow(RangeError);
    expect(() => toNumericString(Number.NaN)).toThrow(RangeError);
    expect(() => toNumericString(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('names the field it rejected, so a 50-line request says which line', () => {
    expect(() => toNumericString(Number.NaN, 'lines[3].quantity')).toThrow(/lines\[3\]\.quantity/);
  });
});

describe('milli conversion', () => {
  it('round-trips', () => {
    for (const q of [0, 1, 1.5, 0.001, 12345.678, -4.25]) {
      expect(fromMilli(toMilli(q))).toBeCloseTo(q, 3);
    }
  });

  it('makes the classic float comparison exact', () => {
    // 0.1 + 0.2 !== 0.3 as doubles; as milli-units it is 100 + 200 === 300.
    expect(toMilli(0.1) + toMilli(0.2)).toBe(toMilli(0.3));
  });
});

describe('toNumber', () => {
  it('accepts what the driver may hand back for NUMERIC', () => {
    expect(toNumber('12.500')).toBe(12.5);
    expect(toNumber(12.5)).toBe(12.5);
    expect(toNumber({ toString: () => '7.250' })).toBe(7.25);
  });

  it('treats a missing level as zero, which is what no row means', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });
});

describe('stockStatus', () => {
  it('reports the sprint example', () => {
    expect(stockStatus(3, 5)).toBe('LOW_STOCK');
    expect(stockStatus(0, 5)).toBe('OUT_OF_STOCK');
  });

  it('treats the minimum as inclusive — at the minimum is already low', () => {
    expect(stockStatus(5, 5)).toBe('LOW_STOCK');
    expect(stockStatus(5.001, 5)).toBe('IN_STOCK');
  });

  it('never reports LOW_STOCK when no minimum is configured', () => {
    // Otherwise every product in the catalogue would be "low" the moment it
    // ran out, which is what OUT_OF_STOCK already says.
    expect(stockStatus(1, 0)).toBe('IN_STOCK');
    expect(stockStatus(0.001, 0)).toBe('IN_STOCK');
  });

  it('calls negative stock out of stock, not in stock', () => {
    expect(stockStatus(-2, 5)).toBe('OUT_OF_STOCK');
  });
});

describe('QUANTITY_PATTERN', () => {
  it('accepts what the API contract promises', () => {
    for (const value of ['0', '1', '1.5', '1.500', '-3.000', '99999999999.999']) {
      expect(QUANTITY_PATTERN.test(value)).toBe(true);
    }
  });

  it('rejects the shapes that would round somewhere unhelpful', () => {
    // Four decimals, exponent notation, a stray space, an empty string: each
    // would parse to *something* and quietly lose precision on the way in.
    for (const value of ['1.5000', '1e3', ' 1.5', '', '1.', '.5', 'abc', '123456789012']) {
      expect(QUANTITY_PATTERN.test(value)).toBe(false);
    }
  });
});

describe('parseQuantity', () => {
  it('parses at the stored scale', () => {
    expect(parseQuantity('1.500')).toBe(1.5);
    expect(parseQuantity('-3')).toBe(-3);
    expect(parseQuantity('0.001')).toBe(0.001);
  });

  it('rejects what the column cannot hold, naming the field', () => {
    expect(() => parseQuantity('999999999999', 'items[2].quantity')).toThrow(
      /items\[2\]\.quantity/,
    );
    expect(() => parseQuantity('nope')).toThrow(RangeError);
  });
});

describe('formatQuantity', () => {
  it('always emits three decimals, whatever it was given', () => {
    expect(formatQuantity(1)).toBe('1.000');
    expect(formatQuantity('2.5')).toBe('2.500');
    expect(formatQuantity({ toString: () => '7.25' })).toBe('7.250');
    expect(formatQuantity(null)).toBe('0.000');
  });

  it('round-trips through parseQuantity', () => {
    for (const value of ['0.000', '1.500', '-12.250', '99999.999']) {
      expect(formatQuantity(parseQuantity(value))).toBe(value);
    }
  });
});
