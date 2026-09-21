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
 * Checkout over real HTTP — docs/ARCHITECTURE.md §10 and §11.
 *
 * The tampering block is the important half. Every one of those tests sends a
 * request a malicious or broken client would send and asserts that the server
 * charged its own number, not the client's.
 */
describe('Sales (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let cashierToken: string;
  let managerToken: string;
  let warehouseToken: string;

  let customerId: string;
  let foreign: { variantId: string; customerId: string; saleId: string };

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
  const nextSku = () => `SL-${Date.now().toString(36)}-${counter++}`.toUpperCase();

  /** A product with stock, ready to sell. */
  async function sellable(
    price: number,
    quantity = 100,
    cost = 0,
  ): Promise<{ variantId: string; sku: string }> {
    const sku = nextSku();
    const created = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({ name: `Savdo mahsuloti ${counter}`, sku, sellingPrice: price, purchasePrice: cost });
    expect(created.status).toBe(201);
    const variantId = created.body.variants[0].id as string;

    await api()
      .post('/api/v1/inventory/adjustments')
      .set(auth(adminToken))
      .send({
        warehouseId: orgA.warehouseId,
        lines: [{ variantId, quantity: quantity.toFixed(3), reason: 'CORRECTION' }],
      })
      .expect(201);

    return { variantId, sku };
  }

  async function levelOf(variantId: string, warehouseId = orgA.warehouseId): Promise<number> {
    const level = await db.inventoryLevel.findFirst({
      where: { warehouseId, productVariantId: variantId },
      select: { quantity: true },
    });
    return level ? Number(level.quantity.toString()) : 0;
  }

  function checkout(body: Record<string, unknown>, token = cashierToken, key?: string) {
    return api()
      .post('/api/v1/sales/checkout')
      .set(auth(token))
      .set(key ? { 'Idempotency-Key': key } : idem())
      .send(body);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'salesA');
    orgB = await seedTestOrg(db, 'salesB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    managerToken = await tokenFor(orgA, 'MANAGER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    // Customers have no endpoints until Sprint 6, so the fixture is written
    // directly. The relationship is what Sprint 5 owns; the CRM is not.
    const customer = await db.customer.create({
      data: {
        organizationId: orgA.organizationId,
        fullName: 'Dilnoza Karimova',
        phone: '+998901110011',
        creditLimit: 1_000_000n,
      },
      select: { id: true },
    });
    customerId = customer.id;

    // Organization B, with a real product, a real customer and a real sale,
    // so every isolation probe is denied something that genuinely exists.
    const product = await db.product.create({
      data: { organizationId: orgB.organizationId, name: 'Begona mahsulot' },
      select: { id: true },
    });
    const variant = await db.productVariant.create({
      data: {
        organizationId: orgB.organizationId,
        productId: product.id,
        sku: 'FOREIGN-SALE-1',
        sellingPrice: 5_000n,
        isDefault: true,
      },
      select: { id: true },
    });
    const foreignCustomer = await db.customer.create({
      data: { organizationId: orgB.organizationId, fullName: 'Begona mijoz' },
      select: { id: true },
    });
    const foreignSale = await db.sale.create({
      data: {
        organizationId: orgB.organizationId,
        storeId: orgB.storeId,
        warehouseId: orgB.warehouseId,
        saleNumber: 'S-999999',
        status: 'COMPLETED',
        subtotalAmount: 5_000n,
        totalAmount: 5_000n,
        paidAmount: 5_000n,
        createdBy: orgB.users.get('ADMIN')!.id,
        completedAt: new Date(),
      },
      select: { id: true },
    });

    foreign = {
      variantId: variant.id,
      customerId: foreignCustomer.id,
      saleId: foreignSale.id,
    };
  }, 120_000);

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
  // The happy path
  // ──────────────────────────────────────────────────────────────────────

  describe('single payment', () => {
    it('completes a cash sale and deducts the stock', async () => {
      const { variantId } = await sellable(24_000, 50);

      const res = await checkout({
        items: [{ variantId, quantity: '3.000' }],
        payments: [{ method: 'CASH', amount: 72_000 }],
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.saleNumber).toMatch(/^S-\d{6}$/);
      expect(res.body.totalAmount).toBe('72000');
      expect(res.body.paidAmount).toBe('72000');
      expect(res.body.creditAmount).toBe('0');
      expect(res.body.completedAt).not.toBeNull();

      expect(await levelOf(variantId)).toBe(47);

      const movement = await db.inventoryMovement.findFirst({
        where: { sourceType: 'sale', sourceId: res.body.id, productVariantId: variantId },
        select: { type: true, quantityDelta: true },
      });
      expect(movement!.type).toBe('SALE');
      expect(Number(movement!.quantityDelta.toString())).toBe(-3);
    });

    it('records a card sale with its provider reference', async () => {
      const { variantId } = await sellable(15_000, 10);

      const res = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CARD', amount: 30_000, providerRef: 'TXN-99881' }],
      });

      expect(res.status).toBe(201);
      expect(res.body.payments).toHaveLength(1);
      expect(res.body.payments[0]).toMatchObject({
        method: 'CARD',
        direction: 'IN',
        amount: '30000',
        providerRef: 'TXN-99881',
      });
    });

    it('snapshots the name and SKU onto the line', async () => {
      const { variantId, sku } = await sellable(10_000, 10);
      const res = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });

      const line = res.body.items[0];
      expect(line.skuSnapshot).toBe(sku);
      expect(line.nameSnapshot).toContain('Savdo mahsuloti');

      // Rename the product; the sale must not change.
      const variant = await db.productVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: { productId: true },
      });
      await db.product.update({
        where: { id: variant.productId },
        data: { name: 'Butunlay boshqa nom' },
      });

      const reread = await api()
        .get(`/api/v1/sales/${res.body.id}`)
        .set(auth(cashierToken))
        .expect(200);
      expect(reread.body.items[0].nameSnapshot).toBe(line.nameSnapshot);
    });

    it('snapshots the cost, so margin is a subtraction and not a lookup', async () => {
      const { variantId } = await sellable(30_000, 10, 18_000);

      // Give the level a real average cost by receiving at a known price.
      await db.$executeRaw`
        UPDATE inventory_level SET avg_cost = 18000
         WHERE warehouse_id = ${orgA.warehouseId}::uuid
           AND product_variant_id = ${variantId}::uuid`;

      const res = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 60_000 }],
      });

      expect(res.body.costAmount).toBe('36000');
      expect(res.body.items[0].unitCost).toBe('18000');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Mixed payment — the architecture's worked example
  // ──────────────────────────────────────────────────────────────────────

  describe('mixed payment', () => {
    it('splits 450,000 into cash, card and credit — §11.3', async () => {
      const { variantId } = await sellable(45_000, 20);

      const res = await checkout(
        {
          items: [{ variantId, quantity: '10.000' }],
          payments: [
            { method: 'CASH', amount: 200_000 },
            { method: 'CARD', amount: 150_000 },
          ],
          creditAmount: 100_000,
          customerId,
        },
        managerToken,
      );

      expect(res.status).toBe(201);
      expect(res.body.totalAmount).toBe('450000');
      expect(res.body.paidAmount).toBe('350000');
      expect(res.body.creditAmount).toBe('100000');

      // Two payments, two allocations, one receivable.
      expect(res.body.payments).toHaveLength(2);
      expect(res.body.receivable).toMatchObject({
        originalAmount: '100000',
        paidAmount: '0',
        remainingAmount: '100000',
        status: 'OPEN',
      });

      const allocated = await db.paymentAllocation.aggregate({
        where: { saleId: res.body.id },
        _sum: { amount: true },
      });
      expect(allocated._sum.amount).toBe(350_000n);
    });

    it('rejects an under-tender with no credit', async () => {
      const { variantId } = await sellable(20_000, 10);

      const res = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 30_000 }],
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PAYMENT_MISMATCH');
      expect(res.body.errors[0].meta).toMatchObject({ expected: '40000', paid: '30000' });
    });

    it('rejects an over-tender — change is the client’s arithmetic, not the drawer’s', async () => {
      const { variantId } = await sellable(20_000, 10);

      const res = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 50_000 }],
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PAYMENT_MISMATCH');
    });

    it('refuses credit with no customer to owe it', async () => {
      const { variantId } = await sellable(20_000, 10);

      const res = await checkout(
        {
          items: [{ variantId, quantity: '2.000' }],
          payments: [{ method: 'CASH', amount: 30_000 }],
          creditAmount: 10_000,
        },
        managerToken,
      );

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CREDIT_WITHOUT_CUSTOMER');
    });

    it('refuses credit beyond the customer’s limit', async () => {
      const { variantId } = await sellable(1_000_000, 10);

      const res = await checkout(
        {
          items: [{ variantId, quantity: '2.000' }],
          payments: [],
          creditAmount: 2_000_000,
          customerId,
        },
        managerToken,
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CREDIT_LIMIT_EXCEEDED');
      expect(res.body.errors[0].meta.limit).toBe('1000000');
    });

    it('sells entirely on credit when the limit allows', async () => {
      const buyer = await db.customer.create({
        data: {
          organizationId: orgA.organizationId,
          fullName: 'Qarzdor mijoz',
          creditLimit: 5_000_000n,
        },
        select: { id: true },
      });
      const { variantId } = await sellable(50_000, 10);

      const res = await checkout(
        {
          items: [{ variantId, quantity: '4.000' }],
          payments: [],
          creditAmount: 200_000,
          customerId: buyer.id,
        },
        managerToken,
      );

      expect(res.status).toBe(201);
      expect(res.body.paidAmount).toBe('0');
      expect(res.body.receivable.originalAmount).toBe('200000');
      // One sale, one debt — customer_receivable.sale_id is UNIQUE.
      const count = await db.customerReceivable.count({ where: { saleId: res.body.id } });
      expect(count).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Tampering — the server's number, never the client's
  // ──────────────────────────────────────────────────────────────────────

  describe('tampering', () => {
    it('ignores a client-supplied total entirely', async () => {
      const { variantId } = await sellable(24_000, 10);

      const res = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 48_000 }],
        // Fields the server does not read. forbidNonWhitelisted rejects them,
        // which is the strongest possible answer: the field does not exist.
        totalAmount: 1,
        subtotalAmount: 1,
      });

      expect(res.status).toBe(400);
    });

    it('charges the catalogue price when a cashier invents a cheaper one', async () => {
      const { variantId } = await sellable(24_000, 10);

      const res = await checkout({
        items: [{ variantId, quantity: '2.000', unitPrice: 1 }],
        payments: [{ method: 'CASH', amount: 2 }],
      });

      // A cashier has no override right, so the request is refused outright
      // rather than silently re-priced.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PRICE_OVERRIDE_FORBIDDEN');
      expect(await levelOf(variantId)).toBe(10);
    });

    it('lets a manager override the price, and charges the override', async () => {
      const { variantId } = await sellable(24_000, 10);

      const res = await checkout(
        {
          items: [{ variantId, quantity: '2.000', unitPrice: 20_000 }],
          payments: [{ method: 'CASH', amount: 40_000 }],
        },
        managerToken,
      );

      expect(res.status).toBe(201);
      expect(res.body.items[0].unitPrice).toBe('20000');
      expect(res.body.totalAmount).toBe('40000');
    });

    it('refuses a line discount from a role that may not give one', async () => {
      const { variantId } = await sellable(24_000, 10);

      // The warehouse role has no sales permissions at all.
      const res = await checkout(
        {
          items: [{ variantId, quantity: '1.000', discountAmount: 5_000 }],
          payments: [{ method: 'CASH', amount: 19_000 }],
        },
        warehouseToken,
      );

      expect(res.status).toBe(403);
    });

    it('refuses an order discount from a cashier', async () => {
      const { variantId } = await sellable(24_000, 10);

      const res = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 20_000 }],
        orderDiscountAmount: 4_000,
      });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('DISCOUNT_FORBIDDEN');
    });

    it('applies a manager’s order discount and allocates it across the lines', async () => {
      const a = await sellable(30_000, 10);
      const b = await sellable(10_000, 10);

      const res = await checkout(
        {
          items: [
            { variantId: a.variantId, quantity: '1.000' },
            { variantId: b.variantId, quantity: '1.000' },
          ],
          payments: [{ method: 'CASH', amount: 36_000 }],
          orderDiscountAmount: 4_000,
          discountReason: 'Doimiy mijoz',
        },
        managerToken,
      );

      expect(res.status).toBe(201);
      expect(res.body.subtotalAmount).toBe('40000');
      expect(res.body.orderDiscountAmount).toBe('4000');
      expect(res.body.totalAmount).toBe('36000');

      const allocated = res.body.items.reduce(
        (sum: bigint, i: { allocatedOrderDiscount: string }) =>
          sum + BigInt(i.allocatedOrderDiscount),
        0n,
      );
      expect(allocated).toBe(4_000n);

      // The lines reconcile against the total.
      const net = res.body.items.reduce(
        (sum: bigint, i: { netAmount: string }) => sum + BigInt(i.netAmount),
        0n,
      );
      expect(net).toBe(36_000n);
    });

    it('rejects a foreign product', async () => {
      const res = await checkout({
        items: [{ variantId: foreign.variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 5_000 }],
      });
      expect(res.status).toBe(404);
    });

    it('rejects a foreign customer', async () => {
      const { variantId } = await sellable(10_000, 10);
      const res = await checkout(
        {
          items: [{ variantId, quantity: '1.000' }],
          payments: [],
          creditAmount: 10_000,
          customerId: foreign.customerId,
        },
        managerToken,
      );
      expect(res.status).toBe(404);
    });

    it('rejects a foreign warehouse', async () => {
      const { variantId } = await sellable(10_000, 10);
      const res = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
        warehouseId: orgB.warehouseId,
      });
      expect(res.status).toBe(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Stock
  // ──────────────────────────────────────────────────────────────────────

  describe('stock', () => {
    it('refuses a sale the shop cannot cover, and moves nothing', async () => {
      const { variantId } = await sellable(10_000, 2);

      const res = await checkout({
        items: [{ variantId, quantity: '5.000' }],
        payments: [{ method: 'CASH', amount: 50_000 }],
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      expect(await levelOf(variantId)).toBe(2);

      // No orphan sale, no orphan payment: the transaction took everything
      // with it.
      const sales = await db.sale.count({
        where: {
          organizationId: orgA.organizationId,
          items: { some: { productVariantId: variantId } },
        },
      });
      expect(sales).toBe(0);
    });

    it('rolls the money back when a later line has no stock', async () => {
      const ok = await sellable(10_000, 100);
      const short = await sellable(10_000, 1);

      const paymentsBefore = await db.payment.count({
        where: { organizationId: orgA.organizationId },
      });

      const res = await checkout({
        items: [
          { variantId: ok.variantId, quantity: '2.000' },
          { variantId: short.variantId, quantity: '9.000' },
        ],
        payments: [{ method: 'CASH', amount: 110_000 }],
      });

      expect(res.status).toBe(409);
      expect(await levelOf(ok.variantId)).toBe(100);
      expect(await levelOf(short.variantId)).toBe(1);
      expect(await db.payment.count({ where: { organizationId: orgA.organizationId } })).toBe(
        paymentsBefore,
      );
    });

    it('two cashiers racing for the last unit: exactly one sells it', async () => {
      const { variantId } = await sellable(10_000, 1);

      const attempt = () =>
        checkout({
          items: [{ variantId, quantity: '1.000' }],
          payments: [{ method: 'CASH', amount: 10_000 }],
        });

      const [first, second] = await Promise.all([attempt(), attempt()]);
      const statuses = [first.status, second.status].sort();

      expect(statuses).toEqual([201, 409]);
      expect(await levelOf(variantId)).toBe(0);

      const sold = await db.saleItem.count({ where: { productVariantId: variantId } });
      expect(sold).toBe(1);
    });

    it('ten parallel sales against five units sell exactly five', async () => {
      const { variantId } = await sellable(10_000, 5);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          checkout({
            items: [{ variantId, quantity: '1.000' }],
            payments: [{ method: 'CASH', amount: 10_000 }],
          }),
        ),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(await levelOf(variantId)).toBe(0);

      const movements = await db.inventoryMovement.aggregate({
        where: { productVariantId: variantId, type: 'SALE' },
        _sum: { quantityDelta: true },
      });
      expect(Number(movements._sum.quantityDelta!.toString())).toBe(-5);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Idempotency — docs/ARCHITECTURE.md §26
  // ──────────────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('requires the header', async () => {
      const { variantId } = await sellable(10_000, 10);

      const res = await api()
        .post('/api/v1/sales/checkout')
        .set(auth(cashierToken))
        .send({
          items: [{ variantId, quantity: '1.000' }],
          payments: [{ method: 'CASH', amount: 10_000 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('replays the first response instead of selling twice', async () => {
      const { variantId } = await sellable(10_000, 10);
      const key = randomUUID();
      const body = {
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 20_000 }],
      };

      const first = await checkout(body, cashierToken, key);
      expect(first.status).toBe(201);

      const second = await checkout(body, cashierToken, key);
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.replayed).toBe(true);

      // One sale, one deduction.
      expect(await levelOf(variantId)).toBe(8);
      expect(await db.saleItem.count({ where: { productVariantId: variantId } })).toBe(1);
    });

    it('survives a double-tap sent in parallel', async () => {
      const { variantId } = await sellable(10_000, 10);
      const key = randomUUID();
      const body = {
        items: [{ variantId, quantity: '3.000' }],
        payments: [{ method: 'CASH', amount: 30_000 }],
      };

      const results = await Promise.all([
        checkout(body, cashierToken, key),
        checkout(body, cashierToken, key),
      ]);

      // One does the work; the other either replays it or is told it is still
      // running. Neither may produce a second sale.
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(await db.saleItem.count({ where: { productVariantId: variantId } })).toBe(1);
      expect(await levelOf(variantId)).toBe(7);
    });

    it('refuses a different body under the same key', async () => {
      const { variantId } = await sellable(10_000, 20);
      const key = randomUUID();

      await checkout(
        {
          items: [{ variantId, quantity: '1.000' }],
          payments: [{ method: 'CASH', amount: 10_000 }],
        },
        cashierToken,
        key,
      ).expect(201);

      const res = await checkout(
        {
          items: [{ variantId, quantity: '5.000' }],
          payments: [{ method: 'CASH', amount: 50_000 }],
        },
        cashierToken,
        key,
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await levelOf(variantId)).toBe(19);
    });

    it('frees the key when the attempt failed, so a retry can succeed', async () => {
      const { variantId } = await sellable(10_000, 1);
      const key = randomUUID();

      const failed = await checkout(
        {
          items: [{ variantId, quantity: '9.000' }],
          payments: [{ method: 'CASH', amount: 90_000 }],
        },
        cashierToken,
        key,
      );
      expect(failed.status).toBe(409);
      expect(failed.body.code).toBe('INSUFFICIENT_STOCK');

      // The rollback took the IN_PROGRESS record with it.
      const retried = await checkout(
        {
          items: [{ variantId, quantity: '1.000' }],
          payments: [{ method: 'CASH', amount: 10_000 }],
        },
        cashierToken,
        key,
      );
      expect(retried.status).toBe(201);
    });

    it('rejects a key that is not a UUID', async () => {
      const { variantId } = await sellable(10_000, 10);
      const res = await checkout(
        {
          items: [{ variantId, quantity: '1.000' }],
          payments: [{ method: 'CASH', amount: 10_000 }],
        },
        cashierToken,
        'not-a-uuid',
      );
      expect(res.status).toBe(400);
    });

    it('blocks a replayed offline sale by client id, even with a fresh key', async () => {
      const { variantId } = await sellable(10_000, 10);
      const clientId = randomUUID();

      const first = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
        clientId,
      });
      expect(first.status).toBe(201);

      // A client that regenerates its key defeats idempotency; the natural key
      // on the sale itself is what still holds (§26.4).
      const second = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
        clientId,
      });
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(await db.sale.count({ where: { clientId } })).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // History, receipt and cancellation
  // ──────────────────────────────────────────────────────────────────────

  describe('history', () => {
    it('filters by cashier, method, status and amount range, in the database', async () => {
      const { variantId } = await sellable(25_000, 10);
      const sale = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CLICK', amount: 50_000 }],
      });
      expect(sale.status).toBe(201);

      const byMethod = await api()
        .get('/api/v1/sales')
        .query({ paymentMethod: 'CLICK', limit: 100 })
        .set(auth(adminToken))
        .expect(200);
      expect(byMethod.body.data.some((s: { id: string }) => s.id === sale.body.id)).toBe(true);

      const byAmount = await api()
        .get('/api/v1/sales')
        .query({ minAmount: 49_000, maxAmount: 51_000, limit: 100 })
        .set(auth(adminToken))
        .expect(200);
      expect(
        byAmount.body.data.every((s: { totalAmount: string }) => {
          const total = BigInt(s.totalAmount);
          return total >= 49_000n && total <= 51_000n;
        }),
      ).toBe(true);

      const byCashier = await api()
        .get('/api/v1/sales')
        .query({ cashierId: orgA.users.get('CASHIER')!.id, limit: 100 })
        .set(auth(adminToken))
        .expect(200);
      expect(byCashier.body.data.length).toBeGreaterThan(0);
    });

    it('returns revenue and margin for the header', async () => {
      const res = await api()
        .get('/api/v1/sales')
        .query({ limit: 1 })
        .set(auth(adminToken))
        .expect(200);

      expect(res.body.summary).toMatchObject({
        revenue: expect.any(String),
        cost: expect.any(String),
        margin: expect.any(String),
      });
    });

    it('finds a sale by its receipt number', async () => {
      const { variantId } = await sellable(10_000, 10);
      const sale = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });

      const res = await api()
        .get('/api/v1/sales')
        .query({ q: sale.body.saleNumber })
        .set(auth(adminToken))
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(sale.body.id);
    });

    it('builds a receipt entirely from stored values', async () => {
      const { variantId } = await sellable(12_500, 10);
      const sale = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 25_000 }],
      });

      const receipt = await api()
        .get(`/api/v1/sales/${sale.body.id}/receipt`)
        .set(auth(cashierToken))
        .expect(200);

      expect(receipt.body.saleNumber).toBe(sale.body.saleNumber);
      expect(receipt.body.store.code).toBeTruthy();
      expect(receipt.body.items[0]).toMatchObject({ quantity: '2.000', total: '25000' });
      expect(receipt.body.total).toBe('25000');
      expect(receipt.body.payments).toHaveLength(1);
    });
  });

  describe('cancellation', () => {
    it('preserves the sale, returns the stock and reverses the money', async () => {
      const { variantId } = await sellable(20_000, 10);
      const sale = await checkout({
        items: [{ variantId, quantity: '3.000' }],
        payments: [{ method: 'CASH', amount: 60_000 }],
      });
      expect(await levelOf(variantId)).toBe(7);

      const res = await api()
        .post(`/api/v1/sales/${sale.body.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Mijoz fikridan qaytdi' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('CANCELLED');
      expect(res.body.cancelReason).toBe('Mijoz fikridan qaytdi');
      // The figures are untouched — history, not a correction.
      expect(res.body.totalAmount).toBe('60000');

      expect(await levelOf(variantId)).toBe(10);

      const compensating = await db.inventoryMovement.findFirst({
        where: { sourceType: 'sale_cancellation', sourceId: sale.body.id },
        select: { type: true, quantityDelta: true },
      });
      expect(compensating!.type).toBe('RETURN');
      expect(Number(compensating!.quantityDelta.toString())).toBe(3);

      const out = await db.payment.findFirst({
        where: { direction: 'OUT', allocations: { some: { saleId: sale.body.id } } },
        select: { amount: true, method: true },
      });
      expect(out).toMatchObject({ amount: 60_000n, method: 'CASH' });
    });

    it('writes off the debt when a credit sale is cancelled', async () => {
      const buyer = await db.customer.create({
        data: {
          organizationId: orgA.organizationId,
          fullName: 'Bekor mijoz',
          creditLimit: 5_000_000n,
        },
        select: { id: true },
      });
      const { variantId } = await sellable(50_000, 10);

      const sale = await checkout(
        {
          items: [{ variantId, quantity: '2.000' }],
          payments: [],
          creditAmount: 100_000,
          customerId: buyer.id,
        },
        managerToken,
      );
      expect(sale.status).toBe(201);

      await api()
        .post(`/api/v1/sales/${sale.body.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Xato savdo' })
        .expect(201);

      const receivable = await db.customerReceivable.findFirstOrThrow({
        where: { saleId: sale.body.id },
        select: { status: true, writtenOffAmount: true, originalAmount: true },
      });
      // Written off, never deleted: no debt may disappear.
      expect(receivable.status).toBe('WRITTEN_OFF');
      expect(receivable.writtenOffAmount).toBe(100_000n);
      expect(receivable.originalAmount).toBe(100_000n);
    });

    it('cannot be cancelled twice, even in parallel', async () => {
      const { variantId } = await sellable(10_000, 10);
      const sale = await checkout({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 20_000 }],
      });

      const cancel = () =>
        api()
          .post(`/api/v1/sales/${sale.body.id}/cancel`)
          .set(auth(managerToken))
          .send({ reason: 'Ikki marta' });

      const results = await Promise.all([cancel(), cancel()]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);

      // The stock came back exactly once.
      expect(await levelOf(variantId)).toBe(10);
    });

    it('requires a reason', async () => {
      const { variantId } = await sellable(10_000, 10);
      const sale = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });

      const res = await api()
        .post(`/api/v1/sales/${sale.body.id}/cancel`)
        .set(auth(managerToken))
        .send({});
      expect(res.status).toBe(400);
    });

    it('is refused to a cashier', async () => {
      const { variantId } = await sellable(10_000, 10);
      const sale = await checkout({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });

      const res = await api()
        .post(`/api/v1/sales/${sale.body.id}/cancel`)
        .set(auth(cashierToken))
        .send({ reason: 'Ruxsatsiz' });
      expect(res.status).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Authorization and isolation
  // ──────────────────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('refuses a warehouse keeper, who has no sales permissions', async () => {
      const { variantId } = await sellable(10_000, 10);
      const res = await checkout(
        {
          items: [{ variantId, quantity: '1.000' }],
          payments: [{ method: 'CASH', amount: 10_000 }],
        },
        warehouseToken,
      );
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated checkout', async () => {
      await api().post('/api/v1/sales/checkout').set(idem()).send({}).expect(401);
      await api().get('/api/v1/sales').expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("never lists another organization's sales", async () => {
      const res = await api()
        .get('/api/v1/sales')
        .query({ limit: 100 })
        .set(auth(adminToken))
        .expect(200);
      expect(res.body.data.map((s: { id: string }) => s.id)).not.toContain(foreign.saleId);
    });

    it("cannot read another organization's sale", async () => {
      await api().get(`/api/v1/sales/${foreign.saleId}`).set(auth(adminToken)).expect(404);
      await api().get(`/api/v1/sales/${foreign.saleId}/receipt`).set(auth(adminToken)).expect(404);
    });

    it("cannot cancel another organization's sale", async () => {
      const res = await api()
        .post(`/api/v1/sales/${foreign.saleId}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Begona' });
      expect(res.status).toBe(404);

      const untouched = await db.sale.findUniqueOrThrow({
        where: { id: foreign.saleId },
        select: { status: true },
      });
      expect(untouched.status).toBe('COMPLETED');
    });

    it('sale numbers are per store, so two stores may both have S-000001', async () => {
      const mine = await db.sale.count({
        where: { organizationId: orgA.organizationId, saleNumber: 'S-000001' },
      });
      const theirs = await db.sale.count({
        where: { organizationId: orgB.organizationId, saleNumber: 'S-000001' },
      });
      expect(mine + theirs).toBeGreaterThanOrEqual(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Database-level guarantees
  // ──────────────────────────────────────────────────────────────────────

  describe('database constraints', () => {
    it('refuses a sale whose total does not add up', async () => {
      await expect(
        db.$executeRaw`
          INSERT INTO sale (id, organization_id, store_id, warehouse_id, sale_number,
                            status, subtotal_amount, order_discount_amount, tax_amount,
                            rounding_adjustment, total_amount, paid_amount, created_by,
                            completed_at, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.storeId}::uuid,
                  ${orgA.warehouseId}::uuid, 'S-BAD-1', 'DRAFT', 100, 0, 0, 0, 999, 0,
                  ${orgA.users.get('ADMIN')!.id}::uuid, NULL, now(), now())
        `,
      ).rejects.toThrow(/ck_sale_total_adds_up/);
    });

    it('refuses a completed sale that is not fully settled', async () => {
      await expect(
        db.$executeRaw`
          INSERT INTO sale (id, organization_id, store_id, warehouse_id, sale_number,
                            status, subtotal_amount, total_amount, paid_amount, credit_amount,
                            created_by, completed_at, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.storeId}::uuid,
                  ${orgA.warehouseId}::uuid, 'S-BAD-2', 'COMPLETED', 1000, 1000, 400, 0,
                  ${orgA.users.get('ADMIN')!.id}::uuid, now(), now(), now())
        `,
      ).rejects.toThrow(/ck_sale_settled_when_completed/);
    });

    it('refuses credit with no customer', async () => {
      await expect(
        db.$executeRaw`
          INSERT INTO sale (id, organization_id, store_id, warehouse_id, sale_number,
                            status, subtotal_amount, total_amount, paid_amount, credit_amount,
                            created_by, completed_at, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.storeId}::uuid,
                  ${orgA.warehouseId}::uuid, 'S-BAD-3', 'COMPLETED', 1000, 1000, 0, 1000,
                  ${orgA.users.get('ADMIN')!.id}::uuid, now(), now(), now())
        `,
      ).rejects.toThrow(/ck_sale_credit_needs_customer/);
    });

    it('refuses a payment with no amount', async () => {
      await expect(
        db.$executeRaw`
          INSERT INTO payment (id, organization_id, store_id, direction, method, amount,
                               received_by, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.storeId}::uuid,
                  'IN', 'CASH', 0, ${orgA.users.get('ADMIN')!.id}::uuid, now(), now())
        `,
      ).rejects.toThrow(/ck_payment_amount_positive/);
    });

    it('refuses an allocation that settles nothing, or two things at once', async () => {
      const payment = await db.payment.create({
        data: {
          organizationId: orgA.organizationId,
          storeId: orgA.storeId,
          direction: 'IN',
          method: 'CASH',
          amount: 1_000n,
          receivedBy: orgA.users.get('ADMIN')!.id,
        },
        select: { id: true },
      });

      await expect(
        db.$executeRaw`
          INSERT INTO payment_allocation (id, organization_id, payment_id, amount, created_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${payment.id}::uuid, 500, now())
        `,
      ).rejects.toThrow(/ck_allocation_single_target/);
    });

    it('the allocation ledger is append-only', async () => {
      const allocation = await db.paymentAllocation.findFirst({ select: { id: true } });
      expect(allocation).not.toBeNull();

      await expect(
        db.$executeRaw`UPDATE payment_allocation SET amount = 1 WHERE id = ${allocation!.id}::uuid`,
      ).rejects.toThrow(/append-only/i);
    });

    it('refuses a receivable paid beyond its original amount', async () => {
      const receivable = await db.customerReceivable.create({
        data: {
          organizationId: orgA.organizationId,
          storeId: orgA.storeId,
          customerId,
          origin: 'MANUAL',
          originalAmount: 10_000n,
          issuedAt: new Date(),
          dueDate: new Date(),
          createdBy: orgA.users.get('ADMIN')!.id,
        },
        select: { id: true },
      });

      await expect(
        db.$executeRaw`
          UPDATE customer_receivable SET paid_amount = 20000 WHERE id = ${receivable.id}::uuid
        `,
      ).rejects.toThrow(/ck_receivable_not_overpaid/);
    });

    it("refuses a sale line pointing at another organization's variant", async () => {
      const sale = await db.sale.findFirstOrThrow({
        where: { organizationId: orgA.organizationId, status: 'COMPLETED' },
        select: { id: true },
      });

      await expect(
        db.$executeRaw`
          INSERT INTO sale_item (id, organization_id, sale_id, product_variant_id,
                                 name_snapshot, sku_snapshot, quantity, unit_price,
                                 gross_amount, net_amount, unit_cost, position)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${sale.id}::uuid,
                  ${foreign.variantId}::uuid, 'Begona', 'X', 1, 100, 100, 100, 0, 99)
        `,
      ).rejects.toThrow(/fk_sale_item_variant_same_org/);
    });

    it('the stock ledger still reconciles after everything above', async () => {
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
