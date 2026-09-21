import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { applyGlobalSetup } from '../src/bootstrap';
import { writeStockMovement } from '../src/inventory/stock-writer';
import { dropStaleTestOrgs, dropTestOrg, seedTestOrg, TEST_PASSWORD } from './helpers/seed-org';
import type { SeededOrg } from './helpers/seed-org';

/**
 * Inventory over real HTTP — levels, the ledger, adjustments, counts and
 * transfers.
 *
 * Two things this suite is deliberately strict about:
 *
 *   1. Every stock number is checked against the ledger as well as the level.
 *      A test that only reads the projection would pass while the truth it is
 *      derived from rotted (docs/ARCHITECTURE.md §9.7).
 *   2. The concurrency tests fire genuinely parallel requests rather than
 *      simulating a race. A check-then-act bug survives any sequential test.
 */
describe('Inventory (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let cashierToken: string;
  let warehouseToken: string;

  /** Organization B fixtures, so the isolation probes attack real rows. */
  let foreign: { warehouseId: string; variantId: string; levelId: string };

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function tokenFor(org: SeededOrg, roleCode: string): Promise<string> {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ phone: org.users.get(roleCode)!.phone, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  let skuCounter = 0;
  const nextSku = () => `INV-${Date.now().toString(36)}-${skuCounter++}`.toUpperCase();

  /** A fresh product with its default variant, via the real catalog API. */
  async function makeVariant(
    overrides: Record<string, unknown> = {},
  ): Promise<{ variantId: string; productId: string; sku: string }> {
    const sku = nextSku();
    const res = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({
        name: 'Qoldiq testi',
        sku,
        sellingPrice: 20_000,
        purchasePrice: 12_000,
        ...overrides,
      });
    expect(res.status).toBe(201);
    return {
      variantId: res.body.variants[0].id as string,
      productId: res.body.id as string,
      sku,
    };
  }

  /** Arranges stock for a test. Uses the adjustment endpoint deliberately:
   *  arranging fixtures with raw SQL would let a broken write path still
   *  produce a passing test. */
  async function stock(
    variantId: string,
    quantity: number,
    warehouseId = orgA.warehouseId,
  ): Promise<void> {
    const res = await api()
      .post('/api/v1/inventory/adjustments')
      .set(auth(adminToken))
      .send({
        warehouseId,
        lines: [{ variantId, quantity: quantity.toFixed(3), reason: 'CORRECTION' }],
      });
    expect(res.status).toBe(201);
  }

  async function levelOf(variantId: string, warehouseId = orgA.warehouseId): Promise<number> {
    const level = await db.inventoryLevel.findFirst({
      where: { warehouseId, productVariantId: variantId },
      select: { quantity: true },
    });
    return level ? Number(level.quantity.toString()) : 0;
  }

  /** The ledger's own answer, which must always equal the level. */
  async function ledgerOf(variantId: string, warehouseId = orgA.warehouseId): Promise<number> {
    const rows = await db.$queryRaw<Array<{ total: string }>>`
      SELECT COALESCE(SUM(quantity_delta), 0)::text AS total
        FROM inventory_movement
       WHERE warehouse_id = ${warehouseId}::uuid
         AND product_variant_id = ${variantId}::uuid
    `;
    return Number(rows[0]!.total);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'invA');
    orgB = await seedTestOrg(db, 'invB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    // Organization B: a real product with real stock, so every cross-tenant
    // probe below is denied access to something that actually exists.
    const product = await db.product.create({
      data: { organizationId: orgB.organizationId, name: 'Begona mahsulot' },
      select: { id: true },
    });
    const variant = await db.productVariant.create({
      data: {
        organizationId: orgB.organizationId,
        productId: product.id,
        sku: 'FOREIGN-INV-1',
        sellingPrice: 5_000n,
        isDefault: true,
      },
      select: { id: true },
    });
    const level = await db.inventoryLevel.create({
      data: {
        organizationId: orgB.organizationId,
        warehouseId: orgB.warehouseId,
        productVariantId: variant.id,
        quantity: '99.000',
        avgCost: 3_000n,
      },
      select: { id: true },
    });

    foreign = { warehouseId: orgB.warehouseId, variantId: variant.id, levelId: level.id };
  }, 90_000);

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
  // Stock initialization and the ledger
  // ──────────────────────────────────────────────────────────────────────

  describe('stock initialization', () => {
    it('a brand-new variant has no level row and reads as out of stock', async () => {
      const { variantId } = await makeVariant();

      expect(await levelOf(variantId)).toBe(0);

      const res = await api().get(`/api/v1/inventory/${variantId}`).set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.totalQuantity).toBe('0.000');
      expect(res.body.status).toBe('OUT_OF_STOCK');
      expect(res.body.warehouses).toEqual([]);
    });

    it('creates the level on the first movement and records it in the ledger', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 40);

      expect(await levelOf(variantId)).toBe(40);
      expect(await ledgerOf(variantId)).toBe(40);

      const movements = await db.inventoryMovement.findMany({
        where: { productVariantId: variantId },
        select: { type: true, quantityDelta: true, quantityAfter: true, sourceType: true },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]!.type).toBe('ADJUSTMENT');
      expect(Number(movements[0]!.quantityAfter.toString())).toBe(40);
      expect(movements[0]!.sourceType).toBe('adjustment');
    });

    it('stores quantityAfter so a point-in-time question is one row read', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);
      await stock(variantId, 5);
      await stock(variantId, -3);

      const movements = await db.inventoryMovement.findMany({
        where: { productVariantId: variantId },
        orderBy: { createdAt: 'asc' },
        select: { quantityAfter: true },
      });
      expect(movements.map((m) => Number(m.quantityAfter.toString()))).toEqual([10, 15, 12]);
    });

    it('tracks fractional quantities — 1.5 kg of rice is a real quantity', async () => {
      const { variantId } = await makeVariant({ unit: 'KG' });
      await stock(variantId, 2.5);
      await stock(variantId, -0.75);

      expect(await levelOf(variantId)).toBe(1.75);
      expect(await ledgerOf(variantId)).toBe(1.75);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Adjustments
  // ──────────────────────────────────────────────────────────────────────

  describe('adjustments', () => {
    it('increases stock', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 12);
      expect(await levelOf(variantId)).toBe(12);
    });

    it('decreases stock', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 12);
      await stock(variantId, -5);
      expect(await levelOf(variantId)).toBe(7);
    });

    it('refuses to take more than there is, and says how much there is', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 4);

      const res = await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '-5.0', reason: 'CORRECTION' }],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      expect(res.body.errors[0].meta).toMatchObject({ available: '4.000', requested: '5.000' });
      expect(await levelOf(variantId)).toBe(4);
    });

    it('rolls the whole request back when one line fails', async () => {
      const a = await makeVariant();
      const b = await makeVariant();
      await stock(a.variantId, 10);
      await stock(b.variantId, 1);

      const res = await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [
            { variantId: a.variantId, quantity: '-5.0', reason: 'DAMAGE' },
            { variantId: b.variantId, quantity: '-50.0', reason: 'DAMAGE' },
          ],
        });

      expect(res.status).toBe(409);
      // The first line must not have survived the second line's failure.
      expect(await levelOf(a.variantId)).toBe(10);
      expect(await levelOf(b.variantId)).toBe(1);
      expect(await ledgerOf(a.variantId)).toBe(10);
    });

    it('maps DAMAGE and WRITE_OFF to their own movement types', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 20);

      await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [
            { variantId, quantity: '-2.0', reason: 'DAMAGE' },
            { variantId, quantity: '-1.0', reason: 'WRITE_OFF' },
          ],
        })
        .expect(201);

      const types = await db.inventoryMovement.findMany({
        where: { productVariantId: variantId },
        select: { type: true, reason: true },
      });
      expect(types.map((t) => t.type).sort()).toEqual(['ADJUSTMENT', 'DAMAGE', 'WRITE_OFF']);
      // Every reducing movement names its reason — the database insists.
      expect(types.every((t) => t.reason !== null)).toBe(true);
      expect(await levelOf(variantId)).toBe(17);
    });

    it('rejects a zero-quantity line', async () => {
      const { variantId } = await makeVariant();
      const res = await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '0.0', reason: 'CORRECTION' }],
        });
      expect([400, 422]).toContain(res.status);
    });

    it('rejects an unknown reason', async () => {
      const { variantId } = await makeVariant();
      await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '1.0', reason: 'BECAUSE' }],
        })
        .expect(400);
    });

    it('writes an audit entry naming every line', async () => {
      const { variantId, sku } = await makeVariant();
      await stock(variantId, 9);

      const entry = await db.auditLog.findFirst({
        where: { organizationId: orgA.organizationId, action: 'inventory.adjusted' },
        // By id, not createdAt: two entries in the same microsecond tie, and
        // the tie-break would be arbitrary.
        orderBy: { id: 'desc' },
      });
      expect(entry).not.toBeNull();
      const metadata = entry!.metadata as { lines: Array<{ sku: string; quantity: string }> };
      expect(metadata.lines.some((l) => l.sku === sku && l.quantity === '9.000')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Concurrency — docs/ARCHITECTURE.md §9.3
  // ──────────────────────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('two simultaneous deductions of the last unit: exactly one wins', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 1);

      const take = () =>
        api()
          .post('/api/v1/inventory/adjustments')
          .set(auth(adminToken))
          .send({
            warehouseId: orgA.warehouseId,
            lines: [{ variantId, quantity: '-1.0', reason: 'CORRECTION' }],
          });

      const [first, second] = await Promise.all([take(), take()]);
      const statuses = [first.status, second.status].sort();

      expect(statuses).toEqual([201, 409]);
      expect(await levelOf(variantId)).toBe(0);
      expect(await ledgerOf(variantId)).toBe(0);
    });

    it('ten parallel deductions of five units leave exactly five', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 5);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          api()
            .post('/api/v1/inventory/adjustments')
            .set(auth(adminToken))
            .send({
              warehouseId: orgA.warehouseId,
              lines: [{ variantId, quantity: '-1.0', reason: 'CORRECTION' }],
            }),
        ),
      );

      expect(results.filter((r) => r.status === 201)).toHaveLength(5);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(await levelOf(variantId)).toBe(0);
      // The point of the whole design: the projection still equals the ledger.
      expect(await ledgerOf(variantId)).toBe(0);
    });

    it('parallel increases do not lose an update', async () => {
      const { variantId } = await makeVariant();

      await Promise.all(
        Array.from({ length: 8 }, () =>
          api()
            .post('/api/v1/inventory/adjustments')
            .set(auth(adminToken))
            .send({
              warehouseId: orgA.warehouseId,
              lines: [{ variantId, quantity: '3.0', reason: 'CORRECTION' }],
            })
            .expect(201),
        ),
      );

      expect(await levelOf(variantId)).toBe(24);
      expect(await ledgerOf(variantId)).toBe(24);
    });

    it('a first-ever movement racing itself does not collide on the level index', async () => {
      const { variantId } = await makeVariant();

      // Both requests find no level row and both try to create one. ON
      // CONFLICT DO NOTHING is what keeps the loser queueing rather than
      // failing on the unique index.
      const results = await Promise.all([
        api()
          .post('/api/v1/inventory/adjustments')
          .set(auth(adminToken))
          .send({
            warehouseId: orgA.warehouseId,
            lines: [{ variantId, quantity: '7.0', reason: 'CORRECTION' }],
          }),
        api()
          .post('/api/v1/inventory/adjustments')
          .set(auth(adminToken))
          .send({
            warehouseId: orgA.warehouseId,
            lines: [{ variantId, quantity: '7.0', reason: 'CORRECTION' }],
          }),
      ]);

      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await levelOf(variantId)).toBe(14);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Cost
  // ──────────────────────────────────────────────────────────────────────

  describe('moving average cost', () => {
    /**
     * Costed inbound movements are written through the same writer the API
     * uses. Sprint 4 has no endpoint that receives goods at a stated cost —
     * that is Sprint 7's purchase receiving — so the rule is exercised at the
     * level it is implemented, rather than left untested until then.
     */
    it('blends receipts at different costs — docs/ARCHITECTURE.md §8.6', async () => {
      const { variantId } = await makeVariant();

      const receive = (quantity: number, unitCost: bigint) =>
        writeStockMovement(db, {
          organizationId: orgA.organizationId,
          warehouseId: orgA.warehouseId,
          productVariantId: variantId,
          type: 'INITIAL',
          delta: quantity.toFixed(3),
          unitCost,
          sourceType: 'onboarding',
          sourceId: null,
          reason: null,
          note: null,
          createdBy: null,
        });

      await receive(10, 1_000n);
      const first = await db.inventoryLevel.findFirstOrThrow({
        where: { warehouseId: orgA.warehouseId, productVariantId: variantId },
        select: { avgCost: true },
      });
      // Nothing to average against yet, so the incoming cost is taken whole.
      expect(first.avgCost).toBe(1_000n);

      await receive(10, 2_000n);
      const blended = await db.inventoryLevel.findFirstOrThrow({
        where: { warehouseId: orgA.warehouseId, productVariantId: variantId },
        select: { avgCost: true, quantity: true },
      });
      expect(blended.avgCost).toBe(1_500n);
      expect(Number(blended.quantity.toString())).toBe(20);
    });

    it('rounds the average once, half up', async () => {
      const { variantId } = await makeVariant();

      const receive = (quantity: number, unitCost: bigint) =>
        writeStockMovement(db, {
          organizationId: orgA.organizationId,
          warehouseId: orgA.warehouseId,
          productVariantId: variantId,
          type: 'INITIAL',
          delta: quantity.toFixed(3),
          unitCost,
          sourceType: 'onboarding',
          sourceId: null,
          reason: null,
          note: null,
          createdBy: null,
        });

      // (1 x 1000 + 2 x 1001) / 3 = 1000.666… → 1001.
      await receive(1, 1_000n);
      await receive(2, 1_001n);

      const level = await db.inventoryLevel.findFirstOrThrow({
        where: { warehouseId: orgA.warehouseId, productVariantId: variantId },
        select: { avgCost: true },
      });
      expect(level.avgCost).toBe(1_001n);
    });

    it('a sale does not disturb the average', async () => {
      const { variantId } = await makeVariant();
      await writeStockMovement(db, {
        organizationId: orgA.organizationId,
        warehouseId: orgA.warehouseId,
        productVariantId: variantId,
        type: 'INITIAL',
        delta: '10.000',
        unitCost: 4_000n,
        sourceType: 'onboarding',
        sourceId: null,
        reason: null,
        note: null,
        createdBy: null,
      });

      await stock(variantId, -3);

      const level = await db.inventoryLevel.findFirstOrThrow({
        where: { warehouseId: orgA.warehouseId, productVariantId: variantId },
        select: { avgCost: true, quantity: true },
      });
      expect(level.avgCost).toBe(4_000n);
      expect(Number(level.quantity.toString())).toBe(7);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Low stock
  // ──────────────────────────────────────────────────────────────────────

  describe('low stock', () => {
    it('reports LOW_STOCK at or below the minimum, OUT_OF_STOCK at zero', async () => {
      const { variantId } = await makeVariant({ minStock: '5' });
      await stock(variantId, 3);

      const low = await api().get(`/api/v1/inventory/${variantId}`).set(auth(adminToken));
      expect(low.body.status).toBe('LOW_STOCK');
      expect(low.body.minStock).toBe('5.000');

      await stock(variantId, -3);
      const out = await api().get(`/api/v1/inventory/${variantId}`).set(auth(adminToken));
      expect(out.body.status).toBe('OUT_OF_STOCK');
    });

    it('never reports LOW_STOCK when no minimum is set', async () => {
      const { variantId } = await makeVariant({ minStock: '0' });
      await stock(variantId, 1);

      const res = await api().get(`/api/v1/inventory/${variantId}`).set(auth(adminToken));
      expect(res.body.status).toBe('IN_STOCK');
    });

    it('filters the list to what needs ordering, in the database', async () => {
      const lowOne = await makeVariant({ minStock: '10' });
      const healthy = await makeVariant({ minStock: '1' });
      await stock(lowOne.variantId, 2);
      await stock(healthy.variantId, 50);

      const res = await api()
        .get('/api/v1/inventory')
        .query({ lowStock: 'true', warehouseId: orgA.warehouseId, limit: 100 })
        .set(auth(adminToken));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((r: { variantId: string }) => r.variantId);
      expect(ids).toContain(lowOne.variantId);
      expect(ids).not.toContain(healthy.variantId);
      expect(res.body.data.every((r: { status: string }) => r.status !== 'IN_STOCK')).toBe(true);
    });

    it('status=LOW_STOCK excludes the ones already at zero', async () => {
      const zero = await makeVariant({ minStock: '4' });
      const low = await makeVariant({ minStock: '4' });
      await stock(low.variantId, 2);

      const res = await api()
        .get('/api/v1/inventory')
        .query({ status: 'LOW_STOCK', warehouseId: orgA.warehouseId, limit: 100 })
        .set(auth(adminToken));

      const ids = res.body.data.map((r: { variantId: string }) => r.variantId);
      expect(ids).toContain(low.variantId);
      expect(ids).not.toContain(zero.variantId);
    });

    it('lists variants that have never been stocked as out of stock', async () => {
      const { variantId, sku } = await makeVariant();

      const res = await api()
        .get('/api/v1/inventory')
        .query({ status: 'OUT_OF_STOCK', warehouseId: orgA.warehouseId, q: sku, limit: 100 })
        .set(auth(adminToken));

      // A report driven from levels would omit exactly the rows most in need
      // of ordering.
      const ids = res.body.data.map((r: { variantId: string }) => r.variantId);
      expect(ids).toContain(variantId);
    });

    it('summarises the header counts', async () => {
      const res = await api()
        .get('/api/v1/inventory')
        .query({ warehouseId: orgA.warehouseId, limit: 1 })
        .set(auth(adminToken));

      expect(res.body.summary).toMatchObject({
        tracked: expect.any(Number),
        outOfStock: expect.any(Number),
        lowStock: expect.any(Number),
      });
      expect(res.body.summary.tracked).toBeGreaterThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Movements
  // ──────────────────────────────────────────────────────────────────────

  describe('movement history', () => {
    it('returns the stock card newest first', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);
      await stock(variantId, -4);

      const res = await api()
        .get('/api/v1/inventory/movements')
        .query({ variantId })
        .set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].quantityDelta).toBe('-4.000');
      expect(res.body.data[0].quantityAfter).toBe('6.000');
      expect(res.body.data[1].quantityDelta).toBe('10.000');
    });

    it('filters by type and by warehouse, in the database', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);
      await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '-1.0', reason: 'DAMAGE' }],
        })
        .expect(201);

      const damage = await api()
        .get('/api/v1/inventory/movements')
        .query({ variantId, type: 'DAMAGE' })
        .set(auth(adminToken));
      expect(damage.body.data).toHaveLength(1);

      const elsewhere = await api()
        .get('/api/v1/inventory/movements')
        .query({ variantId, warehouseId: orgA.secondWarehouseId })
        .set(auth(adminToken));
      expect(elsewhere.body.data).toHaveLength(0);
    });

    it('the ledger is append-only — the database refuses an UPDATE', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 5);

      const movement = await db.inventoryMovement.findFirstOrThrow({
        where: { productVariantId: variantId },
        select: { id: true },
      });

      await expect(
        db.$executeRaw`UPDATE inventory_movement SET quantity_delta = 999 WHERE id = ${movement.id}::uuid`,
      ).rejects.toThrow(/append-only/i);

      await expect(
        db.$executeRaw`DELETE FROM inventory_movement WHERE id = ${movement.id}::uuid`,
      ).rejects.toThrow(/append-only/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Warehouses
  // ──────────────────────────────────────────────────────────────────────

  describe('warehouses', () => {
    it('creates, reads, updates and archives', async () => {
      const code = `WH-${Date.now().toString(36)}`;
      const created = await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code, name: 'Qoshimcha ombor', storeId: orgA.storeId });
      expect(created.status).toBe(201);
      expect(created.body.code).toBe(code.toUpperCase());

      const read = await api().get(`/api/v1/warehouses/${created.body.id}`).set(auth(adminToken));
      expect(read.status).toBe(200);
      expect(read.body.stock).toMatchObject({ trackedVariants: 0 });

      const updated = await api()
        .patch(`/api/v1/warehouses/${created.body.id}`)
        .set(auth(adminToken))
        .send({ name: 'Yangi nom' });
      expect(updated.body.name).toBe('Yangi nom');

      const archived = await api()
        .patch(`/api/v1/warehouses/${created.body.id}/archive`)
        .set(auth(adminToken));
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();

      const restored = await api()
        .patch(`/api/v1/warehouses/${created.body.id}/restore`)
        .set(auth(adminToken));
      expect(restored.body.archivedAt).toBeNull();
    });

    it('a central warehouse needs no store', async () => {
      const res = await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code: `CENTRAL-${Date.now().toString(36)}`, name: 'Markaziy ombor' });
      expect(res.status).toBe(201);
      expect(res.body.storeId).toBeNull();
    });

    it('refuses a duplicate code among live warehouses', async () => {
      const code = `DUP-${Date.now().toString(36)}`;
      await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code, name: 'Birinchi' })
        .expect(201);

      const res = await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code, name: 'Ikkinchi' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_RESOURCE');
    });

    it('moving the default flag leaves exactly one default per store', async () => {
      const res = await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({
          code: `DEF-${Date.now().toString(36)}`,
          name: 'Yangi standart',
          storeId: orgA.storeId,
          isDefault: true,
        });
      expect(res.status).toBe(201);

      const defaults = await db.warehouse.count({
        where: { storeId: orgA.storeId, isDefault: true, archivedAt: null },
      });
      expect(defaults).toBe(1);

      // Put the original back, so later tests still find their warehouse.
      await api()
        .patch(`/api/v1/warehouses/${orgA.warehouseId}`)
        .set(auth(adminToken))
        .send({ isDefault: true })
        .expect(200);
    });

    it('refuses to archive a warehouse that still holds stock', async () => {
      const created = await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code: `HOLD-${Date.now().toString(36)}`, name: 'Toʻla ombor' })
        .expect(201);

      const { variantId } = await makeVariant();
      await stock(variantId, 6, created.body.id);

      const res = await api()
        .patch(`/api/v1/warehouses/${created.body.id}/archive`)
        .set(auth(adminToken));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WAREHOUSE_HAS_STOCK');
    });

    it('refuses to adjust stock in an archived warehouse', async () => {
      const created = await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code: `ARCH-${Date.now().toString(36)}`, name: 'Yopilgan ombor' })
        .expect(201);
      await api()
        .patch(`/api/v1/warehouses/${created.body.id}/archive`)
        .set(auth(adminToken))
        .expect(200);

      const { variantId } = await makeVariant();
      const res = await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: created.body.id,
          lines: [{ variantId, quantity: '1.0', reason: 'CORRECTION' }],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('WAREHOUSE_ARCHIVED');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Inventory counts — docs/ARCHITECTURE.md §9.5
  // ──────────────────────────────────────────────────────────────────────

  describe('inventory counts', () => {
    /** A private warehouse per test, so one count never blocks another. */
    async function freshWarehouse(name = 'Sanoq ombori') {
      const res = await api()
        .post('/api/v1/warehouses')
        .set(auth(adminToken))
        .send({ code: `CNT-${Date.now().toString(36)}-${skuCounter++}`, name })
        .expect(201);
      return res.body.id as string;
    }

    it('walks the sprint example: 50 on the system, 47 counted, -3 applied', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant();
      await stock(variantId, 50, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId });
      expect(opened.status).toBe(201);
      expect(opened.body.status).toBe('COUNTING');
      expect(opened.body.countNumber).toMatch(/^INV-\d{6}$/);

      const line = opened.body.items.find((i: { variantId: string }) => i.variantId === variantId);
      expect(line.expectedQuantity).toBe('50.000');
      expect(line.countedQuantity).toBeNull();

      const submitted = await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '47.0' }] });
      expect(submitted.status).toBe(200);

      const counted = submitted.body.items.find(
        (i: { variantId: string }) => i.variantId === variantId,
      );
      expect(counted.countedQuantity).toBe('47.000');
      expect(counted.difference).toBe('-3.000');
      // Nothing has moved yet.
      expect(await levelOf(variantId, warehouseId)).toBe(50);

      const finalized = await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
        .set(auth(adminToken))
        .send({});
      expect(finalized.status).toBe(201);
      expect(finalized.body.status).toBe('FINALIZED');

      expect(await levelOf(variantId, warehouseId)).toBe(47);
      expect(await ledgerOf(variantId, warehouseId)).toBe(47);

      const correction = await db.inventoryMovement.findFirst({
        where: {
          productVariantId: variantId,
          warehouseId,
          type: 'COUNT_CORRECTION',
        },
        select: { quantityDelta: true, sourceType: true, sourceId: true },
      });
      expect(Number(correction!.quantityDelta.toString())).toBe(-3);
      expect(correction!.sourceType).toBe('inventory_count');
      expect(correction!.sourceId).toBe(opened.body.id);
    });

    it('reconciles against live stock, not the snapshot', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant();
      await stock(variantId, 50, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);

      await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '50.0' }] })
        .expect(200);

      // The shop keeps selling while the count is open.
      await stock(variantId, -4, warehouseId);
      expect(await levelOf(variantId, warehouseId)).toBe(46);

      await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      // Using the stale snapshot would have put it back to 50 and silently
      // reversed those four sales.
      expect(await levelOf(variantId, warehouseId)).toBe(50);
      const applied = await db.inventoryCountItem.findFirst({
        where: { inventoryCountId: opened.body.id, productVariantId: variantId },
        select: { appliedDelta: true, expectedQuantity: true, countedQuantity: true },
      });
      expect(Number(applied!.appliedDelta!.toString())).toBe(4);
      // Both the snapshot and what was counted survive for the report.
      expect(Number(applied!.expectedQuantity.toString())).toBe(50);
      expect(Number(applied!.countedQuantity!.toString())).toBe(50);
    });

    it('skips lines that were never counted instead of zeroing them', async () => {
      const warehouseId = await freshWarehouse();
      const counted = await makeVariant();
      const untouched = await makeVariant();
      await stock(counted.variantId, 10, warehouseId);
      await stock(untouched.variantId, 25, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);

      await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId: counted.variantId, countedQuantity: '8.0' }] })
        .expect(200);

      await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      expect(await levelOf(counted.variantId, warehouseId)).toBe(8);
      // Counting nothing is not the same as counting zero.
      expect(await levelOf(untouched.variantId, warehouseId)).toBe(25);
    });

    it('allows only one open count per warehouse', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant();
      await stock(variantId, 5, warehouseId);

      await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);

      const second = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('COUNT_ALREADY_OPEN');
    });

    it('refuses to modify or re-finalize a finalized count', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant();
      await stock(variantId, 5, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);
      await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '4.0' }] })
        .expect(200);
      await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      const again = await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
        .set(auth(adminToken))
        .send({});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('COUNT_NOT_OPEN');

      const edit = await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '99.0' }] });
      expect(edit.status).toBe(409);

      // The stock must not have moved a second time.
      expect(await levelOf(variantId, warehouseId)).toBe(4);
    });

    it('two simultaneous finalizations apply the correction once', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant();
      await stock(variantId, 20, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);
      await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '15.0' }] })
        .expect(200);

      const results = await Promise.all([
        api()
          .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
          .set(auth(adminToken))
          .send({}),
        api()
          .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
          .set(auth(adminToken))
          .send({}),
      ]);

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await levelOf(variantId, warehouseId)).toBe(15);
      expect(await ledgerOf(variantId, warehouseId)).toBe(15);
    });

    it('cancelling leaves stock untouched and frees the warehouse', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant();
      await stock(variantId, 12, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);
      await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '1.0' }] })
        .expect(200);

      const cancelled = await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/cancel`)
        .set(auth(adminToken));
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(await levelOf(variantId, warehouseId)).toBe(12);

      // A cancelled count no longer blocks the warehouse.
      await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);
    });

    it('a CATEGORY count covers only that category', async () => {
      const warehouseId = await freshWarehouse();
      const category = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: `Sanoq kategoriyasi ${skuCounter++}` })
        .expect(201);

      const inside = await makeVariant({ categoryId: category.body.id });
      const outside = await makeVariant();
      await stock(inside.variantId, 4, warehouseId);
      await stock(outside.variantId, 4, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId, scope: 'CATEGORY', categoryId: category.body.id })
        .expect(201);

      const ids = opened.body.items.map((i: { variantId: string }) => i.variantId);
      expect(ids).toContain(inside.variantId);
      expect(ids).not.toContain(outside.variantId);
    });

    it('a PARTIAL count can cover a variant with no stock at all', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant();

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId, scope: 'PARTIAL', variantIds: [variantId] })
        .expect(201);

      expect(opened.body.items).toHaveLength(1);
      expect(opened.body.items[0].expectedQuantity).toBe('0.000');

      // Finding four of something the system thinks it has none of is one of
      // the main things a stocktake is for.
      await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '4.0' }] })
        .expect(200);
      await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      expect(await levelOf(variantId, warehouseId)).toBe(4);
    });

    it('records the shrinkage value in the audit trail', async () => {
      const warehouseId = await freshWarehouse();
      const { variantId } = await makeVariant({ purchasePrice: 10_000 });
      await stock(variantId, 10, warehouseId);

      const opened = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId })
        .expect(201);
      await api()
        .patch(`/api/v1/inventory-counts/${opened.body.id}/items`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, countedQuantity: '8.0' }] })
        .expect(200);
      await api()
        .post(`/api/v1/inventory-counts/${opened.body.id}/finalize`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      const entry = await db.auditLog.findFirst({
        where: {
          organizationId: orgA.organizationId,
          action: 'inventory_count.finalized',
          entityId: opened.body.id,
        },
      });
      expect(entry).not.toBeNull();
      const metadata = entry!.metadata as { corrections: number; shrinkageValue: string };
      expect(metadata.corrections).toBe(1);
      expect(BigInt(metadata.shrinkageValue)).toBeLessThan(0n);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Transfers — docs/ARCHITECTURE.md §9.6
  // ──────────────────────────────────────────────────────────────────────

  describe('transfers', () => {
    it('moves stock out at send and in at receive', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 30);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '12.0' }],
        });
      expect(sent.status).toBe(201);
      expect(sent.body.status).toBe('SENT');
      expect(sent.body.transferNumber).toMatch(/^TRF-\d{6}$/);

      // Goods in transit belong to neither warehouse's sellable stock.
      expect(await levelOf(variantId, orgA.warehouseId)).toBe(18);
      expect(await levelOf(variantId, orgA.secondWarehouseId)).toBe(0);

      const received = await api()
        .post(`/api/v1/transfers/${sent.body.id}/receive`)
        .set(auth(adminToken))
        .send({});
      expect(received.status).toBe(201);
      expect(received.body.status).toBe('RECEIVED');

      expect(await levelOf(variantId, orgA.warehouseId)).toBe(18);
      expect(await levelOf(variantId, orgA.secondWarehouseId)).toBe(12);

      // Both legs carry the same source_id, so the pair is one query away.
      const legs = await db.inventoryMovement.findMany({
        where: { sourceType: 'stock_transfer', sourceId: sent.body.id },
        select: { type: true, quantityDelta: true, warehouseId: true },
      });
      expect(legs).toHaveLength(2);
      expect(legs.map((l) => l.type).sort()).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
    });

    it('refuses to send more than the source holds', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 3);

      const res = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '5.0' }],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      expect(await levelOf(variantId, orgA.warehouseId)).toBe(3);
      // The whole transfer rolled back — no orphan document.
      const transfers = await db.stockTransfer.count({
        where: {
          organizationId: orgA.organizationId,
          items: { some: { productVariantId: variantId } },
        },
      });
      expect(transfers).toBe(0);
    });

    it('refuses a transfer to the same warehouse', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 5);

      const res = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.warehouseId,
          items: [{ variantId, quantity: '1.0' }],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRANSFER_SAME_WAREHOUSE');
    });

    it('records a shortfall without deducting it twice', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 20);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '10.0' }],
        })
        .expect(201);

      const received = await api()
        .post(`/api/v1/transfers/${sent.body.id}/receive`)
        .set(auth(adminToken))
        .send({
          items: [{ variantId, receivedQuantity: '8.0' }],
          note: "Yo'lda 2 dona shikastlangan",
        });
      expect(received.status).toBe(201);

      expect(await levelOf(variantId, orgA.warehouseId)).toBe(10);
      expect(await levelOf(variantId, orgA.secondWarehouseId)).toBe(8);

      // The two missing units left the source exactly once, at send time.
      // A second WRITE_OFF at the source would take stock it no longer has.
      const sourceLedger = await ledgerOf(variantId, orgA.warehouseId);
      expect(sourceLedger).toBe(10);

      const line = received.body.items.find(
        (i: { variantId: string }) => i.variantId === variantId,
      );
      expect(line.quantity).toBe('10.000');
      expect(line.receivedQuantity).toBe('8.000');
      expect(line.shortfall).toBe('2.000');
    });

    it('requires a note when less arrived than was sent', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '6.0' }],
        })
        .expect(201);

      const res = await api()
        .post(`/api/v1/transfers/${sent.body.id}/receive`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, receivedQuantity: '4.0' }] });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('refuses to receive more than was sent', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '5.0' }],
        })
        .expect(201);

      const res = await api()
        .post(`/api/v1/transfers/${sent.body.id}/receive`)
        .set(auth(adminToken))
        .send({ items: [{ variantId, receivedQuantity: '6.0' }] });

      expect(res.status).toBe(409);
    });

    it('cannot be received twice, even in parallel', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 20);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '6.0' }],
        })
        .expect(201);

      const results = await Promise.all([
        api().post(`/api/v1/transfers/${sent.body.id}/receive`).set(auth(adminToken)).send({}),
        api().post(`/api/v1/transfers/${sent.body.id}/receive`).set(auth(adminToken)).send({}),
      ]);

      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await levelOf(variantId, orgA.secondWarehouseId)).toBe(6);
    });

    it('cancelling in transit returns the goods to the source', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 15);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '9.0' }],
        })
        .expect(201);
      expect(await levelOf(variantId, orgA.warehouseId)).toBe(6);

      const cancelled = await api()
        .post(`/api/v1/transfers/${sent.body.id}/cancel`)
        .set(auth(adminToken));
      expect(cancelled.status).toBe(201);
      expect(cancelled.body.status).toBe('CANCELLED');

      expect(await levelOf(variantId, orgA.warehouseId)).toBe(15);
      // The ledger records that it went out and came back, rather than
      // pretending it never left.
      const movements = await db.inventoryMovement.count({
        where: { sourceType: 'stock_transfer', sourceId: sent.body.id },
      });
      expect(movements).toBe(2);
    });

    it('a received transfer cannot be cancelled', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '4.0' }],
        })
        .expect(201);
      await api()
        .post(`/api/v1/transfers/${sent.body.id}/receive`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      const res = await api()
        .post(`/api/v1/transfers/${sent.body.id}/cancel`)
        .set(auth(adminToken));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TRANSFER_NOT_SENT');
    });

    it('carries cost with the goods', async () => {
      const { variantId } = await makeVariant({ purchasePrice: 7_000 });
      await stock(variantId, 10);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '5.0' }],
        })
        .expect(201);
      await api()
        .post(`/api/v1/transfers/${sent.body.id}/receive`)
        .set(auth(adminToken))
        .send({})
        .expect(201);

      const destination = await db.inventoryLevel.findFirst({
        where: { warehouseId: orgA.secondWarehouseId, productVariantId: variantId },
        select: { avgCost: true },
      });
      // Not zero: an arrival with no cost would quietly destroy every margin
      // report at the destination.
      expect(destination!.avgCost).toBeGreaterThan(0n);
    });

    it('rejects a duplicate variant line', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);

      const res = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [
            { variantId, quantity: '1.0' },
            { variantId, quantity: '2.0' },
          ],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_RESOURCE');
    });

    it('filters by direction', async () => {
      const outbound = await api()
        .get('/api/v1/transfers')
        .query({ warehouseId: orgA.warehouseId, direction: 'OUT', limit: 100 })
        .set(auth(adminToken));
      expect(outbound.status).toBe(200);
      expect(
        outbound.body.data.every(
          (t: { fromWarehouse: { id: string } }) => t.fromWarehouse.id === orgA.warehouseId,
        ),
      ).toBe(true);

      const inbound = await api()
        .get('/api/v1/transfers')
        .query({ warehouseId: orgA.secondWarehouseId, direction: 'IN', limit: 100 })
        .set(auth(adminToken));
      expect(
        inbound.body.data.every(
          (t: { toWarehouse: { id: string } }) => t.toWarehouse.id === orgA.secondWarehouseId,
        ),
      ).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Authorization
  // ──────────────────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('a cashier may read stock but not adjust it', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 5);

      await api().get('/api/v1/inventory').set(auth(cashierToken)).expect(200);
      await api().get(`/api/v1/inventory/${variantId}`).set(auth(cashierToken)).expect(200);
      await api().get('/api/v1/inventory/movements').set(auth(cashierToken)).expect(200);

      const res = await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(cashierToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '-1.0', reason: 'CORRECTION' }],
        });
      expect(res.status).toBe(403);
      expect(await levelOf(variantId)).toBe(5);
    });

    it('a cashier may not open a count or send a transfer', async () => {
      await api()
        .post('/api/v1/inventory-counts')
        .set(auth(cashierToken))
        .send({ warehouseId: orgA.warehouseId })
        .expect(403);

      await api()
        .post('/api/v1/transfers')
        .set(auth(cashierToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [],
        })
        .expect(403);
    });

    it('a warehouse keeper may adjust, count and transfer', async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 10);

      await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(warehouseToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '-1.0', reason: 'DAMAGE' }],
        })
        .expect(201);

      const sent = await api()
        .post('/api/v1/transfers')
        .set(auth(warehouseToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          items: [{ variantId, quantity: '2.0' }],
        });
      expect(sent.status).toBe(201);
    });

    it('a warehouse keeper may not create a warehouse — that is store structure', async () => {
      const res = await api()
        .post('/api/v1/warehouses')
        .set(auth(warehouseToken))
        .send({ code: `NOPE-${Date.now().toString(36)}`, name: 'Ruxsatsiz' });
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request', async () => {
      await api().get('/api/v1/inventory').expect(401);
      await api().get('/api/v1/warehouses').expect(401);
      await api().post('/api/v1/inventory/adjustments').send({}).expect(401);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Cross-tenant isolation
  // ──────────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it("never returns another organization's stock in a list", async () => {
      const res = await api()
        .get('/api/v1/inventory')
        .query({ limit: 100 })
        .set(auth(adminToken))
        .expect(200);

      const ids = res.body.data.map((r: { variantId: string }) => r.variantId);
      expect(ids).not.toContain(foreign.variantId);
    });

    it("cannot read another organization's variant stock", async () => {
      const res = await api().get(`/api/v1/inventory/${foreign.variantId}`).set(auth(adminToken));
      expect(res.status).toBe(404);
    });

    it("cannot read another organization's warehouse", async () => {
      const res = await api()
        .get(`/api/v1/warehouses/${foreign.warehouseId}`)
        .set(auth(adminToken));
      expect(res.status).toBe(404);
    });

    it("cannot adjust stock in another organization's warehouse", async () => {
      const { variantId } = await makeVariant();
      const res = await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: foreign.warehouseId,
          lines: [{ variantId, quantity: '1.0', reason: 'CORRECTION' }],
        });
      expect(res.status).toBe(404);
    });

    it("cannot adjust another organization's variant", async () => {
      const res = await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId: foreign.variantId, quantity: '1.0', reason: 'CORRECTION' }],
        });
      expect(res.status).toBe(404);
      // And the foreign stock is untouched.
      const level = await db.inventoryLevel.findUniqueOrThrow({
        where: { id: foreign.levelId },
        select: { quantity: true },
      });
      expect(Number(level.quantity.toString())).toBe(99);
    });

    it("cannot transfer into another organization's warehouse", async () => {
      const { variantId } = await makeVariant();
      await stock(variantId, 5);

      const res = await api()
        .post('/api/v1/transfers')
        .set(auth(adminToken))
        .send({
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: foreign.warehouseId,
          items: [{ variantId, quantity: '1.0' }],
        });
      expect(res.status).toBe(404);
      expect(await levelOf(variantId)).toBe(5);
    });

    it("cannot open a count in another organization's warehouse", async () => {
      const res = await api()
        .post('/api/v1/inventory-counts')
        .set(auth(adminToken))
        .send({ warehouseId: foreign.warehouseId });
      expect(res.status).toBe(404);
    });

    it("cannot see another organization's movements", async () => {
      await db.$executeRaw`
        INSERT INTO inventory_movement
          (id, organization_id, warehouse_id, product_variant_id, type, quantity_delta,
           quantity_after, source_type, created_at)
        VALUES
          (gen_random_uuid(), ${orgB.organizationId}::uuid, ${foreign.warehouseId}::uuid,
           ${foreign.variantId}::uuid, 'INITIAL', 99, 99, 'onboarding', now())
      `;

      const res = await api()
        .get('/api/v1/inventory/movements')
        .query({ limit: 100 })
        .set(auth(adminToken))
        .expect(200);

      const variantIds = res.body.data.map((m: { variant: { id: string } }) => m.variant.id);
      expect(variantIds).not.toContain(foreign.variantId);
    });

    it("cannot list another organization's warehouses", async () => {
      const res = await api()
        .get('/api/v1/warehouses')
        .query({ limit: 100 })
        .set(auth(adminToken))
        .expect(200);

      const ids = res.body.data.map((w: { id: string }) => w.id);
      expect(ids).not.toContain(foreign.warehouseId);
      expect(ids).toContain(orgA.warehouseId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Database-level guarantees, bypassing the API entirely
  // ──────────────────────────────────────────────────────────────────────

  describe('database constraints', () => {
    it('refuses a movement whose sign contradicts its type', async () => {
      const { variantId } = await makeVariant();

      await expect(
        db.$executeRaw`
          INSERT INTO inventory_movement
            (id, organization_id, warehouse_id, product_variant_id, type, quantity_delta,
             quantity_after, source_type, created_at)
          VALUES
            (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.warehouseId}::uuid,
             ${variantId}::uuid, 'PURCHASE', -5, 0, 'purchase', now())
        `,
      ).rejects.toThrow(/ck_movement_sign/);
    });

    it('refuses a reducing movement with no reason', async () => {
      const { variantId } = await makeVariant();

      await expect(
        db.$executeRaw`
          INSERT INTO inventory_movement
            (id, organization_id, warehouse_id, product_variant_id, type, quantity_delta,
             quantity_after, source_type, created_at)
          VALUES
            (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.warehouseId}::uuid,
             ${variantId}::uuid, 'DAMAGE', -1, 0, 'adjustment', now())
        `,
      ).rejects.toThrow(/ck_movement_reason_required/);
    });

    it('refuses a movement that moves nothing', async () => {
      const { variantId } = await makeVariant();

      await expect(
        db.$executeRaw`
          INSERT INTO inventory_movement
            (id, organization_id, warehouse_id, product_variant_id, type, quantity_delta,
             quantity_after, source_type, created_at)
          VALUES
            (gen_random_uuid(), ${orgA.organizationId}::uuid, ${orgA.warehouseId}::uuid,
             ${variantId}::uuid, 'ADJUSTMENT', 0, 0, 'adjustment', now())
        `,
      ).rejects.toThrow(/ck_movement_delta_nonzero/);
    });

    it("refuses a level pointing at another organization's warehouse", async () => {
      const { variantId } = await makeVariant();

      await expect(
        db.$executeRaw`
          INSERT INTO inventory_level
            (id, organization_id, warehouse_id, product_variant_id, quantity, avg_cost, updated_at)
          VALUES
            (gen_random_uuid(), ${orgA.organizationId}::uuid, ${foreign.warehouseId}::uuid,
             ${variantId}::uuid, 1, 0, now())
        `,
      ).rejects.toThrow(/fk_level_warehouse_same_org/);
    });

    it('refuses a transfer between a warehouse and itself', async () => {
      await expect(
        db.$executeRaw`
          INSERT INTO stock_transfer
            (id, organization_id, transfer_number, from_warehouse_id, to_warehouse_id,
             status, created_by, created_at, updated_at)
          VALUES
            (gen_random_uuid(), ${orgA.organizationId}::uuid, 'TRF-BAD-1',
             ${orgA.warehouseId}::uuid, ${orgA.warehouseId}::uuid, 'DRAFT',
             ${orgA.users.get('ADMIN')!.id}::uuid, now(), now())
        `,
      ).rejects.toThrow(/ck_transfer_distinct_warehouses/);
    });

    it('refuses a transfer line receiving more than was sent', async () => {
      const { variantId } = await makeVariant();

      const transfer = await db.stockTransfer.create({
        data: {
          organizationId: orgA.organizationId,
          transferNumber: `TRF-CK-${Date.now().toString(36)}`,
          fromWarehouseId: orgA.warehouseId,
          toWarehouseId: orgA.secondWarehouseId,
          status: 'DRAFT',
          createdBy: orgA.users.get('ADMIN')!.id,
        },
        select: { id: true },
      });

      await expect(
        db.$executeRaw`
          INSERT INTO stock_transfer_item
            (id, organization_id, stock_transfer_id, product_variant_id,
             quantity, received_quantity, unit_cost)
          VALUES
            (gen_random_uuid(), ${orgA.organizationId}::uuid, ${transfer.id}::uuid,
             ${variantId}::uuid, 5, 9, 0)
        `,
      ).rejects.toThrow(/ck_transfer_item_received_within_sent/);
    });

    it('the projection always equals the ledger — docs/ARCHITECTURE.md §9.7', async () => {
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

      // Any row here means some code path moved a level outside apply().
      expect(drifted).toEqual([]);
    });
  });
});
