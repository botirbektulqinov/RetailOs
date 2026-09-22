import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { applyGlobalSetup } from '../src/bootstrap';
import { dropStaleTestOrgs, dropTestOrg, seedTestOrg, TEST_PASSWORD } from './helpers/seed-org';
import type { SeededOrg } from './helpers/seed-org';

/**
 * Reporting and dashboard metrics — §28.
 *
 * A report suite that asserts against fixtures proves only that the fixture
 * and the assertion were written by the same person. Every number here is
 * checked against the rows it claims to summarise: the sales total against the
 * sale ledger, the cash figures against the shift's own payments and
 * movements, the debt total against the receivables, and the movement report
 * against the stock it moved. If a query drifts, the reconciliation fails —
 * which is the only failure mode worth catching here.
 */
describe('Reports and dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let managerToken: string;
  let cashierToken: string;
  let warehouseToken: string;

  /** The window every report and every reconciliation query shares. */
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const window = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  let counter = 0;
  const nextCode = () => `RP-${Date.now().toString(36)}-${counter++}`.toUpperCase();

  /** Every fixture's stock comes from this one supplier, so the supplier
   * report's own fixture stays a clean, separately-asserted row. */
  let stockSupplierId: string;

  async function tokenFor(org: SeededOrg, roleCode: string): Promise<string> {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ phone: org.users.get(roleCode)!.phone, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  /**
   * A stocked variant at a known selling price and a known cost.
   *
   * Stock arrives through a received purchase rather than an adjustment,
   * because an adjustment carries no unit cost — `inventory_level.avg_cost`
   * would stay zero and every margin in this suite would be trivially equal to
   * revenue, which is exactly the assertion that proves nothing.
   */
  async function sellable(price: number, cost = 0, quantity = 200): Promise<string> {
    const created = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({
        name: `Hisobot mahsuloti ${counter}`,
        sku: nextCode(),
        sellingPrice: price,
        purchasePrice: cost,
      });
    expect(created.status).toBe(201);
    const variantId = created.body.variants[0].id as string;

    if (quantity > 0) {
      const purchase = await api()
        .post('/api/v1/purchases')
        .set(auth(adminToken))
        .set(idem())
        .send({
          supplierId: stockSupplierId,
          warehouseId: orgA.warehouseId,
          items: [{ variantId, quantity: quantity.toFixed(3), unitCost: cost }],
          order: true,
        });
      expect(purchase.status).toBe(201);

      await api()
        .post(`/api/v1/purchases/${purchase.body.id}/receive`)
        .set(auth(adminToken))
        .set(idem())
        .send({})
        .expect(201);
    }

    return variantId;
  }

  interface SoldSale {
    id: string;
    totalAmount: string;
    items: Array<{ id: string }>;
  }

  async function sell(body: Record<string, unknown>, token = cashierToken): Promise<SoldSale> {
    const res = await api().post('/api/v1/sales/checkout').set(auth(token)).set(idem()).send(body);
    expect(res.status).toBe(201);
    return res.body as SoldSale;
  }

  const report = (name: string, token = adminToken, extra = '') =>
    api().get(`/api/v1/reports/${name}?${window}${extra}`).set(auth(token));

  /** One scalar out of PostgreSQL, so the comparison is against the rows. */
  async function scalar(sql: Prisma.Sql): Promise<string> {
    const rows = await db.$queryRaw<Array<{ v: string | null }>>(sql);
    return rows[0]?.v ?? '0';
  }

  /** The three bindings every reconciliation query repeats. */
  const org = () => Prisma.sql`${orgA.organizationId}::uuid`;
  const since = () => Prisma.sql`${from}::timestamptz AND ${to}::timestamptz`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'repA');
    orgB = await seedTestOrg(db, 'repB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    managerToken = await tokenFor(orgA, 'MANAGER');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    await db.organization.update({
      where: { id: orgA.organizationId },
      data: { maxUsers: 500 },
    });

    const supplier = await api()
      .post('/api/v1/suppliers')
      .set(auth(adminToken))
      .send({ name: 'Zaxira ta’minotchisi', phone: `${orgA.phonePrefix}900099` });
    expect(supplier.status).toBe(201);
    stockSupplierId = supplier.body.id as string;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await dropTestOrg(db, orgA.organizationId);
      await dropTestOrg(db, orgB.organizationId);
      await db.$disconnect();
    }
    await pool?.end();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Sales
  // ──────────────────────────────────────────────────────────────────────

  describe('the sales report against the sale ledger', () => {
    it('gross, count, cost and refunds are exactly what the rows say', async () => {
      const variantId = await sellable(50_000, 30_000);
      await sell({
        items: [{ variantId, quantity: '3.000' }],
        payments: [{ method: 'CASH', amount: 150_000 }],
      });
      const second = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CARD', amount: 100_000 }],
      });
      await api()
        .post('/api/v1/returns')
        .set(auth(managerToken))
        .set(idem())
        .send({
          saleId: second.id,
          items: [{ saleItemId: second.items[0]!.id, quantity: '1.000' }],
          reason: 'DEFECTIVE',
        })
        .expect(201);

      const res = await report('sales');
      expect(res.status).toBe(200);

      const [gross, count, cost, refunds] = await Promise.all([
        scalar(Prisma.sql`
          SELECT COALESCE(SUM(total_amount), 0)::text AS v FROM sale
           WHERE organization_id = ${org()} AND status = 'COMPLETED'
             AND completed_at BETWEEN ${since()}`),
        scalar(Prisma.sql`
          SELECT count(*)::text AS v FROM sale
           WHERE organization_id = ${org()} AND status = 'COMPLETED'
             AND completed_at BETWEEN ${since()}`),
        scalar(Prisma.sql`
          SELECT COALESCE(SUM(cost_amount), 0)::text AS v FROM sale
           WHERE organization_id = ${org()} AND status = 'COMPLETED'
             AND completed_at BETWEEN ${since()}`),
        scalar(Prisma.sql`
          SELECT COALESCE(SUM(refund_amount + credit_offset_amount), 0)::text AS v
            FROM sale_return
           WHERE organization_id = ${org()}
             AND created_at BETWEEN ${since()}`),
      ]);

      expect(res.body.summary.gross).toBe(gross);
      expect(String(res.body.summary.salesCount)).toBe(count);
      expect(res.body.summary.cost).toBe(cost);
      expect(res.body.summary.refunds).toBe(refunds);
      // Revenue and margin are derived, not separately queried — assert the
      // arithmetic so a sign error cannot hide behind two matching totals.
      expect(res.body.summary.revenue).toBe((BigInt(gross) - BigInt(refunds)).toString());
      expect(res.body.summary.margin).toBe(
        (BigInt(gross) - BigInt(cost) - BigInt(refunds)).toString(),
      );
    });

    it('the daily rows add up to the period total', async () => {
      const res = await report('sales');
      const byDay = res.body.byDay as Array<{ gross: string }>;
      const summed = byDay.reduce((sum, d) => sum + BigInt(d.gross), 0n);
      expect(summed.toString()).toBe(res.body.summary.gross);
    });

    it('the per-employee rows add up to the period total', async () => {
      const res = await report('sales');
      const byEmployee = res.body.byEmployee as Array<{ gross: string }>;
      const summed = byEmployee.reduce((sum, e) => sum + BigInt(e.gross), 0n);
      expect(summed.toString()).toBe(res.body.summary.gross);
    });

    it('a cancelled sale leaves the total where it was', async () => {
      const variantId = await sellable(10_000, 6_000, 10);
      const before = (await report('sales')).body.summary.gross as string;

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });
      expect((await report('sales')).body.summary.gross).toBe(
        (BigInt(before) + 10_000n).toString(),
      );

      await api()
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Mijoz fikridan qaytdi' })
        .expect(201);

      // Cancelled is history, not a correction — the row keeps its figures and
      // the report simply stops counting it.
      expect((await report('sales')).body.summary.gross).toBe(before);
    });

    it('groups by business date, not by the UTC date', async () => {
      // Asia/Tashkent is UTC+5, so 20:00 UTC is already tomorrow locally. The
      // report must agree with the cashier's own calendar, not the server's.
      const rows = await db.$queryRaw<Array<{ local: Date }>>`
        SELECT (s.completed_at AT TIME ZONE 'Asia/Tashkent')::date AS local
          FROM sale s
         WHERE s.organization_id = ${orgA.organizationId}::uuid
           AND s.status = 'COMPLETED'
         LIMIT 1`;
      expect(rows).toHaveLength(1);

      const res = await report('sales');
      const dates = (res.body.byDay as Array<{ date: string }>).map((d) => d.date.slice(0, 10));
      expect(dates).toContain(rows[0]!.local.toISOString().slice(0, 10));
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Products
  // ──────────────────────────────────────────────────────────────────────

  describe('the product report', () => {
    it('is net of returns — a returned line is not a sold line', async () => {
      const variantId = await sellable(80_000, 50_000);
      const sale = await sell({
        items: [{ variantId, quantity: '5.000' }],
        payments: [{ method: 'CASH', amount: 400_000 }],
      });
      await api()
        .post('/api/v1/returns')
        .set(auth(managerToken))
        .set(idem())
        .send({
          saleId: sale.id,
          items: [{ saleItemId: sale.items[0]!.id, quantity: '2.000' }],
          reason: 'CHANGED_MIND',
        })
        .expect(201);

      const res = await report('products', adminToken, '&limit=200');
      const row = (res.body.products as Array<Record<string, string>>).find(
        (p) => p['variantId'] === variantId,
      );
      expect(row).toBeDefined();
      expect(Number(row!['quantitySold'])).toBe(5);
      expect(Number(row!['quantityReturned'])).toBe(2);
      // 5 sold at 80,000 less 2 refunded at 80,000.
      expect(row!['revenue']).toBe('240000');
      expect(row!['margin']).toBe((240_000 - 3 * 50_000).toString());
    });

    it('category revenue reconciles with the item rows', async () => {
      const res = await report('products', adminToken, '&limit=200');
      const categories = res.body.categories as Array<{ revenue: string }>;
      const fromCategories = categories.reduce((sum, c) => sum + BigInt(c.revenue), 0n);

      const total = await scalar(Prisma.sql`
        SELECT COALESCE(SUM(i.net_amount - i.refunded_amount), 0)::text AS v
          FROM sale_item i JOIN sale s ON s.id = i.sale_id
         WHERE s.organization_id = ${org()} AND s.status = 'COMPLETED'
           AND s.completed_at BETWEEN ${since()}`);
      expect(fromCategories.toString()).toBe(total);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Payments
  // ──────────────────────────────────────────────────────────────────────

  describe('the payment report against the payment rows', () => {
    it('taken and refunded match the ledger, per direction', async () => {
      const res = await report('payments');
      expect(res.status).toBe(200);

      const [taken, refunded] = await Promise.all([
        scalar(Prisma.sql`
          SELECT COALESCE(SUM(amount), 0)::text AS v FROM payment
           WHERE organization_id = ${org()} AND status = 'COMPLETED' AND direction = 'IN'
             AND created_at BETWEEN ${since()}`),
        scalar(Prisma.sql`
          SELECT COALESCE(SUM(amount), 0)::text AS v FROM payment
           WHERE organization_id = ${org()} AND status = 'COMPLETED' AND direction = 'OUT'
             AND created_at BETWEEN ${since()}`),
      ]);

      expect(res.body.summary.taken).toBe(taken);
      expect(res.body.summary.refunded).toBe(refunded);
      expect(res.body.summary.net).toBe((BigInt(taken) - BigInt(refunded)).toString());

      const byMethod = res.body.byMethod as Array<{ direction: string; amount: string }>;
      const inbound = byMethod
        .filter((m) => m.direction === 'IN')
        .reduce((sum, m) => sum + BigInt(m.amount), 0n);
      expect(inbound.toString()).toBe(taken);
    });

    it('filters to one method without changing what that method totals', async () => {
      interface MethodRow {
        method: string;
        direction: string;
        amount: string;
      }

      const all = await report('payments');
      const cashRow = (all.body.byMethod as MethodRow[]).find(
        (m) => m.method === 'CASH' && m.direction === 'IN',
      );

      const only = await report('payments', adminToken, '&paymentMethod=CASH');
      const rows = only.body.byMethod as MethodRow[];
      const onlyCash = rows.find((m) => m.method === 'CASH' && m.direction === 'IN');

      expect(onlyCash!.amount).toBe(cashRow!.amount);
      expect(rows.every((m) => m.method === 'CASH')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Debt
  // ──────────────────────────────────────────────────────────────────────

  describe('the debt report against the receivables', () => {
    let customerId: string;

    beforeAll(async () => {
      const created = await api()
        .post('/api/v1/customers')
        .set(auth(managerToken))
        .send({
          fullName: 'Qarzdor Hisobotov',
          phone: `${orgA.phonePrefix}900001`,
          creditLimit: 10_000_000,
        });
      expect(created.status).toBe(201);
      customerId = created.body.id as string;

      const variantId = await sellable(200_000, 120_000);
      await sell(
        {
          items: [{ variantId, quantity: '3.000' }],
          payments: [{ method: 'CASH', amount: 200_000 }],
          creditAmount: 400_000,
          customerId,
        },
        managerToken,
      );
    });

    it('outstanding is the sum of what is still open', async () => {
      const res = await report('debt');
      expect(res.status).toBe(200);

      const outstanding = await scalar(Prisma.sql`
        SELECT COALESCE(SUM(original_amount - paid_amount - written_off_amount), 0)::text AS v
          FROM customer_receivable
         WHERE organization_id = ${org()} AND status IN ('OPEN', 'PARTIALLY_PAID')`);
      expect(res.body.summary.outstanding).toBe(outstanding);
      expect(BigInt(outstanding)).toBeGreaterThanOrEqual(400_000n);
    });

    it('the aging buckets add up to outstanding — every soʻm lands in exactly one', async () => {
      const res = await report('debt');
      const a = res.body.aging as Record<string, string>;
      const bucketed =
        BigInt(a['current']!) +
        BigInt(a['dueToday']!) +
        BigInt(a['overdue1to30']!) +
        BigInt(a['overdue31to60']!) +
        BigInt(a['overdue60plus']!);
      expect(bucketed.toString()).toBe(res.body.summary.outstanding);
    });

    it('a collection moves the report, and the ledger moves with it', async () => {
      const before = (await report('debt')).body.summary.outstanding as string;

      await api()
        .post('/api/v1/debts/payments')
        .set(auth(managerToken))
        .set(idem())
        .send({ customerId, amount: 150_000, method: 'CASH' })
        .expect(201);

      const after = (await report('debt')).body.summary.outstanding as string;
      expect(BigInt(after)).toBe(BigInt(before) - 150_000n);

      const ledger = await scalar(Prisma.sql`
        SELECT COALESCE(SUM(original_amount - paid_amount - written_off_amount), 0)::text AS v
          FROM customer_receivable
         WHERE organization_id = ${org()} AND status IN ('OPEN', 'PARTIALLY_PAID')`);
      expect(after).toBe(ledger);
    });

    it('the debtor list agrees with the total it is drawn from', async () => {
      const res = await report('debt', adminToken, '&limit=500');
      const listed = (res.body.topDebtors as Array<{ outstanding: string }>).reduce(
        (sum, d) => sum + BigInt(d.outstanding),
        0n,
      );
      expect(listed.toString()).toBe(res.body.summary.outstanding);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Cash
  // ──────────────────────────────────────────────────────────────────────

  describe('the cash report against the shift ledger', () => {
    let shiftId: string;

    beforeAll(async () => {
      const register = await api()
        .post('/api/v1/cash-registers')
        .set(auth(adminToken))
        .send({ code: nextCode(), name: 'Hisobot kassasi' });
      expect(register.status).toBe(201);

      const shift = await api()
        .post('/api/v1/shifts')
        .set(auth(cashierToken))
        .send({ registerId: register.body.id, openingAmount: 300_000 });
      expect(shift.status).toBe(201);
      shiftId = shift.body.id as string;

      const variantId = await sellable(60_000, 40_000);
      await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 120_000 }],
      });
      await api()
        .post(`/api/v1/shifts/${shiftId}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'OUT', type: 'DROP', amount: 100_000, reason: 'Seyfga' })
        .expect(201);
    });

    it('a closed shift reports the difference the drawer arithmetic produced', async () => {
      const z = await api().get(`/api/v1/shifts/${shiftId}/report`).set(auth(cashierToken));
      expect(z.status).toBe(200);
      const expected = BigInt(z.body.drawer.expected as string);
      // 300,000 float + 120,000 cash sale − 100,000 dropped.
      expect(expected).toBe(320_000n);

      // Count 5,000 short, which is what a real till does.
      const closed = await api()
        .post(`/api/v1/shifts/${shiftId}/close`)
        .set(auth(cashierToken))
        .send({ countedCashAmount: Number(expected) - 5_000 });
      expect(closed.status).toBe(201);

      const res = await report('cash', adminToken, '&limit=500');
      expect(res.status).toBe(200);
      const row = (res.body.shifts as Array<Record<string, string>>).find(
        (s) => s['shiftId'] === shiftId,
      );
      expect(row).toBeDefined();
      expect(row!['expected']).toBe(expected.toString());
      expect(row!['difference']).toBe('-5000');
      expect(res.body.summary.shortages).toBeGreaterThanOrEqual(1);
    });

    it('the net difference is the sum of the stored differences, not a recomputation', async () => {
      const res = await report('cash', adminToken, '&limit=500');
      const stored = await scalar(Prisma.sql`
        SELECT COALESCE(SUM(difference_amount), 0)::text AS v FROM cash_register_shift
         WHERE organization_id = ${org()} AND status = 'CLOSED'
           AND opened_at BETWEEN ${since()}`);
      expect(res.body.summary.netDifference).toBe(stored);
    });

    it('a movement written after the close cannot change what was signed for', async () => {
      const before = (await report('cash', adminToken, '&limit=500')).body.summary
        .netDifference as string;

      // cash_movement is append-only, so the row goes in directly; the point
      // is that the stored snapshot does not move under it.
      await db.$executeRaw`
        INSERT INTO cash_movement (id, organization_id, store_id, cash_register_shift_id,
                                   direction, type, amount, reason, created_by, created_at)
        VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.storeId}::uuid,
                ${shiftId}::uuid, 'OUT', 'EXPENSE', 25000, 'Kech yozilgan',
                ${orgA.users.get('ADMIN')!.id}::uuid, now())`;

      const after = (await report('cash', adminToken, '&limit=500')).body.summary
        .netDifference as string;
      expect(after).toBe(before);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Inventory
  // ──────────────────────────────────────────────────────────────────────

  describe('the inventory report against stock', () => {
    it('stock value is the levels valued at their own average cost', async () => {
      const res = await report('inventory', adminToken, '&limit=500');
      expect(res.status).toBe(200);

      const value = await scalar(Prisma.sql`
        SELECT COALESCE(SUM(l.quantity * l.avg_cost), 0)::bigint::text AS v
          FROM inventory_level l
          JOIN product_variant v ON v.id = l.product_variant_id
          JOIN product p ON p.id = v.product_id
         WHERE v.organization_id = ${org()}
           AND v.archived_at IS NULL AND p.archived_at IS NULL`);
      expect(res.body.summary.stockValue).toBe(value);
    });

    it('the movement report reconciles with the level it moved — §9.7', async () => {
      const variantId = await sellable(70_000, 45_000, 100);
      await sell({
        items: [{ variantId, quantity: '4.000' }],
        payments: [{ method: 'CASH', amount: 280_000 }],
      });

      const rows = await db.$queryRaw<Array<{ level: string; movements: string }>>`
        SELECT l.quantity::text AS level,
               (SELECT COALESCE(SUM(m.quantity_delta), 0)
                  FROM inventory_movement m
                 WHERE m.product_variant_id = l.product_variant_id
                   AND m.warehouse_id = l.warehouse_id)::text AS movements
          FROM inventory_level l
         WHERE l.product_variant_id = ${variantId}::uuid`;

      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.level)).toBe(96);
      // The invariant the whole inventory design exists to hold: the cached
      // level is the sum of the movements that produced it.
      expect(Number(rows[0]!.movements)).toBe(Number(rows[0]!.level));

      const res = await report('inventory', adminToken, '&limit=500');
      const sale = (res.body.movements as Array<Record<string, string>>).find(
        (m) => m['type'] === 'SALE',
      );
      expect(sale).toBeDefined();

      const soldByLedger = await scalar(Prisma.sql`
        SELECT COALESCE(SUM(quantity_delta), 0)::text AS v FROM inventory_movement
         WHERE organization_id = ${org()} AND type = 'SALE'
           AND created_at BETWEEN ${since()}`);
      expect(Number(sale!['quantity'])).toBe(Number(soldByLedger));
      expect(Number(soldByLedger)).toBeLessThan(0);
    });

    it('the re-order list is the variants at or below their minimum', async () => {
      const variantId = await sellable(15_000, 9_000, 5);
      await db.productVariant.update({
        where: { organizationId_id: { organizationId: orgA.organizationId, id: variantId } },
        data: { minStock: '20' },
      });

      const res = await report('inventory', adminToken, '&limit=500');
      const row = (res.body.needsOrdering as Array<Record<string, string>>).find(
        (r) => r['variantId'] === variantId,
      );
      expect(row).toBeDefined();
      expect(row!['status']).toBe('LOW_STOCK');
      expect(Number(row!['quantity'])).toBeLessThanOrEqual(Number(row!['minStock']));
      expect(res.body.summary.lowStock).toBeGreaterThanOrEqual(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Suppliers and returns
  // ──────────────────────────────────────────────────────────────────────

  describe('the supplier and return reports', () => {
    it('supplier spend and payable match the purchase rows', async () => {
      const supplier = await api()
        .post('/api/v1/suppliers')
        .set(auth(adminToken))
        .send({ name: `Hisobot ta'minotchisi ${counter++}`, phone: `${orgA.phonePrefix}900010` });
      expect(supplier.status).toBe(201);

      const variantId = await sellable(30_000, 20_000, 0);
      const purchase = await api()
        .post('/api/v1/purchases')
        .set(auth(adminToken))
        .set(idem())
        .send({
          supplierId: supplier.body.id,
          warehouseId: orgA.warehouseId,
          items: [{ variantId, quantity: '10.000', unitCost: 20_000 }],
        });
      expect(purchase.status).toBe(201);

      await api()
        .post(`/api/v1/purchases/${purchase.body.id}/order`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      const res = await report('suppliers', adminToken, '&limit=500');
      const row = (res.body.suppliers as Array<Record<string, string>>).find(
        (s) => s['supplierId'] === supplier.body.id,
      );
      expect(row).toBeDefined();
      expect(row!['purchased']).toBe('200000');

      const ledger = await scalar(Prisma.sql`
        SELECT COALESCE(SUM(total_amount - paid_amount), 0)::text AS v FROM purchase
         WHERE organization_id = ${org()} AND supplier_id = ${supplier.body.id}::uuid
           AND status IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED')`);
      expect(row!['payable']).toBe(ledger);
    });

    it('the return rate is refunds over gross, from the same window', async () => {
      const res = await report('returns');
      expect(res.status).toBe(200);

      const sales = await report('sales');
      const gross = BigInt(sales.body.summary.gross as string);
      const refunded = BigInt(res.body.summary.refunded as string);

      expect(res.body.summary.grossSales).toBe(gross.toString());
      expect(res.body.summary.returnRate).toBeCloseTo(
        Number((refunded * 10_000n) / gross) / 100,
        2,
      );

      const byReason = (res.body.byReason as Array<{ refunded: string }>).reduce(
        (sum, r) => sum + BigInt(r.refunded),
        0n,
      );
      expect(byReason).toBe(refunded);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Dashboard
  // ──────────────────────────────────────────────────────────────────────

  describe('the dashboard', () => {
    it('agrees with the sales report for the same day', async () => {
      const dash = await api().get('/api/v1/dashboard').set(auth(adminToken));
      expect(dash.status).toBe(200);

      const startOfDay = await db.$queryRaw<Array<{ start: Date }>>`
        SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent')
                AT TIME ZONE 'Asia/Tashkent') AS start`;
      const dayFrom = startOfDay[0]!.start.toISOString();

      const sales = await api()
        .get(`/api/v1/reports/sales?from=${encodeURIComponent(dayFrom)}`)
        .set(auth(adminToken));
      expect(sales.status).toBe(200);

      expect(dash.body.today.gross).toBe(sales.body.summary.gross);
      expect(dash.body.today.salesCount).toBe(sales.body.summary.salesCount);
      expect(dash.body.today.revenue).toBe(sales.body.summary.revenue);
    });

    it('the average check is revenue over the count, not a separate number', async () => {
      const dash = await api().get('/api/v1/dashboard').set(auth(adminToken));
      const { revenue, salesCount, averageCheck } = dash.body.today;
      expect(averageCheck).toBe((BigInt(revenue) / BigInt(salesCount)).toString());
    });

    it('carries stock, debt, cash, payments and a feed in one request', async () => {
      const dash = await api().get('/api/v1/dashboard').set(auth(adminToken));
      expect(dash.body.stock.lowStock).toBeGreaterThanOrEqual(1);
      expect(BigInt(dash.body.debt.outstanding as string)).toBeGreaterThan(0n);
      expect(dash.body.paymentBreakdown.length).toBeGreaterThan(0);
      expect(dash.body.recentSales.length).toBeGreaterThan(0);
      expect(dash.body.recentSales[0]).toHaveProperty('cashier');
      expect(dash.body.cash.shifts.length).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Export
  // ──────────────────────────────────────────────────────────────────────

  describe('CSV export', () => {
    it('is CSV, with a header row and one line per record', async () => {
      const res = await api()
        .get(`/api/v1/reports/export?${window}&report=top-products&limit=5`)
        .set(auth(managerToken));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');

      const lines = res.text.trim().split('\n');
      expect(lines[0]).toBe('sku,name,quantity,returned,revenue,cost,margin');
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.length).toBeLessThanOrEqual(6);
    });

    it('quotes a value containing a comma, so the columns stay put', async () => {
      const created = await api()
        .post('/api/v1/products')
        .set(auth(adminToken))
        .send({ name: 'Choy, 250 g', sku: nextCode(), sellingPrice: 25_000 });
      expect(created.status).toBe(201);
      const variantId = created.body.variants[0].id as string;

      await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '10.000', reason: 'CORRECTION' }],
        })
        .expect(201);
      await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 25_000 }],
      });

      const res = await api()
        .get(`/api/v1/reports/export?${window}&report=top-products&limit=500`)
        .set(auth(managerToken));
      expect(res.status).toBe(200);
      expect(res.text).toContain('"Choy, 250 g"');

      const line = res.text.split('\n').find((l) => l.includes('"Choy, 250 g"'))!;
      // Quoted, so the comma is inside one field: exactly two quote characters
      // and seven columns, not eight.
      expect(line.match(/"/g)).toHaveLength(2);
    });

    it('defaults to the daily sales roll-up when no report is named', async () => {
      const res = await api().get(`/api/v1/reports/export?${window}`).set(auth(managerToken));
      expect(res.status).toBe(200);
      expect(res.text.split('\n')[0]).toBe('date,sales,gross,cost,margin,discount');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Authorization — §20.4
  // ──────────────────────────────────────────────────────────────────────

  describe('who may read a report', () => {
    it('refuses a role without reports.read', async () => {
      const res = await report('sales', warehouseToken);
      expect(res.status).toBe(403);
    });

    it('lets a cashier read but not export — reading and extracting differ', async () => {
      expect((await report('sales', cashierToken)).status).toBe(200);

      const exported = await api()
        .get(`/api/v1/reports/export?${window}&report=top-products`)
        .set(auth(cashierToken));
      expect(exported.status).toBe(403);
    });

    it('refuses a store the caller is not assigned to', async () => {
      const res = await report('sales', managerToken, `&storeId=${orgA.secondStoreId}`);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain('STORE_ACCESS_DENIED');
    });

    it('scopes a manager to their own stores even with no storeId given', async () => {
      // A completed sale in the branch the manager does not work in.
      await db.$executeRaw`
        INSERT INTO sale (id, organization_id, store_id, warehouse_id, sale_number, status,
                          subtotal_amount, total_amount, paid_amount, cost_amount,
                          created_by, completed_at, updated_at)
        VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.secondStoreId}::uuid,
                ${orgA.warehouseId}::uuid, ${`BRANCH-${counter++}`}, 'COMPLETED',
                777000, 777000, 777000, 0,
                ${orgA.users.get('ADMIN')!.id}::uuid, now(), now())`;

      const owner = await report('sales', adminToken);
      const manager = await report('sales', managerToken);

      // The wildcard holder is org-wide; the manager is not.
      expect(BigInt(owner.body.summary.gross as string)).toBe(
        BigInt(manager.body.summary.gross as string) + 777_000n,
      );
    });

    it('never crosses an organization, even though the SQL is raw', async () => {
      const otherAdmin = await tokenFor(orgB, 'ADMIN');
      const res = await api().get(`/api/v1/reports/sales?${window}`).set(auth(otherAdmin));
      expect(res.status).toBe(200);
      expect(res.body.summary.gross).toBe('0');
      expect(res.body.summary.salesCount).toBe(0);
    });

    it('rejects a filter that is not a uuid rather than passing it to SQL', async () => {
      const res = await api().get('/api/v1/reports/sales?storeId=not-a-uuid').set(auth(adminToken));
      expect(res.status).toBe(400);
    });

    it('caps the limit', async () => {
      const res = await api().get('/api/v1/reports/products?limit=100000').set(auth(adminToken));
      expect(res.status).toBe(400);
    });
  });
});
