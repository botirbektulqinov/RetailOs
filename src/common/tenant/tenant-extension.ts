import { Prisma } from '@prisma/client';

import { currentOrganizationId } from './tenant-context';

/**
 * Tenant isolation, enforced below the service layer — docs/ARCHITECTURE.md §4.3.
 *
 * This is the layer that makes a cross-tenant leak require deliberate effort
 * rather than a single forgotten `where` clause. It does three things:
 *
 *   1. injects `organizationId` into `where` on every read and bulk write;
 *   2. injects `organizationId` into `data` on every create;
 *   3. REFUSES a single-row operation targeted by bare `id`, because such a
 *      query cannot be scoped and would silently reach across tenants.
 *
 * It is defence in depth, not the only defence: services still scope by store,
 * and the database enforces cross-organization integrity with composite
 * foreign keys. Any one of the three failing should not produce a leak.
 */

/** Models carrying `organization_id`. `Organization` itself is the root. */
const TENANT_MODELS = new Set<string>([
  'OrganizationSettings',
  'Store',
  'Warehouse',
  'User',
  'StoreMembership',
  'Role',
  'RefreshToken',
  'AuditLog',
  'Category',
  'Product',
  'ProductVariant',
  'InventoryLevel',
  'InventoryMovement',
  'InventoryCount',
  'InventoryCountItem',
  'StockTransfer',
  'StockTransferItem',
  'DocumentCounter',
  'Customer',
  'Sale',
  'SaleItem',
  'Payment',
  'PaymentAllocation',
  'CustomerReceivable',
  'IdempotencyRecord',
  'CustomerGroup',
  'CustomerNote',
  'Supplier',
  'Purchase',
  'PurchaseItem',
  'SupplierPayment',
  'SaleReturn',
  'ReturnItem',
  'Exchange',
  'Promotion',
  'LoyaltyAccount',
  'LoyaltyTransaction',
  'CashRegister',
  'CashRegisterShift',
  'CashMovement',
]);

/** Operations whose `where` must be narrowed to the tenant. */
const READ_OPS = new Set<string>([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/** Operations that must have the tenant written into `data`. */
const CREATE_OPS = new Set<string>(['create', 'createMany', 'createManyAndReturn']);

/**
 * Single-row operations. Prisma requires a unique selector here, and a bare
 * `{ id }` is unique globally rather than within a tenant — exactly the shape
 * that leaks. Every tenant model declares `@@unique([organizationId, id])` so
 * these can be written as `{ organizationId_id: { organizationId, id } }`.
 */
const UNIQUE_OPS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

export class TenantIsolationError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refusing ${model}.${operation}() targeted by bare id inside a tenant request. ` +
        `Use { organizationId_id: { organizationId, id } }, or prisma.asSystem() ` +
        `when the operation is deliberately cross-tenant.`,
    );
    this.name = 'TenantIsolationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `where` already pins the tenant — directly, or through any
 * compound unique that includes `organizationId`.
 *
 * Deliberately generic rather than looking for `organizationId_id` by name:
 * models also carry compounds like `organizationId_key` and
 * `organizationId_storeId_saleNumber`, and a check that only knew one of them
 * would refuse a correctly-scoped query. What matters is that the selector
 * names this organization, not which selector it is.
 */
function isTenantScoped(where: unknown, organizationId: string): boolean {
  if (!isPlainObject(where)) return false;
  if (where['organizationId'] === organizationId) return true;

  for (const value of Object.values(where)) {
    if (isPlainObject(value) && value['organizationId'] === organizationId) return true;
  }
  return false;
}

interface OperationParams {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

function applyTenantScope({ model, operation, args, query }: OperationParams): Promise<unknown> {
  const organizationId = currentOrganizationId();

  // No request context: startup, seeds, migrations, cron. Those run as the
  // system and are trusted; they are explicitly not user-driven.
  if (!organizationId || !TENANT_MODELS.has(model)) {
    return query(args);
  }

  const input: Record<string, unknown> = isPlainObject(args) ? args : {};

  if (UNIQUE_OPS.has(operation)) {
    if (!isTenantScoped(input['where'], organizationId)) {
      throw new TenantIsolationError(model, operation);
    }
    return query(args);
  }

  if (READ_OPS.has(operation)) {
    const where = isPlainObject(input['where']) ? input['where'] : {};
    // Overwrite rather than merge: a caller-supplied organizationId is exactly
    // the value an attacker would try to control.
    return query({ ...input, where: { ...where, organizationId } });
  }

  if (CREATE_OPS.has(operation)) {
    const data = input['data'];
    if (Array.isArray(data)) {
      const rows: unknown[] = data;
      return query({
        ...input,
        data: rows.map((row) => (isPlainObject(row) ? { ...row, organizationId } : row)),
      });
    }
    if (isPlainObject(data)) {
      return query({ ...input, data: { ...data, organizationId } });
    }
  }

  return query(args);
}

export function createTenantExtension() {
  return Prisma.defineExtension({
    name: 'retailos-tenant-isolation',
    query: {
      $allModels: {
        // Prisma types $allOperations as the intersection of every operation's
        // signature, which collapses its args and return type to `never`, so a
        // generic handler cannot be written against it directly. The real
        // contract is OperationParams above.
        $allOperations: applyTenantScope,
      },
    },
  });
}
