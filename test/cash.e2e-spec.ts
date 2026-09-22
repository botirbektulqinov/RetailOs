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
 * Cash register, shifts and employee administration — §19 and §20.
 *
 * The drawer arithmetic is asserted against real sales, refunds, debt
 * collections and supplier payments rather than against fixtures, because the
 * whole point of not storing a running balance is that every one of those
 * paths has to reach the same number.
 */
describe('Cash register and employees (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let managerToken: string;
  let cashierToken: string;
  let warehouseToken: string;

  let registerId: string;
  let foreign: { registerId: string; shiftId: string; userId: string };

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
  const nextCode = () => `K-${Date.now().toString(36)}-${counter++}`.toUpperCase();
  const nextPhone = () =>
    `+9989${String(40 + (counter % 30))}${String(3_000_000 + counter++).slice(-6)}`;

  async function makeRegister(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api()
      .post('/api/v1/cash-registers')
      .set(auth(adminToken))
      .send({ code: nextCode(), name: `Kassa ${counter}`, ...over });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function openShift(register: string, openingAmount = 200_000, token = cashierToken) {
    const res = await api()
      .post('/api/v1/shifts')
      .set(auth(token))
      .send({ registerId: register, openingAmount });
    expect(res.status).toBe(201);
    return res.body as { id: string; shiftNumber: string; drawer: Record<string, string> };
  }

  async function closeShift(shiftId: string, counted: number, token = cashierToken) {
    return api()
      .post(`/api/v1/shifts/${shiftId}/close`)
      .set(auth(token))
      .send({ countedCashAmount: counted });
  }

  async function sellable(price: number, quantity = 100): Promise<string> {
    const created = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({
        name: `Kassa mahsuloti ${counter}`,
        sku: `CS-${Date.now().toString(36)}-${counter++}`.toUpperCase(),
        sellingPrice: price,
      });
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

    return variantId;
  }

  interface SoldSale {
    id: string;
    cashRegisterShiftId: string | null;
    items: Array<{ id: string }>;
  }

  async function sell(body: Record<string, unknown>, token = cashierToken): Promise<SoldSale> {
    const res = await api().post('/api/v1/sales/checkout').set(auth(token)).set(idem()).send(body);
    expect(res.status).toBe(201);
    return res.body as SoldSale;
  }

  const drawerOf = async (shiftId: string, token = cashierToken) => {
    const res = await api().get(`/api/v1/shifts/${shiftId}/report`).set(auth(token));
    expect(res.status).toBe(200);
    return res.body as { drawer: Record<string, string | null>; tenders: unknown[] };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'cashA');
    orgB = await seedTestOrg(db, 'cashB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    managerToken = await tokenFor(orgA, 'MANAGER');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    // The seat limit is a real product rule (the employees screen renders
    // "8 / 10 band"), and this suite creates far more than ten. Raised for the
    // fixture rather than worked around in the service.
    await db.organization.update({
      where: { id: orgA.organizationId },
      data: { maxUsers: 500 },
    });

    registerId = await makeRegister();

    const foreignRegister = await db.cashRegister.create({
      data: {
        organizationId: orgB.organizationId,
        storeId: orgB.storeId,
        code: 'FOREIGN-K1',
        name: 'Begona kassa',
      },
      select: { id: true },
    });
    const foreignShift = await db.cashRegisterShift.create({
      data: {
        organizationId: orgB.organizationId,
        storeId: orgB.storeId,
        cashRegisterId: foreignRegister.id,
        shiftNumber: 'SH-999999',
        status: 'OPEN',
        openingAmount: 100_000n,
        openedBy: orgB.users.get('ADMIN')!.id,
      },
      select: { id: true },
    });

    foreign = {
      registerId: foreignRegister.id,
      shiftId: foreignShift.id,
      userId: orgB.users.get('CASHIER')!.id,
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

  /** Every test starts with no shift open on the shared store. */
  beforeEach(async () => {
    if (orgA) {
      await db.cashRegisterShift.updateMany({
        where: { organizationId: orgA.organizationId, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          expectedCashAmount: 0n,
          countedCashAmount: 0n,
          differenceAmount: 0n,
          closedBy: orgA.users.get('ADMIN')!.id,
          closedAt: new Date(),
        },
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Registers and shifts
  // ──────────────────────────────────────────────────────────────────────

  describe('registers', () => {
    it('creates one and reports no open shift', async () => {
      const code = nextCode();
      const created = await api()
        .post('/api/v1/cash-registers')
        .set(auth(adminToken))
        .send({ code, name: 'Ikkinchi kassa' });

      expect(created.status).toBe(201);
      expect(created.body.code).toBe(code.toUpperCase());

      const list = await api().get('/api/v1/cash-registers').set(auth(cashierToken)).expect(200);
      const row = list.body.data.find((r: { id: string }) => r.id === created.body.id);
      expect(row.openShift).toBeNull();
    });

    it('refuses a duplicate code in the same store', async () => {
      const code = nextCode();
      await api()
        .post('/api/v1/cash-registers')
        .set(auth(adminToken))
        .send({ code, name: 'Birinchi' })
        .expect(201);

      const res = await api()
        .post('/api/v1/cash-registers')
        .set(auth(adminToken))
        .send({ code, name: 'Ikkinchi' });
      expect(res.status).toBe(409);
    });

    it('refuses to archive a register with an open shift', async () => {
      const register = await makeRegister();
      await openShift(register);

      const res = await api()
        .patch(`/api/v1/cash-registers/${register}/archive`)
        .set(auth(adminToken));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SHIFT_STILL_OPEN');
    });
  });

  describe('opening a shift', () => {
    it('opens with a float and starts the drawer there', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 200_000);

      expect(shift.shiftNumber).toMatch(/^SH-\d{6}$/);
      expect(shift.drawer['opening']).toBe('200000');
      expect(shift.drawer['expected']).toBe('200000');
      expect(shift.drawer['counted']).toBeNull();
    });

    it('allows only one open shift per register', async () => {
      const register = await makeRegister();
      await openShift(register);

      const second = await api()
        .post('/api/v1/shifts')
        .set(auth(cashierToken))
        .send({ registerId: register, openingAmount: 100_000 });

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('SHIFT_ALREADY_OPEN');
    });

    it('two cashiers opening the same till in parallel: exactly one wins', async () => {
      const register = await makeRegister();

      const attempt = () =>
        api()
          .post('/api/v1/shifts')
          .set(auth(cashierToken))
          .send({ registerId: register, openingAmount: 50_000 });

      const [first, second] = await Promise.all([attempt(), attempt()]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);

      const open = await db.cashRegisterShift.count({
        where: { cashRegisterId: register, status: 'OPEN' },
      });
      expect(open).toBe(1);
    });

    it('surfaces the open shift on the register list and on /shifts/current', async () => {
      const register = await makeRegister();
      const shift = await openShift(register);

      const list = await api().get('/api/v1/cash-registers').set(auth(cashierToken));
      const row = list.body.data.find((r: { id: string }) => r.id === register);
      expect(row.openShift.id).toBe(shift.id);

      const current = await api().get('/api/v1/shifts/current').set(auth(cashierToken));
      expect(current.status).toBe(200);
      expect(current.body.id).toBe(shift.id);
    });

    it('/shifts/current is null, not an error, when nothing is open', async () => {
      const res = await api().get('/api/v1/shifts/current').set(auth(cashierToken));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // What moves the drawer
  // ──────────────────────────────────────────────────────────────────────

  describe('the drawer', () => {
    it('a cash sale raises it; a card sale does not', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);
      const variantId = await sellable(20_000);

      await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 40_000 }],
      });
      let drawer = (await drawerOf(shift.id)).drawer;
      expect(drawer['cashSales']).toBe('40000');
      expect(drawer['expected']).toBe('140000');

      await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CARD', amount: 20_000 }],
      });
      drawer = (await drawerOf(shift.id)).drawer;
      // The card is on the Z-report but not in the drawer.
      expect(drawer['cashSales']).toBe('40000');
      expect(drawer['expected']).toBe('140000');

      const report = await drawerOf(shift.id);
      const methods = (report.tenders as Array<{ method: string }>).map((t) => t.method).sort();
      expect(methods).toEqual(['CARD', 'CASH']);
    });

    it('attaches the sale to the shift it was rung on', async () => {
      const register = await makeRegister();
      const shift = await openShift(register);
      const variantId = await sellable(10_000);

      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });
      expect(sale.cashRegisterShiftId).toBe(shift.id);
    });

    it('sells fine with no shift open — the Z-report is simply about the shifts that happened', async () => {
      const variantId = await sellable(10_000);
      const sale = await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });
      expect(sale.cashRegisterShiftId).toBeNull();
    });

    it('a cash refund lowers it', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);
      const variantId = await sellable(50_000);

      const sale = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 100_000 }],
      });

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

      const drawer = (await drawerOf(shift.id)).drawer;
      expect(drawer['cashSales']).toBe('100000');
      expect(drawer['cashRefunds']).toBe('50000');
      expect(drawer['expected']).toBe('150000');
    });

    it('a cash in and a cash out move it by exactly those amounts', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 500_000);

      await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'IN', type: 'CORRECTION', amount: 50_000, reason: 'Maydalik qo‘shildi' })
        .expect(201);

      await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'OUT', type: 'DROP', amount: 200_000, reason: 'Seyfga topshirildi' })
        .expect(201);

      const drawer = (await drawerOf(shift.id)).drawer;
      expect(drawer['cashIn']).toBe('50000');
      expect(drawer['cashOut']).toBe('200000');
      expect(drawer['expected']).toBe('350000');
    });

    it('a cash debt collection raises it, with no debt-specific drawer logic', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 0);

      const customer = await db.customer.create({
        data: { organizationId: orgA.organizationId, fullName: `Qarzdor ${counter++}` },
        select: { id: true },
      });
      const debt = await api()
        .post('/api/v1/debts')
        .set(auth(managerToken))
        .send({ customerId: customer.id, amount: 300_000 })
        .expect(201);

      await api()
        .post('/api/v1/debts/payments')
        .set(auth(cashierToken))
        .set(idem())
        .send({ customerId: customer.id, amount: 120_000, method: 'CASH' })
        .expect(201);

      const drawer = (await drawerOf(shift.id)).drawer;
      expect(drawer['cashSales']).toBe('120000');
      expect(drawer['expected']).toBe('120000');
      void debt;
    });

    it('a cash supplier payment lowers it; a transfer does not', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 1_000_000);

      const supplier = await api()
        .post('/api/v1/suppliers')
        .set(auth(adminToken))
        .send({ name: `Kassa taminotchi ${counter++}` })
        .expect(201);

      await api()
        .post('/api/v1/suppliers/payments')
        .set(auth(managerToken))
        .set(idem())
        .send({ supplierId: supplier.body.id, amount: 300_000, method: 'CASH' })
        .expect(201);

      await api()
        .post('/api/v1/suppliers/payments')
        .set(auth(managerToken))
        .set(idem())
        .send({ supplierId: supplier.body.id, amount: 500_000, method: 'TRANSFER' })
        .expect(201);

      const drawer = (await drawerOf(shift.id)).drawer;
      expect(drawer['supplierPaid']).toBe('300000');
      expect(drawer['expected']).toBe('700000');
    });

    it('a credit sale does not move it at all', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);
      const variantId = await sellable(50_000);
      const customer = await db.customer.create({
        data: {
          organizationId: orgA.organizationId,
          fullName: `Kredit ${counter++}`,
          creditLimit: 10_000_000n,
        },
        select: { id: true },
      });

      await sell(
        {
          items: [{ variantId, quantity: '2.000' }],
          payments: [],
          creditAmount: 100_000,
          customerId: customer.id,
        },
        managerToken,
      );

      const drawer = (await drawerOf(shift.id)).drawer;
      expect(drawer['expected']).toBe('100000');
    });

    it('refuses a payout larger than the drawer holds', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 50_000);

      const res = await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'OUT', type: 'EXPENSE', amount: 500_000, reason: 'Juda ko‘p' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_CASH_IN_DRAWER');
      expect(res.body.errors[0].meta.available).toBe('50000');
    });

    it('requires a reason, and the movement cannot be edited afterwards', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);

      await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'OUT', type: 'EXPENSE', amount: 1_000 })
        .expect(400);

      const created = await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'OUT', type: 'EXPENSE', amount: 1_000, reason: 'Choy' })
        .expect(201);

      await expect(
        db.$executeRaw`UPDATE cash_movement SET amount = 999999 WHERE id = ${created.body.id}::uuid`,
      ).rejects.toThrow(/append-only/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Closing
  // ──────────────────────────────────────────────────────────────────────

  describe('closing a shift', () => {
    it('reconciles the whole drawer and stores the difference', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 200_000);
      const variantId = await sellable(50_000);

      // 200,000 float + 150,000 cash sales + 20,000 in − 100,000 out = 270,000
      await sell({
        items: [{ variantId, quantity: '3.000' }],
        payments: [{ method: 'CASH', amount: 150_000 }],
      });
      await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'IN', type: 'CORRECTION', amount: 20_000, reason: 'Maydalik' })
        .expect(201);
      await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'OUT', type: 'DROP', amount: 100_000, reason: 'Seyf' })
        .expect(201);

      const res = await closeShift(shift.id, 265_000);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('CLOSED');
      expect(res.body.drawer.expected).toBe('270000');
      expect(res.body.drawer.counted).toBe('265000');
      // Short by 5,000. Negative is short, positive is over; neither is
      // silently corrected.
      expect(res.body.drawer.difference).toBe('-5000');
    });

    it('records an overage as positive', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);

      const res = await closeShift(shift.id, 103_000);
      expect(res.body.drawer.difference).toBe('3000');
    });

    it('the stored expected figure does not move afterwards', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);
      const variantId = await sellable(10_000);

      await sell({
        items: [{ variantId, quantity: '1.000' }],
        payments: [{ method: 'CASH', amount: 10_000 }],
      });
      const closed = await closeShift(shift.id, 110_000);
      expect(closed.body.drawer.expected).toBe('110000');

      // A movement written against the closed shift directly cannot change
      // what the cashier signed for.
      await db.cashMovement.create({
        data: {
          organizationId: orgA.organizationId,
          storeId: orgA.storeId,
          cashRegisterShiftId: shift.id,
          direction: 'IN',
          type: 'CORRECTION',
          amount: 999_000n,
          reason: 'Keyin yozilgan',
          createdBy: orgA.users.get('ADMIN')!.id,
        },
      });

      const reread = await drawerOf(shift.id);
      expect(reread.drawer['expected']).toBe('110000');
      expect(reread.drawer['difference']).toBe('0');
    });

    it('cannot be closed twice, even in parallel', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);

      const [first, second] = await Promise.all([
        closeShift(shift.id, 100_000),
        closeShift(shift.id, 100_000),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);

      const stored = await db.cashRegisterShift.findUniqueOrThrow({
        where: { id: shift.id },
        select: { status: true, differenceAmount: true },
      });
      expect(stored.status).toBe('CLOSED');
      expect(stored.differenceAmount).toBe(0n);
    });

    it('refuses to close with an unfinished sale on the shift', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);

      await db.sale.create({
        data: {
          organizationId: orgA.organizationId,
          storeId: orgA.storeId,
          warehouseId: orgA.warehouseId,
          cashRegisterShiftId: shift.id,
          saleNumber: `S-DRAFT-${counter++}`,
          status: 'DRAFT',
          createdBy: orgA.users.get('ADMIN')!.id,
        },
      });

      const res = await closeShift(shift.id, 100_000);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('OPEN_DRAFTS_EXIST');
    });

    it('no movement is accepted on a closed shift', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);
      expect((await closeShift(shift.id, 100_000)).status).toBe(201);

      const res = await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'IN', type: 'CORRECTION', amount: 1_000, reason: 'Kech' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SHIFT_ALREADY_CLOSED');
    });

    it('writes the whole breakdown to the audit trail', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 300_000);
      expect((await closeShift(shift.id, 295_000)).status).toBe(201);

      const entry = await db.auditLog.findFirst({
        where: { action: 'shift.closed', entityId: shift.id },
      });
      expect(entry).not.toBeNull();
      const metadata = entry!.metadata as Record<string, string>;
      // The close is reproducible from the audit entry alone.
      expect(metadata['opening']).toBe('300000');
      expect(metadata['expected']).toBe('300000');
      expect(metadata['counted']).toBe('295000');
      expect(metadata['difference']).toBe('-5000');
    });

    it('the database refuses a difference that contradicts its inputs', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);
      expect((await closeShift(shift.id, 100_000)).status).toBe(201);

      await expect(
        db.$executeRaw`
          UPDATE cash_register_shift SET difference_amount = 50000 WHERE id = ${shift.id}::uuid
        `,
      ).rejects.toThrow(/ck_shift_difference_adds_up/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Authorization
  // ──────────────────────────────────────────────────────────────────────

  describe('cash authorization', () => {
    it('a warehouse keeper cannot see or touch the drawer', async () => {
      await api().get('/api/v1/cash-registers').set(auth(warehouseToken)).expect(403);
      await api()
        .post('/api/v1/shifts')
        .set(auth(warehouseToken))
        .send({ registerId, openingAmount: 1_000 })
        .expect(403);
    });

    it('a cashier may open and close but not record a manual movement', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000, cashierToken);

      // The seeded CASHIER has cash.open_shift and cash.close_shift but NOT
      // cash.movement — a till operator should not be able to pay money out of
      // the drawer on their own authority.
      const res = await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(cashierToken))
        .send({ direction: 'OUT', type: 'EXPENSE', amount: 1_000, reason: 'Choy' });
      expect(res.status).toBe(403);

      expect((await closeShift(shift.id, 100_000, cashierToken)).status).toBe(201);
    });

    it('a manager may record movements', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);

      await api()
        .post(`/api/v1/shifts/${shift.id}/movements`)
        .set(auth(managerToken))
        .send({ direction: 'OUT', type: 'EXPENSE', amount: 5_000, reason: 'Kanstovar' })
        .expect(201);
    });

    it('only store managers may create a register', async () => {
      const res = await api()
        .post('/api/v1/cash-registers')
        .set(auth(cashierToken))
        .send({ code: nextCode(), name: 'Ruxsatsiz' });
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated requests', async () => {
      await api().get('/api/v1/cash-registers').expect(401);
      await api().post('/api/v1/shifts').send({}).expect(401);
    });
  });

  describe('cash tenant isolation', () => {
    it("cannot read or close another organization's shift", async () => {
      await api().get(`/api/v1/shifts/${foreign.shiftId}/report`).set(auth(adminToken)).expect(404);

      const res = await closeShift(foreign.shiftId, 100_000, adminToken);
      expect(res.status).toBe(404);

      const untouched = await db.cashRegisterShift.findUniqueOrThrow({
        where: { id: foreign.shiftId },
        select: { status: true },
      });
      expect(untouched.status).toBe('OPEN');
    });

    it("cannot open a shift on another organization's register", async () => {
      const res = await api()
        .post('/api/v1/shifts')
        .set(auth(adminToken))
        .send({ registerId: foreign.registerId, openingAmount: 1_000 });
      expect(res.status).toBe(404);
    });

    it("never lists another organization's registers", async () => {
      const res = await api().get('/api/v1/cash-registers').set(auth(adminToken)).expect(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).not.toContain(foreign.registerId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Employees and store-aware authorization
  // ──────────────────────────────────────────────────────────────────────

  describe('employee administration', () => {
    async function makeEmployee(roleCode = 'CASHIER'): Promise<string> {
      const res = await api()
        .post('/api/v1/employees')
        .set(auth(adminToken))
        .send({
          fullName: `Yangi xodim ${counter}`,
          phone: nextPhone(),
          password: 'YangiParol2026',
          roleId: orgA.roles.get(roleCode)!,
          storeId: orgA.storeId,
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    }

    it('assigns a second store with a different role', async () => {
      const userId = await makeEmployee();

      const res = await api()
        .post(`/api/v1/employees/${userId}/assignments`)
        .set(auth(adminToken))
        .send({ storeId: orgA.secondStoreId, roleId: orgA.roles.get('MANAGER')! });

      expect(res.status).toBe(201);
      expect(res.body.data).toHaveLength(2);

      // The same person, two roles — which a role column on the user could
      // not express.
      const roles = res.body.data.map((a: { role: { code: string } }) => a.role.code).sort();
      expect(roles).toEqual(['CASHIER', 'MANAGER']);
    });

    it('re-assigning changes the role rather than failing', async () => {
      const userId = await makeEmployee();

      await api()
        .post(`/api/v1/employees/${userId}/assignments`)
        .set(auth(adminToken))
        .send({ storeId: orgA.storeId, roleId: orgA.roles.get('WAREHOUSE')! })
        .expect(201);

      const res = await api()
        .get(`/api/v1/employees/${userId}/assignments`)
        .set(auth(adminToken))
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].role.code).toBe('WAREHOUSE');
    });

    it('moves the primary so a fresh session still lands somewhere', async () => {
      const userId = await makeEmployee();
      await api()
        .post(`/api/v1/employees/${userId}/assignments`)
        .set(auth(adminToken))
        .send({
          storeId: orgA.secondStoreId,
          roleId: orgA.roles.get('CASHIER')!,
          isPrimary: true,
        })
        .expect(201);

      const primaries = await db.storeMembership.count({ where: { userId, isPrimary: true } });
      expect(primaries).toBe(1);
    });

    it('refuses to remove the last assignment', async () => {
      const userId = await makeEmployee();

      const res = await api()
        .delete(`/api/v1/employees/${userId}/assignments/${orgA.storeId}`)
        .set(auth(adminToken));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_STORE_ASSIGNMENT');
    });

    it('removes a second assignment and promotes a new primary', async () => {
      const userId = await makeEmployee();
      await api()
        .post(`/api/v1/employees/${userId}/assignments`)
        .set(auth(adminToken))
        .send({
          storeId: orgA.secondStoreId,
          roleId: orgA.roles.get('CASHIER')!,
          isPrimary: true,
        })
        .expect(201);

      const res = await api()
        .delete(`/api/v1/employees/${userId}/assignments/${orgA.secondStoreId}`)
        .set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].isPrimary).toBe(true);
    });

    it('an assignment change invalidates the employee’s tokens immediately', async () => {
      const phone = nextPhone();
      const created = await api()
        .post('/api/v1/employees')
        .set(auth(adminToken))
        .send({
          fullName: `Token xodim ${counter}`,
          phone,
          password: 'YangiParol2026',
          roleId: orgA.roles.get('CASHIER')!,
          storeId: orgA.storeId,
        })
        .expect(201);

      const login = await api()
        .post('/api/v1/auth/login')
        .send({ phone, password: 'YangiParol2026' })
        .expect(200);
      const token = login.body.accessToken as string;

      await api().get('/api/v1/products').set(auth(token)).expect(200);

      await api()
        .post(`/api/v1/employees/${created.body.id}/assignments`)
        .set(auth(adminToken))
        .send({ storeId: orgA.secondStoreId, roleId: orgA.roles.get('MANAGER')! })
        .expect(201);

      // The old token carries a stale permission version.
      await api().get('/api/v1/products').set(auth(token)).expect(401);
    });
  });

  describe('account actions', () => {
    async function makeEmployeeWithLogin(): Promise<{ id: string; phone: string; token: string }> {
      const phone = nextPhone();
      const created = await api()
        .post('/api/v1/employees')
        .set(auth(adminToken))
        .send({
          fullName: `Hisob xodim ${counter}`,
          phone,
          password: 'YangiParol2026',
          roleId: orgA.roles.get('CASHIER')!,
          storeId: orgA.storeId,
        })
        .expect(201);

      const login = await api()
        .post('/api/v1/auth/login')
        .send({ phone, password: 'YangiParol2026' })
        .expect(200);

      return { id: created.body.id as string, phone, token: login.body.accessToken as string };
    }

    it('deactivates and reactivates', async () => {
      const employee = await makeEmployeeWithLogin();

      await api().delete(`/api/v1/employees/${employee.id}`).set(auth(adminToken)).expect(204);
      await api()
        .post('/api/v1/auth/login')
        .send({ phone: employee.phone, password: 'YangiParol2026' })
        .expect(403);

      const activated = await api()
        .patch(`/api/v1/employees/${employee.id}/activate`)
        .set(auth(adminToken));
      expect(activated.status).toBe(200);
      expect(activated.body.status).toBe('ACTIVE');

      await api()
        .post('/api/v1/auth/login')
        .send({ phone: employee.phone, password: 'YangiParol2026' })
        .expect(200);
    });

    it('resets a password without ever returning it', async () => {
      const employee = await makeEmployeeWithLogin();

      const res = await api()
        .post(`/api/v1/employees/${employee.id}/reset-password`)
        .set(auth(adminToken))
        .send({ newPassword: 'ButunlayBoshqa2026' });

      expect(res.status).toBe(201);
      expect(JSON.stringify(res.body)).not.toContain('ButunlayBoshqa2026');
      expect(res.body.sessionsRevoked).toBe(true);

      // The old session is dead and the old password no longer works.
      await api().get('/api/v1/products').set(auth(employee.token)).expect(401);
      await api()
        .post('/api/v1/auth/login')
        .send({ phone: employee.phone, password: 'YangiParol2026' })
        .expect(401);
      await api()
        .post('/api/v1/auth/login')
        .send({ phone: employee.phone, password: 'ButunlayBoshqa2026' })
        .expect(200);

      const entry = await db.auditLog.findFirst({
        where: { action: 'employee.password_reset', entityId: employee.id },
      });
      expect(JSON.stringify(entry!.metadata)).not.toContain('ButunlayBoshqa2026');
    });

    it('refuses a weak password', async () => {
      const employee = await makeEmployeeWithLogin();
      const res = await api()
        .post(`/api/v1/employees/${employee.id}/reset-password`)
        .set(auth(adminToken))
        .send({ newPassword: 'aaaaaaaa' });
      expect([400, 422]).toContain(res.status);
    });

    it('signs an employee out everywhere, immediately', async () => {
      const employee = await makeEmployeeWithLogin();
      await api().get('/api/v1/products').set(auth(employee.token)).expect(200);

      const res = await api()
        .post(`/api/v1/employees/${employee.id}/revoke-sessions`)
        .set(auth(adminToken));
      expect(res.status).toBe(201);
      expect(res.body.sessionsRevoked).toBeGreaterThan(0);

      // Not "within fifteen minutes" — now.
      await api().get('/api/v1/products').set(auth(employee.token)).expect(401);
    });

    it('is refused to a manager, who cannot manage employees', async () => {
      const employee = await makeEmployeeWithLogin();
      await api()
        .post(`/api/v1/employees/${employee.id}/revoke-sessions`)
        .set(auth(managerToken))
        .expect(403);
    });
  });

  describe('activity summary', () => {
    it('aggregates sales, refunds and shifts for one employee', async () => {
      const register = await makeRegister();
      const shift = await openShift(register, 100_000);
      const variantId = await sellable(30_000);

      const sale = await sell({
        items: [{ variantId, quantity: '2.000' }],
        payments: [{ method: 'CASH', amount: 60_000 }],
      });
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

      const res = await api()
        .get(`/api/v1/employees/${orgA.users.get('CASHIER')!.id}/activity`)
        .set(auth(adminToken));

      expect(res.status).toBe(200);
      expect(res.body.sales.count).toBeGreaterThan(0);
      expect(BigInt(res.body.sales.revenue as string) > 0n).toBe(true);
      expect(res.body.shifts.some((s: { id: string }) => s.id === shift.id)).toBe(true);
      expect(res.body.activeSessions).toBeGreaterThan(0);
    });

    it("cannot read another organization's employee", async () => {
      await api()
        .get(`/api/v1/employees/${foreign.userId}/activity`)
        .set(auth(adminToken))
        .expect(404);
      await api()
        .get(`/api/v1/employees/${foreign.userId}/assignments`)
        .set(auth(adminToken))
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Consistency
  // ──────────────────────────────────────────────────────────────────────

  describe('consistency', () => {
    it('every closed shift carries its full reconciliation', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM cash_register_shift
         WHERE organization_id = ${orgA.organizationId}::uuid
           AND status = 'CLOSED'
           AND (closed_at IS NULL OR expected_cash_amount IS NULL
                OR counted_cash_amount IS NULL OR difference_amount IS NULL)
      `;
      expect(broken).toEqual([]);
    });

    it('every stored difference equals counted minus expected', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM cash_register_shift
         WHERE organization_id = ${orgA.organizationId}::uuid
           AND difference_amount IS NOT NULL
           AND difference_amount <> counted_cash_amount - expected_cash_amount
      `;
      expect(broken).toEqual([]);
    });

    it('no register has two open shifts', async () => {
      const broken = await db.$queryRaw<Array<{ cash_register_id: string }>>`
        SELECT cash_register_id FROM cash_register_shift
         WHERE organization_id = ${orgA.organizationId}::uuid AND status = 'OPEN'
         GROUP BY cash_register_id HAVING count(*) > 1
      `;
      expect(broken).toEqual([]);
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
