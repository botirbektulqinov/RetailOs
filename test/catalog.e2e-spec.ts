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
 * Catalog: categories, products and variants over real HTTP.
 *
 * The cross-tenant block is the important half. Organization B's fixtures are
 * created directly through Prisma so the probes below are attacking data that
 * genuinely exists — a 404 against a nonexistent id would prove nothing.
 */
describe('Catalog (e2e)', () => {
  let app: INestApplication<App>;
  let db: PrismaClient;
  let pool: Pool;
  let orgA: SeededOrg;
  let orgB: SeededOrg;

  let adminToken: string;
  let cashierToken: string;
  let warehouseToken: string;

  /** Organization B fixtures, for the isolation probes. */
  let foreign: { categoryId: string; productId: string; variantId: string };

  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function tokenFor(org: SeededOrg, roleCode: string): Promise<string> {
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ phone: org.users.get(roleCode)!.phone, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  /** Unique per test so a leftover row never collides on the SKU index. */
  let skuCounter = 0;
  const nextSku = (prefix = 'T') => `${prefix}-${Date.now().toString(36)}-${skuCounter++}`;
  const nextBarcode = () => String(4_780_000_000_000 + Math.floor(Math.random() * 999_999_999));

  async function createProduct(overrides: Record<string, unknown> = {}) {
    const res = await api()
      .post('/api/v1/products')
      .set(auth(adminToken))
      .send({ name: 'Test mahsulot', sku: nextSku(), sellingPrice: 24_000, ...overrides });
    return res;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'], max: 5 });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    applyGlobalSetup(app, { swagger: false });
    await app.init();

    await dropStaleTestOrgs(db);
    orgA = await seedTestOrg(db, 'catalogA');
    orgB = await seedTestOrg(db, 'catalogB');

    adminToken = await tokenFor(orgA, 'ADMIN');
    cashierToken = await tokenFor(orgA, 'CASHIER');
    warehouseToken = await tokenFor(orgA, 'WAREHOUSE');

    const category = await db.category.create({
      data: { organizationId: orgB.organizationId, name: 'Begona kategoriya', path: '', depth: 1 },
      select: { id: true },
    });
    const product = await db.product.create({
      data: {
        organizationId: orgB.organizationId,
        categoryId: category.id,
        name: 'Begona mahsulot',
      },
      select: { id: true },
    });
    const variant = await db.productVariant.create({
      data: {
        organizationId: orgB.organizationId,
        productId: product.id,
        sku: 'FOREIGN-1',
        barcode: '4999999999999',
        sellingPrice: 1_000n,
        isDefault: true,
      },
      select: { id: true },
    });

    foreign = { categoryId: category.id, productId: product.id, variantId: variant.id };
  }, 90_000);

  afterAll(async () => {
    if (orgA) await dropTestOrg(db, orgA.organizationId);
    if (orgB) await dropTestOrg(db, orgB.organizationId);
    await db?.$disconnect();
    await pool?.end();
    await app?.close();
  });

  // ── Categories ───────────────────────────────────────────────────────────

  describe('categories', () => {
    it('creates a root category and a child, maintaining the rendered path', async () => {
      const root = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Ichimliklar' });
      expect(root.status).toBe(201);
      expect(root.body).toMatchObject({ depth: 1, path: '' });

      const child = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Issiq', parentId: root.body.id });
      expect(child.status).toBe(201);
      // The categories screen renders this path under the name.
      expect(child.body).toMatchObject({ depth: 2, path: 'Ichimliklar' });

      const grandchild = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Choy va qahva', parentId: child.body.id });
      expect(grandchild.body.path).toBe('Ichimliklar / Issiq');
    });

    it('refuses a fourth level', async () => {
      const list = await api().get('/api/v1/categories?flat=true').set(auth(adminToken));
      const deepest = list.body.data.find((c: { depth: number }) => c.depth === 3);

      const res = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Juda chuqur', parentId: deepest.id });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_TOO_DEEP');
    });

    it('refuses two siblings with the same name, case-insensitively', async () => {
      await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Takror' })
        .expect(201);

      const res = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'takror' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_NAME_TAKEN');
    });

    it('prevents a cycle when a category is moved under its own descendant', async () => {
      const parent = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Halqa ota' });
      const child = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Halqa bola', parentId: parent.body.id });

      const res = await api()
        .patch(`/api/v1/categories/${parent.body.id}`)
        .set(auth(adminToken))
        .send({ parentId: child.body.id });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_CYCLE');
    });

    it('rejects a category that is its own parent', async () => {
      const category = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: "O'zi ota" });

      const res = await api()
        .patch(`/api/v1/categories/${category.body.id}`)
        .set(auth(adminToken))
        .send({ parentId: category.body.id });

      expect(res.status).toBe(409);
    });

    it('rewrites descendant paths when a parent is renamed', async () => {
      const root = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Eski nom' });
      const child = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Bola', parentId: root.body.id });

      await api()
        .patch(`/api/v1/categories/${root.body.id}`)
        .set(auth(adminToken))
        .send({ name: 'Yangi nom' })
        .expect(200);

      const after = await api().get(`/api/v1/categories/${child.body.id}`).set(auth(adminToken));
      expect(after.body.path).toBe('Yangi nom');
    });

    it('returns a tree by default and a flat list on request', async () => {
      const tree = await api().get('/api/v1/categories').set(auth(adminToken));
      expect(tree.status).toBe(200);
      expect(tree.body.data.every((c: { depth: number }) => c.depth === 1)).toBe(true);
      expect(tree.body.data.some((c: { children: unknown[] }) => c.children.length > 0)).toBe(true);

      const flat = await api().get('/api/v1/categories?flat=true').set(auth(adminToken));
      expect(flat.body.data.some((c: { depth: number }) => c.depth > 1)).toBe(true);
    });

    it('refuses to archive a category that still holds products', async () => {
      const category = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Band kategoriya' });

      await createProduct({ categoryId: category.body.id });

      const res = await api()
        .patch(`/api/v1/categories/${category.body.id}/archive`)
        .set(auth(adminToken));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_HAS_PRODUCTS');
    });

    it('refuses to archive a category that still holds subcategories', async () => {
      const parent = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Bolali ota' });
      await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Bir bola', parentId: parent.body.id });

      const res = await api()
        .patch(`/api/v1/categories/${parent.body.id}/archive`)
        .set(auth(adminToken));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CATEGORY_HAS_CHILDREN');
    });

    it('archives an empty category and restores it', async () => {
      const category = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: "Bo'sh kategoriya" });

      const archived = await api()
        .patch(`/api/v1/categories/${category.body.id}/archive`)
        .set(auth(adminToken));
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();

      const hidden = await api().get('/api/v1/categories?flat=true').set(auth(adminToken));
      expect(hidden.body.data.map((c: { id: string }) => c.id)).not.toContain(category.body.id);
      // The screen header counts these: "18 kategoriya · 3 ta yashirilgan".
      expect(hidden.body.summary.archivedCount).toBeGreaterThan(0);

      const restored = await api()
        .patch(`/api/v1/categories/${category.body.id}/restore`)
        .set(auth(adminToken));
      expect(restored.body.archivedAt).toBeNull();
    });
  });

  // ── Products ─────────────────────────────────────────────────────────────

  describe('products', () => {
    it('creates a product with its default variant in one call', async () => {
      const res = await createProduct({
        name: 'Safia qora choy 100g',
        sku: 'ch-021-test',
        barcode: '4780 0123 45678',
        sellingPrice: 24_000,
        purchasePrice: 17_500,
        minStock: '5.000',
      });

      expect(res.status).toBe(201);
      expect(res.body.hasVariants).toBe(false);
      expect(res.body.variants).toHaveLength(1);

      const variant = res.body.variants[0];
      expect(variant.isDefault).toBe(true);
      // SKU uppercased, barcode stripped to digits.
      expect(variant.sku).toBe('CH-021-TEST');
      expect(variant.barcode).toBe('4780012345678');
      // Money is a JSON integer in minor units, never a float.
      expect(variant.sellingPrice).toBe(24000);
      expect(variant.purchasePrice).toBe(17500);
      // Quantities are decimal strings, so 5.000 cannot become 5.000000001.
      expect(variant.minStock).toBe('5.000');
    });

    it('rejects a duplicate SKU, and the rejection comes from the database', async () => {
      const sku = nextSku('DUP');
      await createProduct({ sku }).then((r) => expect(r.status).toBe(201));

      const res = await createProduct({ sku: sku.toLowerCase() });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SKU_ALREADY_USED');

      // Not a leaked Prisma message.
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|P2002|product_variant/i);
    });

    it('rejects a duplicate barcode with the message the design shows', async () => {
      const barcode = nextBarcode();
      await createProduct({ barcode }).then((r) => expect(r.status).toBe(201));

      const res = await createProduct({ barcode });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BARCODE_ALREADY_USED');
      expect(res.body.detail).toContain('boshqa mahsulotda mavjud');
    });

    it('rejects a non-numeric barcode', async () => {
      const res = await createProduct({ barcode: 'ABC123' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects a negative price', async () => {
      const res = await createProduct({ sellingPrice: -1 });
      expect(res.status).toBe(400);
    });

    it('accepts a selling price below the purchase price', async () => {
      // Clearing stock below cost is ordinary retail. A backend that forbade
      // it would be wrong about the business, so there is deliberately no
      // sellingPrice >= purchasePrice rule.
      const res = await createProduct({ sellingPrice: 5_000, purchasePrice: 9_000 });
      expect(res.status).toBe(201);
    });

    it('rejects unknown fields instead of silently dropping them', async () => {
      const res = await api()
        .post('/api/v1/products')
        .set(auth(adminToken))
        .send({ name: 'X', sku: nextSku(), sellingPrice: 1000, stock: 500 });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.errors)).toContain('stock');
    });

    it('updates a simple product price through the product endpoint', async () => {
      const created = await createProduct({ sellingPrice: 120_000 });

      const updated = await api()
        .patch(`/api/v1/products/${created.body.id}`)
        .set(auth(adminToken))
        .send({ sellingPrice: 129_000 });

      expect(updated.status).toBe(200);
      expect(updated.body.variants[0].sellingPrice).toBe(129000);

      // The audit screen renders this as "Narx o'zgartirildi · 120 000 -> 129 000".
      const audit = await db.auditLog.findFirst({
        where: { organizationId: orgA.organizationId, action: 'product.price_changed' },
        orderBy: { id: 'desc' },
        select: { metadata: true },
      });
      expect(audit?.metadata).toMatchObject({
        oldSellingPrice: '120000',
        newSellingPrice: '129000',
      });
    });

    it('rejects a stale version with 409 rather than overwriting', async () => {
      const created = await createProduct();
      const staleVersion = created.body.version;

      await api()
        .patch(`/api/v1/products/${created.body.id}`)
        .set(auth(adminToken))
        .send({ name: 'Birinchi tahrir', version: staleVersion })
        .expect(200);

      const res = await api()
        .patch(`/api/v1/products/${created.body.id}`)
        .set(auth(adminToken))
        .send({ name: 'Ikkinchi tahrir', version: staleVersion });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONCURRENT_MODIFICATION');
    });

    it('archives a product, hides it from search, and frees its SKU', async () => {
      const sku = nextSku('ARCH');
      const created = await createProduct({ name: 'Arxivlanadigan', sku });

      await api()
        .patch(`/api/v1/products/${created.body.id}/archive`)
        .set(auth(adminToken))
        .expect(200);

      const search = await api().get('/api/v1/products?q=Arxivlanadigan').set(auth(adminToken));
      expect(search.body.data).toHaveLength(0);

      // Still readable by id — history must keep resolving.
      const byId = await api().get(`/api/v1/products/${created.body.id}`).set(auth(adminToken));
      expect(byId.status).toBe(200);
      expect(byId.body.archivedAt).not.toBeNull();

      // The partial unique index is on archived_at IS NULL, so the SKU is free.
      const reused = await createProduct({ sku });
      expect(reused.status).toBe(201);

      // ... and restoring the original now collides with the reuse.
      const restore = await api()
        .patch(`/api/v1/products/${created.body.id}/restore`)
        .set(auth(adminToken));
      expect(restore.status).toBe(409);
      expect(restore.body.code).toBe('SKU_ALREADY_USED');
    });

    it('rejects a category from another organization at creation', async () => {
      const res = await createProduct({ categoryId: foreign.categoryId });
      expect(res.status).toBe(404);

      const planted = await db.product.count({
        where: { organizationId: orgA.organizationId, categoryId: foreign.categoryId },
      });
      expect(planted).toBe(0);
    });
  });

  // ── Variants ─────────────────────────────────────────────────────────────

  describe('variants', () => {
    let shirtId: string;

    beforeAll(async () => {
      const created = await createProduct({ name: 'Futbolka Test', sellingPrice: 129_000 });
      shirtId = created.body.id as string;
    });

    it('adds a variant and flips the product to a variant product', async () => {
      const res = await api()
        .post(`/api/v1/products/${shirtId}/variants`)
        .set(auth(adminToken))
        .send({
          sku: nextSku('FT'),
          attributes: { Rang: 'Qora', "O'lcham": 'S' },
          sellingPrice: 129_000,
        });

      expect(res.status).toBe(201);
      // Name rendered from the attributes, as the variants table shows it.
      expect(res.body.name).toBe('Qora / S');

      const product = await api().get(`/api/v1/products/${shirtId}`).set(auth(adminToken));
      expect(product.body.hasVariants).toBe(true);
    });

    it('derives the option pickers from the variants themselves', async () => {
      await api()
        .post(`/api/v1/products/${shirtId}/variants`)
        .set(auth(adminToken))
        .send({
          sku: nextSku('FT'),
          attributes: { Rang: 'Oq', "O'lcham": 'L' },
          sellingPrice: 135_000,
        })
        .expect(201);

      const res = await api().get(`/api/v1/products/${shirtId}/variants`).set(auth(adminToken));

      const options = res.body.options as { name: string; values: string[] }[];
      const colour = options.find((o) => o.name === 'Rang');
      expect(colour?.values).toEqual(expect.arrayContaining(['Qora', 'Oq']));
      expect(options.find((o) => o.name === "O'lcham")?.values).toEqual(
        expect.arrayContaining(['S', 'L']),
      );
    });

    it('reports a price range once a product has several variants', async () => {
      const list = await api().get('/api/v1/products?q=Futbolka Test').set(auth(adminToken));

      const shirt = list.body.data.find((p: { id: string }) => p.id === shirtId);
      expect(shirt.variantCount).toBeGreaterThan(1);
      expect(shirt.priceRange).toMatchObject({ min: 129000, max: 135000 });
    });

    it('enforces SKU uniqueness across variants of different products', async () => {
      const sku = nextSku('SHARED');
      await api()
        .post(`/api/v1/products/${shirtId}/variants`)
        .set(auth(adminToken))
        .send({ sku, sellingPrice: 1_000 })
        .expect(201);

      const other = await createProduct();
      const res = await api()
        .post(`/api/v1/products/${other.body.id}/variants`)
        .set(auth(adminToken))
        .send({ sku, sellingPrice: 1_000 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SKU_ALREADY_USED');
    });

    it('refuses to archive the last remaining variant', async () => {
      const simple = await createProduct();
      const variantId = simple.body.variants[0].id as string;

      const res = await api()
        .patch(`/api/v1/products/${simple.body.id}/variants/${variantId}/archive`)
        .set(auth(adminToken));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_VARIANT');
    });

    it('refuses a variant id that belongs to a different product', async () => {
      const a = await createProduct();
      const b = await createProduct();

      const res = await api()
        .patch(`/api/v1/products/${a.body.id}/variants/${b.body.variants[0].id}`)
        .set(auth(adminToken))
        .send({ sellingPrice: 1 });

      expect(res.status).toBe(404);
    });
  });

  // ── Search, filter, sort, paginate ───────────────────────────────────────

  describe('search and listing', () => {
    let categoryId: string;

    beforeAll(async () => {
      const category = await api()
        .post('/api/v1/categories')
        .set(auth(adminToken))
        .send({ name: 'Qidiruv kategoriyasi' });
      categoryId = category.body.id as string;

      await createProduct({
        name: 'Qidiruv choyi',
        brand: 'Safia',
        categoryId,
        sku: 'SEARCH-TEA-1',
        barcode: '4771111111111',
        sellingPrice: 30_000,
      });
      await createProduct({
        name: 'Qidiruv qahvasi',
        brand: 'Jacobs',
        categoryId,
        sku: 'SEARCH-COFFEE-1',
        sellingPrice: 90_000,
      });
    });

    it('finds by name', async () => {
      const res = await api().get('/api/v1/products?q=Qidiruv choyi').set(auth(adminToken));
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Qidiruv choyi');
    });

    it('finds by SKU, case-insensitively', async () => {
      const res = await api().get('/api/v1/products?q=search-tea').set(auth(adminToken));
      expect(res.body.data.some((p: { name: string }) => p.name === 'Qidiruv choyi')).toBe(true);
    });

    it('finds by barcode', async () => {
      const res = await api().get('/api/v1/products?q=4771111111111').set(auth(adminToken));
      expect(res.body.data.some((p: { name: string }) => p.name === 'Qidiruv choyi')).toBe(true);
    });

    it('finds by brand', async () => {
      const res = await api().get('/api/v1/products?q=Jacobs').set(auth(adminToken));
      expect(res.body.data.some((p: { name: string }) => p.name === 'Qidiruv qahvasi')).toBe(true);
    });

    it('filters by category', async () => {
      const res = await api()
        .get(`/api/v1/products?categoryId=${categoryId}`)
        .set(auth(adminToken));
      expect(res.body.data).toHaveLength(2);
    });

    it('filters by price range', async () => {
      const res = await api()
        .get(`/api/v1/products?categoryId=${categoryId}&minPrice=50000`)
        .set(auth(adminToken));
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Qidiruv qahvasi');
    });

    it('sorts by a whitelisted field and rejects anything else', async () => {
      const sorted = await api()
        .get(`/api/v1/products?categoryId=${categoryId}&sort=name:asc`)
        .set(auth(adminToken));
      expect(sorted.body.data.map((p: { name: string }) => p.name)).toEqual([
        'Qidiruv choyi',
        'Qidiruv qahvasi',
      ]);

      // Arbitrary ORDER BY input never reaches the query.
      const rejected = await api().get('/api/v1/products?sort=price:asc').set(auth(adminToken));
      expect(rejected.status).toBe(400);
    });

    it('paginates and caps the page size', async () => {
      const page = await api()
        .get(`/api/v1/products?categoryId=${categoryId}&limit=1&offset=0`)
        .set(auth(adminToken));
      expect(page.body.data).toHaveLength(1);
      expect(page.body.page).toMatchObject({ limit: 1, offset: 0, total: 2, hasMore: true });

      const second = await api()
        .get(`/api/v1/products?categoryId=${categoryId}&limit=1&offset=1`)
        .set(auth(adminToken));
      expect(second.body.page.hasMore).toBe(false);
      expect(second.body.data[0].id).not.toBe(page.body.data[0].id);

      await api().get('/api/v1/products?limit=5000').set(auth(adminToken)).expect(400);
    });

    it('looks a barcode up for POS and refuses an archived product', async () => {
      const barcode = nextBarcode();
      const created = await createProduct({ name: 'Skaner mahsuloti', barcode });

      const found = await api()
        .get(`/api/v1/products/lookup?barcode=${barcode}`)
        .set(auth(adminToken));
      expect(found.status).toBe(200);
      expect(found.body.product.name).toBe('Skaner mahsuloti');
      expect(found.body.sellingPrice).toBe(24000);

      await api()
        .patch(`/api/v1/products/${created.body.id}/archive`)
        .set(auth(adminToken))
        .expect(200);

      const gone = await api()
        .get(`/api/v1/products/lookup?barcode=${barcode}`)
        .set(auth(adminToken));
      expect(gone.status).toBe(404);
    });
  });

  // ── Authorization ────────────────────────────────────────────────────────

  describe('authorization', () => {
    it('lets a cashier read the catalogue but not change it', async () => {
      await api().get('/api/v1/products').set(auth(cashierToken)).expect(200);
      await api().get('/api/v1/categories').set(auth(cashierToken)).expect(200);

      const create = await api()
        .post('/api/v1/products')
        .set(auth(cashierToken))
        .send({ name: 'Kassir mahsuloti', sku: nextSku(), sellingPrice: 1_000 });
      expect(create.status).toBe(403);
      expect(create.body.errors[0].meta.permission).toBe('products.create');
    });

    it('lets a warehouse worker create and update but not archive', async () => {
      const created = await api()
        .post('/api/v1/products')
        .set(auth(warehouseToken))
        .send({ name: 'Ombor mahsuloti', sku: nextSku('WH'), sellingPrice: 5_000 });
      expect(created.status).toBe(201);

      await api()
        .patch(`/api/v1/products/${created.body.id}`)
        .set(auth(warehouseToken))
        .send({ name: 'Ombor mahsuloti 2' })
        .expect(200);

      // products.delete is not in the WAREHOUSE role.
      const archived = await api()
        .patch(`/api/v1/products/${created.body.id}/archive`)
        .set(auth(warehouseToken));
      expect(archived.status).toBe(403);
    });

    it('rejects an unauthenticated request', async () => {
      await api().get('/api/v1/products').expect(401);
      await api().get('/api/v1/categories').expect(401);
    });
  });

  // ── Tenant isolation ─────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('cannot read another organization’s product', async () => {
      const res = await api().get(`/api/v1/products/${foreign.productId}`).set(auth(adminToken));
      expect(res.status).toBe(404);
    });

    it('cannot update another organization’s product', async () => {
      const res = await api()
        .patch(`/api/v1/products/${foreign.productId}`)
        .set(auth(adminToken))
        .send({ name: 'Hacked' });
      expect(res.status).toBe(404);

      const untouched = await db.product.findUniqueOrThrow({
        where: { id: foreign.productId },
        select: { name: true },
      });
      expect(untouched.name).toBe('Begona mahsulot');
    });

    it('cannot archive another organization’s product', async () => {
      const res = await api()
        .patch(`/api/v1/products/${foreign.productId}/archive`)
        .set(auth(adminToken));
      expect(res.status).toBe(404);

      const untouched = await db.product.findUniqueOrThrow({
        where: { id: foreign.productId },
        select: { archivedAt: true },
      });
      expect(untouched.archivedAt).toBeNull();
    });

    it('cannot read or archive another organization’s category', async () => {
      expect(
        (await api().get(`/api/v1/categories/${foreign.categoryId}`).set(auth(adminToken))).status,
      ).toBe(404);
      expect(
        (
          await api()
            .patch(`/api/v1/categories/${foreign.categoryId}/archive`)
            .set(auth(adminToken))
        ).status,
      ).toBe(404);
    });

    it('cannot assign a foreign category by updating a local product', async () => {
      const local = await createProduct();

      const res = await api()
        .patch(`/api/v1/products/${local.body.id}`)
        .set(auth(adminToken))
        .send({ categoryId: foreign.categoryId });

      expect(res.status).toBe(404);
    });

    it('cannot add a variant to another organization’s product', async () => {
      const res = await api()
        .post(`/api/v1/products/${foreign.productId}/variants`)
        .set(auth(adminToken))
        .send({ sku: nextSku('X'), sellingPrice: 1_000 });
      expect(res.status).toBe(404);
    });

    it('never lists another organization’s products or categories', async () => {
      const products = await api().get('/api/v1/products?limit=100').set(auth(adminToken));
      expect(products.body.data.map((p: { id: string }) => p.id)).not.toContain(foreign.productId);

      const categories = await api().get('/api/v1/categories?flat=true').set(auth(adminToken));
      expect(categories.body.data.map((c: { id: string }) => c.id)).not.toContain(
        foreign.categoryId,
      );
    });

    it('does not leak a foreign barcode through the POS lookup', async () => {
      const res = await api()
        .get('/api/v1/products/lookup?barcode=4999999999999')
        .set(auth(adminToken));
      expect(res.status).toBe(404);
    });

    it('allows the same SKU in two different organizations', async () => {
      // Uniqueness is tenant-scoped, not global: two shops may legitimately
      // both use "CH-021".
      const sku = 'SHARED-ACROSS-ORGS';
      await createProduct({ sku }).then((r) => expect(r.status).toBe(201));

      const other = await db.product.create({
        data: { organizationId: orgB.organizationId, name: 'Boshqa tashkilot' },
        select: { id: true },
      });
      await expect(
        db.productVariant.create({
          data: {
            organizationId: orgB.organizationId,
            productId: other.id,
            sku,
            sellingPrice: 1_000n,
            isDefault: true,
          },
        }),
      ).resolves.toBeDefined();
    });
  });

  // ── Database constraints ─────────────────────────────────────────────────

  describe('database constraints', () => {
    it('rejects a cross-organization category assignment below the API', async () => {
      // The composite foreign key is the last line of defence if the service
      // check is ever removed.
      await expect(
        db.product.create({
          data: {
            organizationId: orgA.organizationId,
            categoryId: foreign.categoryId,
            name: 'Qonunbuzar',
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a negative price below the API', async () => {
      const product = await createProduct();
      await expect(
        db.productVariant.update({
          where: { id: product.body.variants[0].id },
          data: { sellingPrice: -1n },
        }),
      ).rejects.toThrow();
    });

    it('rejects a non-numeric barcode below the API', async () => {
      const product = await createProduct();
      await expect(
        db.productVariant.update({
          where: { id: product.body.variants[0].id },
          data: { barcode: 'NOT-DIGITS' },
        }),
      ).rejects.toThrow();
    });

    it('rejects a second default variant on the same product', async () => {
      const product = await createProduct();
      await expect(
        db.productVariant.create({
          data: {
            organizationId: orgA.organizationId,
            productId: product.body.id,
            sku: nextSku('SECOND'),
            sellingPrice: 1_000n,
            isDefault: true,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
