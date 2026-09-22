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
 * Customers, groups and the debt ledger — docs/ARCHITECTURE.md §12.
 *
 * The invariant every test here defends: no debt and no payment may ever
 * disappear, and the outstanding balance is always the subtraction over the
 * documents — never a stored number that could drift from them.
 */
describe('Customers and debt (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let cashierToken: string;
  let managerToken: string;
  let warehouseToken: string;

  let foreign: { customerId: string; receivableId: string };

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
  const nextPhone = () =>
    `+9989${String(70 + (counter % 20))}${String(1_000_000 + counter++).slice(-6)}`;

  async function makeCustomer(over: Record<string, unknown> = {}): Promise<string> {
    const res = await api()
      .post('/api/v1/customers')
      .set(auth(adminToken))
      .send({ fullName: `Mijoz ${counter}`, phone: nextPhone(), ...over });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** A debt, created through the manual endpoint. */
  async function makeDebt(customerId: string, amount: number, dueDate?: string): Promise<string> {
    const res = await api()
      .post('/api/v1/debts')
      .set(auth(managerToken))
      .send({ customerId, amount, ...(dueDate ? { dueDate } : {}) });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  function pay(body: Record<string, unknown>, token = managerToken, key?: string) {
    return api()
      .post('/api/v1/debts/payments')
      .set(auth(token))
      .set(key ? { 'Idempotency-Key': key } : idem())
      .send(body);
  }

  const daysFromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 10 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'custA');
    orgB = await seedTestOrg(db, 'custB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    managerToken = await tokenFor(orgA, 'MANAGER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    const foreignCustomer = await db.customer.create({
      data: { organizationId: orgB.organizationId, fullName: 'Begona mijoz' },
      select: { id: true },
    });
    const foreignDebt = await db.customerReceivable.create({
      data: {
        organizationId: orgB.organizationId,
        storeId: orgB.storeId,
        customerId: foreignCustomer.id,
        origin: 'MANUAL',
        originalAmount: 500_000n,
        issuedAt: new Date(),
        dueDate: new Date(),
        createdBy: orgB.users.get('ADMIN')!.id,
      },
      select: { id: true },
    });

    foreign = { customerId: foreignCustomer.id, receivableId: foreignDebt.id };
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
  // CRUD
  // ──────────────────────────────────────────────────────────────────────

  describe('customer CRUD', () => {
    it('creates, reads, updates and archives', async () => {
      const phone = nextPhone();
      const created = await api()
        .post('/api/v1/customers')
        .set(auth(adminToken))
        .send({ fullName: 'Dilnoza Karimova', phone, address: 'Chorsu', note: 'Birinchi izoh' });

      expect(created.status).toBe(201);
      expect(created.body.fullName).toBe('Dilnoza Karimova');
      expect(created.body.balance.outstanding).toBe('0');
      expect(created.body.notes).toHaveLength(1);

      const read = await api().get(`/api/v1/customers/${created.body.id}`).set(auth(cashierToken));
      expect(read.status).toBe(200);
      expect(read.body.phone).toBe(phone);

      const updated = await api()
        .patch(`/api/v1/customers/${created.body.id}`)
        .set(auth(adminToken))
        .send({ address: 'Yunusobod' });
      expect(updated.body.address).toBe('Yunusobod');

      const archived = await api()
        .patch(`/api/v1/customers/${created.body.id}/archive`)
        .set(auth(adminToken));
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();

      const restored = await api()
        .patch(`/api/v1/customers/${created.body.id}/restore`)
        .set(auth(adminToken));
      expect(restored.body.archivedAt).toBeNull();
    });

    it('refuses a duplicate phone among live customers', async () => {
      const phone = nextPhone();
      await api()
        .post('/api/v1/customers')
        .set(auth(adminToken))
        .send({ fullName: 'Birinchi', phone })
        .expect(201);

      const res = await api()
        .post('/api/v1/customers')
        .set(auth(adminToken))
        .send({ fullName: 'Ikkinchi', phone });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PHONE_ALREADY_USED');
    });

    it('rejects a malformed phone', async () => {
      await api()
        .post('/api/v1/customers')
        .set(auth(adminToken))
        .send({ fullName: 'Yomon raqam', phone: '901234567' })
        .expect(400);
    });

    it('searches by name and by phone', async () => {
      const phone = nextPhone();
      await api()
        .post('/api/v1/customers')
        .set(auth(adminToken))
        .send({ fullName: 'Shaxsiy Qidiruv Nomi', phone })
        .expect(201);

      const byName = await api()
        .get('/api/v1/customers')
        .query({ q: 'Shaxsiy Qidiruv' })
        .set(auth(cashierToken))
        .expect(200);
      expect(byName.body.data).toHaveLength(1);

      const byPhone = await api()
        .get('/api/v1/customers')
        .query({ q: phone.slice(-6) })
        .set(auth(cashierToken))
        .expect(200);
      expect(byPhone.body.data.length).toBeGreaterThan(0);
    });

    it('logs notes rather than overwriting one field', async () => {
      const id = await makeCustomer();

      await api()
        .post(`/api/v1/customers/${id}/notes`)
        .set(auth(adminToken))
        .send({ body: "Qo'ng'iroq qilindi, juma kuni to'lashga va'da berdi" })
        .expect(201);
      await api()
        .post(`/api/v1/customers/${id}/notes`)
        .set(auth(adminToken))
        .send({ body: "Juma kuni to'lamadi" })
        .expect(201);

      const res = await api().get(`/api/v1/customers/${id}`).set(auth(adminToken));
      expect(res.body.notes).toHaveLength(2);
      // Newest first, and the earlier promise is still there — which is the
      // entry that matters once it is broken.
      expect(res.body.notes[1].body).toContain("va'da berdi");
    });

    it('a note cannot be edited afterwards', async () => {
      const id = await makeCustomer();
      const note = await api()
        .post(`/api/v1/customers/${id}/notes`)
        .set(auth(adminToken))
        .send({ body: 'Asl yozuv' })
        .expect(201);

      await expect(
        db.$executeRaw`UPDATE customer_note SET body = 'Boshqacha' WHERE id = ${note.body.id}::uuid`,
      ).rejects.toThrow(/append-only/i);
    });
  });

  describe('groups', () => {
    it('creates a group and assigns a customer to it', async () => {
      const group = await api()
        .post('/api/v1/customer-groups')
        .set(auth(adminToken))
        .send({ name: `VIP ${counter++}`, discountPercent: 10, creditLimit: 5_000_000 });
      expect(group.status).toBe(201);

      const id = await makeCustomer({ customerGroupId: group.body.id });
      const res = await api().get(`/api/v1/customers/${id}`).set(auth(adminToken));

      expect(res.body.group.name).toBe(group.body.name);
      // No personal limit, so the group's applies.
      expect(res.body.creditLimit).toBeNull();
      expect(res.body.effectiveCreditLimit).toBe('5000000');
    });

    it("a customer's own limit overrides the group's", async () => {
      const group = await api()
        .post('/api/v1/customer-groups')
        .set(auth(adminToken))
        .send({ name: `Ulgurji ${counter++}`, creditLimit: 5_000_000 })
        .expect(201);

      const id = await makeCustomer({ customerGroupId: group.body.id, creditLimit: 100_000 });
      const res = await api().get(`/api/v1/customers/${id}`).set(auth(adminToken));
      expect(res.body.effectiveCreditLimit).toBe('100000');
    });

    it('refuses a duplicate group name', async () => {
      const name = `Doimiy ${counter++}`;
      await api().post('/api/v1/customer-groups').set(auth(adminToken)).send({ name }).expect(201);

      const res = await api().post('/api/v1/customer-groups').set(auth(adminToken)).send({ name });
      expect(res.status).toBe(409);
    });

    it('rejects a discount outside 0–100', async () => {
      await api()
        .post('/api/v1/customer-groups')
        .set(auth(adminToken))
        .send({ name: `Yomon ${counter++}`, discountPercent: 150 })
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // The debt ledger
  // ──────────────────────────────────────────────────────────────────────

  describe('debt creation', () => {
    it('creates a manual debt and shows it on the balance', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 450_000);

      const debt = await api().get(`/api/v1/debts/${debtId}`).set(auth(managerToken));
      expect(debt.status).toBe(200);
      expect(debt.body).toMatchObject({
        originalAmount: '450000',
        paidAmount: '0',
        remainingAmount: '450000',
        status: 'OPEN',
      });

      const balance = await api().get(`/api/v1/customers/${id}/balance`).set(auth(managerToken));
      expect(balance.body.outstanding).toBe('450000');
      expect(balance.body.openDebts).toBe(1);
    });

    it('records an opening balance distinctly from a sale debt', async () => {
      const id = await makeCustomer();
      const res = await api().post('/api/v1/debts').set(auth(managerToken)).send({
        customerId: id,
        amount: 200_000,
        origin: 'OPENING_BALANCE',
        note: "O'tgan yildan",
      });

      expect(res.status).toBe(201);
      expect(res.body.origin).toBe('OPENING_BALANCE');
    });

    it('uses the organization default term when no due date is given', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 100_000);

      const debt = await api().get(`/api/v1/debts/${debtId}`).set(auth(managerToken));
      const due = new Date(debt.body.dueDate as string);
      const days = Math.round((due.getTime() - Date.now()) / 86_400_000);
      expect(days).toBeGreaterThanOrEqual(29);
      expect(days).toBeLessThanOrEqual(31);
    });
  });

  describe('debt payment', () => {
    it('walks the architecture example: 450,000 → pay 100,000 → 350,000 left', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 450_000);

      const payment = await pay({ customerId: id, amount: 100_000, method: 'CASH' });
      expect(payment.status).toBe(201);
      expect(payment.body.allocations).toHaveLength(1);
      expect(payment.body.allocations[0]).toMatchObject({
        receivableId: debtId,
        amount: '100000',
      });

      const debt = await api().get(`/api/v1/debts/${debtId}`).set(auth(managerToken));
      expect(debt.body).toMatchObject({
        originalAmount: '450000',
        paidAmount: '100000',
        remainingAmount: '350000',
        status: 'PARTIALLY_PAID',
      });
      // The original is never overwritten.
      expect(debt.body.payments).toHaveLength(1);
    });

    it('settles the rest and closes the debt', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 450_000);

      await pay({ customerId: id, amount: 100_000, method: 'CASH' }).expect(201);
      await pay({ customerId: id, amount: 350_000, method: 'CARD' }).expect(201);

      const debt = await api().get(`/api/v1/debts/${debtId}`).set(auth(managerToken));
      expect(debt.body.status).toBe('PAID');
      expect(debt.body.remainingAmount).toBe('0');
      expect(debt.body.closedAt).not.toBeNull();
      // Both payments survive, individually.
      expect(debt.body.payments).toHaveLength(2);
      expect(debt.body.payments.map((p: { amount: string }) => p.amount)).toEqual([
        '100000',
        '350000',
      ]);

      const balance = await api().get(`/api/v1/customers/${id}/balance`).set(auth(managerToken));
      expect(balance.body.outstanding).toBe('0');
      expect(balance.body.lifetimePaid).toBe('450000');
    });

    it('spreads one payment across several debts, oldest due first', async () => {
      const id = await makeCustomer();
      const oldest = await makeDebt(id, 100_000, daysFromNow(-10));
      const middle = await makeDebt(id, 100_000, daysFromNow(5));
      const newest = await makeDebt(id, 100_000, daysFromNow(30));

      const res = await pay({ customerId: id, amount: 150_000, method: 'CASH' });
      expect(res.status).toBe(201);
      expect(res.body.allocations).toEqual([
        { receivableId: oldest, amount: '100000', status: 'PAID' },
        { receivableId: middle, amount: '50000', status: 'PARTIALLY_PAID' },
      ]);

      const untouched = await api().get(`/api/v1/debts/${newest}`).set(auth(managerToken));
      expect(untouched.body.remainingAmount).toBe('100000');
    });

    it('honours explicit targets over the FIFO order', async () => {
      const id = await makeCustomer();
      await makeDebt(id, 100_000, daysFromNow(-10));
      const chosen = await makeDebt(id, 100_000, daysFromNow(30));

      const res = await pay({
        customerId: id,
        amount: 40_000,
        method: 'CASH',
        receivableIds: [chosen],
      });
      expect(res.status).toBe(201);
      expect(res.body.allocations[0].receivableId).toBe(chosen);
    });

    it('rejects an over-payment rather than absorbing it', async () => {
      const id = await makeCustomer();
      await makeDebt(id, 50_000);

      const res = await pay({ customerId: id, amount: 80_000, method: 'CASH' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('RECEIVABLE_OVERPAYMENT');
      expect(res.body.errors[0].meta.excess).toBe('30000');

      // Nothing was written — not even the part that would have fitted.
      const balance = await api().get(`/api/v1/customers/${id}/balance`).set(auth(managerToken));
      expect(balance.body.outstanding).toBe('50000');
      expect(balance.body.lifetimePaid).toBe('0');
    });

    it('refuses a payment when nothing is owed', async () => {
      const id = await makeCustomer();
      const res = await pay({ customerId: id, amount: 1_000, method: 'CASH' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_OPEN_RECEIVABLE');
    });

    it('two cashiers collecting the same debt cannot together overpay it', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 100_000);

      const collect = () =>
        pay({ customerId: id, amount: 100_000, method: 'CASH', receivableIds: [debtId] });

      const [first, second] = await Promise.all([collect(), collect()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const debt = await api().get(`/api/v1/debts/${debtId}`).set(auth(managerToken));
      expect(debt.body.paidAmount).toBe('100000');
      expect(debt.body.remainingAmount).toBe('0');
    });

    it('is idempotent — a double-tapped collection is recorded once', async () => {
      const id = await makeCustomer();
      await makeDebt(id, 200_000);
      const key = randomUUID();
      const body = { customerId: id, amount: 50_000, method: 'CASH' };

      const first = await pay(body, managerToken, key);
      expect(first.status).toBe(201);
      const second = await pay(body, managerToken, key);
      expect(second.status).toBe(201);
      expect(second.body.replayed).toBe(true);
      expect(second.body.paymentId).toBe(first.body.paymentId);

      const balance = await api().get(`/api/v1/customers/${id}/balance`).set(auth(managerToken));
      expect(balance.body.outstanding).toBe('150000');
    });

    it('requires the idempotency header', async () => {
      const id = await makeCustomer();
      await makeDebt(id, 10_000);

      const res = await api()
        .post('/api/v1/debts/payments')
        .set(auth(managerToken))
        .send({ customerId: id, amount: 1_000, method: 'CASH' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('a debt payment is the same two tables as a sale payment', async () => {
      const id = await makeCustomer();
      await makeDebt(id, 30_000);
      const res = await pay({ customerId: id, amount: 30_000, method: 'CASH' });

      const payment = await db.payment.findUniqueOrThrow({
        where: { id: res.body.paymentId },
        select: { direction: true, method: true, amount: true, customerId: true },
      });
      expect(payment).toMatchObject({ direction: 'IN', method: 'CASH', amount: 30_000n });

      const allocations = await db.paymentAllocation.findMany({
        where: { paymentId: res.body.paymentId },
        select: { receivableId: true, saleId: true },
      });
      expect(allocations).toHaveLength(1);
      expect(allocations[0]!.saleId).toBeNull();
      expect(allocations[0]!.receivableId).not.toBeNull();
    });
  });

  describe('overdue', () => {
    it('derives overdue from the due date, not from a status column', async () => {
      const id = await makeCustomer();
      const late = await makeDebt(id, 100_000, daysFromNow(-5));
      const future = await makeDebt(id, 100_000, daysFromNow(20));

      const overdue = await api().get(`/api/v1/debts/${late}`).set(auth(managerToken)).expect(200);
      expect(overdue.body.overdue).toBe(true);
      expect(overdue.body.daysOverdue).toBe(5);
      // The stored status is still OPEN — overdue is not a status.
      expect(overdue.body.status).toBe('OPEN');

      const fine = await api().get(`/api/v1/debts/${future}`).set(auth(managerToken));
      expect(fine.body.overdue).toBe(false);
    });

    it('filters overdue, due today and due soon', async () => {
      const id = await makeCustomer();
      const late = await makeDebt(id, 10_000, daysFromNow(-3));
      const today = await makeDebt(id, 10_000, daysFromNow(0));
      const soon = await makeDebt(id, 10_000, daysFromNow(4));
      const later = await makeDebt(id, 10_000, daysFromNow(60));

      const ids = async (filter: string) => {
        const res = await api()
          .get('/api/v1/debts')
          .query({ customerId: id, filter, limit: 100 })
          .set(auth(managerToken))
          .expect(200);
        return res.body.data.map((d: { id: string }) => d.id) as string[];
      };

      expect(await ids('overdue')).toEqual([late]);
      expect(await ids('due_today')).toEqual([today]);
      expect(await ids('due_soon')).toEqual([soon]);
      expect(await ids('unpaid')).toEqual(expect.arrayContaining([later]));
    });

    it('a fully paid debt stops being overdue', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 50_000, daysFromNow(-10));

      await pay({ customerId: id, amount: 50_000, method: 'CASH' }).expect(201);

      const debt = await api().get(`/api/v1/debts/${debtId}`).set(auth(managerToken));
      expect(debt.body.status).toBe('PAID');
      expect(debt.body.overdue).toBe(false);
    });

    it('lists customers with overdue debt, computed in the database', async () => {
      const late = await makeCustomer();
      const fine = await makeCustomer();
      await makeDebt(late, 70_000, daysFromNow(-2));
      await makeDebt(fine, 70_000, daysFromNow(45));

      const res = await api()
        .get('/api/v1/customers')
        .query({ overdue: 'true', limit: 100 })
        .set(auth(managerToken))
        .expect(200);

      const ids = res.body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(late);
      expect(ids).not.toContain(fine);
    });

    it('sorts customers by outstanding debt', async () => {
      const res = await api()
        .get('/api/v1/customers')
        .query({ hasDebt: 'true', sort: 'debt:desc', limit: 20 })
        .set(auth(managerToken))
        .expect(200);

      const amounts = res.body.data.map((c: { balance: { outstanding: string } }) =>
        BigInt(c.balance.outstanding),
      );
      for (let i = 1; i < amounts.length; i += 1) {
        expect(amounts[i - 1] >= amounts[i]).toBe(true);
      }
    });
  });

  describe('write-off', () => {
    it('reduces the balance without touching what was paid', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 100_000);
      await pay({ customerId: id, amount: 30_000, method: 'CASH' }).expect(201);

      const res = await api()
        .post(`/api/v1/debts/${debtId}/write-off`)
        .set(auth(managerToken))
        .send({ reason: 'Mijoz ko‘chib ketdi' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        originalAmount: '100000',
        paidAmount: '30000',
        writtenOffAmount: '70000',
        remainingAmount: '0',
        status: 'WRITTEN_OFF',
      });

      const balance = await api().get(`/api/v1/customers/${id}/balance`).set(auth(managerToken));
      // A loss and a collection are reported separately, never netted.
      expect(balance.body.lifetimePaid).toBe('30000');
      expect(balance.body.lifetimeWrittenOff).toBe('70000');
      expect(balance.body.outstanding).toBe('0');
    });

    it('supports a partial write-off', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 100_000);

      const res = await api()
        .post(`/api/v1/debts/${debtId}/write-off`)
        .set(auth(managerToken))
        .send({ reason: 'Chegirma', amount: 20_000 });

      expect(res.status).toBe(201);
      expect(res.body.remainingAmount).toBe('80000');
      expect(res.body.status).toBe('OPEN');
    });

    it('refuses more than remains', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 50_000);

      const res = await api()
        .post(`/api/v1/debts/${debtId}/write-off`)
        .set(auth(managerToken))
        .send({ reason: 'Juda ko‘p', amount: 90_000 });
      expect(res.status).toBe(409);
    });

    it('requires a reason', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 50_000);

      await api()
        .post(`/api/v1/debts/${debtId}/write-off`)
        .set(auth(managerToken))
        .send({})
        .expect(400);
    });

    it('is refused to a cashier', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 50_000);

      await api()
        .post(`/api/v1/debts/${debtId}/write-off`)
        .set(auth(cashierToken))
        .send({ reason: 'Ruxsatsiz' })
        .expect(403);
    });

    it('writes an audit entry', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 40_000);
      await api()
        .post(`/api/v1/debts/${debtId}/write-off`)
        .set(auth(managerToken))
        .send({ reason: 'Auditga tushsin' })
        .expect(201);

      const entry = await db.auditLog.findFirst({
        where: { action: 'debt.written_off', entityId: debtId },
      });
      expect(entry).not.toBeNull();
      expect((entry!.metadata as { reason: string }).reason).toBe('Auditga tushsin');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Sale → debt, the Sprint 5 path completed
  // ──────────────────────────────────────────────────────────────────────

  describe('sale integration', () => {
    async function sellOnCredit(customerId: string, credit: number, cash = 0) {
      const sku = `DBT-${Date.now().toString(36)}-${counter++}`.toUpperCase();
      const product = await api()
        .post('/api/v1/products')
        .set(auth(adminToken))
        .send({ name: 'Qarz mahsuloti', sku, sellingPrice: credit + cash })
        .expect(201);
      const variantId = product.body.variants[0].id as string;

      await api()
        .post('/api/v1/inventory/adjustments')
        .set(auth(adminToken))
        .send({
          warehouseId: orgA.warehouseId,
          lines: [{ variantId, quantity: '10.000', reason: 'CORRECTION' }],
        })
        .expect(201);

      return api()
        .post('/api/v1/sales/checkout')
        .set(auth(managerToken))
        .set(idem())
        .send({
          items: [{ variantId, quantity: '1.000' }],
          payments: cash > 0 ? [{ method: 'CASH', amount: cash }] : [],
          creditAmount: credit,
          customerId,
        });
    }

    it('a credit sale appears in the debt list and on the balance', async () => {
      const id = await makeCustomer({ creditLimit: 5_000_000 });
      const sale = await sellOnCredit(id, 450_000);
      expect(sale.status).toBe(201);

      const debts = await api()
        .get(`/api/v1/customers/${id}/debts`)
        .set(auth(managerToken))
        .expect(200);

      expect(debts.body.data).toHaveLength(1);
      expect(debts.body.data[0]).toMatchObject({
        origin: 'SALE',
        originalAmount: '450000',
        remainingAmount: '450000',
      });
      expect(debts.body.data[0].sale.id).toBe(sale.body.id);
    });

    it('a mixed payment leaves exactly the unpaid part as debt', async () => {
      const id = await makeCustomer({ creditLimit: 5_000_000 });
      const sale = await sellOnCredit(id, 100_000, 350_000);
      expect(sale.status).toBe(201);

      const balance = await api().get(`/api/v1/customers/${id}/balance`).set(auth(managerToken));
      expect(balance.body.outstanding).toBe('100000');

      // Sale, allocation and receivable agree.
      expect(sale.body.paidAmount).toBe('350000');
      expect(sale.body.creditAmount).toBe('100000');
      expect(sale.body.totalAmount).toBe('450000');
    });

    it('collecting the debt later closes it and leaves the sale alone', async () => {
      const id = await makeCustomer({ creditLimit: 5_000_000 });
      const sale = await sellOnCredit(id, 200_000);

      await pay({ customerId: id, amount: 200_000, method: 'CASH' }).expect(201);

      const balance = await api().get(`/api/v1/customers/${id}/balance`).set(auth(managerToken));
      expect(balance.body.outstanding).toBe('0');

      // The sale's own figures are historical and unchanged.
      const reread = await api().get(`/api/v1/sales/${sale.body.id}`).set(auth(managerToken));
      expect(reread.body.creditAmount).toBe('200000');
      expect(reread.body.paidAmount).toBe('0');
      expect(reread.body.receivable.status).toBe('PAID');
    });

    it('a customer with debt cannot be archived', async () => {
      const id = await makeCustomer({ creditLimit: 5_000_000 });
      await sellOnCredit(id, 150_000);

      const res = await api().patch(`/api/v1/customers/${id}/archive`).set(auth(adminToken));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CUSTOMER_HAS_DEBT');
      expect(res.body.errors[0].meta.outstanding).toBe('150000');
    });

    it("the customer's sales and payments are both listable", async () => {
      const id = await makeCustomer({ creditLimit: 5_000_000 });
      await sellOnCredit(id, 80_000);
      await pay({ customerId: id, amount: 30_000, method: 'CARD' }).expect(201);

      const sales = await api()
        .get(`/api/v1/customers/${id}/sales`)
        .set(auth(managerToken))
        .expect(200);
      expect(sales.body.data).toHaveLength(1);
      expect(sales.body.data[0].creditAmount).toBe('80000');

      const payments = await api()
        .get(`/api/v1/customers/${id}/payments`)
        .set(auth(managerToken))
        .expect(200);
      expect(payments.body.data).toHaveLength(1);
      expect(payments.body.data[0].settled[0].receivableId).not.toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Authorization and isolation
  // ──────────────────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('a cashier may read and create customers but not write off debt', async () => {
      await api().get('/api/v1/customers').set(auth(cashierToken)).expect(200);

      const created = await api()
        .post('/api/v1/customers')
        .set(auth(cashierToken))
        .send({ fullName: 'Kassir qo‘shdi', phone: nextPhone() });
      expect(created.status).toBe(201);

      const debtId = await makeDebt(created.body.id, 10_000);
      await api()
        .post(`/api/v1/debts/${debtId}/write-off`)
        .set(auth(cashierToken))
        .send({ reason: 'Yo‘q' })
        .expect(403);
    });

    it('a cashier may collect a debt payment', async () => {
      const id = await makeCustomer();
      await makeDebt(id, 25_000);

      const res = await pay({ customerId: id, amount: 25_000, method: 'CASH' }, cashierToken);
      expect(res.status).toBe(201);
    });

    it('a warehouse keeper sees no customers at all', async () => {
      await api().get('/api/v1/customers').set(auth(warehouseToken)).expect(403);
      await api().get('/api/v1/debts').set(auth(warehouseToken)).expect(403);
    });

    it('rejects unauthenticated requests', async () => {
      await api().get('/api/v1/customers').expect(401);
      await api().get('/api/v1/debts').expect(401);
      await api().post('/api/v1/debts/payments').set(idem()).send({}).expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("cannot read another organization's customer or debt", async () => {
      await api().get(`/api/v1/customers/${foreign.customerId}`).set(auth(adminToken)).expect(404);
      await api().get(`/api/v1/debts/${foreign.receivableId}`).set(auth(managerToken)).expect(404);
    });

    it("cannot pay another organization's debt", async () => {
      const res = await pay({
        customerId: foreign.customerId,
        amount: 1_000,
        method: 'CASH',
      });
      expect(res.status).toBe(404);

      const untouched = await db.customerReceivable.findUniqueOrThrow({
        where: { id: foreign.receivableId },
        select: { paidAmount: true },
      });
      expect(untouched.paidAmount).toBe(0n);
    });

    it("cannot write off another organization's debt", async () => {
      const res = await api()
        .post(`/api/v1/debts/${foreign.receivableId}/write-off`)
        .set(auth(managerToken))
        .send({ reason: 'Begona' });
      expect(res.status).toBe(404);
    });

    it("never lists another organization's customers or debts", async () => {
      const customers = await api()
        .get('/api/v1/customers')
        .query({ limit: 100 })
        .set(auth(adminToken))
        .expect(200);
      expect(customers.body.data.map((c: { id: string }) => c.id)).not.toContain(
        foreign.customerId,
      );

      const debts = await api()
        .get('/api/v1/debts')
        .query({ limit: 100 })
        .set(auth(managerToken))
        .expect(200);
      expect(debts.body.data.map((d: { id: string }) => d.id)).not.toContain(foreign.receivableId);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Financial consistency
  // ──────────────────────────────────────────────────────────────────────

  describe('financial consistency', () => {
    it('every receivable equals its own allocations', async () => {
      const mismatched = await db.$queryRaw<Array<{ id: string }>>`
        SELECT r.id
          FROM customer_receivable r
         WHERE r.organization_id = ${orgA.organizationId}::uuid
           AND r.paid_amount <> COALESCE((
             SELECT SUM(a.amount) FROM payment_allocation a
              WHERE a.receivable_id = r.id
           ), 0)
      `;
      // Anything here means a paid_amount moved without an allocation, or an
      // allocation was written without moving paid_amount.
      expect(mismatched).toEqual([]);
    });

    it('no receivable is over-settled', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM customer_receivable
         WHERE organization_id = ${orgA.organizationId}::uuid
           AND paid_amount + written_off_amount > original_amount
      `;
      expect(broken).toEqual([]);
    });

    it('every closed receivable carries a closing timestamp', async () => {
      const broken = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM customer_receivable
         WHERE organization_id = ${orgA.organizationId}::uuid
           AND status IN ('PAID','WRITTEN_OFF') AND closed_at IS NULL
      `;
      expect(broken).toEqual([]);
    });

    it('the database refuses a receivable paid past its original', async () => {
      const id = await makeCustomer();
      const debtId = await makeDebt(id, 10_000);

      await expect(
        db.$executeRaw`UPDATE customer_receivable SET paid_amount = 99999 WHERE id = ${debtId}::uuid`,
      ).rejects.toThrow(/ck_receivable_not_overpaid/);
    });

    it('the database refuses a group belonging to another organization', async () => {
      const group = await db.customerGroup.create({
        data: { organizationId: orgB.organizationId, name: `Begona guruh ${counter++}` },
        select: { id: true },
      });
      const id = await makeCustomer();

      await expect(
        db.$executeRaw`
          UPDATE customer SET customer_group_id = ${group.id}::uuid WHERE id = ${id}::uuid
        `,
      ).rejects.toThrow(/fk_customer_group_same_org/);
    });
  });
});
