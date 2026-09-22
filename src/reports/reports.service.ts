import { Injectable } from '@nestjs/common';

import type { TenantContext } from '../common/tenant/tenant-context';
import { AssignmentsService } from '../employees/assignments.service';
import { isOrgWide } from '../rbac/permissions';
import type { ExportQueryDto, ReportFilter, ReportQueryDto } from './dto/report.dto';
import { ReportsRepository } from './reports.repository';

/** An unbounded report is the one that takes the database down. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Reports and dashboard metrics — docs/ARCHITECTURE.md §28.
 *
 * This layer resolves the filter, calls the repository and shapes the
 * response. It contains no arithmetic over rows: everything is aggregated in
 * PostgreSQL, so a year of sales is a few index scans rather than a few
 * hundred thousand objects in Node's heap.
 *
 * Money crosses the boundary as strings, exactly as everywhere else — a BIGINT
 * total above 2^53 is a real soʻm figure, not a theoretical one.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly assignments: AssignmentsService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────
  // Sales
  // ────────────────────────────────────────────────────────────────────────

  /**
   * The sales report.
   *
   * Revenue is gross less refunds, margin is revenue less cost, and both are
   * stated so a reader never has to guess which one a number is.
   */
  async sales(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const [summary, byDay, byEmployee] = await Promise.all([
      this.repo.salesSummary(filter),
      this.repo.salesByDay(filter),
      this.repo.salesByEmployee(filter),
    ]);

    const gross = summary.gross;
    const refunds = summary.refunds;
    const revenue = gross - refunds;
    const margin = gross - summary.cost - refunds;

    return {
      period: { from: filter.from, to: filter.to },
      summary: {
        salesCount: summary.sales_count,
        gross: gross.toString(),
        refunds: refunds.toString(),
        revenue: revenue.toString(),
        discount: summary.discount.toString(),
        cost: summary.cost.toString(),
        margin: margin.toString(),
        marginPercent: gross > 0n ? Number((margin * 10_000n) / gross) / 100 : 0,
        creditIssued: summary.credit.toString(),
        unitsSold: summary.units,
        averageCheck:
          summary.sales_count > 0 ? (revenue / BigInt(summary.sales_count)).toString() : '0',
      },
      // Business date, not UTC date (§28.5) — a sale at 00:30 belongs to the
      // evening that produced it.
      byDay: byDay.map((d) => ({
        date: d.business_date,
        salesCount: d.sales_count,
        gross: d.gross.toString(),
        cost: d.cost.toString(),
        margin: (d.gross - d.cost).toString(),
        discount: d.discount.toString(),
      })),
      byEmployee: byEmployee.map(toEmployeeRow),
    };
  }

  async products(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const [products, categories] = await Promise.all([
      this.repo.topProducts(filter),
      this.repo.topCategories(filter),
    ]);

    return {
      period: { from: filter.from, to: filter.to },
      products: products.map((p) => ({
        variantId: p.variant_id,
        name: p.name,
        sku: p.sku,
        quantitySold: p.quantity,
        quantityReturned: p.returned,
        revenue: p.revenue.toString(),
        cost: p.cost.toString(),
        margin: (p.revenue - p.cost).toString(),
      })),
      categories: categories.map((c) => ({
        categoryId: c.category_id,
        name: c.name,
        revenue: c.revenue.toString(),
        quantity: c.quantity,
      })),
    };
  }

  async employees(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const rows = await this.repo.salesByEmployee(filter);
    return { period: { from: filter.from, to: filter.to }, data: rows.map(toEmployeeRow) };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Money
  // ────────────────────────────────────────────────────────────────────────

  async payments(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const rows = await this.repo.paymentsByMethod(filter);

    const taken = rows.filter((r) => r.direction === 'IN').reduce((sum, r) => sum + r.amount, 0n);
    const refunded = rows
      .filter((r) => r.direction === 'OUT')
      .reduce((sum, r) => sum + r.amount, 0n);

    return {
      period: { from: filter.from, to: filter.to },
      summary: {
        taken: taken.toString(),
        refunded: refunded.toString(),
        net: (taken - refunded).toString(),
      },
      byMethod: rows.map((r) => ({
        method: r.method,
        direction: r.direction,
        count: r.count,
        amount: r.amount.toString(),
      })),
    };
  }

  async debt(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const [summary, debtors] = await Promise.all([
      this.repo.debtSummary(filter),
      this.repo.topDebtors(filter),
    ]);

    return {
      summary: {
        issued: summary.original.toString(),
        collected: summary.paid.toString(),
        writtenOff: summary.written_off.toString(),
        outstanding: summary.outstanding.toString(),
        debtors: summary.debtors,
      },
      // Computed from due_date against today, not stored: a bucket that needs
      // a nightly job to stay true is a bucket that is wrong every morning.
      aging: {
        current: summary.current.toString(),
        dueToday: summary.due_today.toString(),
        overdue1to30: summary.overdue_30.toString(),
        overdue31to60: summary.overdue_60.toString(),
        overdue60plus: summary.overdue_60_plus.toString(),
      },
      topDebtors: debtors.map((d) => ({
        customerId: d.customer_id,
        fullName: d.full_name,
        phone: d.phone,
        outstanding: d.outstanding.toString(),
        overdue: d.overdue.toString(),
        openDebts: d.open_debts,
        oldestDueDate: d.oldest_due,
      })),
    };
  }

  async cash(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const shifts = await this.repo.cashSummary(filter);

    const closed = shifts.filter((s) => s.status === 'CLOSED');
    const totalDifference = closed.reduce((sum, s) => sum + (s.difference ?? 0n), 0n);

    return {
      period: { from: filter.from, to: filter.to },
      summary: {
        shifts: shifts.length,
        open: shifts.length - closed.length,
        closed: closed.length,
        // The number a manager actually watches: are the tills consistently
        // short, and by how much.
        netDifference: totalDifference.toString(),
        shortages: closed.filter((s) => (s.difference ?? 0n) < 0n).length,
        overages: closed.filter((s) => (s.difference ?? 0n) > 0n).length,
      },
      shifts: shifts.map((s) => ({
        shiftId: s.shift_id,
        shiftNumber: s.shift_number,
        register: s.register_code,
        status: s.status,
        openedAt: s.opened_at,
        closedAt: s.closed_at,
        opening: s.opening.toString(),
        expected: s.expected?.toString() ?? null,
        counted: s.counted?.toString() ?? null,
        difference: s.difference?.toString() ?? null,
      })),
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Stock and procurement
  // ────────────────────────────────────────────────────────────────────────

  async inventory(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const [summary, movements, low] = await Promise.all([
      this.repo.inventorySummary(filter),
      this.repo.movementSummary(filter),
      this.repo.lowStock(filter),
    ]);

    return {
      period: { from: filter.from, to: filter.to },
      summary: {
        trackedVariants: summary.tracked,
        // Valuation at moving average cost (§8.6), which is what the stock is
        // worth to the business rather than what it would sell for.
        stockValue: summary.stock_value.toString(),
        units: summary.units,
        outOfStock: summary.out_of_stock,
        lowStock: summary.low_stock,
      },
      movements: movements.map((m) => ({
        type: m.type,
        movements: m.movements,
        quantity: m.quantity,
        value: m.value.toString(),
      })),
      needsOrdering: low.map((l) => ({
        variantId: l.variant_id,
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        minStock: l.min_stock,
        status: l.status,
      })),
    };
  }

  async suppliers(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const [spend, purchases] = await Promise.all([
      this.repo.supplierSpend(filter),
      this.repo.purchaseSummary(filter),
    ]);

    return {
      period: { from: filter.from, to: filter.to },
      suppliers: spend.map((s) => ({
        supplierId: s.supplier_id,
        name: s.name,
        purchases: s.purchases,
        purchased: s.purchased.toString(),
        paid: s.paid.toString(),
        payable: s.payable.toString(),
      })),
      purchasesByStatus: purchases.map((p) => ({
        status: p.status,
        count: p.count,
        total: p.total.toString(),
        paid: p.paid.toString(),
      })),
    };
  }

  async returns(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const [reasons, sales] = await Promise.all([
      this.repo.returnsSummary(filter),
      this.repo.salesSummary(filter),
    ]);

    const refunded = reasons.reduce((sum, r) => sum + r.refunded, 0n);

    return {
      period: { from: filter.from, to: filter.to },
      summary: {
        returns: reasons.reduce((sum, r) => sum + r.count, 0),
        refunded: refunded.toString(),
        grossSales: sales.gross.toString(),
        // The number a manager watches: what share of what we sold came back.
        returnRate: sales.gross > 0n ? Number((refunded * 10_000n) / sales.gross) / 100 : 0,
      },
      byReason: reasons.map((r) => ({
        reason: r.reason,
        count: r.count,
        refunded: r.refunded.toString(),
        quantity: r.quantity,
      })),
    };
  }

  async customers(query: ReportQueryDto, tenant: TenantContext) {
    const filter = await this.resolve(query, tenant);
    const rows = await this.repo.topCustomers(filter);

    return {
      period: { from: filter.from, to: filter.to },
      data: rows.map((c) => ({
        customerId: c.customer_id,
        fullName: c.full_name,
        phone: c.phone,
        salesCount: c.sales_count,
        spent: c.spent.toString(),
        outstanding: c.outstanding.toString(),
        averageCheck: c.sales_count > 0 ? (c.spent / BigInt(c.sales_count)).toString() : '0',
      })),
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Dashboard
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Everything the home screen shows, in one round of parallel queries.
   *
   * Six statements rather than a dozen sequential ones, and not a single row
   * loaded to be counted in Node. "Today" is the store's day, not UTC's
   * (§28.5).
   */
  async dashboard(query: ReportQueryDto, tenant: TenantContext) {
    const today = await this.resolve({ ...query, from: startOfToday().toISOString() }, tenant);
    const recent = { ...today, limit: 10 };

    const [sales, products, categories, payments, debt, inventory, cash, feed] = await Promise.all([
      this.repo.salesSummary(today),
      this.repo.topProducts({ ...today, limit: 5 }),
      this.repo.topCategories({ ...today, limit: 5 }),
      this.repo.paymentsByMethod(today),
      this.repo.debtSummary(today),
      this.repo.inventorySummary(today),
      this.repo.cashSummary({ ...today, limit: 5 }),
      this.repo.recentSales(recent),
    ]);

    const revenue = sales.gross - sales.refunds;

    return {
      today: {
        revenue: revenue.toString(),
        gross: sales.gross.toString(),
        refunds: sales.refunds.toString(),
        salesCount: sales.sales_count,
        unitsSold: sales.units,
        margin: (sales.gross - sales.cost - sales.refunds).toString(),
        averageCheck:
          sales.sales_count > 0 ? (revenue / BigInt(sales.sales_count)).toString() : '0',
        creditIssued: sales.credit.toString(),
      },
      stock: {
        value: inventory.stock_value.toString(),
        lowStock: inventory.low_stock,
        outOfStock: inventory.out_of_stock,
      },
      debt: {
        outstanding: debt.outstanding.toString(),
        overdue: (debt.overdue_30 + debt.overdue_60 + debt.overdue_60_plus).toString(),
        dueToday: debt.due_today.toString(),
        debtors: debt.debtors,
      },
      cash: {
        openShifts: cash.filter((s) => s.status === 'OPEN').length,
        shifts: cash.map((s) => ({
          shiftNumber: s.shift_number,
          register: s.register_code,
          status: s.status,
          expected: s.expected?.toString() ?? null,
          difference: s.difference?.toString() ?? null,
        })),
      },
      paymentBreakdown: payments
        .filter((p) => p.direction === 'IN')
        .map((p) => ({ method: p.method, count: p.count, amount: p.amount.toString() })),
      topProducts: products.map((p) => ({
        variantId: p.variant_id,
        name: p.name,
        quantity: p.quantity,
        revenue: p.revenue.toString(),
      })),
      topCategories: categories.map((c) => ({
        name: c.name,
        revenue: c.revenue.toString(),
      })),
      recentSales: feed.map((s) => ({
        id: s.id,
        saleNumber: s.sale_number,
        total: s.total.toString(),
        credit: s.credit.toString(),
        lines: s.lines,
        cashier: s.cashier,
        customer: s.customer,
        completedAt: s.completed_at,
      })),
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Export
  // ────────────────────────────────────────────────────────────────────────

  /**
   * CSV, generated synchronously.
   *
   * §28.4 proposes an `export_job` table and a worker for anything over 5,000
   * rows. Every report here is capped at 500 by the filter, so the job table,
   * the worker and the download-link flow would be infrastructure for a case
   * that cannot currently occur. Add them when a report needs to exceed the
   * cap — the boundary is this one method.
   */
  async exportCsv(query: ExportQueryDto, tenant: TenantContext): Promise<string> {
    const filter = await this.resolve(query, tenant);

    switch (query.report) {
      case 'top-products': {
        const rows = await this.repo.topProducts(filter);
        return toCsv(
          ['sku', 'name', 'quantity', 'returned', 'revenue', 'cost', 'margin'],
          rows.map((r) => [
            r.sku,
            r.name,
            r.quantity,
            r.returned,
            r.revenue.toString(),
            r.cost.toString(),
            (r.revenue - r.cost).toString(),
          ]),
        );
      }
      case 'employees': {
        const rows = await this.repo.salesByEmployee(filter);
        return toCsv(
          ['employee', 'sales', 'gross', 'cost', 'margin', 'discount'],
          rows.map((r) => [
            r.full_name,
            String(r.sales_count),
            r.gross.toString(),
            r.cost.toString(),
            (r.gross - r.cost).toString(),
            r.discount.toString(),
          ]),
        );
      }
      case 'low-stock': {
        const rows = await this.repo.lowStock(filter);
        return toCsv(
          ['sku', 'name', 'quantity', 'minStock', 'status'],
          rows.map((r) => [r.sku, r.name, r.quantity, r.min_stock, r.status]),
        );
      }
      case 'top-debtors': {
        const rows = await this.repo.topDebtors(filter);
        return toCsv(
          ['customer', 'phone', 'outstanding', 'overdue', 'openDebts'],
          rows.map((r) => [
            r.full_name,
            r.phone ?? '',
            r.outstanding.toString(),
            r.overdue.toString(),
            String(r.open_debts),
          ]),
        );
      }
      case 'suppliers': {
        const rows = await this.repo.supplierSpend(filter);
        return toCsv(
          ['supplier', 'purchases', 'purchased', 'paid', 'payable'],
          rows.map((r) => [
            r.name,
            String(r.purchases),
            r.purchased.toString(),
            r.paid.toString(),
            r.payable.toString(),
          ]),
        );
      }
      default: {
        const rows = await this.repo.salesByDay(filter);
        return toCsv(
          ['date', 'sales', 'gross', 'cost', 'margin', 'discount'],
          rows.map((r) => [
            r.business_date.toISOString().slice(0, 10),
            String(r.sales_count),
            r.gross.toString(),
            r.cost.toString(),
            (r.gross - r.cost).toString(),
            r.discount.toString(),
          ]),
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────

  /**
   * The filter, resolved once — and the only place authorization happens.
   *
   * This is the one module whose SQL bypasses the Prisma tenant extension, so
   * both scopes are applied by hand here:
   *
   * - **Tenant** — the organization comes from the verified token, never the
   *   query. A forgotten line leaks a tenant.
   * - **Store** — §20.4 layer 3. `reports.read` says a manager may read
   *   reports; it does not say which branch's. An explicit `storeId` is
   *   checked against their memberships, and without one they get their own
   *   stores rather than the organization.
   */
  private async resolve(query: ReportQueryDto, tenant: TenantContext): Promise<ReportFilter> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);

    let storeIds: string[] = [];
    if (query.storeId) {
      await this.assignments.assertStoreAccess(tenant, query.storeId);
      storeIds = [query.storeId];
    } else if (!isOrgWide(tenant.permissions)) {
      // An owner reads the whole organization; everybody else reads the
      // branches they actually work in.
      storeIds = await this.assignments.storesFor(tenant);
      if (!storeIds.length) storeIds = [tenant.storeId];
    }

    return {
      organizationId: tenant.organizationId,
      from,
      to,
      storeIds,
      warehouseId: query.warehouseId,
      employeeId: query.employeeId,
      customerId: query.customerId,
      categoryId: query.categoryId,
      productId: query.productId,
      paymentMethod: query.paymentMethod,
      limit: query.limit ?? 20,
    };
  }
}

function toEmployeeRow(r: {
  user_id: string;
  full_name: string;
  sales_count: number;
  gross: bigint;
  cost: bigint;
  discount: bigint;
}) {
  return {
    userId: r.user_id,
    fullName: r.full_name,
    salesCount: r.sales_count,
    gross: r.gross.toString(),
    cost: r.cost.toString(),
    margin: (r.gross - r.cost).toString(),
    discountGiven: r.discount.toString(),
    averageCheck: r.sales_count > 0 ? (r.gross / BigInt(r.sales_count)).toString() : '0',
  };
}

/** Midnight in Asia/Tashkent, which is UTC+5 with no daylight saving. */
function startOfToday(): Date {
  const now = new Date();
  const tashkent = new Date(now.getTime() + 5 * 3_600_000);
  return new Date(
    Date.UTC(tashkent.getUTCFullYear(), tashkent.getUTCMonth(), tashkent.getUTCDate()) -
      5 * 3_600_000,
  );
}

/**
 * RFC 4180 quoting.
 *
 * A product called `Choy, 250g` is not exotic, and a name containing a comma
 * silently shifts every later column when it is not quoted.
 */
function toCsv(headers: readonly string[], rows: readonly string[][]): string {
  const escape = (value: string) =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  return [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
}
