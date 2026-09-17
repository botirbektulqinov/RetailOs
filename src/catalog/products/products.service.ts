import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { BusinessRuleException } from '../../common/exceptions/business-rule.exception';
import { ErrorCode } from '../../common/exceptions/error-codes';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../database/prisma.service';
import {
  mapCatalogUniqueViolation,
  normalizeBarcode,
  normalizeSku,
  normalizeText,
} from '../normalize';
import type {
  CreateProductDto,
  CreateVariantDto,
  ListProductsDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product.dto';

/**
 * Sortable columns, whitelisted.
 *
 * `sort` is client input that becomes an ORDER BY. Passing it through would
 * let a caller order by an unindexed column and turn a product list into a
 * sequential scan — and, with a different ORM, worse than that.
 */
const PRODUCT_SORT: Record<string, Prisma.ProductOrderByWithRelationInput> = {
  'createdAt:desc': { createdAt: 'desc' },
  'createdAt:asc': { createdAt: 'asc' },
  'updatedAt:desc': { updatedAt: 'desc' },
  'updatedAt:asc': { updatedAt: 'asc' },
  'name:asc': { name: 'asc' },
  'name:desc': { name: 'desc' },
};
const DEFAULT_SORT = 'createdAt:desc';

const VARIANT_FIELDS = {
  id: true,
  sku: true,
  barcode: true,
  name: true,
  attributes: true,
  unit: true,
  purchasePrice: true,
  sellingPrice: true,
  minStock: true,
  isDefault: true,
  status: true,
  archivedAt: true,
  version: true,
} as const;

const PRODUCT_FIELDS = {
  id: true,
  categoryId: true,
  name: true,
  description: true,
  brand: true,
  imageUrls: true,
  hasVariants: true,
  status: true,
  archivedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Read ─────────────────────────────────────────────────────────────────

  async list(query: ListProductsDto) {
    const where = this.buildWhere(query);
    const orderBy = PRODUCT_SORT[query.sort ?? DEFAULT_SORT] ?? PRODUCT_SORT[DEFAULT_SORT]!;

    const [rows, total] = await Promise.all([
      this.prisma.db.product.findMany({
        where,
        skip: query.offset,
        take: query.limit,
        orderBy,
        select: {
          ...PRODUCT_FIELDS,
          category: { select: { id: true, name: true, path: true } },
          // Included, not counted separately: the list row shows a price and a
          // SKU, and a second query per product is the N+1 this avoids.
          variants: {
            where: { archivedAt: null },
            select: VARIANT_FIELDS,
            orderBy: [{ isDefault: 'desc' }, { sku: 'asc' }],
          },
        },
      }),
      this.prisma.db.product.count({ where }),
    ]);

    return {
      data: rows.map((row) => toListItem(row)),
      page: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + rows.length < total,
      },
    };
  }

  async findOne(productId: string) {
    const product = await this.prisma.db.product.findFirst({
      where: { id: productId },
      select: {
        ...PRODUCT_FIELDS,
        category: { select: { id: true, name: true, path: true } },
        variants: {
          select: VARIANT_FIELDS,
          orderBy: [{ isDefault: 'desc' }, { sku: 'asc' }],
        },
      },
    });

    if (!product) throw BusinessRuleException.notFound('Mahsulot', productId);

    return {
      ...product,
      variants: product.variants.map(toVariant),
      // The variants screen renders option pickers ("Rang ● Qora ○ Oq") above
      // the table. Derived from the variants themselves rather than stored in
      // an attribute/value/assignment triple that nothing else would read.
      options: deriveOptions(product.variants),
    };
  }

  /**
   * The POS scan path.
   *
   * Exactly one indexed lookup on (organization_id, barcode). Sprint 5 will
   * call this on every scan, so it deliberately does no joins beyond the
   * product row it must return.
   */
  async lookupByBarcode(rawBarcode: string) {
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode) throw BusinessRuleException.notFound('Shtrix-kod', rawBarcode);

    const variant = await this.prisma.db.productVariant.findFirst({
      where: { barcode, archivedAt: null, status: 'ACTIVE' },
      select: {
        ...VARIANT_FIELDS,
        product: {
          select: {
            id: true,
            name: true,
            status: true,
            archivedAt: true,
            imageUrls: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!variant || variant.product.archivedAt || variant.product.status !== 'ACTIVE') {
      throw BusinessRuleException.notFound('Shtrix-kod', barcode);
    }

    const { product, ...rest } = variant;
    return { ...toVariant(rest), product };
  }

  // ── Write ────────────────────────────────────────────────────────────────

  /**
   * Creates the product and its FIRST variant in one transaction.
   *
   * Every product has at least one variant, always (§10.2). A simple product
   * gets one flagged `isDefault`, which the UI edits inline and never shows.
   * That is what lets inventory, sale lines and purchase lines point at a
   * single foreign key forever instead of branching on "does this have
   * variants?".
   */
  async create(dto: CreateProductDto, tenant: TenantContext) {
    const name = normalizeText(dto.name);
    if (dto.categoryId) await this.requireCategory(dto.categoryId);

    const sku = normalizeSku(dto.sku);
    const barcode = normalizeBarcode(dto.barcode);

    try {
      const created = await this.prisma.asSystem().$transaction(async (tx) => {
        const product = await tx.product.create({
          data: {
            organizationId: tenant.organizationId,
            categoryId: dto.categoryId ?? null,
            name,
            description: dto.description ? normalizeText(dto.description) : null,
            brand: dto.brand ? normalizeText(dto.brand) : null,
            imageUrls: dto.imageUrls ?? [],
            hasVariants: false,
            createdBy: tenant.userId,
          },
          select: { id: true },
        });

        await tx.productVariant.create({
          data: {
            organizationId: tenant.organizationId,
            productId: product.id,
            sku,
            barcode,
            name: null,
            attributes: {},
            unit: dto.unit ?? 'PIECE',
            purchasePrice: BigInt(dto.purchasePrice ?? 0),
            sellingPrice: BigInt(dto.sellingPrice),
            minStock: new Prisma.Decimal(dto.minStock ?? 0),
            isDefault: true,
          },
        });

        return product;
      });

      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'product.created',
        entityType: 'product',
        entityId: created.id,
        metadata: { name, sku, categoryId: dto.categoryId ?? null },
      });

      return this.findOne(created.id);
    } catch (error) {
      mapCatalogUniqueViolation(error);
    }
  }

  async update(productId: string, dto: UpdateProductDto, tenant: TenantContext) {
    const existing = await this.requireProduct(productId);
    if (dto.categoryId) await this.requireCategory(dto.categoryId);

    const priceChange =
      dto.sellingPrice !== undefined || dto.purchasePrice !== undefined
        ? await this.defaultVariantPrices(productId)
        : null;

    try {
      const result = await this.prisma.asSystem().$transaction(async (tx) => {
        // Optimistic concurrency: two managers editing the same product in two
        // tabs must not silently overwrite each other.
        const updated = await tx.product.updateMany({
          where: {
            id: productId,
            organizationId: tenant.organizationId,
            ...(dto.version !== undefined ? { version: dto.version } : {}),
          },
          data: {
            ...(dto.name !== undefined ? { name: normalizeText(dto.name) } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description ? normalizeText(dto.description) : null }
              : {}),
            ...(dto.brand !== undefined
              ? { brand: dto.brand ? normalizeText(dto.brand) : null }
              : {}),
            ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId || null } : {}),
            ...(dto.imageUrls !== undefined ? { imageUrls: dto.imageUrls } : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            version: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          throw new BusinessRuleException({
            code: ErrorCode.CONCURRENT_MODIFICATION,
            status: HttpStatus.CONFLICT,
            detail: 'Mahsulot boshqa joyda o‘zgartirilgan. Sahifani yangilang.',
          });
        }

        // A simple product's price lives on its hidden default variant, so the
        // product form can set it without the client knowing variants exist.
        if (
          dto.sellingPrice !== undefined ||
          dto.purchasePrice !== undefined ||
          dto.minStock !== undefined
        ) {
          await tx.productVariant.updateMany({
            where: { productId, isDefault: true, organizationId: tenant.organizationId },
            data: {
              ...(dto.sellingPrice !== undefined ? { sellingPrice: BigInt(dto.sellingPrice) } : {}),
              ...(dto.purchasePrice !== undefined
                ? { purchasePrice: BigInt(dto.purchasePrice) }
                : {}),
              ...(dto.minStock !== undefined ? { minStock: new Prisma.Decimal(dto.minStock) } : {}),
              version: { increment: 1 },
            },
          });
        }

        return updated;
      });

      void result;

      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        // A price change is its own audited event: it is the single most
        // disputed field in a shop, and the audit screen renders it as
        // "Narx o'zgartirildi · 120 000 -> 129 000".
        action: dto.sellingPrice !== undefined ? 'product.price_changed' : 'product.updated',
        entityType: 'product',
        entityId: productId,
        metadata:
          dto.sellingPrice !== undefined && priceChange
            ? {
                name: existing.name,
                oldSellingPrice: priceChange.sellingPrice.toString(),
                newSellingPrice: String(dto.sellingPrice),
              }
            : { name: existing.name, fields: Object.keys(dto) },
      });

      return this.findOne(productId);
    } catch (error) {
      mapCatalogUniqueViolation(error);
    }
  }

  /**
   * Archive, never delete.
   *
   * Sales, purchases and inventory movements reference a product forever — a
   * receipt from last year must still name what was sold. An archived product
   * disappears from search and POS but every historical relation survives.
   */
  async archive(productId: string, tenant: TenantContext) {
    const product = await this.requireProduct(productId);
    if (product.archivedAt) return this.findOne(productId);

    const now = new Date();
    await this.prisma.asSystem().$transaction([
      this.prisma.asSystem().product.update({
        where: { id: productId },
        data: { archivedAt: now, status: 'INACTIVE', version: { increment: 1 } },
      }),
      // Archiving the variants too is what frees their SKU and barcode for
      // reuse, because both unique indexes are partial on archived_at IS NULL.
      this.prisma.asSystem().productVariant.updateMany({
        where: { productId, archivedAt: null },
        data: { archivedAt: now, status: 'INACTIVE' },
      }),
    ]);

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'product.archived',
      entityType: 'product',
      entityId: productId,
      metadata: { name: product.name },
    });

    return this.findOne(productId);
  }

  async restore(productId: string, tenant: TenantContext) {
    const product = await this.requireProduct(productId, { includeArchived: true });
    if (!product.archivedAt) return this.findOne(productId);

    try {
      await this.prisma.asSystem().$transaction([
        this.prisma.asSystem().product.update({
          where: { id: productId },
          data: { archivedAt: null, status: 'ACTIVE', version: { increment: 1 } },
        }),
        this.prisma.asSystem().productVariant.updateMany({
          where: { productId },
          data: { archivedAt: null, status: 'ACTIVE' },
        }),
      ]);
    } catch (error) {
      // Its SKU or barcode may have been taken by a live product in the
      // meantime — that is exactly what the partial unique index allows.
      mapCatalogUniqueViolation(error);
    }

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'product.restored',
      entityType: 'product',
      entityId: productId,
      metadata: { name: product.name },
    });

    return this.findOne(productId);
  }

  // ── Variants ─────────────────────────────────────────────────────────────

  async listVariants(productId: string) {
    await this.requireProduct(productId, { includeArchived: true });

    const variants = await this.prisma.db.productVariant.findMany({
      where: { productId },
      select: VARIANT_FIELDS,
      orderBy: [{ isDefault: 'desc' }, { sku: 'asc' }],
    });

    return { data: variants.map(toVariant), options: deriveOptions(variants) };
  }

  async createVariant(productId: string, dto: CreateVariantDto, tenant: TenantContext) {
    const product = await this.requireProduct(productId);
    if (product.archivedAt) throw productArchived();

    const sku = normalizeSku(dto.sku);
    const barcode = normalizeBarcode(dto.barcode);

    try {
      const created = await this.prisma.asSystem().$transaction(async (tx) => {
        const variant = await tx.productVariant.create({
          data: {
            organizationId: tenant.organizationId,
            productId,
            sku,
            barcode,
            name: dto.name ? normalizeText(dto.name) : renderVariantName(dto.attributes),
            attributes: dto.attributes ?? {},
            unit: dto.unit ?? 'PIECE',
            purchasePrice: BigInt(dto.purchasePrice ?? 0),
            sellingPrice: BigInt(dto.sellingPrice),
            minStock: new Prisma.Decimal(dto.minStock ?? 0),
            isDefault: false,
          },
          select: VARIANT_FIELDS,
        });

        // The second variant is what makes a product a variant product. The
        // flag is presentation only — nothing downstream branches on it.
        await tx.product.update({
          where: { id: productId },
          data: { hasVariants: true, version: { increment: 1 } },
        });

        return variant;
      });

      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'variant.created',
        entityType: 'product_variant',
        entityId: created.id,
        metadata: { productId, sku, name: created.name },
      });

      return toVariant(created);
    } catch (error) {
      mapCatalogUniqueViolation(error);
    }
  }

  async updateVariant(
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    tenant: TenantContext,
  ) {
    const variant = await this.requireVariant(productId, variantId);

    try {
      const updated = await this.prisma.db.productVariant.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: variantId } },
        data: {
          ...(dto.sku !== undefined ? { sku: normalizeSku(dto.sku) } : {}),
          ...(dto.barcode !== undefined ? { barcode: normalizeBarcode(dto.barcode) } : {}),
          ...(dto.name !== undefined ? { name: dto.name ? normalizeText(dto.name) : null } : {}),
          ...(dto.attributes !== undefined ? { attributes: dto.attributes } : {}),
          ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
          ...(dto.purchasePrice !== undefined ? { purchasePrice: BigInt(dto.purchasePrice) } : {}),
          ...(dto.sellingPrice !== undefined ? { sellingPrice: BigInt(dto.sellingPrice) } : {}),
          ...(dto.minStock !== undefined ? { minStock: new Prisma.Decimal(dto.minStock) } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          version: { increment: 1 },
        },
        select: VARIANT_FIELDS,
      });

      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: dto.sellingPrice !== undefined ? 'variant.price_changed' : 'variant.updated',
        entityType: 'product_variant',
        entityId: variantId,
        metadata:
          dto.sellingPrice !== undefined
            ? {
                productId,
                sku: updated.sku,
                oldSellingPrice: variant.sellingPrice.toString(),
                newSellingPrice: String(dto.sellingPrice),
              }
            : { productId, sku: updated.sku, fields: Object.keys(dto) },
      });

      return toVariant(updated);
    } catch (error) {
      mapCatalogUniqueViolation(error);
    }
  }

  async archiveVariant(productId: string, variantId: string, tenant: TenantContext) {
    const variant = await this.requireVariant(productId, variantId);

    const liveCount = await this.prisma.db.productVariant.count({
      where: { productId, archivedAt: null },
    });

    // Every product must keep at least one variant, or there is nothing for
    // inventory and sale lines to reference. Archiving the whole product is
    // the way to retire the last one.
    if (liveCount <= 1) {
      throw new BusinessRuleException({
        code: ErrorCode.LAST_VARIANT,
        status: HttpStatus.CONFLICT,
        detail: 'Mahsulotda kamida bitta variant qolishi kerak. Mahsulotning o‘zini arxivlang.',
      });
    }

    const archived = await this.prisma.db.productVariant.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: variantId } },
      data: { archivedAt: new Date(), status: 'INACTIVE' },
      select: VARIANT_FIELDS,
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'variant.archived',
      entityType: 'product_variant',
      entityId: variantId,
      metadata: { productId, sku: variant.sku },
    });

    return toVariant(archived);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private buildWhere(query: ListProductsDto): Prisma.ProductWhereInput {
    // Built as an AND array rather than one object literal: `q` and the price
    // filter both constrain `variants`, and two `variants` keys in the same
    // object would silently clobber each other — the second one wins and the
    // first filter quietly stops applying.
    const and: Prisma.ProductWhereInput[] = [];

    if (!query.includeArchived) and.push({ archivedAt: null });
    if (query.status) and.push({ status: query.status });
    if (query.categoryId) and.push({ categoryId: query.categoryId });
    if (query.brand) and.push({ brand: { equals: query.brand, mode: 'insensitive' } });
    if (query.hasVariants !== undefined) and.push({ hasVariants: query.hasVariants });

    if (query.q) {
      const search = normalizeText(query.q);
      const digits = search.replace(/\D/g, '');

      const or: Prisma.ProductWhereInput[] = [
        { name: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: normalizeSku(search) } } } },
      ];

      // Only search barcodes when the term actually contains digits. The
      // earlier version passed a NUL sentinel instead, which PostgreSQL
      // rejects outright — every text search 500'd.
      if (digits.length > 0) {
        or.push({ variants: { some: { barcode: { contains: digits } } } });
      }

      and.push({ OR: or });
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      and.push({
        variants: {
          some: {
            archivedAt: null,
            sellingPrice: {
              ...(query.minPrice !== undefined ? { gte: BigInt(query.minPrice) } : {}),
              ...(query.maxPrice !== undefined ? { lte: BigInt(query.maxPrice) } : {}),
            },
          },
        },
      });
    }

    return and.length > 0 ? { AND: and } : {};
  }

  private async requireProduct(productId: string, options?: { includeArchived?: boolean }) {
    const product = await this.prisma.db.product.findFirst({
      where: { id: productId, ...(options?.includeArchived ? {} : {}) },
      select: { id: true, name: true, archivedAt: true, version: true },
    });
    if (!product) throw BusinessRuleException.notFound('Mahsulot', productId);
    return product;
  }

  private async requireVariant(productId: string, variantId: string) {
    const variant = await this.prisma.db.productVariant.findFirst({
      where: { id: variantId, productId },
      select: { id: true, sku: true, sellingPrice: true, isDefault: true },
    });
    // Scoped to the product too, so a variant id from another product (or
    // another tenant) is simply not found.
    if (!variant) throw BusinessRuleException.notFound('Variant', variantId);
    return variant;
  }

  private async requireCategory(categoryId: string) {
    const category = await this.prisma.db.category.findFirst({
      where: { id: categoryId, archivedAt: null },
      select: { id: true },
    });
    // The tenant extension scoped this, and the composite foreign key would
    // reject it anyway — this just turns it into a clean 404.
    if (!category) throw BusinessRuleException.notFound('Kategoriya', categoryId);
    return category;
  }

  private async defaultVariantPrices(productId: string) {
    return this.prisma.db.productVariant.findFirst({
      where: { productId, isDefault: true },
      select: { sellingPrice: true, purchasePrice: true },
    });
  }
}

