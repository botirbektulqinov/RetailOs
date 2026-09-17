import { WILDCARD } from './permissions';
import type { Permission } from './permissions';

/**
 * The four system roles, taken verbatim from the roles screen
 * ("STANDART ROLLAR"): Administrator, Menejer, Kassir, Omborchi.
 *
 * The architecture document listed five, including a separate SALES role. The
 * design does not have one — a salesperson in a small shop is a cashier — so
 * it is dropped. Organizations that need the distinction create a custom role,
 * which the roles screen already offers ("Yangi rol yaratish").
 *
 * These are seeded per organization and are editable except ADMIN, so an owner
 * can tighten a cashier's permissions without a migration.
 */

export const SYSTEM_ROLE = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CASHIER: 'CASHIER',
  WAREHOUSE: 'WAREHOUSE',
} as const;

export type SystemRoleCode = (typeof SYSTEM_ROLE)[keyof typeof SYSTEM_ROLE];

export interface SystemRoleDef {
  code: SystemRoleCode;
  /** Uzbek display name, as rendered on the roles screen. */
  name: string;
  /** The one-line summary under the name ("Barcha bo'limlar"). */
  description: string;
  permissions: readonly (Permission | typeof WILDCARD)[];
  /** ADMIN's permission set is fixed; the others can be edited by an owner. */
  editable: boolean;
}

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    code: SYSTEM_ROLE.ADMIN,
    name: 'Administrator',
    description: "Barcha bo'limlar",
    permissions: [WILDCARD],
    // Not editable: an organization that can strip permissions from its only
    // administrator can lock itself out, and support cannot fix it from inside
    // the product.
    editable: false,
  },
  {
    code: SYSTEM_ROLE.MANAGER,
    name: 'Menejer',
    description: 'Hisobot va boshqaruv',
    permissions: [
      'sales.read',
      'sales.create',
      'sales.hold',
      'sales.cancel',
      'sales.refund',
      'sales.discount_item',
      'sales.discount_order',
      'sales.override_price',
      'sales.resend_receipt',
      'products.read',
      'products.create',
      'products.update',
      'products.import',
      'inventory.read',
      'inventory.adjust',
      'inventory.count',
      'inventory.transfer',
      'customers.read',
      'customers.create',
      'customers.update',
      'debt.read',
      'debt.create',
      'debt.pay',
      'debt.write_off',
      'purchases.read',
      'purchases.create',
      'purchases.receive',
      'purchases.pay',
      'suppliers.read',
      'suppliers.create',
      'suppliers.update',
      'cash.read',
      'cash.open_shift',
      'cash.close_shift',
      'cash.movement',
      'loyalty.read',
      'loyalty.adjust',
      'promotions.read',
      'promotions.manage',
      'reports.read',
      'reports.export',
      'employees.read',
      'roles.read',
      'stores.read',
      'settings.read',
      // Deliberately absent: employees.manage, roles.manage, stores.manage,
      // settings.manage, audit.read. A manager runs the shop; changing who may
      // do what, and reading the audit trail that records it, stays with the
      // administrator.
    ],
    editable: true,
  },
  {
    code: SYSTEM_ROLE.CASHIER,
    name: 'Kassir',
    description: 'Savdo va cheklar',
    // Matches the permissions screen exactly, which shows a cashier with
    // "Savdo yaratish" and "Chekni qayta yuborish" and "Kunlik hisobot" ON,
    // and "Qaytarish yaratish", "Narxni o'zgartirish" and "Xodimlarni
    // boshqarish" OFF.
    permissions: [
      'sales.read',
      'sales.create',
      'sales.hold',
      'sales.discount_item',
      'sales.resend_receipt',
      'products.read',
      'inventory.read',
      'customers.read',
      'customers.create',
      'debt.read',
      'debt.create',
      'debt.pay',
      'cash.read',
      'cash.open_shift',
      'cash.close_shift',
      'loyalty.read',
      'reports.read',
    ],
    editable: true,
  },
  {
    code: SYSTEM_ROLE.WAREHOUSE,
    name: 'Omborchi',
    description: 'Mahsulot va ombor',
    permissions: [
      'products.read',
      'products.create',
      'products.update',
      'products.import',
      'inventory.read',
      'inventory.adjust',
      'inventory.count',
      'inventory.transfer',
      'purchases.read',
      'purchases.receive',
      'suppliers.read',
    ],
    editable: true,
  },
];

export const SYSTEM_ROLE_CODES: ReadonlySet<string> = new Set(SYSTEM_ROLES.map((r) => r.code));

export function isSystemRoleCode(code: string): code is SystemRoleCode {
  return SYSTEM_ROLE_CODES.has(code);
}

/** ADMIN is the only role whose permissions may never be edited. */
export function isImmutableRole(code: string): boolean {
  return code === SYSTEM_ROLE.ADMIN;
}
