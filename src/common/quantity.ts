/**
 * Quantity primitives — the counterpart to money.ts.
 *
 * Stock is `NUMERIC(14,3)`: 1.5 kg of rice is a real quantity, 1.5 phone
 * chargers is not. The scale is fixed at three decimals everywhere — schema,
 * API and ledger — so there is never a rounding decision to make at a
 * boundary.
 *
 * Quantities cross the API boundary as decimal strings — `"1.500"`, never
 * `1.5`. That is the contract the whole API already states (see the Swagger
 * description and `product_variant.minStock`), and it is stated for a reason:
 * a client that parses `0.1` and `0.2` as doubles and adds them does not get
 * `0.3`, and the client here is a Flutter app whose `double` has exactly the
 * same problem. A string moves the parsing decision to the one place that
 * knows the scale.
 *
 * Inside the process a quantity is an ordinary number: bounded by 10^11 with
 * three decimals, its milli-unit form is at most 10^14, comfortably inside the
 * 2^53 a double represents exactly. Money has no such bound — a soʻm total can
 * exceed it — which is why money is bigint and this is not.
 */

/** Matches NUMERIC(14,3): eleven integer digits, three decimal. */
export const MAX_QUANTITY = 99_999_999_999;
export const QUANTITY_DP = 3;

/** Quantity x 1000, as an integer. Exact comparison and summation live here. */
export type QtyMilli = number;

export function toMilli(quantity: number): QtyMilli {
  return Math.round(quantity * 1000);
}

export function fromMilli(milli: QtyMilli): number {
  return milli / 1000;
}

/**
 * Validates and renders a client-supplied quantity for SQL.
 *
 * Returns a fixed-point string rather than binding the number directly:
 * PostgreSQL would receive a float8 and round it back to NUMERIC(14,3)
 * itself, which turns 0.1 + 0.2 into a support ticket. `$1::numeric` on a
 * decimal string has no such step.
 */
export function toNumericString(quantity: number, field = 'quantity'): string {
  if (!Number.isFinite(quantity)) {
    throw new RangeError(`${field}: must be a finite number`);
  }
  if (Math.abs(quantity) > MAX_QUANTITY) {
    throw new RangeError(`${field}: exceeds NUMERIC(14,3)`);
  }
  return quantity.toFixed(QUANTITY_DP);
}

/**
 * Prisma returns NUMERIC as Decimal (or as a string through the driver
 * adapter, depending on the path). Both collapse to a number here, which is
 * safe at this scale and is what the API contract promises.
 */
export function toNumber(value: { toString(): string } | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  return Number(value.toString());
}

/** Stock status for a level — docs/ARCHITECTURE.md §7.6. */
export type StockStatus = 'OUT_OF_STOCK' | 'LOW_STOCK' | 'IN_STOCK';

/**
 * Derived, never stored.
 *
 * A stored status would need updating on every movement AND on every edit of
 * `minStock`, and the second one is the update everybody forgets. The rule is
 * two comparisons; computing it is cheaper than keeping it true.
 *
 * `minStock = 0` means "no minimum configured", so it never reports LOW_STOCK
 * — otherwise every product in the catalogue would be low the moment it sold
 * out, which is what OUT_OF_STOCK already says.
 */
export function stockStatus(quantity: number, minStock: number): StockStatus {
  if (quantity <= 0) return 'OUT_OF_STOCK';
  if (minStock > 0 && quantity <= minStock) return 'LOW_STOCK';
  return 'IN_STOCK';
}

/** What a quantity may look like on the wire: optional sign, up to 3 decimals. */
export const QUANTITY_PATTERN = /^-?\d{1,11}(\.\d{1,3})?$/;

/**
 * Parses a wire quantity.
 *
 * The DTO layer has already matched QUANTITY_PATTERN, so this is about range,
 * not shape — but it validates anyway, because a service is reachable from a
 * seed and a test as well as from a controller.
 */
export function parseQuantity(value: string, field = 'quantity'): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${field}: not a number`);
  if (Math.abs(parsed) > MAX_QUANTITY) throw new RangeError(`${field}: exceeds NUMERIC(14,3)`);
  return Math.round(parsed * 1000) / 1000;
}

/** Renders a quantity for a response, at the stored scale, always. */
export function formatQuantity(value: { toString(): string } | number | null | undefined): string {
  return toNumber(value).toFixed(QUANTITY_DP);
}