// ── mapping ────────────────────────────────────────────────────────────────

interface VariantRow {
  id: string;
  sku: string;
  barcode: string | null;
  name: string | null;
  attributes: Prisma.JsonValue;
  unit: string;
  purchasePrice: bigint;
  sellingPrice: bigint;
  minStock: Prisma.Decimal;
  isDefault: boolean;
  status: string;
  archivedAt: Date | null;
  version: number;
}

/**
 * Money stays a bigint all the way to serialization, where the global
 * BigInt.toJSON emits a JSON integer. Quantities become decimal STRINGS —
 * a float would lose "1.500" the moment anyone did arithmetic on it.
 */
function toVariant(v: VariantRow) {
  return {
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    name: v.name,
    attributes: v.attributes,
    unit: v.unit,
    purchasePrice: v.purchasePrice,
    sellingPrice: v.sellingPrice,
    minStock: v.minStock.toFixed(3),
    isDefault: v.isDefault,
    status: v.status,
    archivedAt: v.archivedAt,
    version: v.version,
  };
}

function toListItem(row: { variants: VariantRow[]; [key: string]: unknown }) {
  const { variants, ...product } = row;
  const primary = variants.find((v) => v.isDefault) ?? variants[0];

  return {
    ...product,
    variantCount: variants.length,
    // The list row shows one price and one SKU. For a variant product that is
    // the cheapest live variant, which is what a shopper's eye expects.
    defaultVariant: primary ? toVariant(primary) : null,
    priceRange:
      variants.length > 1
        ? {
            min: variants.reduce(
              (a, v) => (v.sellingPrice < a ? v.sellingPrice : a),
              variants[0]!.sellingPrice,
            ),
            max: variants.reduce(
              (a, v) => (v.sellingPrice > a ? v.sellingPrice : a),
              variants[0]!.sellingPrice,
            ),
          }
        : null,
  };
}

