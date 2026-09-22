/**
 * The permission catalogue — docs/ARCHITECTURE.md §20.1.
 *
 * Permissions are a typed constant, not a database table. A permission no
 * guard references is meaningless, and a guard naming a permission that does
 * not exist should be a compile error rather than a check that is silently
 * false forever. A table would add two joins per request and no capability.
 *
 * Roles hold permission strings in `role.permissions TEXT[]`. Matching
 * supports a trailing wildcard, so `sales.*` grants every sales permission and
 * `*` grants everything.
 *
 * Labels are Uzbek because the permissions screen renders them directly
 * ("Savdo yaratish", "Xodimlarni boshqarish"). Adding a permission here makes
 * it appear in the API catalogue and in that screen automatically.
 */

/** Groups match the product's module boundaries, and the screen's sections. */
export const PERMISSION_GROUPS = {
  sales: 'Savdo',
  products: 'Mahsulotlar',
  inventory: 'Inventar',
  customers: 'Mijozlar',
  debt: 'Qarzlar',
  purchases: 'Xaridlar',
  suppliers: "Ta'minotchilar",
  cash: 'Kassa',
  loyalty: 'Sodiqlik',
  promotions: 'Aksiyalar',
  reports: 'Hisobotlar',
  employees: 'Xodimlar',
  roles: 'Rollar',
  stores: "Do'konlar",
  settings: 'Sozlamalar',
  audit: 'Audit',
} as const;

export type PermissionGroup = keyof typeof PERMISSION_GROUPS;

interface PermissionDef {
  /** Uzbek label shown on the permissions screen. */
  readonly label: string;
  /** Only `true` for permissions that move money, stock or authority. */
  readonly sensitive?: boolean;
}

/**
 * Declared per group. Sprint 2 implements the identity permissions; the rest
 * are declared now because roles must be seeded with a complete permission set
 * — a cashier role that gains `sales.create` only in Sprint 6 would mean
 * re-seeding every organization then.
 */
export const PERMISSION_CATALOGUE = {
  sales: {
    read: { label: "Savdolarni ko'rish" },
    create: { label: 'Savdo yaratish' },
    hold: { label: 'Savdoni vaqtincha saqlash' },
    cancel: { label: 'Savdoni bekor qilish', sensitive: true },
    refund: { label: 'Qaytarish yaratish', sensitive: true },
    refund_expired: { label: 'Muddati o‘tgan qaytarish', sensitive: true },
    discount_item: { label: 'Mahsulotga chegirma' },
    discount_order: { label: 'Chekka chegirma', sensitive: true },
    override_price: { label: "Narxni o'zgartirish", sensitive: true },
    resend_receipt: { label: 'Chekni qayta yuborish' },
  },
  products: {
    read: { label: "Mahsulotlarni ko'rish" },
    create: { label: "Mahsulot qo'shish" },
    update: { label: 'Mahsulotni tahrirlash' },
    delete: { label: "Mahsulotni o'chirish", sensitive: true },
    import: { label: 'Ommaviy import' },
  },
  inventory: {
    read: { label: "Qoldiqlarni ko'rish" },
    adjust: { label: 'Qoldiqni tuzatish', sensitive: true },
    count: { label: 'Inventarizatsiya' },
    transfer: { label: 'Transfer qilish' },
  },
  customers: {
    read: { label: "Mijozlarni ko'rish" },
    create: { label: "Mijoz qo'shish" },
    update: { label: 'Mijozni tahrirlash' },
    delete: { label: "Mijozni o'chirish", sensitive: true },
  },
  debt: {
    read: { label: "Qarzlarni ko'rish" },
    create: { label: 'Qarzga savdo' },
    pay: { label: "Qarz to'lovini qabul qilish" },
    write_off: { label: 'Qarzni hisobdan chiqarish', sensitive: true },
  },
  purchases: {
    read: { label: "Xaridlarni ko'rish" },
    create: { label: 'Buyurtma yaratish' },
    receive: { label: 'Tovarni qabul qilish' },
    pay: { label: "Ta'minotchiga to'lov", sensitive: true },
    cancel: { label: 'Buyurtmani bekor qilish', sensitive: true },
  },
  suppliers: {
    read: { label: "Ta'minotchilarni ko'rish" },
    create: { label: "Ta'minotchi qo'shish" },
    update: { label: "Ta'minotchini tahrirlash" },
  },
  cash: {
    read: { label: "Kassani ko'rish" },
    open_shift: { label: 'Smena ochish' },
    close_shift: { label: 'Smenani yopish' },
    movement: { label: 'Kassa harakati', sensitive: true },
  },
  loyalty: {
    read: { label: "Sodiqlikni ko'rish" },
    adjust: { label: 'Ballarni tuzatish', sensitive: true },
  },
  promotions: {
    read: { label: "Aksiyalarni ko'rish" },
    manage: { label: 'Aksiyalarni boshqarish' },
  },
  reports: {
    read: { label: 'Kunlik hisobot' },
    export: { label: 'Hisobotni eksport qilish' },
  },
  employees: {
    read: { label: "Xodimlarni ko'rish" },
    manage: { label: 'Xodimlarni boshqarish', sensitive: true },
  },
  roles: {
    read: { label: "Rollarni ko'rish" },
    manage: { label: 'Rollar va ruxsatlar', sensitive: true },
  },
  stores: {
    read: { label: "Do'kon ma'lumotlari" },
    manage: { label: "Do'konni boshqarish", sensitive: true },
  },
  settings: {
    read: { label: "Sozlamalarni ko'rish" },
    manage: { label: 'Sozlamalarni boshqarish', sensitive: true },
  },
  audit: {
    read: { label: 'Audit tarixi', sensitive: true },
  },
} as const satisfies Record<PermissionGroup, Record<string, PermissionDef>>;

