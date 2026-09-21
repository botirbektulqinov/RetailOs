import { randomInt, randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import type { PrismaClient } from '@prisma/client';

import { SYSTEM_ROLES } from '../../src/rbac/system-roles';

/** 2 === Argon2id. Weakened cost on purpose: these hashes are throwaway and
 *  production parameters would make the suite several minutes slower. */
const TEST_ARGON2 = { algorithm: 2, memoryCost: 8_192, timeCost: 1, parallelism: 1 } as const;

export const TEST_PASSWORD = 'TestParol2026';

export interface SeededUser {
  id: string;
  phone: string;
  roleCode: string;
  roleId: string;
}

export interface SeededOrg {
  organizationId: string;
  storeId: string;
  secondStoreId: string;
  warehouseId: string;
  /** A second warehouse in the same store, so a transfer has somewhere to go. */
  secondWarehouseId: string;
  roles: Map<string, string>;
  users: Map<string, SeededUser>;
  /** Unique per call, so two orgs never collide on the global phone index. */
  phonePrefix: string;
}

/**
 * Builds a complete, realistic organization: settings, two stores, a default
 * warehouse, all four system roles, and one user per role.
 *
 * Called TWICE by the isolation suite, deliberately producing two orgs whose
 * data looks identical, so a cross-tenant leak surfaces as a wrong-org row
 * rather than as a not-found that could have any cause.
 */
export async function seedTestOrg(db: PrismaClient, label: string): Promise<SeededOrg> {
  const passwordHash = await hash(TEST_PASSWORD, TEST_ARGON2);
  const slug = `test-${label}-${randomUUID().slice(0, 8)}`;

  // Phones are globally unique across the whole database, so each seeded org
  // takes a random block. A module counter is not enough: a suite that fails
  // before teardown leaves its users behind, and the next run would collide
  // with them on the very first insert.
  const prefix = `+9989${String(randomInt(10, 100))}`;

  const organization = await db.organization.create({
    data: {
      name: `Test ${label}`,
      slug,
      currencyCode: 'UZS',
      maxUsers: 10,
      settings: { create: { timezone: 'Asia/Tashkent' } },
    },
    select: { id: true },
  });

  const roles = new Map<string, string>();
  for (const role of SYSTEM_ROLES) {
    const created = await db.role.create({
      data: {
        organizationId: organization.id,
        code: role.code,
        name: role.name,
        description: role.description,
        permissions: [...role.permissions],
        isSystem: true,
      },
      select: { id: true },
    });
    roles.set(role.code, created.id);
  }

  const store = await db.store.create({
    data: {
      organizationId: organization.id,
      code: `${label.toUpperCase()}-1`,
      name: `${label} Chorsu`,
      address: "Beruniy ko'chasi 12, Toshkent",
      legalName: 'Test Systems MChJ',
      taxId: '300000001',
      workingHours: '09:00-22:00',
    },
    select: { id: true },
  });

  // A second store, so "member of store A but not store B" is testable inside
  // one organization — store isolation is not the same thing as tenancy.
  const secondStore = await db.store.create({
    data: {
      organizationId: organization.id,
      code: `${label.toUpperCase()}-2`,
      name: `${label} Yunusobod`,
    },
    select: { id: true },
  });

  const warehouse = await db.warehouse.create({
    data: {
      organizationId: organization.id,
      storeId: store.id,
      code: `${label.toUpperCase()}-1-MAIN`,
      name: 'Asosiy ombor',
      isDefault: true,
    },
    select: { id: true },
  });

  // Transfers need two warehouses in one organization. Both hang off the
  // first store, so a transfer is testable without also crossing stores —
  // those are separate concerns and a test that mixes them cannot say which
  // rule it proved.
  const secondWarehouse = await db.warehouse.create({
    data: {
      organizationId: organization.id,
      storeId: store.id,
      code: `${label.toUpperCase()}-1-BACK`,
      name: 'Zaxira ombor',
      isDefault: false,
    },
    select: { id: true },
  });

  const users = new Map<string, SeededUser>();
  let index = 0;
  for (const role of SYSTEM_ROLES) {
    const phone = `${prefix}${String(1_000_000 + index++).slice(-6)}`;
    const roleId = roles.get(role.code)!;

    const user = await db.user.create({
      data: {
        organizationId: organization.id,
        phone,
        fullName: `${role.name} ${label}`,
        passwordHash,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    await db.storeMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        storeId: store.id,
        roleId,
        isPrimary: true,
      },
    });

    users.set(role.code, { id: user.id, phone, roleCode: role.code, roleId });
  }

  return {
    organizationId: organization.id,
    storeId: store.id,
    secondStoreId: secondStore.id,
    warehouseId: warehouse.id,
    secondWarehouseId: secondWarehouse.id,
    roles,
    users,
    phonePrefix: prefix,
  };
}

/**
 * Removes every organization a previous run left behind.
 *
 * Fixtures are torn down in afterAll, but a suite that throws in beforeAll
 * never gets there — and the leftovers then collide with the next run's
 * phones. Cleaning up front makes the suite re-runnable after a crash.
 */
export async function dropStaleTestOrgs(db: PrismaClient): Promise<void> {
  const stale = await db.organization.findMany({
    where: { slug: { startsWith: 'test-' } },
    select: { id: true },
  });
  for (const org of stale) await dropTestOrg(db, org.id);
}

/** Removes a seeded organization. Order respects the foreign keys. */
export async function dropTestOrg(db: PrismaClient, organizationId: string): Promise<void> {
  await db.refreshToken.deleteMany({ where: { organizationId } });

  // audit_log is append-only for the application, and users are referenced by
  // it with ON DELETE RESTRICT. Test fixtures are the one place that genuinely
  // needs to remove history, so the trigger is dropped for this statement and
  // restored immediately — a scalpel, and only ever in a test database.
  await db.$executeRaw`ALTER TABLE audit_log DISABLE TRIGGER tg_audit_log_immutable`;
  try {
    await db.$executeRaw`DELETE FROM audit_log WHERE organization_id = ${organizationId}::uuid`;
  } finally {
    await db.$executeRaw`ALTER TABLE audit_log ENABLE TRIGGER tg_audit_log_immutable`;
  }

  // Inventory before catalog: levels and movements reference variants and
  // warehouses with ON DELETE RESTRICT. inventory_movement is append-only for
  // the application, so its trigger comes off for exactly one statement — a
  // scalpel, and only ever in a test database.
  await db.stockTransferItem.deleteMany({ where: { organizationId } });
  await db.stockTransfer.deleteMany({ where: { organizationId } });
  await db.inventoryCountItem.deleteMany({ where: { organizationId } });
  await db.inventoryCount.deleteMany({ where: { organizationId } });
  await db.inventoryLevel.deleteMany({ where: { organizationId } });

  await db.$executeRaw`ALTER TABLE inventory_movement DISABLE TRIGGER tg_inventory_movement_immutable`;
  try {
    await db.$executeRaw`DELETE FROM inventory_movement WHERE organization_id = ${organizationId}::uuid`;
  } finally {
    await db.$executeRaw`ALTER TABLE inventory_movement ENABLE TRIGGER tg_inventory_movement_immutable`;
  }

  await db.documentCounter.deleteMany({ where: { organizationId } });

  // Catalog before identity: variants reference products, products reference
  // categories, and every one of those foreign keys is ON DELETE RESTRICT.
  await db.productVariant.deleteMany({ where: { organizationId } });
  await db.product.deleteMany({ where: { organizationId } });
  // Children first, or a parent delete trips fk_category_parent_same_org.
  for (let depth = 3; depth >= 1; depth -= 1) {
    await db.category.deleteMany({ where: { organizationId, depth } });
  }

  await db.storeMembership.deleteMany({ where: { organizationId } });
  await db.user.deleteMany({ where: { organizationId } });
  await db.role.deleteMany({ where: { organizationId } });
  await db.warehouse.deleteMany({ where: { organizationId } });
  await db.store.deleteMany({ where: { organizationId } });
  await db.organizationSettings.deleteMany({ where: { organizationId } });
  await db.organization.deleteMany({ where: { id: organizationId } });
}