/**
 * Derives the option pickers the variants screen shows ("Rang ● Qora ○ Oq")
 * from the variants' own attribute maps.
 *
 * No attribute/value/assignment tables: three tables would store exactly what
 * this function computes in one pass over rows already loaded.
 */
function deriveOptions(variants: { attributes: Prisma.JsonValue }[]) {
  const options = new Map<string, Set<string>>();

  for (const variant of variants) {
    const attributes = variant.attributes;
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes))
      continue;

    for (const [key, value] of Object.entries(attributes)) {
      if (typeof value !== 'string') continue;
      if (!options.has(key)) options.set(key, new Set());
      options.get(key)!.add(value);
    }
  }

  return [...options.entries()].map(([name, values]) => ({ name, values: [...values] }));
}

/** "Qora / S" from { Rang: "Qora", "O'lcham": "S" }. */
function renderVariantName(attributes: Record<string, string> | undefined): string | null {
  if (!attributes) return null;
  const parts = Object.values(attributes).filter((v) => typeof v === 'string' && v.length > 0);
  return parts.length > 0 ? parts.join(' / ') : null;
}

function productArchived(): BusinessRuleException {
  return new BusinessRuleException({
    code: ErrorCode.PRODUCT_ARCHIVED,
    status: HttpStatus.CONFLICT,
    detail: 'Mahsulot arxivlangan. Avval uni tiklang.',
  });
}