/**
 * The union of every valid permission string, derived from the catalogue.
 * `@RequirePermissions('sales.refnud')` is a compile error.
 */
export type Permission = {
  [
    G in keyof typeof PERMISSION_CATALOGUE
  ]: `${G & string}.${keyof (typeof PERMISSION_CATALOGUE)[G] & string}`;
}[keyof typeof PERMISSION_CATALOGUE];

/** Grants everything. Held only by the ADMIN system role. */
export const WILDCARD = '*';

export interface PermissionInfo {
  key: string;
  group: PermissionGroup;
  groupLabel: string;
  label: string;
  sensitive: boolean;
}

function buildCatalogue(): PermissionInfo[] {
  const out: PermissionInfo[] = [];
  for (const [group, actions] of Object.entries(PERMISSION_CATALOGUE)) {
    for (const [action, def] of Object.entries(actions as Record<string, PermissionDef>)) {
      out.push({
        key: `${group}.${action}`,
        group: group as PermissionGroup,
        groupLabel: PERMISSION_GROUPS[group as PermissionGroup],
        label: def.label,
        sensitive: def.sensitive ?? false,
      });
    }
  }
  return out;
}

/** Flat, ordered list. Built once at module load. */
export const ALL_PERMISSIONS: readonly PermissionInfo[] = Object.freeze(buildCatalogue());

const PERMISSION_KEYS: ReadonlySet<string> = new Set(ALL_PERMISSIONS.map((p) => p.key));

export function isKnownPermission(value: string): boolean {
  return PERMISSION_KEYS.has(value);
}

/**
 * Does `granted` satisfy `required`?
 *
 * Supports `*` (everything) and `group.*` (every action in that group). Kept
 * deliberately tiny — this runs on every authorized request.
 */
export function hasPermission(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(WILDCARD) || granted.has(required)) return true;
  const dot = required.indexOf('.');
  return dot > 0 && granted.has(`${required.slice(0, dot)}.${WILDCARD}`);
}

/**
 * Does this caller hold every permission in the system?
 *
 * The question store scoping actually asks: an owner is organization-wide and
 * implicitly a member of every store, everybody else is not.
 *
 * It cannot be `granted.has('*')`, because by the time a permission set
 * reaches a service it has been through expandPermissions() — which replaces
 * the wildcard with the concrete keys and so never contains `*`. The set is
 * built only from ALL_PERMISSIONS, so holding all of them is the same
 * statement, and it stays true for a custom role that was granted everything
 * rather than the literal star.
 */
export function isOrgWide(granted: ReadonlySet<string>): boolean {
  return granted.has(WILDCARD) || granted.size === ALL_PERMISSIONS.length;
}

/**
 * Expands wildcards into concrete permission keys, for the /auth/me response.
 * A client cannot render a permission-driven UI from the literal string `*`.
 */
export function expandPermissions(granted: readonly string[]): string[] {
  if (granted.includes(WILDCARD)) return ALL_PERMISSIONS.map((p) => p.key);

  const out = new Set<string>();
  for (const entry of granted) {
    if (entry.endsWith(`.${WILDCARD}`)) {
      const prefix = entry.slice(0, -1);
      for (const p of ALL_PERMISSIONS) if (p.key.startsWith(prefix)) out.add(p.key);
    } else if (PERMISSION_KEYS.has(entry)) {
      out.add(entry);
    }
  }
  return [...out].sort();
}
