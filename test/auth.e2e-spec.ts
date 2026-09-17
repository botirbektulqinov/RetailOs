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
 * Authentication, authorization and tenant isolation, over real HTTP against a
 * real PostgreSQL.
 *
 * Nothing here is mocked. The invariants under test are enforced by database
 * constraints, by the Prisma tenant extension and by READ COMMITTED semantics,
 * and a mock reproduces none of them — a suite that mocks Prisma tests the mock.
 */
describe('Auth, RBAC and tenant isolation (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  const api = () => request(app.getHttpServer());

  /** Logs in and returns the token pair. */
  async function login(phone: string, password = TEST_PASSWORD, storeId?: string) {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ phone, password, rememberDevice: true, ...(storeId ? { storeId } : {}) });
    return res;
  }

  async function tokenFor(org: SeededOrg, roleCode: string): Promise<string> {
    const res = await login(org.users.get(roleCode)!.phone);
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    // A previous crashed run may have left fixtures behind.
    await dropStaleTestOrgs(db);

    // Two organizations with deliberately similar data.
    orgA = await seedTestOrg(db, 'alpha');
    orgB = await seedTestOrg(db, 'bravo');
  }, 60_000);

  afterAll(async () => {
    if (orgA) await dropTestOrg(db, orgA.organizationId);
    if (orgB) await dropTestOrg(db, orgB.organizationId);
    await db?.$disconnect();
    await pool?.end();
    await app?.close();
  });

  // ── Authentication ───────────────────────────────────────────────────────

  describe('login', () => {
    it('authenticates with a correct phone and password', async () => {
      const res = await login(orgA.users.get('ADMIN')!.phone);

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toEqual(expect.any(String));
      expect(res.body.user.role.code).toBe('ADMIN');
      expect(res.body.user.organization.id).toBe(orgA.organizationId);
      expect(res.body.user.activeStore.id).toBe(orgA.storeId);
    });

    it('normalises the phone, so formatting never decides whether login works', async () => {
      const e164 = orgA.users.get('CASHIER')!.phone;
      const spaced = `${e164.slice(0, 4)} ${e164.slice(4, 6)} ${e164.slice(6, 9)} ${e164.slice(9)}`;

      const res = await login(spaced);
      expect(res.status).toBe(200);
    });

    it('rejects a wrong password', async () => {
      const res = await login(orgA.users.get('ADMIN')!.phone, 'WrongParol123');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('gives an unknown phone the SAME response as a wrong password', async () => {
      const unknown = await login('+998900000000', 'WrongParol123');
      const wrong = await login(orgA.users.get('ADMIN')!.phone, 'WrongParol123');

      // Any difference here is an account-enumeration oracle.
      expect(unknown.status).toBe(wrong.status);
      expect(unknown.body.code).toBe(wrong.body.code);
      expect(unknown.body.detail).toBe(wrong.body.detail);
    });

    it('never returns the password hash', async () => {
      const res = await login(orgA.users.get('ADMIN')!.phone);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
    });

    it('refuses an inactive account and says why', async () => {
      const user = orgB.users.get('WAREHOUSE')!;
      await db.user.update({ where: { id: user.id }, data: { status: 'INACTIVE' } });

      const res = await login(user.phone);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('USER_INACTIVE');

      await db.user.update({ where: { id: user.id }, data: { status: 'ACTIVE' } });
    });

    it('refuses login into a suspended organization', async () => {
      await db.organization.update({
        where: { id: orgB.organizationId },
        data: { status: 'SUSPENDED' },
      });

      const res = await login(orgB.users.get('MANAGER')!.phone);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORGANIZATION_SUSPENDED');

      await db.organization.update({
        where: { id: orgB.organizationId },
        data: { status: 'ACTIVE' },
      });
    });

    it('refuses a store the user is not a member of', async () => {
      const res = await login(
        orgA.users.get('CASHIER')!.phone,
        TEST_PASSWORD,
        orgA.secondStoreId, // exists, same org, but no membership
      );

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STORE_ACCESS_DENIED');
    });
  });

  // ── Tokens and sessions ──────────────────────────────────────────────────

  describe('tokens', () => {
    it('rejects a request with no token', async () => {
      const res = await api().get('/api/v1/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_INVALID');
    });

    it('rejects a tampered payload, even with the original signature', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const [header, payload, signature] = token.split('.');

      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
      claims.org = orgB.organizationId; // try to become another tenant
      const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;

      const res = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
      expect(res.status).toBe(401);
    });

    it('rejects an alg=none forgery', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(
        JSON.stringify({
          sub: orgA.users.get('ADMIN')!.id,
          org: orgA.organizationId,
          store: orgA.storeId,
          role: orgA.roles.get('ADMIN'),
          pv: 0,
          tv: 0,
          sid: 'x',
          jti: 'y',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      const res = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${header}.${claims}.`);
      expect(res.status).toBe(401);
    });

    it('rotates the refresh token and revokes the family on reuse', async () => {
      const first = await login(orgA.users.get('MANAGER')!.phone);
      const original = first.body.refreshToken as string;

      const rotated = await api().post('/api/v1/auth/refresh').send({ refreshToken: original });
      expect(rotated.status).toBe(200);
      expect(rotated.body.refreshToken).not.toBe(original);

      // Replaying the rotated-away token means it was captured.
      const reuse = await api().post('/api/v1/auth/refresh').send({ refreshToken: original });
      expect(reuse.status).toBe(401);
      expect(reuse.body.code).toBe('REFRESH_TOKEN_INVALID');

      // ... and the legitimate holder's token dies with the family.
      const after = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken });
      expect(after.status).toBe(401);
    });

    it('revokes the session on logout, and is safe to call twice', async () => {
      const session = await login(orgA.users.get('WAREHOUSE')!.phone);
      const { accessToken, refreshToken } = session.body;

      expect(
        (await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`)).status,
      ).toBe(200);

      const first = await api()
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });
      expect(first.status).toBe(200);
      expect(first.body.revoked).toBe(1);

      const second = await api()
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });
      expect(second.status).toBe(200);
      expect(second.body.revoked).toBe(0);

      const refreshed = await api().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(refreshed.status).toBe(401);
    });

    it('logout-all kills access tokens too, not just refresh tokens', async () => {
      const session = await login(orgB.users.get('CASHIER')!.phone);
      const token = session.body.accessToken as string;

      await api()
        .post('/api/v1/auth/logout-all')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Without the tokenVersion bump this would keep working for 15 minutes,
      // which is not what "log out everywhere" promises.
      const after = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
      expect(after.status).toBe(401);
    });

    it('lists active sessions', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const res = await api().get('/api/v1/auth/sessions').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/tokenHash/);
    });
  });

  // ── Authorization ────────────────────────────────────────────────────────

  describe('RBAC', () => {
    it('lets an administrator manage employees', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const res = await api().get('/api/v1/employees').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(4);
      expect(res.body.summary.seatLimit).toBe(10);
    });

    it('forbids a cashier from reading employees, and names the missing permission', async () => {
      const token = await tokenFor(orgA, 'CASHIER');
      const res = await api().get('/api/v1/employees').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.errors[0].meta.permission).toBe('employees.read');
    });

    it('forbids a warehouse worker from managing employees', async () => {
      const token = await tokenFor(orgA, 'WAREHOUSE');
      const res = await api()
        .post('/api/v1/employees')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: 'Yangi Xodim',
          phone: '+998900000123',
          password: TEST_PASSWORD,
          storeId: orgA.storeId,
          roleId: orgA.roles.get('CASHIER'),
        });

      expect(res.status).toBe(403);
    });

    it('forbids a manager from editing roles, which stays with the administrator', async () => {
      const token = await tokenFor(orgA, 'MANAGER');
      const res = await api()
        .put(`/api/v1/roles/${orgA.roles.get('CASHIER')}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ permissions: ['sales.read'] });

      expect(res.status).toBe(403);
    });

    it('lets a warehouse worker read products but not sell', async () => {
      const token = await tokenFor(orgA, 'WAREHOUSE');
      const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

      expect(me.body.permissions).toContain('inventory.adjust');
      expect(me.body.permissions).not.toContain('sales.create');
      expect(me.body.permissions).not.toContain('employees.manage');
    });

    it("matches the design's cashier permission toggles exactly", async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const res = await api()
        .get(`/api/v1/roles/${orgA.roles.get('CASHIER')}/permissions`)
        .set('Authorization', `Bearer ${token}`);

      const permissions = res.body.permissions as { key: string; enabled: boolean }[];
      const enabled = (key: string): boolean => permissions.find((p) => p.key === key)!.enabled;

      // Straight from the "Ruxsatlar" screen, Kassir roli.
      expect(enabled('sales.create')).toBe(true);
      expect(enabled('sales.resend_receipt')).toBe(true);
      expect(enabled('reports.read')).toBe(true);
      expect(enabled('sales.refund')).toBe(false);
      expect(enabled('sales.override_price')).toBe(false);
      expect(enabled('employees.manage')).toBe(false);
    });

    it('applies a permission change on the very next request, with no re-login', async () => {
      const adminToken = await tokenFor(orgA, 'ADMIN');
      const cashierToken = await tokenFor(orgA, 'CASHIER');
      const roleId = orgA.roles.get('CASHIER')!;

      const before = await api()
        .get('/api/v1/employees')
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(before.status).toBe(403);

      const current = await db.role.findUniqueOrThrow({
        where: { id: roleId },
        select: { permissions: true },
      });

      await api()
        .put(`/api/v1/roles/${roleId}/permissions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ permissions: [...current.permissions, 'employees.read'] })
        .expect(200);

      // Same token as before — permissions are resolved per request.
      const after = await api()
        .get('/api/v1/employees')
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(after.status).toBe(200);

      await api()
        .put(`/api/v1/roles/${roleId}/permissions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ permissions: current.permissions })
        .expect(200);

      const revoked = await api()
        .get('/api/v1/employees')
        .set('Authorization', `Bearer ${cashierToken}`);
      expect(revoked.status).toBe(403);
    });

    it('refuses to edit the administrator role', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const res = await api()
        .put(`/api/v1/roles/${orgA.roles.get('ADMIN')}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ permissions: ['sales.read'] });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROLE_IMMUTABLE');
    });

    it('rejects a permission that is not in the catalogue', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const res = await api()
        .put(`/api/v1/roles/${orgA.roles.get('CASHIER')}/permissions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ permissions: ['sales.read', 'everything.hack'] });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('UNKNOWN_PERMISSION');
    });
  });

  // ── Tenant isolation ─────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    let tokenA: string;

    beforeAll(async () => {
      tokenA = await tokenFor(orgA, 'ADMIN');
    });

    const auth = () => ({ Authorization: `Bearer ${tokenA}` });

    it('cannot read another organization’s user', async () => {
      const res = await api()
        .get(`/api/v1/employees/${orgB.users.get('ADMIN')!.id}`)
        .set(auth());

      // 404, not 403: confirming the row exists is itself a leak.
      expect(res.status).toBe(404);
    });

    it('cannot modify another organization’s user', async () => {
      const res = await api()
        .patch(`/api/v1/employees/${orgB.users.get('CASHIER')!.id}`)
        .set(auth())
        .send({ fullName: 'Hacked' });

      expect(res.status).toBe(404);

      const untouched = await db.user.findUniqueOrThrow({
        where: { id: orgB.users.get('CASHIER')!.id },
        select: { fullName: true },
      });
      expect(untouched.fullName).not.toBe('Hacked');
    });

    it('cannot read or edit another organization’s store', async () => {
      expect((await api().get(`/api/v1/stores/${orgB.storeId}`).set(auth())).status).toBe(404);
      expect(
        (await api().patch(`/api/v1/stores/${orgB.storeId}`).set(auth()).send({ name: 'Hacked' }))
          .status,
      ).toBe(404);
    });

    it('cannot read or edit another organization’s role', async () => {
      const roleB = orgB.roles.get('CASHIER')!;
      expect((await api().get(`/api/v1/roles/${roleB}/permissions`).set(auth())).status).toBe(404);
      expect(
        (
          await api()
            .put(`/api/v1/roles/${roleB}/permissions`)
            .set(auth())
            .send({ permissions: ['sales.read'] })
        ).status,
      ).toBe(404);
    });

    it('cannot switch into another organization’s store', async () => {
      const res = await api()
        .post('/api/v1/auth/switch-store')
        .set(auth())
        .send({ storeId: orgB.storeId });

      // 403 here, not 404: the caller is authenticated and the parameter is
      // their own claim to make, so the denial is about them, not the resource.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STORE_ACCESS_DENIED');
    });

    it('cannot plant a user in another organization’s store', async () => {
      const res = await api()
        .post('/api/v1/employees')
        .set(auth())
        .send({
          fullName: 'Mole',
          phone: '+998900000999',
          password: TEST_PASSWORD,
          storeId: orgB.storeId,
          roleId: orgB.roles.get('ADMIN'),
        });

      expect(res.status).toBe(404);

      const planted = await db.user.findUnique({ where: { phone: '+998900000999' } });
      expect(planted).toBeNull();
    });

    it('only ever lists its own organization’s employees', async () => {
      const res = await api().get('/api/v1/employees').set(auth());
      const ids: string[] = res.body.data.map((e: { id: string }) => e.id);

      for (const user of orgB.users.values()) {
        expect(ids).not.toContain(user.id);
      }
    });

    it('resolves /organizations/current from the token, not from a parameter', async () => {
      const res = await api().get('/api/v1/organizations/current').set(auth());

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orgA.organizationId);
      expect(res.body.seatsUsed).toBe(4);
    });

    it('only lists stores the caller is actually a member of', async () => {
      const cashier = await tokenFor(orgA, 'CASHIER');
      const res = await api().get('/api/v1/stores').set('Authorization', `Bearer ${cashier}`);

      const ids: string[] = res.body.map((s: { id: string }) => s.id);
      expect(ids).toContain(orgA.storeId);
      // Same organization, but no membership — tenancy alone is not enough.
      expect(ids).not.toContain(orgA.secondStoreId);
      expect(ids).not.toContain(orgB.storeId);
    });

    it('cannot create a cross-organization membership, even below the API', async () => {
      // The composite foreign keys are the last line of defence if every
      // application check is ever removed.
      await expect(
        db.storeMembership.create({
          data: {
            organizationId: orgA.organizationId,
            userId: orgA.users.get('CASHIER')!.id,
            storeId: orgB.storeId, // another tenant's store
            roleId: orgA.roles.get('CASHIER')!,
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ── Employees and password policy ────────────────────────────────────────

  describe('employee management', () => {
    it('creates a user and their membership together', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const phone = `${orgA.phonePrefix}900001`;

      const res = await api()
        .post('/api/v1/employees')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: 'Yangi Kassir',
          phone,
          password: TEST_PASSWORD,
          storeId: orgA.storeId,
          roleId: orgA.roles.get('CASHIER'),
        });

      expect(res.status).toBe(201);
      expect(res.body.role.code).toBe('CASHIER');
      expect(res.body.initials).toBe('YK');

      // The new account can actually log in — a user without a membership
      // would be created "successfully" and then be unable to sign in.
      const session = await login(phone);
      expect(session.status).toBe(200);

      // Deactivated, not deleted: audit rows reference the actor with ON
      // DELETE RESTRICT, which is the product's real behaviour too — users are
      // never removed, so their sales and their audit trail keep naming them.
      await db.refreshToken.deleteMany({ where: { userId: res.body.id } });
      await db.user.update({ where: { id: res.body.id }, data: { status: 'INACTIVE' } });
    });

    it('rejects a duplicate phone number', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const res = await api()
        .post('/api/v1/employees')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: 'Nusxa',
          phone: orgA.users.get('CASHIER')!.phone,
          password: TEST_PASSWORD,
          storeId: orgA.storeId,
          roleId: orgA.roles.get('CASHIER'),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PHONE_ALREADY_USED');
    });

    it('refuses to deactivate the last administrator', async () => {
      const token = await tokenFor(orgA, 'ADMIN');
      const res = await api()
        .patch(`/api/v1/employees/${orgA.users.get('ADMIN')!.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'INACTIVE' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_ADMIN');
    });

    it('kills a deactivated user’s sessions immediately', async () => {
      const admin = await tokenFor(orgB, 'ADMIN');
      const victim = orgB.users.get('WAREHOUSE')!;

      const session = await login(victim.phone);
      const victimToken = session.body.accessToken as string;
      expect(
        (await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${victimToken}`)).status,
      ).toBe(200);

      await api()
        .patch(`/api/v1/employees/${victim.id}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ status: 'SUSPENDED' })
        .expect(200);

      const after = await api()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${victimToken}`);
      expect(after.status).toBe(401);

      await db.user.update({ where: { id: victim.id }, data: { status: 'ACTIVE' } });
    });

    it('enforces the seat limit from the organization plan', async () => {
      const token = await tokenFor(orgB, 'ADMIN');
      await db.organization.update({ where: { id: orgB.organizationId }, data: { maxUsers: 4 } });

      const res = await api()
        .post('/api/v1/employees')
        .set('Authorization', `Bearer ${token}`)
        .send({
          fullName: 'Ortiqcha Xodim',
          phone: `${orgB.phonePrefix}900002`,
          password: TEST_PASSWORD,
          storeId: orgB.storeId,
          roleId: orgB.roles.get('CASHIER'),
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SEAT_LIMIT_REACHED');

      await db.organization.update({ where: { id: orgB.organizationId }, data: { maxUsers: 10 } });
    });
  });

  describe('password change', () => {
    it('revokes every session, including the one that made the request', async () => {
      const victim = orgB.users.get('MANAGER')!;
      const session = await login(victim.phone);
      const { accessToken, refreshToken } = session.body;

      await api()
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'BoshqaParol2026' })
        .expect(204);

      expect(
        (await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken}`)).status,
      ).toBe(401);
      expect((await api().post('/api/v1/auth/refresh').send({ refreshToken })).status).toBe(401);

      expect((await login(victim.phone, TEST_PASSWORD)).status).toBe(401);
      expect((await login(victim.phone, 'BoshqaParol2026')).status).toBe(200);
    });

    it('rejects a wrong current password', async () => {
      const token = await tokenFor(orgA, 'MANAGER');
      const res = await api()
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'NotMyPassword1', newPassword: 'YangiParol2026' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });

    it("enforces the design's policy: 8+ characters and a digit or symbol", async () => {
      const token = await tokenFor(orgA, 'WAREHOUSE');

      const tooShort = await api()
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'Qisqa1' });
      expect(tooShort.status).toBe(400);

      const noDigit = await api()
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'parolsizraqam' });
      expect(noDigit.status).toBe(400);
      expect(noDigit.body.code).toBe('WEAK_PASSWORD');
    });
  });

  // ── Audit ────────────────────────────────────────────────────────────────

  describe('audit trail', () => {
    it('records logins, failures and permission changes', async () => {
      const actions = await db.auditLog.findMany({
        where: { organizationId: orgA.organizationId },
        select: { action: true },
      });
      const seen = new Set(actions.map((a) => a.action));

      expect(seen).toContain('auth.login');
      expect(seen).toContain('auth.login_failed');
      expect(seen).toContain('role.permissions_changed');
    });

    it('is append-only at the database level', async () => {
      const row = await db.auditLog.findFirstOrThrow({
        where: { organizationId: orgA.organizationId },
        select: { id: true },
      });

      await expect(
        db.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
      ).rejects.toThrow(/append-only/);

      await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    });

    it('never stores a password or a token in its metadata', async () => {
      const rows = await db.auditLog.findMany({
        where: { organizationId: { in: [orgA.organizationId, orgB.organizationId] } },
        select: { metadata: true },
      });

      const dumped = JSON.stringify(rows);
      expect(dumped).not.toMatch(new RegExp(TEST_PASSWORD));
      expect(dumped).not.toMatch(/passwordHash|tokenHash|refreshToken/);
    });
  });
});
