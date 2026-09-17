// Loaded explicitly: `npm run seed` invokes tsx directly and, unlike the Nest
// bootstrap, nothing else reads .env for it.
import 'dotenv/config';

import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { SYSTEM_ROLES } from '../src/rbac/system-roles';

/**
 * Seed entry point.
 *
 * Two rules, both load-bearing:
 *
 *  1. **Idempotent.** Every step upserts. Seeds get run against a database that
 *     already has data far more often than anyone plans for, and a second run
 *     must not duplicate a role or reset somebody's password.
 *  2. **Never destructive.** Nothing here truncates, drops or resets. Wiping a
 *     database is `prisma migrate reset`, an explicit and separate command.
 *
 * Demo data is clearly fictional and the credentials below are DEVELOPMENT
 * ONLY — the demo step refuses to run when NODE_ENV=production.
 */

/** 2 === Argon2id. The enum is ambient-const and cannot be imported here. */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Uzbekistan defaults, per the architecture and the design. */
const DEFAULT_TIMEZONE = 'Asia/Tashkent';
const DEFAULT_CURRENCY = 'UZS';

/**
 * DEVELOPMENT CREDENTIALS — fictional people, throwaway password, and a slug
 * that makes it obvious this is demo data. Names match the design's screens.
 */
const DEMO = {
  organization: { name: "Navro'z Market", slug: 'navroz-market-demo', maxUsers: 10 },
  store: {
    code: 'FILIAL-017',
    name: 'RetailOS Chorsu',
    address: "Beruniy ko'chasi 12, Toshkent",
    phone: '+998712002020',
    legalName: 'Retail Systems MChJ',
    taxId: '309456789',
    workingHours: '09:00-22:00 · har kuni',
  },
  password: 'RetailOS2026',
  users: [
    {
      fullName: 'Dilshod Karimov',
      phone: '+998901234567',
      email: 'dilshod@retail.uz',
      role: 'ADMIN',
    },
    { fullName: 'Sevara Tursunova', phone: '+998901234568', email: null, role: 'MANAGER' },
    { fullName: 'Madina Aliyeva', phone: '+998901234569', email: null, role: 'CASHIER' },
    { fullName: 'Aziz Rasulov', phone: '+998901234570', email: null, role: 'WAREHOUSE' },
  ],
} as const;

/**
 * A small demo catalogue, using the names the design's screens show.
 * Two-level categories and one variant product, so the variants screen has
 * something real to render.
 */
const DEMO_CATALOG = {
  categories: [
    { key: 'drinks', name: 'Ichimliklar', parent: null },
    { key: 'hot', name: 'Issiq', parent: 'drinks' },
    { key: 'tea', name: 'Choy va qahva', parent: 'hot' },
    { key: 'food', name: 'Oziq-ovqat', parent: null },
    { key: 'dairy', name: 'Sut mahsulotlari', parent: 'food' },
    { key: 'fashion', name: 'Moda', parent: null },
    { key: 'adults', name: 'Kattalar', parent: 'fashion' },
    { key: 'clothes', name: 'Kiyim', parent: 'adults' },
  ],
  products: [
    {
      name: 'Safia qora choy 100g',
      category: 'tea',
      sku: 'CH-021',
      barcode: '4780012345678',
      sellingPrice: 24_000n,
      purchasePrice: 17_500n,
      minStock: '5.000',
    },
    {
      name: 'Artel choynak 1.7L',
      category: 'hot',
      sku: 'AR-170',
      barcode: '4780012345685',
      sellingPrice: 289_000n,
      purchasePrice: 230_000n,
      minStock: '2.000',
    },
    {
      name: 'Nestle sut 1L',
      category: 'dairy',
      sku: 'SU-001',
      barcode: '4780012345692',
      sellingPrice: 18_000n,
      purchasePrice: 14_000n,
      minStock: '10.000',
    },
  ],
  /** The design's "Futbolka Classic - 8 variant". */
  variantProduct: {
    name: 'Futbolka Classic',
    category: 'clothes',
    baseSku: 'FT',
    colors: [
      { code: 'Q', name: 'Qora' },
      { code: 'O', name: 'Oq' },
    ],
    sizes: ['S', 'M', 'L', 'XL'],
  },
} as const;

type Db = Pick<
  PrismaClient,
  'role' | 'organization' | 'store' | 'warehouse' | 'user' | 'storeMembership'
>;

/**
 * Seeds the four system roles for an organization.
 *
 * Production-safe and re-runnable: a permission added to the catalogue reaches
 * existing organizations on the next deploy's seed run.
 */
