import { priceSale } from './pricing';
import type { PricedLineInput } from './pricing';

const line = (over: Partial<PricedLineInput> = {}): PricedLineInput => ({
  variantId: 'v1',
  nameSnapshot: 'Choy',
  skuSnapshot: 'CH-001',
  quantity: '1.000',
  unitPrice: 10_000n,
  unitCost: 6_000n,
  ...over,
});

describe('priceSale', () => {
  it('multiplies once per line and sums', () => {
    const result = priceSale({
      lines: [
        line({ quantity: '3.000', unitPrice: 24_000n }),
        line({ variantId: 'v2', quantity: '2.000', unitPrice: 12_500n }),
      ],
    });

    expect(result.lines[0]!.grossAmount).toBe(72_000n);
    expect(result.lines[1]!.grossAmount).toBe(25_000n);
    expect(result.subtotalAmount).toBe(97_000n);
    expect(result.totalAmount).toBe(97_000n);
  });

  it('rounds a fractional quantity once, at the line', () => {
    // 1.5 kg at 13,333 = 19,999.5 → 20,000, rounded once rather than twice.
    const result = priceSale({ lines: [line({ quantity: '1.500', unitPrice: 13_333n })] });
    expect(result.lines[0]!.grossAmount).toBe(20_000n);
  });

  it('snapshots cost per line for COGS', () => {
    const result = priceSale({
      lines: [line({ quantity: '3.000', unitPrice: 24_000n, unitCost: 15_000n })],
    });
    expect(result.costAmount).toBe(45_000n);
    // Margin is then a subtraction on stored values, never a later lookup.
    expect(result.totalAmount - result.costAmount).toBe(27_000n);
  });

  describe('line discounts', () => {
    it('subtracts from the line and from the subtotal', () => {
      const result = priceSale({
        lines: [line({ unitPrice: 50_000n, lineDiscount: 5_000n })],
      });
      expect(result.lines[0]!.lineDiscountAmount).toBe(5_000n);
      expect(result.lines[0]!.netAmount).toBe(45_000n);
      expect(result.subtotalAmount).toBe(45_000n);
    });

    it('clamps at the line total — a discount may reach zero, never below', () => {
      const result = priceSale({
        lines: [line({ unitPrice: 10_000n, lineDiscount: 999_000n })],
      });
      expect(result.lines[0]!.lineDiscountAmount).toBe(10_000n);
      expect(result.lines[0]!.netAmount).toBe(0n);
      expect(result.totalAmount).toBe(0n);
    });

    it('ignores a negative discount rather than turning it into a surcharge', () => {
      const result = priceSale({ lines: [line({ lineDiscount: -5_000n })] });
      expect(result.lines[0]!.lineDiscountAmount).toBe(0n);
    });
  });

  describe('order discount', () => {
    it('allocates so the parts sum to exactly the whole', () => {
      // 1,000 over three equal lines is the classic case: three independent
      // roundings give 333 x 3 = 999 and a receipt that is one soʻm out.
      const result = priceSale({
        lines: [line({ variantId: 'a' }), line({ variantId: 'b' }), line({ variantId: 'c' })],
        orderDiscount: 1_000n,
      });

      const allocated = result.lines.reduce((s, l) => s + l.allocatedOrderDiscount, 0n);
      expect(allocated).toBe(1_000n);
    });

    it('weights by line value AFTER line discounts', () => {
      // Allocating over gross would over-discount the line that already had a
      // promotion on it.
      const result = priceSale({
        lines: [
          line({ variantId: 'a', unitPrice: 100_000n, lineDiscount: 90_000n }), // net 10,000
          line({ variantId: 'b', unitPrice: 90_000n }), // net 90,000
        ],
        orderDiscount: 10_000n,
      });

      expect(result.lines[0]!.allocatedOrderDiscount).toBe(1_000n);
      expect(result.lines[1]!.allocatedOrderDiscount).toBe(9_000n);
    });

    it('clamps to the subtotal', () => {
      const result = priceSale({
        lines: [line({ unitPrice: 20_000n })],
        orderDiscount: 500_000n,
      });
      expect(result.orderDiscountAmount).toBe(20_000n);
      expect(result.totalAmount).toBe(0n);
    });

    it('keeps both identities the database and the receipt rely on', () => {
      const result = priceSale({
        lines: [
          line({ variantId: 'a', quantity: '3.000', unitPrice: 24_000n, lineDiscount: 4_000n }),
          line({ variantId: 'b', quantity: '2.000', unitPrice: 12_500n }),
          line({ variantId: 'c', quantity: '1.000', unitPrice: 7_777n }),
        ],
        orderDiscount: 13_333n,
      });

      const netSum = result.lines.reduce((s, l) => s + l.netAmount, 0n);

      // ck_sale_total_adds_up, in the database.
      expect(result.totalAmount).toBe(
        result.subtotalAmount -
          result.orderDiscountAmount +
          result.taxAmount +
          result.roundingAdjustment,
      );
      // The receipt reconciles against the sum of its own lines.
      expect(netSum).toBe(result.subtotalAmount - result.orderDiscountAmount);

      // ck_sale_item_net_adds_up, per line.
      for (const l of result.lines) {
        expect(l.netAmount).toBe(l.grossAmount - l.lineDiscountAmount - l.allocatedOrderDiscount);
        expect(l.netAmount).toBeGreaterThanOrEqual(0n);
      }
    });
  });

  describe('cash rounding', () => {
    it('rounds an all-cash total to the configured unit', () => {
      const result = priceSale({
        lines: [line({ unitPrice: 24_970n })],
        cashRoundingUnit: 100n,
        tenderIsAllCash: true,
      });
      expect(result.roundingAdjustment).toBe(30n);
      expect(result.totalAmount).toBe(25_000n);
    });

    it('leaves a card total alone — the terminal charged the exact figure', () => {
      const result = priceSale({
        lines: [line({ unitPrice: 24_970n })],
        cashRoundingUnit: 100n,
        tenderIsAllCash: false,
      });
      expect(result.roundingAdjustment).toBe(0n);
      expect(result.totalAmount).toBe(24_970n);
    });

    it('does nothing when the organization has rounding switched off', () => {
      const result = priceSale({
        lines: [line({ unitPrice: 24_970n })],
        cashRoundingUnit: 0n,
        tenderIsAllCash: true,
      });
      expect(result.totalAmount).toBe(24_970n);
    });
  });

  it('walks the architecture worked example: 450,000', () => {
    const result = priceSale({
      lines: [
        line({ variantId: 'a', quantity: '10.000', unitPrice: 30_000n, unitCost: 20_000n }),
        line({ variantId: 'b', quantity: '5.000', unitPrice: 30_000n, unitCost: 18_000n }),
      ],
    });
    expect(result.totalAmount).toBe(450_000n);
    expect(result.costAmount).toBe(290_000n);
  });
});
