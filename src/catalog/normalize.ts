import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';

/**
 * Catalog normalisation rules — documented here because silently rewriting a
 * user's input is only acceptable when the rule is predictable and stated.
 *
 *   name / description / brand : trimmed, inner whitespace collapsed
 *   SKU                        : trimmed, UPPERCASED
 *   barcode                    : trimmed, non-digits stripped, empty -> null
 *
 * Nothing else is touched. Case in a product name is the user's business.
 */

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * SKUs are uppercased so "ch-021" and "CH-021" cannot both exist and then
 * confuse a stock count. A case-insensitive unique index would allow both to
 * be stored and displayed differently, which is worse.
 */
export function normalizeSku(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * A scanner emits digits. Anything else a human typed is a mistake that would
 * never match a scan, so it is stripped rather than stored and never matched.
 * An empty result becomes null: "no barcode" and "barcode of empty string"
 * must not be two different states.
 */
export function normalizeBarcode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/**
 * Turns a unique-constraint violation into the specific API error.
 *
 * Pre-checking "does this SKU exist?" and then inserting still races: two
 * requests can both pass the check. The database constraint is the real
 * guard, so this maps its failure rather than pretending it cannot happen.
 */
export function mapCatalogUniqueViolation(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = violatedConstraint(error);

    if (target.includes('sku')) {
      throw new BusinessRuleException({
        code: ErrorCode.SKU_ALREADY_USED,
        status: HttpStatus.CONFLICT,
        detail: 'Bu SKU allaqachon ishlatilgan.',
        errors: [{ field: 'sku', code: ErrorCode.SKU_ALREADY_USED, message: 'SKU band' }],
      });
    }
    if (target.includes('barcode')) {
      // The design's product form shows exactly this under the barcode field:
      // "Bu shtrix-kod boshqa mahsulotda mavjud".
      throw new BusinessRuleException({
        code: ErrorCode.BARCODE_ALREADY_USED,
        status: HttpStatus.CONFLICT,
        detail: 'Bu shtrix-kod boshqa mahsulotda mavjud.',
        errors: [
          { field: 'barcode', code: ErrorCode.BARCODE_ALREADY_USED, message: 'Shtrix-kod band' },
        ],
      });
    }
    if (target.includes('category')) {
      throw new BusinessRuleException({
        code: ErrorCode.CATEGORY_NAME_TAKEN,
        status: HttpStatus.CONFLICT,
        detail: 'Bu nomdagi kategoriya shu bo‘limda allaqachon mavjud.',
        errors: [{ field: 'name', code: ErrorCode.CATEGORY_NAME_TAKEN, message: 'Nom band' }],
      });
    }
  }
  throw error;
}

/**
 * Which constraint a P2002 actually violated, lowercased.
 *
 * Prisma reports this in three different places depending on how the index was
 * declared and which driver is in use. With Prisma 7 and the pg adapter, an
 * index created by hand-written SQL (every partial unique index in this schema)
 * arrives only inside `meta.driverAdapterError`, and `meta.target` is absent —
 * which is why the first version of this function silently matched nothing and
 * every duplicate SKU surfaced as a generic DUPLICATE_RESOURCE.
 */
function violatedConstraint(error: Prisma.PrismaClientKnownRequestError): string {
  const meta = (error.meta ?? {}) as Record<string, unknown>;

  const target = meta['target'];
  if (Array.isArray(target)) return target.join(',').toLowerCase();
  if (typeof target === 'string') return target.toLowerCase();

  const adapter = meta['driverAdapterError'];
  if (isRecord(adapter)) {
    const cause = adapter['cause'];
    if (isRecord(cause)) {
      const constraint = cause['constraint'];
      if (isRecord(constraint)) {
        const name = constraint['index'] ?? constraint['fields'];
        if (typeof name === 'string') return name.toLowerCase();
        if (Array.isArray(name)) return name.join(',').toLowerCase();
      }
      const original = cause['originalMessage'];
      if (typeof original === 'string') return original.toLowerCase();
    }
  }

  // Last resort: the rendered message names the constraint.
  return error.message.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
