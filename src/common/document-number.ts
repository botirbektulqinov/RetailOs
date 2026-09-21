/**
 * Structural, not `Prisma.TransactionClient`: the client this project passes
 * around carries the tenant extension, and an extended client is not
 * assignable to the base transaction type. All this function needs is the one
 * method it calls.
 */
interface RawCapableTx {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Gapless per-store document numbers — docs/ARCHITECTURE.md §25.6.
 *
 * One statement. The upsert takes a row lock on the counter, so concurrent
 * callers serialize and no two documents can receive the same number, and
 * none is skipped. A PostgreSQL sequence would be faster and would leave gaps
 * on rollback; a receipt number with gaps is a question from a tax inspector.
 *
 * ponytail: one counter row per (store, type, period) serializes concurrent
 * checkouts at a store for the rest of the transaction. Fine below roughly
 * 50–100 documents/sec/store. The upgrade path is a sequence per store with
 * gaps tolerated, or moving number assignment to the end of the transaction
 * to shorten the lock window (§25.6).
 */
export async function nextDocumentNumber(
  tx: RawCapableTx,
  input: {
    organizationId: string;
    storeId: string;
    /** 'INVENTORY_COUNT' | 'STOCK_TRANSFER' | 'SALE' | … */
    documentType: string;
    /** Short human prefix: INV, TRF, SALE. */
    prefix: string;
    /** 'ALL', or '2026-09' for counters that restart each month. */
    periodKey?: string;
  },
): Promise<string> {
  const periodKey = input.periodKey ?? 'ALL';

  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    INSERT INTO document_counter
      (organization_id, store_id, document_type, period_key, next_value)
    VALUES
      (${input.organizationId}::uuid, ${input.storeId}::uuid,
       ${input.documentType}, ${periodKey}, 2)
    ON CONFLICT (organization_id, store_id, document_type, period_key)
    DO UPDATE SET next_value = document_counter.next_value + 1
    RETURNING next_value - 1 AS value
  `;

  const value = rows[0]?.value ?? 1n;
  return `${input.prefix}-${value.toString().padStart(6, '0')}`;
}
