import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { applyGlobalSetup } from '../src/bootstrap';
import { dropStaleTestOrgs, dropTestOrg, seedTestOrg, TEST_PASSWORD } from './helpers/seed-org';
import type { SeededOrg } from './helpers/seed-org';

/**
 * Promotions, discounts and loyalty — docs/ARCHITECTURE.md §17 and §18.
 *
 * Two invariants: a discount and a redemption are different things, and
 * promotions never stack. Both are asserted against real checkouts, because
 * the unit tests can prove the resolver picks one winner but only an end-to-end
 * sale can prove the winner reaches the receipt.
 */
describe('Promotions and loyalty (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let managerToken: string;
  let cashierToken: string;
  let warehouseToken: string;

  let foreign: { promotionId: string; customerId: string };

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = () => ({ 'Idempotency-Key': randomUUID() });

  async function tokenFor(org: SeededOrg, roleCode: string): Promise<string> {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ phone: org.users.get(roleCode)!.phone, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  let counter = 0;
  const nextSku = () => `PR-${Date.now().toString(36)}-${counter++}`.toUpperCase();
  const nextPhone = () =>
    `+9989${String(30 + (counter % 30))}${String(2_000_000 + counter++).slice(-6)}`;

  const YESTERDAY = () => new Date(Date.now() - 86_400_000).toISOString();
  const TOMORROW = () => new Date(Date.now() + 86_400_000).toISOString();

  async function sellable(
    price: number,
    over: Record<string, unknown> = {},
  ): Promise<{ variantId: string; productId: string }> {
    const created = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({ name: `Aksiya mahsuloti ${counter}`, sku: nextSku(), sellingPrice: price, ...over });
    expect(created.status).toBe(201);
    const variantId = created.body.variants[0].id as string;

    await api()
      .post('/api/v1/inventory/adjustments')
      .set(auth(adminToken))
      .send({
        warehouseId: orgA.warehouseId,
        lines: [{ variantId, quantity: '100.000', reason: 'CORRECTION' }],
      })
      .expect(201);

    return { variantId, productId: created.body.id as string };
  }

  interface CreatedPromotion {
    id: string;
    name: string;
    value: string;
    isActive: boolean;
  }

  async function makePromotion(over: Record<string, unknown> = {}): Promise<CreatedPromotion> {
    const res = await api()
      .post('/api/v1/promotions')
      .set(auth(adminToken))
      .send({
        name: `Aksiya ${counter++}`,
        type: 'PERCENT_OFF',
        scope: 'ITEM',
        value: 10,
        startsAt: YESTERDAY(),
        endsAt: TOMORROW(),
        ...over,
      });
    expect(res.status).toBe(201);
    return res.body as CreatedPromotion;
  }

  async function makeCustomer(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api()
      .post('/api/v1/customers')
      .set(auth(adminToken))
      .send({ fullName: `Sodiq mijoz ${counter}`, phone: nextPhone(), ...over });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  interface SoldSale {
    id: string;
    subtotalAmount: string;
    orderDiscountAmount: string;
    totalAmount: string;
    items: Array<{
      id: string;
      netAmount: string;
      lineDiscountAmount: string;
      allocatedOrderDiscount: string;
      promotionId: string | null;
    }>;
  }

  function checkout(body: Record<string, unknown>, token = managerToken) {
    return api().post('/api/v1/sales/checkout').set(auth(token)).set(idem()).send(body);
  }

  async function sell(body: Record<string, unknown>, token = managerToken): Promise<SoldSale> {
    const res = await checkout(body, token);
    expect(res.status).toBe(201);
    return res.body as SoldSale;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'loyA');
    orgB = await seedTestOrg(db, 'loyB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    managerToken = await tokenFor(orgA, 'MANAGER');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    // 1% earn, 1 point = 1 soʻm — the settings the rest of the suite assumes.
    await db.organizationSettings.update({
      where: { organizationId: orgA.organizationId },
      data: { loyaltyEarnPercent: '1.00', loyaltyPointValue: 1n },
    });

    const foreignPromotion = await db.promotion.create({
      data: {
        organizationId: orgB.organizationId,
        name: 'Begona aksiya',
        type: 'PERCENT_OFF',
        scope: 'ITEM',
        value: '50.00',
        startsAt: new Date(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const foreignCustomer = await db.customer.create({
      data: { organizationId: orgB.organizationId, fullName: 'Begona mijoz' },
      select: { id: true },
    });

    foreign = { promotionId: foreignPromotion.id, customerId: foreignCustomer.id };
  }, 120_000);

  // Campaigns are global by design: one created for an earlier test would
  // still be live for a later one, and every price assertion would depend on
  // the order the tests happened to run in. Each test starts from none.
  beforeEach(async () => {
    if (orgA) {
      await db.promotion.updateMany({
        where: { organizationId: orgA.organizationId },
        data: { isActive: false },
      });
    }
  });

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
  // Promotion management
  // ──────────────────────────────────────────────────────────────────────

  describe('promotion CRUD', () => {
    it('creates, reads, updates and deactivates', async () => {
      const created = await makePromotion({ value: 15, priority: 3 });
      expect(created.value).toBe('15.00');
      expect(created.isActive).toBe(true);

      const read = await api().get(`/api/v1/promotions/${created.id}`).set(auth(managerToken));
      expect(read.status).toBe(200);

      const updated = await api()
        .patch(`/api/v1/promotions/${created.id}`)
        .set(auth(adminToken))
        .send({ value: 20 });
      expect(updated.body.value).toBe('20.00');

      const off = await api()
        .patch(`/api/v1/promotions/${created.id}/deactivate`)
        .set(auth(adminToken));
      expect(off.body.isActive).toBe(false);
    });

    it('rejects a percentage above 100 and a value of zero', async () => {
      await api()
        .post('/api/v1/promotions')
        .set(auth(adminToken))
        .send({
          name: `Yomon ${counter++}`,
          type: 'PERCENT_OFF',
          scope: 'ITEM',
          value: 150,
          startsAt: YESTERDAY(),
        })
        .expect(409);

      await api()
        .post('/api/v1/promotions')
        .set(auth(adminToken))
        .send({
          name: `Nol ${counter++}`,
          type: 'FIXED_OFF',
          scope: 'ITEM',
          value: 0,
          startsAt: YESTERDAY(),
        })
        .expect(400);
    });

    it('refuses a targeted promotion that targets nothing', async () => {
      const res = await api()
        .post('/api/v1/promotions')
        .set(auth(adminToken))
        .send({
          name: `Bo'sh nishon ${counter++}`,
          type: 'PERCENT_OFF',
          scope: 'ITEM',
          value: 10,
          appliesTo: 'CATEGORY',
          startsAt: YESTERDAY(),
        });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a window that ends before it starts', async () => {
      const res = await api()
        .post('/api/v1/promotions')
        .set(auth(adminToken))
        .send({
          name: `Teskari ${counter++}`,
          type: 'PERCENT_OFF',
          scope: 'ITEM',
          value: 10,
          startsAt: TOMORROW(),
          endsAt: YESTERDAY(),
        });
      expect(res.status).toBe(409);
    });

    it('filters to what is live right now', async () => {
      const live = await makePromotion({ value: 5 });
      const future = await makePromotion({
        value: 5,
        startsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      });

      const res = await api()
        .get('/api/v1/promotions')
        .query({ activeNow: 'true', limit: 100 })
        .set(auth(managerToken))
        .expect(200);

      const ids = res.body.data.map((p: { id: string }) => p.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(future.id);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Discounts at checkout
  // ──────────────────────────────────────────────────────────────────────

  describe('item promotions', () => {
    it('applies a percentage to a matching line', async () => {
      const { variantId } = await sellable(100_000);
      await makePromotion({ value: 10, scope: 'ITEM' });

      const sale = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 180_000 }],
      });

      expect(sale.items[0]!.lineDiscountAmount).toBe('20000');
      expect(sale.items[0]!.netAmount).toBe('180000');
      expect(sale.totalAmount).toBe('180000');
      expect(sale.items[0]!.promotionId).not.toBeNull();
    });

    it('applies a fixed amount', async () => {
      const { variantId } = await sellable(50_000);
      await makePromotion({ type: 'FIXED_OFF', value: 7_000, scope: 'ITEM' });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 43_000 }],
      });
      expect(sale.items[0]!.lineDiscountAmount).toBe('7000');
    });

    it('targets a single product and leaves others alone', async () => {
      const target = await sellable(100_000);
      const other = await sellable(100_000);
      await makePromotion({
        value: 25,
        scope: 'ITEM',
        appliesTo: 'PRODUCT',
        productIds: [target.productId],
      });

      const sale = await sell({
        items: [
          { variantId: target.variantId, quantity: '1.000' },
          { variantId: other.variantId, quantity: '1.000' },
        ],
        payments: [{ method: 'CASH', amount: 175_000 }],
      });

      const discounts = sale.items.map((i) => i.lineDiscountAmount).sort();
      expect(discounts).toEqual(['0', '25000']);
    });

    it('does not stack — the best single promotion wins', async () => {
      const { variantId, productId } = await sellable(100_000);
      await makePromotion({ value: 10, scope: 'ITEM', priority: 0 });
      await makePromotion({
        value: 30,
        scope: 'ITEM',
        priority: 0,
        appliesTo: 'PRODUCT',
        productIds: [productId],
      });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 70_000 }],
      });

      // 30% wins outright; 10% + 30% would have been 40,000.
      expect(sale.items[0]!.lineDiscountAmount).toBe('30000');
    });

    it('respects priority over raw value', async () => {
      const { variantId, productId } = await sellable(100_000);
      await makePromotion({ value: 40, scope: 'ITEM', priority: 0 });
      await makePromotion({
        value: 5,
        scope: 'ITEM',
        priority: 9,
        appliesTo: 'PRODUCT',
        productIds: [productId],
      });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 95_000 }],
      });
      expect(sale.items[0]!.lineDiscountAmount).toBe('5000');
    });

    it('a larger manual discount beats the promotion', async () => {
      const { variantId } = await sellable(100_000);
      await makePromotion({ value: 10, scope: 'ITEM' });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000', discountAmount: 30_000 }],
        payments: [{ method: 'CASH', amount: 70_000 }],
      });
      expect(sale.items[0]!.lineDiscountAmount).toBe('30000');
      // The promotion did not win, so it is not attributed.
      expect(sale.items[0]!.promotionId).toBeNull();
    });

    it('ignores an expired promotion', async () => {
      const { variantId, productId } = await sellable(100_000);
      await makePromotion({
        value: 50,
        scope: 'ITEM',
        appliesTo: 'PRODUCT',
        productIds: [productId],
        startsAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
        endsAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });
      expect(sale.items[0]!.lineDiscountAmount).toBe('0');
    });

    it('ignores a deactivated promotion', async () => {
      const { variantId, productId } = await sellable(100_000);
      const promo = await makePromotion({
        value: 50,
        scope: 'ITEM',
        appliesTo: 'PRODUCT',
        productIds: [productId],
      });
      await api()
        .patch(`/api/v1/promotions/${promo.id}/deactivate`)
        .set(auth(adminToken))
        .expect(200);

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });
      expect(sale.items[0]!.lineDiscountAmount).toBe('0');
    });

    it('caps a percentage at maxDiscount', async () => {
      const { variantId, productId } = await sellable(1_000_000);
      await makePromotion({
        value: 50,
        scope: 'ITEM',
        maxDiscount: 100_000,
        appliesTo: 'PRODUCT',
        productIds: [productId],
      });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 900_000 }],
      });
      expect(sale.items[0]!.lineDiscountAmount).toBe('100000');
    });
  });

  describe('order promotions', () => {
    it('applies below-the-line and allocates across the lines', async () => {
      const a = await sellable(60_000);
      const b = await sellable(40_000);
      await makePromotion({ scope: 'ORDER', value: 10 });

      const sale = await sell({
        items: [
          { variantId: a.variantId, quantity: '1.000' },
          { variantId: b.variantId, quantity: '1.000' },
        ],
        payments: [{ method: 'CASH', amount: 90_000 }],
      });

      expect(sale.subtotalAmount).toBe('100000');
      expect(sale.orderDiscountAmount).toBe('10000');
      expect(sale.totalAmount).toBe('90000');

      const allocated = sale.items.reduce((sum, i) => sum + BigInt(i.allocatedOrderDiscount), 0n);
      expect(allocated).toBe(10_000n);
    });

    it('respects minSubtotal', async () => {
      const { variantId } = await sellable(20_000);
      await makePromotion({ scope: 'ORDER', value: 50, minSubtotal: 500_000 });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 20_000 }],
      });
      expect(sale.orderDiscountAmount).toBe('0');
    });

    it('a customer group percentage competes but does not stack', async () => {
      const group = await api()
        .post('/api/v1/customer-groups')
        .set(auth(adminToken))
        .send({ name: `VIP ${counter++}`, discountPercent: 20 })
        .expect(201);
      const customerId = await makeCustomer({ customerGroupId: group.body.id });

      const { variantId } = await sellable(100_000);
      await makePromotion({ scope: 'ORDER', value: 5 });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 80_000 }],
        customerId,
      });

      // 20% group beats the 5% campaign; 25% would mean they stacked.
      expect(sale.orderDiscountAmount).toBe('20000');
      expect(sale.totalAmount).toBe('80000');
    });

    it('keeps a group promotion away from walk-ins', async () => {
      const group = await api()
        .post('/api/v1/customer-groups')
        .set(auth(adminToken))
        .send({ name: `Ulgurji ${counter++}` })
        .expect(201);

      const { variantId } = await sellable(100_000);
      await makePromotion({
        scope: 'ORDER',
        value: 30,
        customerGroupIds: [group.body.id],
      });

      const walkIn = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });
      expect(walkIn.orderDiscountAmount).toBe('0');

      const member = await makeCustomer({ customerGroupId: group.body.id });
      const eligible = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 70_000 }],
        customerId: member,
      });
      expect(eligible.orderDiscountAmount).toBe('30000');
    });

    it('records which promotion priced the order', async () => {
      const { variantId } = await sellable(100_000);
      const promo = await makePromotion({ scope: 'ORDER', value: 10 });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 90_000 }],
      });

      const stored = await db.sale.findUniqueOrThrow({
        where: { id: sale.id },
        select: { promotionId: true },
      });
      expect(stored.promotionId).toBe(promo.id);
    });
  });

  describe('calculation order', () => {
    it('an item promotion then an order promotion, in that order', async () => {
      const { variantId, productId } = await sellable(100_000);
      await makePromotion({
        scope: 'ITEM',
        value: 10,
        appliesTo: 'PRODUCT',
        productIds: [productId],
      });
      await makePromotion({ scope: 'ORDER', value: 10 });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 81_000 }],
      });

      // 100,000 − 10% line = 90,000, then − 10% order = 81,000.
      // Applying both to the gross would have given 80,000.
      expect(sale.subtotalAmount).toBe('90000');
      expect(sale.orderDiscountAmount).toBe('9000');
      expect(sale.totalAmount).toBe('81000');
    });

    it('never makes a line negative', async () => {
      const { variantId, productId } = await sellable(10_000);
      await makePromotion({
        scope: 'ITEM',
        type: 'FIXED_OFF',
        value: 999_000,
        appliesTo: 'PRODUCT',
        productIds: [productId],
      });

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [],
        creditAmount: 0,
      });
      expect(sale.totalAmount).toBe('0');
      expect(sale.items[0]!.netAmount).toBe('0');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Loyalty
  // ──────────────────────────────────────────────────────────────────────

  describe('earning', () => {
    it('awards points on the subtotal, net of discounts', async () => {
      const customerId = await makeCustomer();
      const { variantId } = await sellable(100_000);

      await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
        customerId,
      });

      const balance = await api()
        .get(`/api/v1/loyalty/${customerId}`)
        .set(auth(managerToken))
        .expect(200);

      // 1% of 100,000.
      expect(balance.body.points).toBe('1000');
      expect(balance.body.redeemableAmount).toBe('1000');
      expect(balance.body.lifetimeEarned).toBe('1000');
    });

    it('earns on the discounted subtotal, not the gross', async () => {
      const customerId = await makeCustomer();
      const { variantId, productId } = await sellable(100_000);
      await makePromotion({
        scope: 'ITEM',
        value: 50,
        appliesTo: 'PRODUCT',
        productIds: [productId],
      });

      await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 50_000 }],
        customerId,
      });

      const balance = await api().get(`/api/v1/loyalty/${customerId}`).set(auth(managerToken));
      expect(balance.body.points).toBe('500');
    });

    it('awards nothing to a walk-in', async () => {
      const { variantId } = await sellable(100_000);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });

      const ledger = await db.loyaltyTransaction.count({ where: { saleId: sale.id } });
      expect(ledger).toBe(0);
    });

    it('writes the ledger row the balance is derived from', async () => {
      const customerId = await makeCustomer();
      const { variantId } = await sellable(200_000);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 200_000 }],
        customerId,
      });

      const history = await api()
        .get(`/api/v1/loyalty/${customerId}/history`)
        .set(auth(managerToken))
        .expect(200);

      expect(history.body.data).toHaveLength(1);
      expect(history.body.data[0]).toMatchObject({
        type: 'EARN',
        pointsDelta: '2000',
        balanceAfter: '2000',
        saleId: sale.id,
      });
    });
  });

  describe('redeeming', () => {
    it('is a payment, not a discount — revenue is unchanged', async () => {
      const customerId = await makeCustomer();
      const { variantId } = await sellable(100_000);

      // Earn first.
      await sell({
        items: [{ variantId, quantity: '5.000' }],
        payments: [{ method: 'CASH', amount: 500_000 }],
        customerId,
      });
      const before = await api().get(`/api/v1/loyalty/${customerId}`).set(auth(managerToken));
      expect(before.body.points).toBe('5000');

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [
          { method: 'LOYALTY', amount: 5_000 },
          { method: 'CASH', amount: 95_000 },
        ],
        customerId,
      });

      // The sale is still worth 100,000: a redemption settles revenue with a
      // liability, it does not reduce the price.
      expect(sale.subtotalAmount).toBe('100000');
      expect(sale.totalAmount).toBe('100000');
      expect(sale.orderDiscountAmount).toBe('0');

      const after = await api().get(`/api/v1/loyalty/${customerId}`).set(auth(managerToken));
      // 5,000 spent, then 1,000 earned on this sale.
      expect(after.body.points).toBe('1000');
      expect(after.body.lifetimeSpent).toBe('5000');

      const tender = await db.payment.findFirst({
        where: { method: 'LOYALTY', allocations: { some: { saleId: sale.id } } },
        select: { amount: true, direction: true },
      });
      expect(tender).toMatchObject({ amount: 5_000n, direction: 'IN' });
    });

    it('refuses to spend points that were never earned', async () => {
      const customerId = await makeCustomer();
      const { variantId } = await sellable(100_000);

      const res = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [
          { method: 'LOYALTY', amount: 50_000 },
          { method: 'CASH', amount: 50_000 },
        ],
        customerId,
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_POINTS');

      // Nothing was written — not the sale, not the stock.
      const sales = await db.sale.count({
        where: { customerId, organizationId: orgA.organizationId },
      });
      expect(sales).toBe(0);
    });

    it('refuses a redemption with no customer to redeem from', async () => {
      const { variantId } = await sellable(100_000);
      const res = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [
          { method: 'LOYALTY', amount: 10_000 },
          { method: 'CASH', amount: 90_000 },
        ],
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CREDIT_WITHOUT_CUSTOMER');
    });

    it('two tills cannot spend the same points', async () => {
      const customerId = await makeCustomer();
      const { variantId } = await sellable(100_000);

      // Earn 5,000 on a large sale, then try to spend all of it twice on a
      // small one. The small sale earns only 1,000 back, so there is not
      // enough for both — which is the point: a redemption larger than what
      // the new sale itself earns cannot be satisfied twice.
      await sell({
        items: [{ variantId, quantity: '5.000' }],
        payments: [{ method: 'CASH', amount: 500_000 }],
        customerId,
      });

      const spend = () =>
        checkout({
          items: [{ variantId, quantity: '1.000' }],
          payments: [
            { method: 'LOYALTY', amount: 5_000 },
            { method: 'CASH', amount: 95_000 },
          ],
          customerId,
        });

      const [first, second] = await Promise.all([spend(), spend()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('returns reverse the points', () => {
    it('claws back proportionally', async () => {
      const customerId = await makeCustomer();
      const { variantId } = await sellable(100_000);

      const sale = await sell({
        items: [{ variantId, quantity: '4.000' }],
        payments: [{ method: 'CASH', amount: 400_000 }],
        customerId,
      });
      const earned = await api().get(`/api/v1/loyalty/${customerId}`).set(auth(managerToken));
      expect(earned.body.points).toBe('4000');

      await api()
        .post('/api/v1/returns')
        .set(auth(managerToken))
        .set(idem())
        .send({
          saleId: sale.id,
          items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
          reason: 'DEFECTIVE',
        })
        .expect(201);

      const after = await api().get(`/api/v1/loyalty/${customerId}`).set(auth(managerToken));
      // A quarter of the sale came back, so a quarter of the points went.
      expect(after.body.points).toBe('3000');

      const reversal = await db.loyaltyTransaction.findFirst({
        where: { organizationId: orgA.organizationId, returnId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { type: true, pointsDelta: true, reason: true },
      });
      expect(reversal!.type).toBe('ADJUSTMENT');
      expect(reversal!.pointsDelta).toBe(-1_000n);
    });

    it('never drives the balance below zero', async () => {
      const customerId = await makeCustomer();
      const { variantId } = await sellable(100_000);

      const sale = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 200_000 }],
        customerId,
      });
      // Spend everything earned, and then some, before returning.
      await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [
          { method: 'LOYALTY', amount: 2_000 },
          { method: 'CASH', amount: 98_000 },
        ],
        customerId,
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

      const after = await api().get(`/api/v1/loyalty/${customerId}`).set(auth(managerToken));
      expect(BigInt(after.body.points as string) >= 0n).toBe(true);

      // The shortfall is recorded rather than forced: clawing back points a
      // customer already spent is a policy decision, not a default.
      const reversal = await db.loyaltyTransaction.findFirst({
        where: { organizationId: orgA.organizationId, returnId: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { reason: true },
      });
      expect(reversal!.reason).toContain('sarflangan');
    });
  });

  describe('manual adjustment', () => {
    it('adds and removes points, with a reason', async () => {
      const customerId = await makeCustomer();

      const added = await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: 5_000, reason: 'Uzr so‘rash uchun' });
      expect(added.status).toBe(201);
      expect(added.body.points).toBe('5000');

      const removed = await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: -2_000, reason: 'Xato hisoblangan' });
      expect(removed.body.points).toBe('3000');
    });

    it('requires a reason', async () => {
      const customerId = await makeCustomer();
      await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: 100 })
        .expect(400);
    });

    it('cannot take a balance negative', async () => {
      const customerId = await makeCustomer();
      const res = await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: -100, reason: 'Yo‘q ballni olish' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_POINTS');
    });

    it('is refused to a cashier', async () => {
      const customerId = await makeCustomer();
      await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(cashierToken))
        .send({ points: 10_000, reason: 'Ruxsatsiz' })
        .expect(403);
    });

    it('the ledger cannot be edited', async () => {
      const customerId = await makeCustomer();
      await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: 1_000, reason: 'Sinov' })
        .expect(201);

      const tx = await db.loyaltyTransaction.findFirstOrThrow({
        where: { organizationId: orgA.organizationId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      await expect(
        db.$executeRaw`UPDATE loyalty_transaction SET points_delta = 999999 WHERE id = ${tx.id}::uuid`,
      ).rejects.toThrow(/append-only/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Authorization and isolation
  // ──────────────────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('a cashier may not manage promotions', async () => {
      await api()
        .post('/api/v1/promotions')
        .set(auth(cashierToken))
        .send({
          name: `Ruxsatsiz ${counter++}`,
          type: 'PERCENT_OFF',
          scope: 'ITEM',
          value: 10,
          startsAt: YESTERDAY(),
        })
        .expect(403);
    });

    it('a warehouse keeper sees neither', async () => {
      await api().get('/api/v1/promotions').set(auth(warehouseToken)).expect(403);
      const customerId = await makeCustomer();
      await api().get(`/api/v1/loyalty/${customerId}`).set(auth(warehouseToken)).expect(403);
    });

    it('rejects unauthenticated requests', async () => {
      await api().get('/api/v1/promotions').expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("cannot read another organization's promotion", async () => {
      await api()
        .get(`/api/v1/promotions/${foreign.promotionId}`)
        .set(auth(managerToken))
        .expect(404);
    });

    it("another organization's promotion never prices our sale", async () => {
      const { variantId } = await sellable(100_000);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });
      // The foreign 50% campaign applies to ALL; if tenancy leaked it would
      // have halved this.
      expect(sale.totalAmount).toBe('100000');
    });

    it("cannot read or adjust another organization's loyalty balance", async () => {
      await api().get(`/api/v1/loyalty/${foreign.customerId}`).set(auth(managerToken)).expect(404);
      await api()
        .post(`/api/v1/loyalty/${foreign.customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: 1_000, reason: 'Begona' })
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Consistency
  // ──────────────────────────────────────────────────────────────────────

  describe('consistency', () => {
    it('every balance equals the sum of its own ledger — BR-10', async () => {
      const drifted = await db.$queryRaw<Array<{ id: string }>>`
        SELECT a.id
          FROM loyalty_account a
         WHERE a.organization_id = ${orgA.organizationId}::uuid
           AND a.points_balance <> COALESCE((
             SELECT SUM(t.points_delta) FROM loyalty_transaction t
              WHERE t.loyalty_account_id = a.id
           ), 0)
      `;
      expect(drifted).toEqual([]);
    });

    it('no ledger row records a balance below zero', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM loyalty_transaction
         WHERE organization_id = ${orgA.organizationId}::uuid AND balance_after < 0
      `;
      expect(broken).toEqual([]);
    });

    it('the database refuses a movement whose sign contradicts its type', async () => {
      const customerId = await makeCustomer();
      await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: 100, reason: 'Sinov' })
        .expect(201);

      const account = await db.loyaltyAccount.findFirstOrThrow({
        where: { customerId },
        select: { id: true },
      });

      await expect(
        db.$executeRaw`
          INSERT INTO loyalty_transaction
            (id, organization_id, loyalty_account_id, type, points_delta, balance_after, created_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${account.id}::uuid,
                  'EARN', -50, 50, now())
        `,
      ).rejects.toThrow(/ck_loyalty_tx_sign/);
    });

    it('the database refuses an adjustment with no reason', async () => {
      const customerId = await makeCustomer();
      await api()
        .post(`/api/v1/loyalty/${customerId}/adjust`)
        .set(auth(managerToken))
        .send({ points: 100, reason: 'Sinov' })
        .expect(201);

      const account = await db.loyaltyAccount.findFirstOrThrow({
        where: { customerId },
        select: { id: true },
      });

      await expect(
        db.$executeRaw`
          INSERT INTO loyalty_transaction
            (id, organization_id, loyalty_account_id, type, points_delta, balance_after, created_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${account.id}::uuid,
                  'ADJUSTMENT', 10, 110, now())
        `,
      ).rejects.toThrow(/ck_loyalty_tx_adjustment_has_reason/);
    });

    it('the stock ledger still reconciles', async () => {
      const drifted = await db.$queryRaw<Array<{ warehouse_id: string }>>`
        SELECT l.warehouse_id
          FROM inventory_level l
          LEFT JOIN inventory_movement m
            ON m.warehouse_id = l.warehouse_id
           AND m.product_variant_id = l.product_variant_id
         WHERE l.organization_id = ${orgA.organizationId}::uuid
         GROUP BY l.warehouse_id, l.product_variant_id, l.quantity
        HAVING l.quantity <> COALESCE(SUM(m.quantity_delta), 0)
      `;
      expect(drifted).toEqual([]);
    });
  });
});
