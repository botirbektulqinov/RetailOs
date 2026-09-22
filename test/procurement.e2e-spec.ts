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
 * Suppliers, purchases and payables — docs/ARCHITECTURE.md §15 and §16.
 *
 * Receiving is the half that matters: it is the only path in the system that
 * creates stock out of nothing, so every test here checks the ledger as well
 * as the level, and the suite ends by re-running §9.7's reconciliation.
 */
describe('Procurement (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let managerToken: string;
  let cashierToken: string;
  let warehouseToken: string;

  let foreign: { supplierId: string; purchaseId: string; variantId: string };

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
  const nextSku = () => `PO-${Date.now().toString(36)}-${counter++}`.toUpperCase();

  async function makeSupplier(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api()
      .post('/api/v1/suppliers')
      .set(auth(adminToken))
      .send({ name: `Taminotchi ${counter++}`, ...over });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function makeVariant(): Promise<string> {
    const res = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({ name: `Xarid mahsuloti ${counter}`, sku: nextSku(), sellingPrice: 20_000 });
    expect(res.status).toBe(201);
    return res.body.variants[0].id as string;
  }

  interface CreatedPurchase {
    id: string;
    status: string;
    purchaseNumber: string;
    subtotalAmount: string;
    discountAmount: string;
    shippingAmount: string;
    totalAmount: string;
    remainingAmount: string;
    items: Array<{ lineAmount: string }>;
  }

  async function makePurchase(
    supplierId: string,
    items: Array<{ variantId: string; quantity: string; unitCost: number }>,
    over: Record<string, unknown> = {},
  ): Promise<CreatedPurchase> {
    const res = await api()
      .post('/api/v1/purchases')
      .set(auth(managerToken))
      .send({ supplierId, items, order: true, ...over });
    expect(res.status).toBe(201);
    return res.body as CreatedPurchase;
  }

  function receive(purchaseId: string, body: Record<string, unknown>, key?: string) {
    return api()
      .post(`/api/v1/purchases/${purchaseId}/receive`)
      .set(auth(warehouseToken))
      .set(key ? { 'Idempotency-Key': key } : idem())
      .send(body);
  }

  function payTo(body: Record<string, unknown>, token = managerToken, key?: string) {
    return api()
      .post('/api/v1/suppliers/payments')
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
    orgA = await seedTestOrg(db, 'procA');
    orgB = await seedTestOrg(db, 'procB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    managerToken = await tokenFor(orgA, 'MANAGER');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    const foreignSupplier = await db.supplier.create({
      data: { organizationId: orgB.organizationId, name: 'Begona taminotchi' },
      select: { id: true },
    });
    const product = await db.product.create({
      data: { organizationId: orgB.organizationId, name: 'Begona mahsulot' },
      select: { id: true },
    });
    const variant = await db.productVariant.create({
      data: {
        organizationId: orgB.organizationId,
        productId: product.id,
        sku: 'FOREIGN-PO-1',
        sellingPrice: 1_000n,
        isDefault: true,
      },
      select: { id: true },
    });
    const foreignPurchase = await db.purchase.create({
      data: {
        organizationId: orgB.organizationId,
        storeId: orgB.storeId,
        warehouseId: orgB.warehouseId,
        supplierId: foreignSupplier.id,
        purchaseNumber: 'PO-999999',
        status: 'ORDERED',
        subtotalAmount: 100_000n,
        totalAmount: 100_000n,
        orderedAt: new Date(),
        createdBy: orgB.users.get('ADMIN')!.id,
      },
      select: { id: true },
    });

    foreign = {
      supplierId: foreignSupplier.id,
      purchaseId: foreignPurchase.id,
      variantId: variant.id,
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
  // Suppliers
  // ──────────────────────────────────────────────────────────────────────

  describe('supplier CRUD', () => {
    it('creates, reads, updates and archives', async () => {
      const name = `Nestle ${counter++}`;
      const created = await api()
        .post('/api/v1/suppliers')
        .set(auth(adminToken))
        .send({ name, phone: '+998712001020', paymentTermDays: 14, contactName: 'Aziz' });

      expect(created.status).toBe(201);
      expect(created.body.name).toBe(name);
      expect(created.body.balance.payable).toBe('0');

      const updated = await api()
        .patch(`/api/v1/suppliers/${created.body.id}`)
        .set(auth(adminToken))
        .send({ paymentTermDays: 30 });
      expect(updated.body.paymentTermDays).toBe(30);

      const archived = await api()
        .patch(`/api/v1/suppliers/${created.body.id}/archive`)
        .set(auth(adminToken));
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();

      const restored = await api()
        .patch(`/api/v1/suppliers/${created.body.id}/restore`)
        .set(auth(adminToken));
      expect(restored.body.archivedAt).toBeNull();
    });

    it('refuses a duplicate name among live suppliers', async () => {
      const name = `Coca ${counter++}`;
      await api().post('/api/v1/suppliers').set(auth(adminToken)).send({ name }).expect(201);
      const res = await api().post('/api/v1/suppliers').set(auth(adminToken)).send({ name });
      expect(res.status).toBe(409);
    });

    it('searches by name and contact', async () => {
      await api()
        .post('/api/v1/suppliers')
        .set(auth(adminToken))
        .send({ name: 'Maxsus Qidiruv Taminot', contactName: 'Bekzod' })
        .expect(201);

      const res = await api()
        .get('/api/v1/suppliers')
        .query({ q: 'Maxsus Qidiruv' })
        .set(auth(managerToken))
        .expect(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Purchases and receiving
  // ──────────────────────────────────────────────────────────────────────

  describe('purchase creation', () => {
    it('computes the totals server-side', async () => {
      const supplierId = await makeSupplier();
      const a = await makeVariant();
      const b = await makeVariant();

      const purchase = await makePurchase(
        supplierId,
        [
          { variantId: a, quantity: '100.000', unitCost: 12_000 },
          { variantId: b, quantity: '50.000', unitCost: 8_000 },
        ],
        { discountAmount: 100_000, shippingAmount: 50_000 },
      );

      expect(purchase.subtotalAmount).toBe('1600000');
      expect(purchase.discountAmount).toBe('100000');
      expect(purchase.shippingAmount).toBe('50000');
      // ck_purchase_total_adds_up checks this in the database too.
      expect(purchase.totalAmount).toBe('1550000');
      expect(purchase.remainingAmount).toBe('1550000');
      expect(purchase.purchaseNumber).toMatch(/^PO-\d{6}$/);
      expect(purchase.status).toBe('ORDERED');
    });

    it('rounds each line once', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();

      // 1.5 x 13,333 = 19,999.5 → 20,000, rounded once.
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '1.500', unitCost: 13_333 },
      ]);
      expect(purchase.items[0]!.lineAmount).toBe('20000');
    });

    it('starts as a DRAFT when not ordered, and can be edited then sent', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();

      const draft = await api()
        .post('/api/v1/purchases')
        .set(auth(managerToken))
        .send({ supplierId, items: [{ variantId, quantity: '10.000', unitCost: 5_000 }] })
        .expect(201);
      expect(draft.body.status).toBe('DRAFT');

      const edited = await api()
        .patch(`/api/v1/purchases/${draft.body.id}`)
        .set(auth(managerToken))
        .send({ items: [{ variantId, quantity: '20.000', unitCost: 5_000 }] });
      expect(edited.status).toBe(200);
      expect(edited.body.totalAmount).toBe('100000');

      const ordered = await api()
        .post(`/api/v1/purchases/${draft.body.id}/order`)
        .set(auth(managerToken));
      expect(ordered.body.status).toBe('ORDERED');
      expect(ordered.body.orderedAt).not.toBeNull();
    });

    it('refuses to edit an order already sent', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '5.000', unitCost: 1_000 },
      ]);

      const res = await api()
        .patch(`/api/v1/purchases/${purchase.id}`)
        .set(auth(managerToken))
        .send({ items: [{ variantId, quantity: '99.000', unitCost: 1_000 }] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURCHASE_NOT_DRAFT');
    });

    it('rejects a duplicate line', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();

      const res = await api()
        .post('/api/v1/purchases')
        .set(auth(managerToken))
        .send({
          supplierId,
          items: [
            { variantId, quantity: '1.000', unitCost: 1_000 },
            { variantId, quantity: '2.000', unitCost: 1_000 },
          ],
        });
      expect(res.status).toBe(409);
    });

    it('does not move stock when a purchase is merely ordered', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      await makePurchase(supplierId, [{ variantId, quantity: '40.000', unitCost: 1_000 }]);

      expect(await levelOf(variantId)).toBe(0);
    });
  });

  describe('receiving', () => {
    it('increases stock and writes a PURCHASE movement', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '100.000', unitCost: 12_000 },
      ]);

      const res = await receive(purchase.id, {});
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('RECEIVED');
      expect(res.body.receivedAt).not.toBeNull();

      expect(await levelOf(variantId)).toBe(100);

      const movement = await db.inventoryMovement.findFirst({
        where: { sourceType: 'purchase', sourceId: purchase.id, productVariantId: variantId },
        select: { type: true, quantityDelta: true, unitCost: true },
      });
      expect(movement!.type).toBe('PURCHASE');
      expect(Number(movement!.quantityDelta.toString())).toBe(100);
      // The cost travels with the receipt, which is what rolls the moving
      // average forward.
      expect(movement!.unitCost).toBe(12_000n);
    });

    it('walks the sprint example: ordered 100, received 60, 40 outstanding', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '100.000', unitCost: 10_000 },
      ]);

      const first = await receive(purchase.id, {
        items: [{ variantId, quantity: '60.000' }],
      });
      expect(first.status).toBe(201);
      expect(first.body.status).toBe('PARTIALLY_RECEIVED');
      expect(first.body.items[0]).toMatchObject({
        orderedQuantity: '100.000',
        receivedQuantity: '60.000',
        outstandingQuantity: '40.000',
      });
      expect(await levelOf(variantId)).toBe(60);

      const second = await receive(purchase.id, {
        items: [{ variantId, quantity: '40.000' }],
      });
      expect(second.body.status).toBe('RECEIVED');
      expect(await levelOf(variantId)).toBe(100);

      // Two deliveries, two movements.
      const movements = await db.inventoryMovement.count({
        where: { sourceType: 'purchase', sourceId: purchase.id },
      });
      expect(movements).toBe(2);
    });

    it('sets the moving average cost from the receipt', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();

      const first = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);
      await receive(first.id, {}).expect(201);

      const second = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 2_000 },
      ]);
      await receive(second.id, {}).expect(201);

      const level = await db.inventoryLevel.findFirstOrThrow({
        where: { warehouseId: orgA.warehouseId, productVariantId: variantId },
        select: { avgCost: true, quantity: true },
      });
      expect(level.avgCost).toBe(1_500n);
      expect(Number(level.quantity.toString())).toBe(20);
    });

    it('refuses over-receipt, and moves nothing', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);

      const res = await receive(purchase.id, { items: [{ variantId, quantity: '15.000' }] });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OVER_RECEIPT');
      expect(res.body.errors[0].meta.outstanding).toBe('10.000');
      expect(await levelOf(variantId)).toBe(0);
    });

    it('refuses to exceed the order across two receipts', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);

      await receive(purchase.id, { items: [{ variantId, quantity: '8.000' }] }).expect(201);
      const res = await receive(purchase.id, { items: [{ variantId, quantity: '5.000' }] });

      expect(res.status).toBe(409);
      expect(await levelOf(variantId)).toBe(8);
    });

    it('is idempotent — a retried delivery does not create phantom stock', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '50.000', unitCost: 1_000 },
      ]);
      const key = randomUUID();

      const first = await receive(purchase.id, { items: [{ variantId, quantity: '50.000' }] }, key);
      expect(first.status).toBe(201);

      const second = await receive(
        purchase.id,
        { items: [{ variantId, quantity: '50.000' }] },
        key,
      );
      expect(second.status).toBe(201);
      expect(second.body.replayed).toBe(true);

      expect(await levelOf(variantId)).toBe(50);
      const movements = await db.inventoryMovement.count({
        where: { sourceType: 'purchase', sourceId: purchase.id },
      });
      expect(movements).toBe(1);
    });

    it('survives two clerks booking in the same pallet in parallel', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '30.000', unitCost: 1_000 },
      ]);

      const results = await Promise.all([
        receive(purchase.id, { items: [{ variantId, quantity: '30.000' }] }),
        receive(purchase.id, { items: [{ variantId, quantity: '30.000' }] }),
      ]);

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await levelOf(variantId)).toBe(30);
    });

    it('requires the idempotency header', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '5.000', unitCost: 1_000 },
      ]);

      const res = await api()
        .post(`/api/v1/purchases/${purchase.id}/receive`)
        .set(auth(warehouseToken))
        .send({});
      expect(res.status).toBe(400);
    });

    it('cannot receive against a draft', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const draft = await api()
        .post('/api/v1/purchases')
        .set(auth(managerToken))
        .send({ supplierId, items: [{ variantId, quantity: '5.000', unitCost: 1_000 }] })
        .expect(201);

      const res = await receive(draft.body.id, {});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURCHASE_NOT_RECEIVABLE');
    });

    it('accepts a corrected unit cost at receipt time', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);

      await receive(purchase.id, {
        items: [{ variantId, quantity: '10.000', unitCost: 1_200 }],
      }).expect(201);

      const level = await db.inventoryLevel.findFirstOrThrow({
        where: { warehouseId: orgA.warehouseId, productVariantId: variantId },
        select: { avgCost: true },
      });
      expect(level.avgCost).toBe(1_200n);
    });
  });

  describe('cancellation', () => {
    it('cancels an order nothing has arrived against', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);

      const res = await api()
        .post(`/api/v1/purchases/${purchase.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Taminotchida yoq' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('CANCELLED');
      expect(await levelOf(variantId)).toBe(0);
    });

    it('refuses to cancel once goods have arrived', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);
      await receive(purchase.id, { items: [{ variantId, quantity: '3.000' }] }).expect(201);

      const res = await api()
        .post(`/api/v1/purchases/${purchase.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Fikrimiz ozgardi' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURCHASE_HAS_RECEIPTS');
      expect(await levelOf(variantId)).toBe(3);
    });

    it('refuses to cancel once paid', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);
      await payTo({
        supplierId,
        purchaseId: purchase.id,
        amount: 5_000,
        method: 'TRANSFER',
      }).expect(201);

      const res = await api()
        .post(`/api/v1/purchases/${purchase.id}/cancel`)
        .set(auth(managerToken))
        .send({ reason: 'Kech' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PURCHASE_HAS_PAYMENTS');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Payables
  // ──────────────────────────────────────────────────────────────────────

  describe('supplier payables', () => {
    it('a received purchase creates a payable', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '100.000', unitCost: 50_000 },
      ]);
      await receive(purchase.id, {}).expect(201);

      const balance = await api()
        .get(`/api/v1/suppliers/${supplierId}/balance`)
        .set(auth(managerToken))
        .expect(200);

      expect(balance.body.invoiced).toBe('5000000');
      expect(balance.body.paidOnInvoices).toBe('0');
      expect(balance.body.payable).toBe('5000000');
      expect(balance.body.openPurchases).toBe(1);
    });

    it('partial payment leaves the rest outstanding and does not change receipt status', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '100.000', unitCost: 50_000 },
      ]);
      await receive(purchase.id, {}).expect(201);

      const payment = await payTo({
        supplierId,
        purchaseId: purchase.id,
        amount: 3_000_000,
        method: 'TRANSFER',
        reference: 'TP-4412',
      });
      expect(payment.status).toBe(201);

      const reread = await api()
        .get(`/api/v1/purchases/${purchase.id}`)
        .set(auth(managerToken))
        .expect(200);

      expect(reread.body.paidAmount).toBe('3000000');
      expect(reread.body.remainingAmount).toBe('2000000');
      // Payment state is separate from receipt state.
      expect(reread.body.status).toBe('RECEIVED');
    });

    it('settles the rest and clears the payable', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 100_000 },
      ]);
      await receive(purchase.id, {}).expect(201);

      await payTo({ supplierId, purchaseId: purchase.id, amount: 400_000, method: 'CASH' }).expect(
        201,
      );
      await payTo({ supplierId, purchaseId: purchase.id, amount: 600_000, method: 'CASH' }).expect(
        201,
      );

      const balance = await api()
        .get(`/api/v1/suppliers/${supplierId}/balance`)
        .set(auth(managerToken));
      expect(balance.body.payable).toBe('0');
      expect(balance.body.openPurchases).toBe(0);
    });

    it('refuses to pay more than a purchase is worth', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 10_000 },
      ]);

      const res = await payTo({
        supplierId,
        purchaseId: purchase.id,
        amount: 500_000,
        method: 'TRANSFER',
      });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SUPPLIER_OVERPAYMENT');
      expect(res.body.errors[0].meta.remaining).toBe('100000');

      // Nothing was written.
      const reread = await api().get(`/api/v1/purchases/${purchase.id}`).set(auth(managerToken));
      expect(reread.body.paidAmount).toBe('0');
    });

    it('two managers settling one invoice cannot together overpay it', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 10_000 },
      ]);

      const settle = () =>
        payTo({ supplierId, purchaseId: purchase.id, amount: 100_000, method: 'TRANSFER' });

      const [first, second] = await Promise.all([settle(), settle()]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);

      const reread = await api().get(`/api/v1/purchases/${purchase.id}`).set(auth(managerToken));
      expect(reread.body.paidAmount).toBe('100000');
    });

    it('is idempotent', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 10_000 },
      ]);
      const key = randomUUID();
      const body = { supplierId, purchaseId: purchase.id, amount: 50_000, method: 'CASH' };

      const first = await payTo(body, managerToken, key);
      expect(first.status).toBe(201);
      const second = await payTo(body, managerToken, key);
      expect(second.body.replayed).toBe(true);
      expect(second.body.paymentId).toBe(first.body.paymentId);

      const reread = await api().get(`/api/v1/purchases/${purchase.id}`).set(auth(managerToken));
      expect(reread.body.paidAmount).toBe('50000');
    });

    it('records a payment on account as unapplied credit', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 100_000 },
      ]);
      await receive(purchase.id, {}).expect(201);

      const payment = await payTo({ supplierId, amount: 300_000, method: 'TRANSFER' });
      expect(payment.status).toBe(201);
      expect(payment.body.applied).toBe(false);

      const balance = await api()
        .get(`/api/v1/suppliers/${supplierId}/balance`)
        .set(auth(managerToken));

      // The invoice still shows fully outstanding; the advance is visible
      // separately rather than silently absorbed.
      expect(balance.body.invoiced).toBe('1000000');
      expect(balance.body.paidOnInvoices).toBe('0');
      expect(balance.body.unappliedCredit).toBe('300000');
      expect(balance.body.payable).toBe('700000');
    });

    it('a payment record cannot be edited afterwards', async () => {
      const supplierId = await makeSupplier();
      const res = await payTo({ supplierId, amount: 10_000, method: 'CASH' });
      expect(res.status).toBe(201);

      await expect(
        db.$executeRaw`UPDATE supplier_payment SET amount = 1 WHERE id = ${res.body.paymentId}::uuid`,
      ).rejects.toThrow(/append-only/i);
    });

    it('a supplier we still owe cannot be archived', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 10_000 },
      ]);
      await receive(purchase.id, {}).expect(201);

      const res = await api()
        .patch(`/api/v1/suppliers/${supplierId}/archive`)
        .set(auth(adminToken));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SUPPLIER_HAS_PAYABLE');
    });

    it('builds a statement from purchases and payments, with a running balance', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 50_000 },
      ]);
      await receive(purchase.id, {}).expect(201);
      await payTo({ supplierId, purchaseId: purchase.id, amount: 200_000, method: 'CASH' }).expect(
        201,
      );

      const res = await api()
        .get(`/api/v1/suppliers/${supplierId}/statement`)
        .set(auth(managerToken))
        .expect(200);

      expect(res.body.entries).toHaveLength(2);
      expect(res.body.entries[0]).toMatchObject({ kind: 'PURCHASE', debit: '500000' });
      expect(res.body.entries[1]).toMatchObject({ kind: 'PAYMENT', credit: '200000' });
      expect(res.body.closingBalance).toBe('300000');
    });

    it('lists suppliers we owe, sorted by what we owe', async () => {
      const res = await api()
        .get('/api/v1/suppliers')
        .query({ hasPayable: 'true', sort: 'payable:desc', limit: 50 })
        .set(auth(managerToken))
        .expect(200);

      const amounts = res.body.data.map((s: { balance: { payable: string } }) =>
        BigInt(s.balance.payable),
      );
      expect(amounts.every((a: bigint) => a > 0n)).toBe(true);
      for (let i = 1; i < amounts.length; i += 1) {
        expect(amounts[i - 1] >= amounts[i]).toBe(true);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Authorization and isolation
  // ──────────────────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('a warehouse keeper may receive but not order or pay', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '10.000', unitCost: 1_000 },
      ]);

      await receive(purchase.id, {}).expect(201);

      await api()
        .post('/api/v1/purchases')
        .set(auth(warehouseToken))
        .send({ supplierId, items: [{ variantId, quantity: '1.000', unitCost: 1 }] })
        .expect(403);

      await payTo({ supplierId, amount: 1_000, method: 'CASH' }, warehouseToken).expect(403);
    });

    it('a cashier sees no procurement at all', async () => {
      await api().get('/api/v1/suppliers').set(auth(cashierToken)).expect(403);
      await api().get('/api/v1/purchases').set(auth(cashierToken)).expect(403);
    });

    it('rejects unauthenticated requests', async () => {
      await api().get('/api/v1/suppliers').expect(401);
      await api().get('/api/v1/purchases').expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("cannot read another organization's supplier or purchase", async () => {
      await api().get(`/api/v1/suppliers/${foreign.supplierId}`).set(auth(adminToken)).expect(404);
      await api()
        .get(`/api/v1/purchases/${foreign.purchaseId}`)
        .set(auth(managerToken))
        .expect(404);
    });

    it("cannot receive against another organization's purchase", async () => {
      const res = await receive(foreign.purchaseId, {});
      expect(res.status).toBe(404);
    });

    it("cannot pay another organization's supplier", async () => {
      const res = await payTo({ supplierId: foreign.supplierId, amount: 1_000, method: 'CASH' });
      expect(res.status).toBe(404);
    });

    it("cannot order another organization's product", async () => {
      const supplierId = await makeSupplier();
      const res = await api()
        .post('/api/v1/purchases')
        .set(auth(managerToken))
        .send({
          supplierId,
          items: [{ variantId: foreign.variantId, quantity: '1.000', unitCost: 1_000 }],
        });
      expect(res.status).toBe(404);
    });

    it("never lists another organization's suppliers", async () => {
      const res = await api()
        .get('/api/v1/suppliers')
        .query({ limit: 100 })
        .set(auth(managerToken))
        .expect(200);
      expect(res.body.data.map((s: { id: string }) => s.id)).not.toContain(foreign.supplierId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Database guarantees
  // ──────────────────────────────────────────────────────────────────────

  describe('database constraints', () => {
    it('refuses a purchase whose total does not add up', async () => {
      const supplierId = await makeSupplier();
      await expect(
        db.$executeRaw`
          INSERT INTO purchase (id, organization_id, store_id, warehouse_id, supplier_id,
                                purchase_number, status, subtotal_amount, discount_amount,
                                shipping_amount, total_amount, created_by, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.storeId}::uuid,
                  ${orgA.warehouseId}::uuid, ${supplierId}::uuid, 'PO-BAD-1', 'DRAFT',
                  1000, 0, 0, 9999, ${orgA.users.get('ADMIN')!.id}::uuid, now(), now())
        `,
      ).rejects.toThrow(/ck_purchase_total_adds_up/);
    });

    it('refuses a purchase paid past its total', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '1.000', unitCost: 1_000 },
      ]);

      await expect(
        db.$executeRaw`UPDATE purchase SET paid_amount = 99999 WHERE id = ${purchase.id}::uuid`,
      ).rejects.toThrow(/ck_purchase_not_overpaid/);
    });

    it('refuses a line received past its order', async () => {
      const supplierId = await makeSupplier();
      const variantId = await makeVariant();
      const purchase = await makePurchase(supplierId, [
        { variantId, quantity: '5.000', unitCost: 1_000 },
      ]);

      await expect(
        db.$executeRaw`
          UPDATE purchase_item SET received_quantity = 9 WHERE purchase_id = ${purchase.id}::uuid
        `,
      ).rejects.toThrow(/ck_purchase_item_received_within_ordered/);
    });

    it("refuses a purchase pointing at another organization's supplier", async () => {
      await expect(
        db.$executeRaw`
          INSERT INTO purchase (id, organization_id, store_id, warehouse_id, supplier_id,
                                purchase_number, status, subtotal_amount, total_amount,
                                created_by, created_at, updated_at)
          VALUES (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.storeId}::uuid,
                  ${orgA.warehouseId}::uuid, ${foreign.supplierId}::uuid, 'PO-BAD-2', 'DRAFT',
                  0, 0, ${orgA.users.get('ADMIN')!.id}::uuid, now(), now())
        `,
      ).rejects.toThrow(/fk_purchase_supplier_same_org/);
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

    it('every purchase equals the sum of its own lines', async () => {
      const mismatched = await db.$queryRaw<Array<{ id: string }>>`
        SELECT p.id
          FROM purchase p
         WHERE p.organization_id = ${orgA.organizationId}::uuid
           AND p.status <> 'CANCELLED'
           AND p.subtotal_amount <> COALESCE((
             SELECT SUM(i.line_amount) FROM purchase_item i WHERE i.purchase_id = p.id
           ), 0)
      `;
      expect(mismatched).toEqual([]);
    });
  });
});
