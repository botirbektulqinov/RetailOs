import type { InventoryMovementType } from '@prisma/client';

/**
 * The two statements that move stock — docs/ARCHITECTURE.md §9.2 and §9.3.
 *
 * Extracted from InventoryService so there is exactly one copy of this SQL in
 * the repository. The seed writes opening balances and has no Nest container
 * to resolve a service from; without this it would grow a second, slowly
 * diverging implementation, and §9.7's reconciliation query exists precisely
 * to catch a level that some other code path moved.
 *
 * Deliberately free of DI, DTOs and HTTP concerns: it takes a transaction and
 * a command, and returns either the new level or null. Turning null into a
 * 409 with an available-quantity payload is the service's job.
 */

/** Only the two methods this needs — an extended client is not assignable to Prisma's own transaction type. */
export interface RawTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface StockWrite {
  organizationId: string;
  warehouseId: string;
  productVariantId: string;
  type: InventoryMovementType;
  /** Signed, already rendered at NUMERIC(14,3) scale. */
  delta: string;
  unitCost: bigint | null;
  sourceType: string;
  sourceId: string | null;
  reason: string | null;
  note: string | null;
  createdBy: string | null;
}

export interface StockWriteResult {
  movementId: string;
  quantity: string;
  avgCost: bigint;
}

/**
 * Applies one movement. Returns null when the negative-stock guard rejected
 * it — the caller decides what that means.
 */
export async function writeStockMovement(
  tx: RawTx,
  cmd: StockWrite,
): Promise<StockWriteResult | null> {
  // 1. Ensure the level row exists, at zero.
  //
  // ON CONFLICT DO NOTHING rather than read-then-insert: two first-ever sales
  // of the same product would otherwise race and one would fail on the unique
  // index instead of simply queueing behind the other.
  await tx.$executeRaw`
    INSERT INTO inventory_level
      (id, organization_id, warehouse_id, product_variant_id, quantity, avg_cost, updated_at)
    VALUES
      (gen_random_uuid(), ${cmd.organizationId}::uuid, ${cmd.warehouseId}::uuid,
       ${cmd.productVariantId}::uuid, 0, 0, now())
    ON CONFLICT (warehouse_id, product_variant_id) DO NOTHING
  `;

  // 2. The conditional UPDATE — the whole concurrency story in one statement.
  //
  // PostgreSQL takes a row lock for its duration and re-evaluates the WHERE
  // against the committed row, so two cashiers selling the last unit serialize
  // here automatically and exactly one wins. A SELECT ... FOR UPDATE followed
  // by an application-side check has a window between the read and the write
  // in READ COMMITTED; this has none, and needs no retry loop.
  //
  // The negative-stock policy resolves inline (§9.4): warehouse override, else
  // organization setting, else false. Inline because a policy read a moment
  // earlier is a policy that can be stale at the only moment it matters.
  //
  // avg_cost moves in the same statement (§8.6), so a quantity and the cost it
  // is valued at can never disagree. `quantity <= 0` takes the incoming cost
  // outright: there is no prior stock to average against, and blending against
  // a negative quantity would produce a nonsense cost.
  const updated = await tx.$queryRaw<Array<{ quantity: string; avg_cost: bigint }>>`
    UPDATE inventory_level
       SET quantity = quantity + ${cmd.delta}::numeric,
           avg_cost = CASE
             WHEN ${cmd.unitCost}::bigint IS NULL OR ${cmd.delta}::numeric <= 0 THEN avg_cost
             WHEN quantity <= 0 THEN ${cmd.unitCost}::bigint
             ELSE round(
               (quantity * avg_cost + ${cmd.delta}::numeric * ${cmd.unitCost}::bigint)
               / (quantity + ${cmd.delta}::numeric)
             )::bigint
           END,
           updated_at = now()
     WHERE warehouse_id = ${cmd.warehouseId}::uuid
       AND product_variant_id = ${cmd.productVariantId}::uuid
       AND (
         COALESCE(
           (SELECT w.allow_negative_stock FROM warehouse w
             WHERE w.id = ${cmd.warehouseId}::uuid),
           (SELECT s.allow_negative_stock FROM organization_settings s
             WHERE s.organization_id = ${cmd.organizationId}::uuid),
           false
         )
         OR quantity + ${cmd.delta}::numeric >= 0
       )
    RETURNING quantity::text AS quantity, avg_cost
  `;

  const level = updated[0];
  if (!level) return null;

  // 3. The ledger entry, carrying the quantity the level now holds, so any
  // point-in-time stock question is a single indexed row read.
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO inventory_movement
      (id, organization_id, warehouse_id, product_variant_id, type, quantity_delta,
       quantity_after, unit_cost, source_type, source_id, reason, note, created_by, created_at)
    VALUES
      (gen_random_uuid(), ${cmd.organizationId}::uuid, ${cmd.warehouseId}::uuid,
       ${cmd.productVariantId}::uuid, ${cmd.type}::"InventoryMovementType",
       ${cmd.delta}::numeric, ${level.quantity}::numeric, ${cmd.unitCost}::bigint,
       ${cmd.sourceType}, ${cmd.sourceId}::uuid, ${cmd.reason}, ${cmd.note},
       ${cmd.createdBy}::uuid, now())
    RETURNING id
  `;

  return {
    movementId: inserted[0]!.id,
    quantity: level.quantity,
    avgCost: level.avg_cost,
  };
}
