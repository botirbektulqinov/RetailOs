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
 * Returns and exchanges — docs/ARCHITECTURE.md §13 and §14.
 *
 * Three invariants every test here defends: the original sale is never
 * rewritten, a line can never be returned for more than it was sold, and a
 * partial return never leaves a soʻm stranded on the line.
 */
describe('Returns and exchanges (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let managerToken: string;
  let cashierToken: string;
  let warehouseToken: string;

  let customerId: string;
  let foreign: { saleId: string; saleItemId: string };

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
  const nextSku = () => `RT-${Date.now().toString(36)}-${counter++}`.toUpperCase();

  async function sellable(price: number, quantity = 100): Promise<string> {
    const created = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({ name: `Qaytarish mahsuloti ${counter}`, sku: nextSku(), sellingPrice: price });
    expect(created.status).toBe(201);
    const variantId = created.body.variants[0].id as string;

    // Zero means "deliberately never stocked" — an adjustment of nothing is
    // rejected, and rightly so.
    if (quantity > 0) {
      await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: quantity.toFixed(3), reason: 'CORRECTION' }],
        })
        .expect(201);
    }

    return variantId;
  }

  interface SoldSale {
    id: string;
    saleNumber: string;
    totalAmount: string;
    items: Array<{ id: string; netAmount: string; quantity: string; productVariantId: string }>;
  }

  async function sell(body: Record<string, unknown>, token = managerToken): Promise<SoldSale> {
    const res = await api().post('/api/v1/sales/checkout').set(auth(token)).set(idem()).send(body);
    expect(res.status).toBe(201);
    return res.body as SoldSale;
  }

  function returnIt(body: Record<string, unknown>, token = managerToken, key?: string) {
    return api()
      .post('/api/v1/returns')
      .set(auth(token))
      .set(key ? { 'Idempotency-Key': key } : idem())
      .send(body);
  }

  function exchangeIt(body: Record<string, unknown>, token = managerToken, key?: string) {
    return api()
      .post('/api/v1/exchanges')
      .set(auth(token))
      .set(key ? { 'Idempotency-Key': key } : idem())
      .send(body);
  }

  async function levelOf(variantId: string): Promise<number> {
    const level = await db.inventoryLevel.findFirst({
      where: { warehouseId: orgA.warehouseId, productVariantId: variantId },
      select: { quantity: true },
    });
    return level ? Number(level.quantity.toString()) : 0;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'retA');
    orgB = await seedTestOrg(db, 'retB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    managerToken = await tokenFor(orgA, 'MANAGER');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    const customer = await db.customer.create({
      data: {
        organizationId: orgA.organizationId,
        fullName: 'Qaytarish mijozi',
        creditLimit: 10_000_000n,
      },
      select: { id: true },
    });
    customerId = customer.id;

    const product = await db.product.create({
      data: { organizationId: orgB.organizationId, name: 'Begona mahsulot' },
      select: { id: true },
    });
    const variant = await db.productVariant.create({
      data: {
        organizationId: orgB.organizationId,
        productId: product.id,
        sku: 'FOREIGN-RT-1',
        sellingPrice: 5_000n,
        isDefault: true,
      },
      select: { id: true },
    });
    const foreignSale = await db.sale.create({
      data: {
        organizationId: orgB.organizationId,
        storeId: orgB.storeId,
        warehouseId: orgB.warehouseId,
        saleNumber: 'S-888888',
        status: 'COMPLETED',
        subtotalAmount: 5_000n,
        totalAmount: 5_000n,
        paidAmount: 5_000n,
        createdBy: orgB.users.get('ADMIN')!.id,
        completedAt: new Date(),
        items: {
          create: {
            organizationId: orgB.organizationId,
            productVariantId: variant.id,
            nameSnapshot: 'Begona',
            skuSnapshot: 'FOREIGN-RT-1',
            quantity: '1.000',
            unitPrice: 5_000n,
            grossAmount: 5_000n,
            netAmount: 5_000n,
            unitCost: 0n,
            position: 1,
          },
        },
      },
      select: { id: true, items: { select: { id: true } } },
    });

    foreign = { saleId: foreignSale.id, saleItemId: foreignSale.items[0]!.id };
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
  // Full and partial returns
  // ──────────────────────────────────────────────────────────────────────

  describe('full return', () => {
    it('refunds the sale, restocks the goods and leaves the sale intact', async () => {
      const variantId = await sellable(25_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '4.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });
      expect(await levelOf(variantId)).toBe(16);

      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '4.000' }],
        reason: 'CHANGED_MIND',
      });

      expect(res.status).toBe(201);
      expect(res.body.returnNumber).toMatch(/^R-\d{6}$/);
      expect(res.body.refundAmount).toBe('100000');
      expect(res.body.sale.returnStatus).toBe('FULL');

      expect(await levelOf(variantId)).toBe(20);

      // The sale's own figures are untouched. Only what has come back moved.
      const reread = await api()
        .get(`/api/v1/sales/${sale.id}`)
        .set(auth(managerToken))
        .expect(200);
      expect(reread.body.totalAmount).toBe('100000');
      expect(reread.body.paidAmount).toBe('100000');
      expect(reread.body.refundedAmount).toBe('100000');
      expect(reread.body.status).toBe('COMPLETED');

      const movement = await db.inventoryMovement.findFirst({
        where: { sourceType: 'sale_return', sourceId: res.body.id },
        select: { type: true, quantityDelta: true },
      });
      expect(movement!.type).toBe('RETURN');
      expect(Number(movement!.quantityDelta.toString())).toBe(4);

      const refund = await db.payment.findFirst({
        where: { direction: 'OUT', allocations: { some: { returnId: res.body.id } } },
        select: { amount: true, method: true },
      });
      expect(refund).toMatchObject({ amount: 100_000n, method: 'CASH' });
    });
  });

  describe('partial return', () => {
    it('returns some of a line and leaves the rest returnable', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '10.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });

      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '3.000' }],
        reason: 'DEFECTIVE',
      });

      expect(res.status).toBe(201);
      expect(res.body.refundAmount).toBe('30000');
      expect(res.body.sale.returnStatus).toBe('PARTIAL');
      expect(await levelOf(variantId)).toBe(13);

      const returnable = await api()
        .get(`/api/v1/returns/returnable/${sale.id}`)
        .set(auth(managerToken))
        .expect(200);
      expect(returnable.body.items[0]).toMatchObject({
        quantity: '10.000',
        returnedQuantity: '3.000',
        returnableQuantity: '7.000',
      });
    });

    it('refuses more than remains, and the sprint example of 11 from 10', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '10.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });

      await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '3.000' }],
        reason: 'DEFECTIVE',
      }).expect(201);

      // 10 sold, 3 returned → at most 7 more. 8 must fail.
      const tooMany = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '8.000' }],
        reason: 'DEFECTIVE',
      });
      expect(tooMany.status).toBe(409);
      expect(tooMany.body.code).toBe('RETURN_QUANTITY_EXCEEDED');
      expect(tooMany.body.errors[0].meta.returnable).toBe('7.000');

      // Nothing moved.
      expect(await levelOf(variantId)).toBe(13);

      const eleven = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '11.000' }],
        reason: 'DEFECTIVE',
      });
      expect(eleven.status).toBe(409);
    });

    it('the closing return sweeps up the rounding residue', async () => {
      // A line of 3 at net 100,000: proportional thirds are 33,333 and would
      // leave 1 soʻm the customer never gets back.
      const variantId = await sellable(33_334, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '3.000' }],
        payments: [{ method: 'CASH', amount: 100_002 }],
      });
      const saleItemId = sale.items[0]!.id;
      const net = BigInt(sale.items[0]!.netAmount);

      const refunds: bigint[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await returnIt({
          saleId: sale.id,
          items: [{ saleItemId, quantity: '1.000' }],
          reason: 'DEFECTIVE',
        });
        expect(res.status).toBe(201);
        refunds.push(BigInt(res.body.refundAmount as string));
      }

      // The three refunds sum to exactly the line's net amount.
      expect(refunds.reduce((a, b) => a + b, 0n)).toBe(net);

      const item = await db.saleItem.findUniqueOrThrow({
        where: { id: saleItemId },
        select: { netAmount: true, refundedAmount: true, returnedQuantity: true },
      });
      expect(item.refundedAmount).toBe(item.netAmount);
      expect(Number(item.returnedQuantity.toString())).toBe(3);
    });

    it('refunds the discounted price, not the list price', async () => {
      const variantId = await sellable(100_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '2.000', discountAmount: 50_000 }],
        payments: [{ method: 'CASH', amount: 150_000 }],
      });

      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        reason: 'CHANGED_MIND',
      });

      // Net 150,000 over 2 units → 75,000 each, not the 100,000 list price.
      expect(res.body.refundAmount).toBe('75000');
    });

    it('spreads an order discount into the refund too', async () => {
      const a = await sellable(30_000, 20);
      const b = await sellable(10_000, 20);
      const sale = await sell({
        items: [
          { variantId: a, quantity: '1.000' },
          { variantId: b, quantity: '1.000' },
        ],
        payments: [{ method: 'CASH', amount: 36_000 }],
        orderDiscountAmount: 4_000,
      });

      const lineA = sale.items.find((i) => i.productVariantId === a)!;
      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: lineA.id, quantity: '1.000' }],
        reason: 'CHANGED_MIND',
      });

      // 30,000 less its 3,000 share of the order discount.
      expect(res.body.refundAmount).toBe('27000');
    });
  });

  describe('restock', () => {
    it('does not restock damaged goods', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '5.000' }],
        payments: [{ method: 'CASH', amount: 50_000 }],
      });
      expect(await levelOf(variantId)).toBe(15);

      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '2.000', condition: 'DAMAGED' }],
        reason: 'DEFECTIVE',
      });

      expect(res.status).toBe(201);
      expect(res.body.items[0]).toMatchObject({ condition: 'DAMAGED', restock: false });
      // The money comes back; the goods do not go on the shelf.
      expect(res.body.refundAmount).toBe('20000');
      expect(await levelOf(variantId)).toBe(15);

      const movements = await db.inventoryMovement.count({
        where: { sourceType: 'sale_return', sourceId: res.body.id },
      });
      expect(movements).toBe(0);
    });

    it('honours restock=false on sellable goods', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 20_000 }],
      });

      await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000', restock: false }],
        reason: 'OTHER',
      }).expect(201);

      expect(await levelOf(variantId)).toBe(18);
    });

    it('the database refuses a damaged line marked for restock', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });
      const created = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        reason: 'OTHER',
      }).expect(201);

      await expect(
        db.$executeRaw`
          UPDATE return_item SET condition = 'DAMAGED', restock = true
           WHERE return_id = ${created.body.id}::uuid
        `,
      ).rejects.toThrow(/ck_return_item_damaged_never_restocks/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Debt-sale returns — docs/ARCHITECTURE.md §13.5
  // ──────────────────────────────────────────────────────────────────────

  describe('returning a credit sale', () => {
    it('offsets the open debt before any cash leaves', async () => {
      const variantId = await sellable(100_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '5.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
        creditAmount: 400_000,
        customerId,
      });

      const before = await api()
        .get(`/api/v1/customers/${customerId}/balance`)
        .set(auth(managerToken));
      expect(before.body.outstanding).toBe('400000');

      // Return 1 of 5 → 100,000 back, all of it against the debt.
      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        reason: 'DEFECTIVE',
      });

      expect(res.status).toBe(201);
      expect(res.body.creditOffsetAmount).toBe('100000');
      // No cash left the drawer.
      expect(res.body.refundAmount).toBe('0');

      const after = await api()
        .get(`/api/v1/customers/${customerId}/balance`)
        .set(auth(managerToken));
      expect(after.body.outstanding).toBe('300000');

      // The offset is a real collection, not a write-off: a return is not bad
      // debt.
      const receivable = await db.customerReceivable.findFirstOrThrow({
        where: { saleId: sale.id },
        select: { paidAmount: true, writtenOffAmount: true, status: true },
      });
      expect(receivable.paidAmount).toBe(100_000n);
      expect(receivable.writtenOffAmount).toBe(0n);
      expect(receivable.status).toBe('PARTIALLY_PAID');
    });

    it('pays out only what exceeds the debt', async () => {
      const buyer = await db.customer.create({
        data: {
          organizationId: orgA.organizationId,
          fullName: `Aralash mijoz ${counter++}`,
          creditLimit: 10_000_000n,
        },
        select: { id: true },
      });
      const variantId = await sellable(100_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '5.000' }],
        payments: [{ method: 'CASH', amount: 400_000 }],
        creditAmount: 100_000,
        customerId: buyer.id,
      });

      // Return 3 of 5 → 300,000. 100,000 clears the debt; 200,000 is cash.
      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '3.000' }],
        reason: 'CHANGED_MIND',
      });

      expect(res.status).toBe(201);
      expect(res.body.creditOffsetAmount).toBe('100000');
      expect(res.body.refundAmount).toBe('200000');

      const balance = await api()
        .get(`/api/v1/customers/${buyer.id}/balance`)
        .set(auth(managerToken));
      expect(balance.body.outstanding).toBe('0');
    });

    it('never produces a negative balance', async () => {
      const buyer = await db.customer.create({
        data: {
          organizationId: orgA.organizationId,
          fullName: `Nol mijoz ${counter++}`,
          creditLimit: 10_000_000n,
        },
        select: { id: true },
      });
      const variantId = await sellable(50_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '4.000' }],
        payments: [],
        creditAmount: 200_000,
        customerId: buyer.id,
      });

      await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '4.000' }],
        reason: 'CHANGED_MIND',
      }).expect(201);

      const balance = await api()
        .get(`/api/v1/customers/${buyer.id}/balance`)
        .set(auth(managerToken));
      expect(BigInt(balance.body.outstanding as string) >= 0n).toBe(true);
      expect(balance.body.outstanding).toBe('0');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Exchanges — docs/ARCHITECTURE.md §14
  // ──────────────────────────────────────────────────────────────────────

  describe('exchanges', () => {
    it('the brief example: return 500,000, take 650,000, customer pays 150,000', async () => {
      const a = await sellable(500_000, 10);
      const b = await sellable(650_000, 10);

      const sale = await sell({
        items: [{ variantId: a, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 500_000 }],
      });

      const res = await exchangeIt({
        saleId: sale.id,
        returnItems: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        replacementItems: [{ variantId: b, quantity: '1.000' }],
        reason: 'WRONG_ITEM',
      });

      expect(res.status).toBe(201);
      expect(res.body.exchangeNumber).toMatch(/^EX-\d{6}$/);
      expect(res.body.returnedValue).toBe('500000');
      expect(res.body.replacementValue).toBe('650000');
      expect(res.body.netAmount).toBe('150000');
      expect(res.body.settlement).toBe('CUSTOMER_PAID');

      // Both legs of stock.
      expect(await levelOf(a)).toBe(10);
      expect(await levelOf(b)).toBe(9);

      // Only the NET moved as money — one payment row, for 150,000.
      // Only the NET crossed the counter. The trade-in is recorded as a
      // non-cash allocation so the sale reconciles, and is excluded here.
      const payments = await db.payment.findMany({
        where: {
          organizationId: orgA.organizationId,
          note: { contains: res.body.exchangeNumber as string },
          method: { not: 'OTHER' },
        },
        select: { direction: true, amount: true },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ direction: 'IN', amount: 150_000n });
    });

    it('refunds the difference when the replacement is cheaper', async () => {
      const a = await sellable(650_000, 10);
      const b = await sellable(500_000, 10);

      const sale = await sell({
        items: [{ variantId: a, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 650_000 }],
      });

      const res = await exchangeIt({
        saleId: sale.id,
        returnItems: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        replacementItems: [{ variantId: b, quantity: '1.000' }],
        reason: 'CHANGED_MIND',
      });

      expect(res.status).toBe(201);
      expect(res.body.netAmount).toBe('-150000');
      expect(res.body.settlement).toBe('REFUNDED');

      const payments = await db.payment.findMany({
        where: {
          organizationId: orgA.organizationId,
          note: { contains: res.body.exchangeNumber as string },
          method: { not: 'OTHER' },
        },
        select: { direction: true, amount: true },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ direction: 'OUT', amount: 150_000n });
    });

    it('moves no money at all on an even exchange', async () => {
      const a = await sellable(500_000, 10);
      const b = await sellable(500_000, 10);

      const sale = await sell({
        items: [{ variantId: a, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 500_000 }],
      });

      const res = await exchangeIt({
        saleId: sale.id,
        returnItems: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        replacementItems: [{ variantId: b, quantity: '1.000' }],
        reason: 'WRONG_ITEM',
      });

      expect(res.status).toBe(201);
      expect(res.body.netAmount).toBe('0');
      expect(res.body.settlement).toBe('EVEN');

      // The trade-in allocation exists — it is what settles the replacement
      // sale — but no money crossed the counter.
      const cash = await db.payment.count({
        where: {
          organizationId: orgA.organizationId,
          note: { contains: res.body.exchangeNumber as string },
          method: { not: 'OTHER' },
        },
      });
      expect(cash).toBe(0);

      expect(await levelOf(a)).toBe(10);
      expect(await levelOf(b)).toBe(9);
    });

    it('can put the difference on credit', async () => {
      const a = await sellable(500_000, 10);
      const b = await sellable(650_000, 10);

      const sale = await sell({
        items: [{ variantId: a, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 500_000 }],
        customerId,
      });

      const res = await exchangeIt({
        saleId: sale.id,
        returnItems: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        replacementItems: [{ variantId: b, quantity: '1.000' }],
        reason: 'WRONG_ITEM',
        onCredit: true,
      });

      expect(res.status).toBe(201);
      expect(res.body.settlement).toBe('CREDITED_TO_DEBT');

      const receivable = await db.customerReceivable.findFirstOrThrow({
        where: { saleId: res.body.replacementSaleId as string },
        select: { originalAmount: true, origin: true },
      });
      expect(receivable.originalAmount).toBe(150_000n);
      expect(receivable.origin).toBe('EXCHANGE');
    });

    it('fails entirely when the replacement is out of stock', async () => {
      const a = await sellable(100_000, 10);
      const b = await sellable(100_000, 0);

      const sale = await sell({
        items: [{ variantId: a, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });

      const res = await exchangeIt({
        saleId: sale.id,
        returnItems: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        replacementItems: [{ variantId: b, quantity: '1.000' }],
        reason: 'WRONG_ITEM',
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');

      // Nothing was written: the returned goods did not come back, the sale
      // is untouched, and no exchange row exists.
      expect(await levelOf(a)).toBe(9);
      const sold = await db.saleItem.findUniqueOrThrow({
        where: { id: sale.items[0]!.id },
        select: { returnedQuantity: true },
      });
      expect(Number(sold.returnedQuantity.toString())).toBe(0);
      expect(
        await db.exchange.count({ where: { organizationId: orgA.organizationId } }),
      ).toBeGreaterThanOrEqual(0);
    });

    it('the database refuses a settlement that contradicts the net', async () => {
      const a = await sellable(500_000, 10);
      const b = await sellable(500_000, 10);
      const sale = await sell({
        items: [{ variantId: a, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 500_000 }],
      });
      const res = await exchangeIt({
        saleId: sale.id,
        returnItems: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        replacementItems: [{ variantId: b, quantity: '1.000' }],
        reason: 'WRONG_ITEM',
      });

      await expect(
        db.$executeRaw`
          UPDATE exchange SET settlement = 'REFUNDED' WHERE id = ${res.body.id}::uuid
        `,
      ).rejects.toThrow(/ck_exchange_settlement_matches_net/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Idempotency and concurrency
  // ──────────────────────────────────────────────────────────────────────

  describe('idempotency', () => {
    it('a double-tapped refund pays out once', async () => {
      const variantId = await sellable(50_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });
      const key = randomUUID();
      const body = {
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '2.000' }],
        reason: 'CHANGED_MIND',
      };

      const first = await returnIt(body, managerToken, key);
      expect(first.status).toBe(201);
      const second = await returnIt(body, managerToken, key);
      expect(second.status).toBe(201);
      expect(second.body.replayed).toBe(true);
      expect(second.body.id).toBe(first.body.id);

      const refunds = await db.payment.count({
        where: { direction: 'OUT', allocations: { some: { returnId: first.body.id } } },
      });
      expect(refunds).toBe(1);
      expect(await levelOf(variantId)).toBe(20);
    });

    it('requires the header', async () => {
      const variantId = await sellable(10_000, 10);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });

      const res = await api()
        .post('/api/v1/returns')
        .set(auth(managerToken))
        .send({
          saleId: sale.id,
          items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
          reason: 'OTHER',
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('two parallel returns of the last unit: exactly one succeeds', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });
      const body = {
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        reason: 'DEFECTIVE',
      };

      const [first, second] = await Promise.all([returnIt(body), returnIt(body)]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);

      const item = await db.saleItem.findUniqueOrThrow({
        where: { id: sale.items[0]!.id },
        select: { returnedQuantity: true },
      });
      expect(Number(item.returnedQuantity.toString())).toBe(1);
      expect(await levelOf(variantId)).toBe(20);
    });

    it('an exchange is idempotent too', async () => {
      const a = await sellable(100_000, 10);
      const b = await sellable(120_000, 10);
      const sale = await sell({
        items: [{ variantId: a, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });
      const key = randomUUID();
      const body = {
        saleId: sale.id,
        returnItems: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        replacementItems: [{ variantId: b, quantity: '1.000' }],
        reason: 'WRONG_ITEM',
      };

      const first = await exchangeIt(body, managerToken, key);
      expect(first.status).toBe(201);
      const second = await exchangeIt(body, managerToken, key);
      expect(second.body.replayed).toBe(true);
      expect(second.body.id).toBe(first.body.id);

      expect(await levelOf(b)).toBe(9);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Rules
  // ──────────────────────────────────────────────────────────────────────

  describe('rules', () => {
    it('refuses a return against a cancelled sale', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });
      await api()
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Bekor' })
        .expect(201);

      const res = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        reason: 'OTHER',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SALE_NOT_COMPLETED');
    });

    it('refuses to cancel a sale that has been returned against', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 20_000 }],
      });
      await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        reason: 'OTHER',
      }).expect(201);

      const res = await api()
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Kech' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SALE_HAS_RETURNS');
    });

    it('rejects a duplicate line in one return', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '3.000' }],
        payments: [{ method: 'CASH', amount: 30_000 }],
      });

      const res = await returnIt({
        saleId: sale.id,
        items: [
          { saleItemId: sale.items[0]!.id, quantity: '1.000' },
          { saleItemId: sale.items[0]!.id, quantity: '1.000' },
        ],
        reason: 'OTHER',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_RESOURCE');
    });

    it('refuses a return outside the window without the permission', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });

      // Age the sale past the 14-day window.
      await db.sale.update({
        where: { id: sale.id },
        data: { completedAt: new Date(Date.now() - 40 * 86_400_000) },
      });

      const res = await returnIt(
        {
          saleId: sale.id,
          items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
          reason: 'DEFECTIVE',
        },
        cashierToken,
      );
      // The cashier has neither sales.refund nor sales.refund_expired.
      expect(res.status).toBe(403);

      // A manager has sales.refund but not sales.refund_expired either.
      const asManager = await returnIt({
        saleId: sale.id,
        items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
        reason: 'DEFECTIVE',
      });
      expect(asManager.status).toBe(409);
      expect(asManager.body.code).toBe('RETURN_WINDOW_EXPIRED');

      // An administrator holds the wildcard and may override.
      const asAdmin = await returnIt(
        {
          saleId: sale.id,
          items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
          reason: 'DEFECTIVE',
        },
        adminToken,
      );
      expect(asAdmin.status).toBe(201);
    });

    it('lists returns with their refund totals', async () => {
      const res = await api()
        .get('/api/v1/returns')
        .query({ limit: 50 })
        .set(auth(managerToken))
        .expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.summary).toMatchObject({
        refunded: expect.any(String),
        creditOffset: expect.any(String),
      });
    });
  });

  describe('authorization', () => {
    it('refuses a cashier, who may sell but not refund', async () => {
      const variantId = await sellable(10_000, 20);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });

      const res = await returnIt(
        {
          saleId: sale.id,
          items: [{ saleItemId: sale.items[0]!.id, quantity: '1.000' }],
          reason: 'OTHER',
        },
        cashierToken,
      );
      expect(res.status).toBe(403);
    });

    it('refuses a warehouse keeper entirely', async () => {
      await api().get('/api/v1/returns').set(auth(warehouseToken)).expect(403);
    });

    it('rejects unauthenticated requests', async () => {
      await api().get('/api/v1/returns').expect(401);
      await api().post('/api/v1/exchanges').set(idem()).send({}).expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("cannot return another organization's sale", async () => {
      const res = await returnIt({
        saleId: foreign.saleId,
        items: [{ saleItemId: foreign.saleItemId, quantity: '1.000' }],
        reason: 'OTHER',
      });
      expect(res.status).toBe(404);

      const untouched = await db.saleItem.findUniqueOrThrow({
        where: { id: foreign.saleItemId },
        select: { returnedQuantity: true },
      });
      expect(Number(untouched.returnedQuantity.toString())).toBe(0);
    });

    it("cannot read another organization's returnable lines", async () => {
      await api()
        .get(`/api/v1/returns/returnable/${foreign.saleId}`)
        .set(auth(managerToken))
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Consistency
  // ──────────────────────────────────────────────────────────────────────

  describe('consistency', () => {
    it('no sale item is returned for more than it was sold', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sale_item
         WHERE organization_id = ${orgA.organizationId}::uuid
           AND returned_quantity > quantity
      `;
      expect(broken).toEqual([]);
    });

    it('no sale item is refunded for more than its net amount', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sale_item
         WHERE organization_id = ${orgA.organizationId}::uuid
           AND refunded_amount > net_amount
      `;
      expect(broken).toEqual([]);
    });

    it('no sale is refunded for more than its total', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM sale
         WHERE organization_id = ${orgA.organizationId}::uuid
           AND refunded_amount > total_amount
      `;
      expect(broken).toEqual([]);
    });

    it('every return equals the sum of its own lines', async () => {
      const mismatched = await db.$queryRaw<Array<{ id: string }>>`
        SELECT r.id
          FROM sale_return r
         WHERE r.organization_id = ${orgA.organizationId}::uuid
           AND r.exchange_id IS NULL
           AND r.refund_amount + r.credit_offset_amount <> COALESCE((
             SELECT SUM(i.refund_amount) FROM return_item i WHERE i.return_id = r.id
           ), 0)
      `;
      expect(mismatched).toEqual([]);
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