async function seedSystemRoles(db: Db, organizationId: string): Promise<void> {
  for (const role of SYSTEM_ROLES) {
    const existing = await db.role.findUnique({
      where: { organizationId_code: { organizationId, code: role.code } },
      select: { id: true, permissions: true },
    });

    const permissions = [...role.permissions].sort();

    if (!existing) {
      await db.role.create({
        data: {
          organizationId,
          code: role.code,
          name: role.name,
          description: role.description,
          permissions,
          isSystem: true,
        },
      });
      continue;
    }

    // Rewrite only the roles an organization is NOT allowed to customise.
    // Overwriting an edited CASHIER role on every deploy would silently undo
    // an owner's work, so editable roles are left alone once they exist.
    const changed =
      existing.permissions.length !== permissions.length ||
      existing.permissions.some((p, i) => p !== permissions[i]);

    if (changed && !role.editable) {
      await db.role.update({
        where: { id: existing.id },
        data: { permissions, permissionVersion: { increment: 1 } },
      });
    }
  }
}

async function verifySchema(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRaw<{ applied: bigint }[]>`
    SELECT count(*)::bigint AS applied
      FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `;
  const applied = rows[0]?.applied ?? 0n;

  const extensions = await client.$queryRaw<{ extname: string }[]>`
    SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm', 'pgcrypto')
    ORDER BY extname
  `;

  return `${applied} migration(s) applied; extensions: ${extensions.map((e) => e.extname).join(', ')}`;
}

async function seedDemo(client: PrismaClient): Promise<string> {
  const passwordHash = await hash(DEMO.password, ARGON2_OPTIONS);

  // One transaction: an organization without roles, a store or an owner is not
  // a usable state to leave behind if a later step fails.
  return client.$transaction(async (tx) => {
    const organization = await tx.organization.upsert({
      where: { slug: DEMO.organization.slug },
      update: {},
      create: {
        name: DEMO.organization.name,
        slug: DEMO.organization.slug,
        currencyCode: DEFAULT_CURRENCY,
        maxUsers: DEMO.organization.maxUsers,
        settings: { create: { timezone: DEFAULT_TIMEZONE, locale: 'uz-UZ' } },
      },
      select: { id: true },
    });

    await seedSystemRoles(tx, organization.id);

    const roles = await tx.role.findMany({
      where: { organizationId: organization.id },
      select: { id: true, code: true },
    });
    const roleByCode = new Map(roles.map((r) => [r.code, r.id]));

    const existingStore = await tx.store.findFirst({
      where: { organizationId: organization.id, code: DEMO.store.code },
      select: { id: true },
    });

    const store =
      existingStore ??
      (await tx.store.create({
        data: {
          organizationId: organization.id,
          code: DEMO.store.code,
          name: DEMO.store.name,
          address: DEMO.store.address,
          phone: DEMO.store.phone,
          legalName: DEMO.store.legalName,
          taxId: DEMO.store.taxId,
          workingHours: DEMO.store.workingHours,
          timezone: DEFAULT_TIMEZONE,
        },
        select: { id: true },
      }));

    // Every store gets a default warehouse. Stock is always warehouse-scoped,
    // so creating it here avoids a data migration when inventory lands.
    const warehouse = await tx.warehouse.findFirst({
      where: { organizationId: organization.id, storeId: store.id, isDefault: true },
      select: { id: true },
    });
    if (!warehouse) {
      await tx.warehouse.create({
        data: {
          organizationId: organization.id,
          storeId: store.id,
          code: `${DEMO.store.code}-MAIN`,
          name: 'Asosiy ombor',
          isDefault: true,
        },
      });
    }

    let created = 0;
    for (const person of DEMO.users) {
      const existing = await tx.user.findUnique({
        where: { phone: person.phone },
        select: { id: true },
      });
      if (existing) continue;

      const roleId = roleByCode.get(person.role);
      if (!roleId) throw new Error(`Missing seeded role ${person.role}`);

      const user = await tx.user.create({
        data: {
          organizationId: organization.id,
          phone: person.phone,
          email: person.email,
          fullName: person.fullName,
          passwordHash,
          status: 'ACTIVE',
        },
        select: { id: true },
      });

      await tx.storeMembership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          storeId: store.id,
          roleId,
          isPrimary: true,
        },
      });
      created += 1;
    }

    return `organization "${DEMO.organization.name}", ${SYSTEM_ROLES.length} roles, 1 store, ${created} new user(s)`;
  });
}

