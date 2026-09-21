import {
  allocate,
  cashRoundingAdjustment,
  priceTimesQuantity,
  quantityToMilli,
} from '../common/money/money';
import type { Money } from '../common/money/money';

/**
 * The checkout calculation — docs/ARCHITECTURE.md §10.3.
 *
 * One deterministic order, executed server-side, written as pure functions so
 * it can be tested without a database, a request or a clock. Ambiguity here is
 * how POS systems end up with receipts that do not add up, and a pipeline
 * buried inside a transaction is a pipeline nobody can check.
 *
 * Nothing in this file reads a request. The caller has already resolved every
 * price from the catalogue; what arrives here is what the server believes, not
 * what the client claimed.
 */

export interface PricedLineInput {
  variantId: string;
  nameSnapshot: string;
  skuSnapshot: string;
  /** Decimal string at NUMERIC(14,3) scale. */
  quantity: string;
  /** Server-resolved, or an override the caller has already permission-checked. */
  unitPrice: Money;
  /** avg_cost at this moment — the COGS snapshot. */
  unitCost: Money;
  /** Manual per-line discount, already validated against the caller's rights. */
  lineDiscount?: Money;
}

export interface PricedLine {
  variantId: string;
  nameSnapshot: string;
  skuSnapshot: string;
  quantity: string;
  quantityMilli: bigint;
  unitPrice: Money;
  unitCost: Money;
  grossAmount: Money;
  lineDiscountAmount: Money;
  allocatedOrderDiscount: Money;
  netAmount: Money;
  /** unit_cost x quantity, rounded once — this line's share of COGS. */
  lineCost: Money;
  position: number;
}

export interface PricingInput {
  lines: readonly PricedLineInput[];
  /** Manual order-level discount, already permission-checked. */
  orderDiscount?: Money;
  /** organization_settings.cash_rounding_unit; 0 disables rounding. */
  cashRoundingUnit?: bigint;
  /** Rounding applies only when the tender is entirely cash (§8.5). */
  tenderIsAllCash?: boolean;
}

export interface PricedSale {
  lines: PricedLine[];
  subtotalAmount: Money;
  orderDiscountAmount: Money;
  taxAmount: Money;
  roundingAdjustment: Money;
  totalAmount: Money;
  costAmount: Money;
}

/**
 * Steps 1–11 of §10.3, in that exact order.
 *
 * The one subtlety worth stating out loud is step 5: the order discount is
 * allocated over line values *after* line discounts. Allocating over gross
 * would over-discount the lines that already had one, and the receipt would
 * not reconcile against the sum of its own lines.
 */
export function priceSale(input: PricingInput): PricedSale {
  // 1 + 2: gross per line, then the line discount, clamped so a discount can
  // take a line to zero but never below it.
  const lines: PricedLine[] = input.lines.map((line, index) => {
    const quantityMilli = quantityToMilli(line.quantity);
    const grossAmount = priceTimesQuantity(line.unitPrice, quantityMilli);

    const requested = line.lineDiscount ?? 0n;
    const lineDiscountAmount = requested < 0n ? 0n : min(requested, grossAmount);

    return {
      variantId: line.variantId,
      nameSnapshot: line.nameSnapshot,
      skuSnapshot: line.skuSnapshot,
      quantity: line.quantity,
      quantityMilli,
      unitPrice: line.unitPrice,
      unitCost: line.unitCost,
      grossAmount,
      lineDiscountAmount,
      allocatedOrderDiscount: 0n,
      netAmount: grossAmount - lineDiscountAmount,
      lineCost: priceTimesQuantity(line.unitCost, quantityMilli),
      position: index + 1,
    };
  });

  // 3: the base the order discount applies to.
  const subtotalBeforeOrderDiscount = sum(lines.map((l) => l.netAmount));

  // 4: clamped, so an order discount cannot exceed what is being bought.
  const requestedOrderDiscount = input.orderDiscount ?? 0n;
  const orderDiscountAmount =
    requestedOrderDiscount < 0n ? 0n : min(requestedOrderDiscount, subtotalBeforeOrderDiscount);

  // 5: allocate() distributes the remainder deterministically, so the parts
  // sum to EXACTLY the whole (§8.4). Splitting 1000 three ways by rounding
  // each share independently is how a receipt ends up one soʻm out.
  if (orderDiscountAmount > 0n) {
    const shares = allocate(
      orderDiscountAmount,
      lines.map((l) => l.netAmount),
    );
    lines.forEach((line, index) => {
      line.allocatedOrderDiscount = shares[index] ?? 0n;
      // 6: net is gross minus both discounts — the value the database's
      // ck_sale_item_net_adds_up will verify.
      line.netAmount = line.grossAmount - line.lineDiscountAmount - line.allocatedOrderDiscount;
    });
  }

  // 7: the stored subtotal is the value BEFORE the order discount.
  //
  // §10.3 step 7 says "subtotal_amount <- sum(net_amount)", but §5.5's CHECK
  // says "total = subtotal - order_discount + tax + rounding". Those two are
  // only compatible under one reading: subtotal is the pre-order-discount
  // figure, sum(gross - line_discount). Taking the other reading would make
  // the constraint subtract the order discount twice.
  //
  // It is also the more useful number to store, because it is the one a
  // receipt prints above the discount line. Both identities then hold:
  //     total          = subtotal - order_discount + tax + rounding
  //     sum(net_amount) = subtotal - order_discount
  const subtotalAmount = subtotalBeforeOrderDiscount;

  // 8: reserved. Uzbekistan retail VAT is out of MVP scope (§35); the column
  // exists so adding it later is not a schema migration on a live sales table.
  const taxAmount = 0n;

  const totalBeforeRounding = subtotalAmount - orderDiscountAmount + taxAmount;

  // 10: cash rounding only when the whole tender is cash. Rounding a card
  // payment would mean charging a number the terminal never saw.
  const roundingAdjustment =
    input.tenderIsAllCash && (input.cashRoundingUnit ?? 0n) > 0n
      ? cashRoundingAdjustment(totalBeforeRounding, input.cashRoundingUnit!)
      : 0n;

  return {
    lines,
    subtotalAmount,
    orderDiscountAmount,
    taxAmount,
    roundingAdjustment,
    // 11. ck_sale_total_adds_up checks this exact equation in the database.
    totalAmount: totalBeforeRounding + roundingAdjustment,
    costAmount: sum(lines.map((l) => l.lineCost)),
  };
}

function min(a: Money, b: Money): Money {
  return a < b ? a : b;
}

function sum(values: readonly Money[]): Money {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
