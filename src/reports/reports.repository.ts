import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../database/prisma.service';
import type { ReportFilter } from './dto/report.dto';

/**
 * Every report query, as reviewed SQL — docs/ARCHITECTURE.md §28.1.
 *
 * Reports are raw SQL, not the ORM. Prisma's query builder is excellent for
 * row access and poor at analytical SQL, and a report is the one place where
 * seeing the query matters more than type inference over the result.
 *
 * Reads are separated from writes **at the code level** so that pointing
 * reports at a read replica later is a connection-string change rather than a
 * refactor. `read` is the same client today; nothing above this line changes
 * when it stops being.
 *
 * No ClickHouse, no warehouse, no ETL: a small store produces a few hundred
 * sales a day, and PostgreSQL answers every question here in milliseconds
 * against the indexes the transactional paths already need.
 *
 * ## Two rules every query here follows
 *
 * 1. **Aggregate in the database.** Nothing loads rows to count them.
 * 2. **Cast every `SUM()` over a BIGINT to `::bigint`.** PostgreSQL widens it
 *    to NUMERIC, which the driver returns as a string, and `1n + "2"` is the
 *    string `"12"`. Sprint 10 shipped that bug once; it is not shipping again.
 */
@Injectable()
export class ReportsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The read client.
   *
   * MVP: the same connection. Phase 2: a replica, injected here and nowhere
   * else.
   */
  private get read() {
    return this.prisma.db;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Shared scope
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Organization is automatic everywhere else in this codebase — the Prisma
   * extension injects it. `$queryRaw` bypasses that extension entirely, so
   * every statement in this file names the organization itself. It is the one
   * place where forgetting a line leaks a tenant.
   */
  private scope(filter: ReportFilter): { org: string; from: Date; to: Date } {
    return { org: filter.organizationId, from: filter.from, to: filter.to };
  }

  /**
   * The store restriction — §20.4 layer 3, resolved by the service from the
   * caller's memberships. Empty means org-wide, which only a wildcard holder
   * is given.
   *
   * Inventory has no clause of its own: stock lives in warehouses, and a
   * warehouse may be org-level (`warehouse.store_id IS NULL`). Scoping the
   * stock reports by store would hide the central warehouse from every branch
   * manager, which is the opposite of useful. `warehouseId` is that filter.
   */
  private storeClause(filter: ReportFilter, alias = 's'): Prisma.Sql {
    if (!filter.storeIds.length) return Prisma.empty;
    const ids = Prisma.join(filter.storeIds.map((id) => Prisma.sql`${id}::uuid`));
    return Prisma.sql`AND ${Prisma.raw(alias)}.store_id IN (${ids})`;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Sales
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Revenue, margin and the return offset for a period.
   *
   * Revenue is gross sales less refunds in the same window (§28.2), which is
   * what a shopkeeper means by "how much did we take". The two halves are
   * separate subqueries because a refund can belong to a sale from an earlier
   * period — netting them inside one join would silently drop those.
   */
  async salesSummary(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    const [row] = await this.read.$queryRaw<
      Array<{
        sales_count: number;
        gross: bigint;
        discount: bigint;
        cost: bigint;
        credit: bigint;
        refunds: bigint;
        units: string;
      }>
    >`
      SELECT
        (SELECT count(*)::int FROM sale s
          WHERE s.organization_id = ${org}::uuid AND s.status = 'COMPLETED'
            AND s.completed_at BETWEEN ${from} AND ${to}
            ${this.storeClause(filter)}) AS sales_count,
        COALESCE((SELECT SUM(s.total_amount) FROM sale s
          WHERE s.organization_id = ${org}::uuid AND s.status = 'COMPLETED'
            AND s.completed_at BETWEEN ${from} AND ${to}
            ${this.storeClause(filter)}), 0)::bigint AS gross,
        COALESCE((SELECT SUM(s.order_discount_amount) FROM sale s
          WHERE s.organization_id = ${org}::uuid AND s.status = 'COMPLETED'
            AND s.completed_at BETWEEN ${from} AND ${to}
            ${this.storeClause(filter)}), 0)::bigint AS discount,
        COALESCE((SELECT SUM(s.cost_amount) FROM sale s
          WHERE s.organization_id = ${org}::uuid AND s.status = 'COMPLETED'
            AND s.completed_at BETWEEN ${from} AND ${to}
            ${this.storeClause(filter)}), 0)::bigint AS cost,
        COALESCE((SELECT SUM(s.credit_amount) FROM sale s
          WHERE s.organization_id = ${org}::uuid AND s.status = 'COMPLETED'
            AND s.completed_at BETWEEN ${from} AND ${to}
            ${this.storeClause(filter)}), 0)::bigint AS credit,
        COALESCE((SELECT SUM(r.refund_amount + r.credit_offset_amount) FROM sale_return r
          WHERE r.organization_id = ${org}::uuid
            AND r.created_at BETWEEN ${from} AND ${to}
            ${this.storeClause(filter, 'r')}), 0)::bigint AS refunds,
        COALESCE((SELECT SUM(i.quantity) FROM sale_item i
          JOIN sale s ON s.id = i.sale_id
          WHERE s.organization_id = ${org}::uuid AND s.status = 'COMPLETED'
            AND s.completed_at BETWEEN ${from} AND ${to}
            ${this.storeClause(filter)}), 0)::text AS units
    `;

    return row!;
  }

  /**
   * The daily trend, by **business date** — §28.5.
   *
   * `(completed_at AT TIME ZONE store.timezone)::date`, not the UTC date. A
   * sale at 00:30 belongs to the evening that produced it, and getting this
   * wrong makes every daily number disagree with the cashier's own count —
   * which destroys trust in the reports faster than any bug.
   *
   * There is deliberately no materialized view. §28.3 proposes one for the
   * 12-month trend; at MVP scale this query is a few thousand rows against an
   * index that already exists, and a view nothing refreshes is worse than no
   * view. Add it when a real dataset makes this slow.
   */
  async salesByDay(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        business_date: Date;
        sales_count: number;
        gross: bigint;
        cost: bigint;
        discount: bigint;
      }>
    >`
      SELECT (s.completed_at AT TIME ZONE COALESCE(st.timezone, o.timezone, 'Asia/Tashkent'))::date
               AS business_date,
             count(*)::int                        AS sales_count,
             SUM(s.total_amount)::bigint          AS gross,
             SUM(s.cost_amount)::bigint           AS cost,
             SUM(s.order_discount_amount)::bigint AS discount
        FROM sale s
        JOIN store st ON st.id = s.store_id
        LEFT JOIN organization_settings o ON o.organization_id = s.organization_id
       WHERE s.organization_id = ${org}::uuid
         AND s.status = 'COMPLETED'
         AND s.completed_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter)}
       GROUP BY business_date
       ORDER BY business_date ASC
    `;
  }

  /** Per-cashier performance — §28.2. */
  async salesByEmployee(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        user_id: string;
        full_name: string;
        sales_count: number;
        gross: bigint;
        cost: bigint;
        discount: bigint;
      }>
    >`
      SELECT s.created_by                         AS user_id,
             u.full_name,
             count(*)::int                        AS sales_count,
             SUM(s.total_amount)::bigint          AS gross,
             SUM(s.cost_amount)::bigint           AS cost,
             SUM(s.order_discount_amount)::bigint AS discount
        FROM sale s
        JOIN app_user u ON u.id = s.created_by
       WHERE s.organization_id = ${org}::uuid
         AND s.status = 'COMPLETED'
         AND s.completed_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter)}
         ${filter.employeeId ? Prisma.sql`AND s.created_by = ${filter.employeeId}::uuid` : Prisma.empty}
       GROUP BY s.created_by, u.full_name
       ORDER BY gross DESC
       LIMIT ${filter.limit}
    `;
  }

  /**
   * Top products — §28.2, by revenue.
   *
   * Grouped on `sale_item` with the snapshot name, so a product renamed since
   * the sale still reports under what the receipt said. Net of returns,
   * because a line returned is not a line sold.
   */
  async topProducts(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        variant_id: string;
        name: string;
        sku: string;
        quantity: string;
        returned: string;
        revenue: bigint;
        cost: bigint;
      }>
    >`
      SELECT i.product_variant_id             AS variant_id,
             MAX(i.name_snapshot)             AS name,
             MAX(i.sku_snapshot)              AS sku,
             SUM(i.quantity)::text            AS quantity,
             SUM(i.returned_quantity)::text   AS returned,
             SUM(i.net_amount - i.refunded_amount)::bigint AS revenue,
             SUM(round(i.unit_cost * (i.quantity - i.returned_quantity)))::bigint AS cost
        FROM sale_item i
        JOIN sale s ON s.id = i.sale_id
        LEFT JOIN product_variant v ON v.id = i.product_variant_id
        LEFT JOIN product p ON p.id = v.product_id
       WHERE s.organization_id = ${org}::uuid
         AND s.status = 'COMPLETED'
         AND s.completed_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter)}
         ${filter.categoryId ? Prisma.sql`AND p.category_id = ${filter.categoryId}::uuid` : Prisma.empty}
         ${filter.productId ? Prisma.sql`AND p.id = ${filter.productId}::uuid` : Prisma.empty}
       GROUP BY i.product_variant_id
       ORDER BY revenue DESC
       LIMIT ${filter.limit}
    `;
  }

  /** Revenue by category, for the dashboard's breakdown. */
  async topCategories(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{ category_id: string | null; name: string; revenue: bigint; quantity: string }>
    >`
      SELECT c.id                            AS category_id,
             COALESCE(c.name, 'Kategoriyasiz') AS name,
             SUM(i.net_amount - i.refunded_amount)::bigint AS revenue,
             SUM(i.quantity)::text           AS quantity
        FROM sale_item i
        JOIN sale s ON s.id = i.sale_id
        JOIN product_variant v ON v.id = i.product_variant_id
        JOIN product p ON p.id = v.product_id
        LEFT JOIN category c ON c.id = p.category_id
       WHERE s.organization_id = ${org}::uuid
         AND s.status = 'COMPLETED'
         AND s.completed_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter)}
       GROUP BY c.id, c.name
       ORDER BY revenue DESC
       LIMIT ${filter.limit}
    `;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Payments
  // ────────────────────────────────────────────────────────────────────────

  /** Tender breakdown, both directions — the till reconciliation view. */
  async paymentsByMethod(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{ method: string; direction: string; count: number; amount: bigint }>
    >`
      SELECT p.method::text    AS method,
             p.direction::text AS direction,
             count(*)::int     AS count,
             SUM(p.amount)::bigint AS amount
        FROM payment p
       WHERE p.organization_id = ${org}::uuid
         AND p.status = 'COMPLETED'
         AND p.created_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter, 'p')}
         ${filter.paymentMethod ? Prisma.sql`AND p.method = ${filter.paymentMethod}::"PaymentMethod"` : Prisma.empty}
       GROUP BY p.method, p.direction
       ORDER BY amount DESC
    `;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Debt
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Receivables with aging buckets — §28.2.
   *
   * Aging is computed from `due_date` against today, not stored: a bucket that
   * needs a nightly job to stay true is a bucket that is wrong every morning.
   */
  async debtSummary(filter: ReportFilter) {
    const { org } = this.scope(filter);

    const [row] = await this.read.$queryRaw<
      Array<{
        original: bigint;
        paid: bigint;
        written_off: bigint;
        outstanding: bigint;
        current: bigint;
        due_today: bigint;
        overdue_30: bigint;
        overdue_60: bigint;
        overdue_60_plus: bigint;
        debtors: number;
      }>
    >`
      SELECT COALESCE(SUM(original_amount), 0)::bigint    AS original,
             COALESCE(SUM(paid_amount), 0)::bigint        AS paid,
             COALESCE(SUM(written_off_amount), 0)::bigint AS written_off,
             COALESCE(SUM(remaining) FILTER (WHERE open), 0)::bigint        AS outstanding,
             COALESCE(SUM(remaining) FILTER (WHERE open AND due_date > CURRENT_DATE), 0)::bigint
               AS current,
             COALESCE(SUM(remaining) FILTER (WHERE open AND due_date = CURRENT_DATE), 0)::bigint
               AS due_today,
             COALESCE(SUM(remaining) FILTER (WHERE open
               AND due_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1), 0)::bigint
               AS overdue_30,
             COALESCE(SUM(remaining) FILTER (WHERE open
               AND due_date BETWEEN CURRENT_DATE - 60 AND CURRENT_DATE - 31), 0)::bigint
               AS overdue_60,
             COALESCE(SUM(remaining) FILTER (WHERE open AND due_date < CURRENT_DATE - 60), 0)::bigint
               AS overdue_60_plus,
             count(DISTINCT customer_id) FILTER (WHERE open AND remaining > 0)::int AS debtors
        FROM (
          SELECT r.customer_id, r.due_date, r.original_amount, r.paid_amount,
                 r.written_off_amount,
                 r.original_amount - r.paid_amount - r.written_off_amount AS remaining,
                 r.status IN ('OPEN', 'PARTIALLY_PAID') AS open
            FROM customer_receivable r
           WHERE r.organization_id = ${org}::uuid
             ${this.storeClause(filter, 'r')}
             ${filter.customerId ? Prisma.sql`AND r.customer_id = ${filter.customerId}::uuid` : Prisma.empty}
        ) t
    `;

    return row!;
  }

  /** Who owes the most, and how overdue they are. */
  async topDebtors(filter: ReportFilter) {
    const { org } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        customer_id: string;
        full_name: string;
        phone: string | null;
        outstanding: bigint;
        overdue: bigint;
        open_debts: number;
        oldest_due: Date | null;
      }>
    >`
      SELECT c.id AS customer_id, c.full_name, c.phone,
             SUM(r.original_amount - r.paid_amount - r.written_off_amount)::bigint AS outstanding,
             COALESCE(SUM(r.original_amount - r.paid_amount - r.written_off_amount)
               FILTER (WHERE r.due_date < CURRENT_DATE), 0)::bigint AS overdue,
             count(*)::int AS open_debts,
             min(r.due_date) AS oldest_due
        FROM customer_receivable r
        JOIN customer c ON c.id = r.customer_id
       WHERE r.organization_id = ${org}::uuid
         AND r.status IN ('OPEN', 'PARTIALLY_PAID')
         ${this.storeClause(filter, 'r')}
       GROUP BY c.id, c.full_name, c.phone
      HAVING SUM(r.original_amount - r.paid_amount - r.written_off_amount) > 0
       ORDER BY outstanding DESC
       LIMIT ${filter.limit}
    `;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Inventory
  // ────────────────────────────────────────────────────────────────────────

  /** Valuation and health, per §28.2. */
  async inventorySummary(filter: ReportFilter) {
    const { org } = this.scope(filter);
    const warehouse = filter.warehouseId
      ? Prisma.sql`AND l.warehouse_id = ${filter.warehouseId}::uuid`
      : Prisma.empty;

    const [row] = await this.read.$queryRaw<
      Array<{
        tracked: number;
        stock_value: bigint;
        units: string;
        out_of_stock: number;
        low_stock: number;
      }>
    >`
      SELECT count(*)::int AS tracked,
             COALESCE(SUM(value), 0)::bigint AS stock_value,
             COALESCE(SUM(qty), 0)::text AS units,
             count(*) FILTER (WHERE qty <= 0)::int AS out_of_stock,
             count(*) FILTER (WHERE qty > 0 AND min_stock > 0 AND qty <= min_stock)::int
               AS low_stock
        FROM (
          SELECT COALESCE(SUM(l.quantity), 0) AS qty,
                 COALESCE(SUM(l.quantity * l.avg_cost), 0) AS value,
                 v.min_stock
            FROM product_variant v
            JOIN product p ON p.id = v.product_id
            LEFT JOIN inventory_level l ON l.product_variant_id = v.id ${warehouse}
           WHERE v.organization_id = ${org}::uuid
             AND v.archived_at IS NULL AND p.archived_at IS NULL
             ${filter.categoryId ? Prisma.sql`AND p.category_id = ${filter.categoryId}::uuid` : Prisma.empty}
           GROUP BY v.id, v.min_stock
        ) t
    `;

    return row!;
  }

  /** Movement volume by type over the period — the stock-change report. */
  async movementSummary(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{ type: string; movements: number; quantity: string; value: bigint }>
    >`
      SELECT m.type::text AS type,
             count(*)::int AS movements,
             SUM(m.quantity_delta)::text AS quantity,
             COALESCE(SUM(round(m.quantity_delta * COALESCE(m.unit_cost, 0))), 0)::bigint AS value
        FROM inventory_movement m
       WHERE m.organization_id = ${org}::uuid
         AND m.created_at BETWEEN ${from} AND ${to}
         ${filter.warehouseId ? Prisma.sql`AND m.warehouse_id = ${filter.warehouseId}::uuid` : Prisma.empty}
       GROUP BY m.type
       ORDER BY movements DESC
    `;
  }

  /** The re-order list: out of stock, or at or below the minimum. */
  async lowStock(filter: ReportFilter) {
    const { org } = this.scope(filter);
    const warehouse = filter.warehouseId
      ? Prisma.sql`AND l.warehouse_id = ${filter.warehouseId}::uuid`
      : Prisma.empty;

    return this.read.$queryRaw<
      Array<{
        variant_id: string;
        sku: string;
        name: string;
        quantity: string;
        min_stock: string;
        status: string;
      }>
    >`
      SELECT v.id AS variant_id, v.sku,
             CASE WHEN v.name IS NULL THEN p.name ELSE p.name || ' · ' || v.name END AS name,
             COALESCE(SUM(l.quantity), 0)::text AS quantity,
             v.min_stock::text AS min_stock,
             CASE WHEN COALESCE(SUM(l.quantity), 0) <= 0 THEN 'OUT_OF_STOCK'
                  ELSE 'LOW_STOCK' END AS status
        FROM product_variant v
        JOIN product p ON p.id = v.product_id
        LEFT JOIN inventory_level l ON l.product_variant_id = v.id ${warehouse}
       WHERE v.organization_id = ${org}::uuid
         AND v.archived_at IS NULL AND p.archived_at IS NULL
       GROUP BY v.id, v.sku, v.name, v.min_stock, p.name
      HAVING COALESCE(SUM(l.quantity), 0) <= 0
          OR (v.min_stock > 0 AND COALESCE(SUM(l.quantity), 0) <= v.min_stock)
       ORDER BY COALESCE(SUM(l.quantity), 0) ASC
       LIMIT ${filter.limit}
    `;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Procurement, returns, customers, cash
  // ────────────────────────────────────────────────────────────────────────

  /** Spend and settlement per supplier — §28.2. */
  async supplierSpend(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        supplier_id: string;
        name: string;
        purchases: number;
        purchased: bigint;
        paid: bigint;
        payable: bigint;
      }>
    >`
      SELECT sup.id AS supplier_id, sup.name,
             count(p.id)::int                    AS purchases,
             COALESCE(SUM(p.total_amount), 0)::bigint AS purchased,
             COALESCE(SUM(p.paid_amount), 0)::bigint  AS paid,
             COALESCE(SUM(p.total_amount - p.paid_amount), 0)::bigint AS payable
        FROM supplier sup
        LEFT JOIN purchase p
               ON p.supplier_id = sup.id
              AND p.status IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED')
              AND p.created_at BETWEEN ${from} AND ${to}
              ${this.storeClause(filter, 'p')}
       WHERE sup.organization_id = ${org}::uuid
       GROUP BY sup.id, sup.name
      HAVING count(p.id) > 0
       ORDER BY purchased DESC
       LIMIT ${filter.limit}
    `;
  }

  /** Purchase volume by status. */
  async purchaseSummary(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{ status: string; count: number; total: bigint; paid: bigint }>
    >`
      SELECT p.status::text AS status,
             count(*)::int  AS count,
             SUM(p.total_amount)::bigint AS total,
             SUM(p.paid_amount)::bigint  AS paid
        FROM purchase p
       WHERE p.organization_id = ${org}::uuid
         AND p.created_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter, 'p')}
       GROUP BY p.status
       ORDER BY total DESC
    `;
  }

  /**
   * Returns: the rate, the reasons and the worst products — §28.2.
   *
   * The rate is refunds over gross sales in the same window, which is the
   * number a manager actually watches.
   */
  async returnsSummary(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{ reason: string; count: number; refunded: bigint; quantity: string }>
    >`
      SELECT r.reason::text AS reason,
             count(DISTINCT r.id)::int AS count,
             SUM(r.refund_amount + r.credit_offset_amount)::bigint AS refunded,
             COALESCE((SELECT SUM(ri.quantity) FROM return_item ri
                        WHERE ri.return_id = ANY(array_agg(r.id))), 0)::text AS quantity
        FROM sale_return r
       WHERE r.organization_id = ${org}::uuid
         AND r.created_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter, 'r')}
       GROUP BY r.reason
       ORDER BY refunded DESC
    `;
  }

  /** The customers who spend the most, with what they still owe. */
  async topCustomers(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        customer_id: string;
        full_name: string;
        phone: string | null;
        sales_count: number;
        spent: bigint;
        outstanding: bigint;
      }>
    >`
      SELECT c.id AS customer_id, c.full_name, c.phone,
             count(s.id)::int AS sales_count,
             COALESCE(SUM(s.total_amount), 0)::bigint AS spent,
             COALESCE((SELECT SUM(r.original_amount - r.paid_amount - r.written_off_amount)
                         FROM customer_receivable r
                        WHERE r.customer_id = c.id
                          AND r.status IN ('OPEN', 'PARTIALLY_PAID')), 0)::bigint AS outstanding
        FROM customer c
        JOIN sale s ON s.customer_id = c.id
                   AND s.status = 'COMPLETED'
                   AND s.completed_at BETWEEN ${from} AND ${to}
       WHERE c.organization_id = ${org}::uuid
         ${this.storeClause(filter)}
       GROUP BY c.id, c.full_name, c.phone
       ORDER BY spent DESC
       LIMIT ${filter.limit}
    `;
  }

  /** Per-shift reconciliation for the period — §28.2. */
  async cashSummary(filter: ReportFilter) {
    const { org, from, to } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        shift_id: string;
        shift_number: string;
        status: string;
        register_code: string;
        opened_at: Date;
        closed_at: Date | null;
        opening: bigint;
        expected: bigint | null;
        counted: bigint | null;
        difference: bigint | null;
      }>
    >`
      SELECT sh.id AS shift_id, sh.shift_number, sh.status::text AS status,
             cr.code AS register_code,
             sh.opened_at, sh.closed_at,
             sh.opening_amount        AS opening,
             sh.expected_cash_amount  AS expected,
             sh.counted_cash_amount   AS counted,
             sh.difference_amount     AS difference
        FROM cash_register_shift sh
        JOIN cash_register cr ON cr.id = sh.cash_register_id
       WHERE sh.organization_id = ${org}::uuid
         AND sh.opened_at BETWEEN ${from} AND ${to}
         ${this.storeClause(filter, 'sh')}
       ORDER BY sh.opened_at DESC
       LIMIT ${filter.limit}
    `;
  }

  /** The most recent completed sales, for the dashboard's feed. */
  async recentSales(filter: ReportFilter) {
    const { org } = this.scope(filter);

    return this.read.$queryRaw<
      Array<{
        id: string;
        sale_number: string;
        total: bigint;
        credit: bigint;
        completed_at: Date;
        cashier: string;
        customer: string | null;
        lines: number;
      }>
    >`
      SELECT s.id, s.sale_number, s.total_amount AS total, s.credit_amount AS credit,
             s.completed_at,
             u.full_name AS cashier,
             c.full_name AS customer,
             (SELECT count(*)::int FROM sale_item i WHERE i.sale_id = s.id) AS lines
        FROM sale s
        JOIN app_user u ON u.id = s.created_by
        LEFT JOIN customer c ON c.id = s.customer_id
       WHERE s.organization_id = ${org}::uuid
         AND s.status = 'COMPLETED'
         ${this.storeClause(filter)}
       ORDER BY s.completed_at DESC
       LIMIT ${filter.limit}
    `;
  }
}