async function seedCatalog(client: PrismaClient): Promise<string> {
  const organization = await client.organization.findUnique({
    where: { slug: DEMO.organization.slug },
    select: { id: true },
  });
  if (!organization) return 'skipped (no demo organization)';

  const organizationId = organization.id;

  return client.$transaction(async (tx) => {
    // Categories, parents first, so a child always finds its parent's path.
    const idByKey = new Map<string, { id: string; name: string; path: string; depth: number }>();

    for (const category of DEMO_CATALOG.categories) {
      const parent = category.parent ? idByKey.get(category.parent) : undefined;
      const path = parent ? (parent.path ? `${parent.path} / ${parent.name}` : parent.name) : '';
      const depth = parent ? parent.depth + 1 : 1;

      const existing = await tx.category.findFirst({
        where: { organizationId, name: category.name, parentId: parent?.id ?? null },
        select: { id: true, name: true, path: true, depth: true },
      });

      const row =
        existing ??
        (await tx.category.create({
          data: {
            organizationId,
            parentId: parent?.id ?? null,
            name: category.name,
            path,
            depth,
          },
          select: { id: true, name: true, path: true, depth: true },
        }));

      idByKey.set(category.key, row);
    }

    let productsCreated = 0;
    let variantsCreated = 0;

    for (const product of DEMO_CATALOG.products) {
      const existing = await tx.productVariant.findFirst({
        where: { organizationId, sku: product.sku },
        select: { id: true },
      });
      if (existing) continue;

      const created = await tx.product.create({
        data: {
          organizationId,
          categoryId: idByKey.get(product.category)?.id ?? null,
          name: product.name,
        },
        select: { id: true },
      });

      await tx.productVariant.create({
        data: {
          organizationId,
          productId: created.id,
          sku: product.sku,
          barcode: product.barcode,
          sellingPrice: product.sellingPrice,
          purchasePrice: product.purchasePrice,
          minStock: product.minStock,
          isDefault: true,
        },
      });
      productsCreated += 1;
    }

    // The variant product: two colours x four sizes, priced like the screen.
    const spec = DEMO_CATALOG.variantProduct;
    const firstSku = `${spec.baseSku}-${spec.colors[0].code}-${spec.sizes[0]}`;
    const alreadySeeded = await tx.productVariant.findFirst({
      where: { organizationId, sku: firstSku },
      select: { id: true },
    });

    if (!alreadySeeded) {
      const shirt = await tx.product.create({
        data: {
          organizationId,
          categoryId: idByKey.get(spec.category)?.id ?? null,
          name: spec.name,
          hasVariants: true,
        },
        select: { id: true },
      });

      let first = true;
      for (const color of spec.colors) {
        for (const size of spec.sizes) {
          await tx.productVariant.create({
            data: {
              organizationId,
              productId: shirt.id,
              sku: `${spec.baseSku}-${color.code}-${size}`,
              name: `${color.name} / ${size}`,
              attributes: { Rang: color.name, "O'lcham": size },
              // White costs more, exactly as the variants screen shows.
              sellingPrice: color.code === 'O' ? 135_000n : 129_000n,
              purchasePrice: 90_000n,
              minStock: '2.000',
              isDefault: first,
            },
          });
          first = false;
          variantsCreated += 1;
        }
      }
      productsCreated += 1;
    }

    return `${DEMO_CATALOG.categories.length} categories, ${productsCreated} new product(s), ${variantsCreated} new variant(s)`;
  });
}

interface SeedStep {
  name: string;
  /** true when the step may run against a production database. */
  productionSafe: boolean;
  run: (client: PrismaClient) => Promise<string>;
}

const steps: SeedStep[] = [
  { name: 'verify-schema', productionSafe: true, run: verifySchema },
  { name: 'demo-data', productionSafe: false, run: seedDemo },
  { name: 'demo-catalog', productionSafe: false, run: seedCatalog },
];

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const isProduction = process.env['NODE_ENV'] === 'production';
  const pool = new Pool({ connectionString, max: 2 });
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    for (const step of steps) {
      if (isProduction && !step.productionSafe) {
        console.info(`  - ${step.name}: skipped (not production-safe)`);
        continue;
      }
      console.info(`  - ${step.name}: ${await step.run(client)}`);
    }

    if (!isProduction) {
      console.info('');
      console.info('  DEVELOPMENT-ONLY demo accounts (never use these anywhere real):');
      for (const user of DEMO.users) {
        console.info(
          `    ${user.phone}  ${DEMO.password}  ${user.role.padEnd(9)} ${user.fullName}`,
        );
      }
    }
    console.info('Seed complete.');
  } finally {
    await client.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
