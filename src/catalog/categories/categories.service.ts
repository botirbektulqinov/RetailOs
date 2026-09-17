import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { BusinessRuleException } from '../../common/exceptions/business-rule.exception';
import { ErrorCode } from '../../common/exceptions/error-codes';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../database/prisma.service';
import { mapCatalogUniqueViolation, normalizeText } from '../normalize';
import type { CreateCategoryDto, ListCategoriesDto, UpdateCategoryDto } from './dto/category.dto';

/**
 * Root is depth 1. The categories screen renders a two-ancestor path
 * ("Choy va qahva" under "Ichimliklar / Issiq"), so three levels is what the
 * product needs.
 *
 * The architecture document said two. The design is the UX source of truth and
 * it clearly nests three deep, so the cap follows the design.
 */
export const MAX_CATEGORY_DEPTH = 3;

const CATEGORY_FIELDS = {
  id: true,
  parentId: true,
  name: true,
  description: true,
  path: true,
  depth: true,
  sortOrder: true,
  status: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The whole tree in ONE query, assembled in memory.
   *
   * A category list is tens of rows, not thousands, so a recursive CTE or a
   * query per level buys nothing. The product count per category comes from a
   * single grouped query rather than a count per row — that is the N+1 the
   * screen's "184" badge would otherwise cause.
   */
  async list(query: ListCategoriesDto) {
    const where: Prisma.CategoryWhereInput = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.parentId !== undefined ? { parentId: query.parentId || null } : {}),
      ...(query.q ? { name: { contains: normalizeText(query.q), mode: 'insensitive' } } : {}),
    };

    const [rows, counts, archivedCount] = await Promise.all([
      this.prisma.db.category.findMany({
        where,
        select: CATEGORY_FIELDS,
        orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.db.product.groupBy({
        by: ['categoryId'],
        where: { archivedAt: null },
        _count: { _all: true },
      }),
      this.prisma.db.category.count({ where: { archivedAt: { not: null } } }),
    ]);

    const productCount = new Map(
      counts.filter((c) => c.categoryId).map((c) => [c.categoryId!, c._count._all]),
    );

    const items = rows.map((row) => ({
      ...row,
      productCount: productCount.get(row.id) ?? 0,
    }));

    return {
      data: query.flat ? items : buildTree(items),
      // The screen header reads "18 kategoriya · 3 ta yashirilgan".
      summary: { total: items.length, archivedCount },
    };
  }

  async findOne(categoryId: string, _tenant: TenantContext) {
    const category = await this.prisma.db.category.findFirst({
      where: { id: categoryId },
      select: {
        ...CATEGORY_FIELDS,
        _count: { select: { products: { where: { archivedAt: null } }, children: true } },
      },
    });

    // Scoped by the tenant extension, so another organization's category is
    // simply not found — the caller learns nothing about it.
    if (!category) throw BusinessRuleException.notFound('Kategoriya', categoryId);

    const { _count, ...rest } = category;
    return { ...rest, productCount: _count.products, childCount: _count.children };
  }

  async create(dto: CreateCategoryDto, tenant: TenantContext) {
    const name = normalizeText(dto.name);
    const parent = dto.parentId ? await this.requireCategory(dto.parentId) : null;

    if (parent && parent.depth >= MAX_CATEGORY_DEPTH) {
      throw tooDeep();
    }

    const depth = parent ? parent.depth + 1 : 1;
    const path = parent ? joinPath(parent.path, parent.name) : '';

    try {
      const created = await this.prisma.db.category.create({
        data: {
          organizationId: tenant.organizationId,
          parentId: parent?.id ?? null,
          name,
          description: dto.description ? normalizeText(dto.description) : null,
          path,
          depth,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: CATEGORY_FIELDS,
      });

      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'category.created',
        entityType: 'category',
        entityId: created.id,
        metadata: { name, parentId: parent?.id ?? null, depth },
      });

      return { ...created, productCount: 0 };
    } catch (error) {
      mapCatalogUniqueViolation(error);
    }
  }

  async update(categoryId: string, dto: UpdateCategoryDto, tenant: TenantContext) {
    const existing = await this.requireCategory(categoryId);

    let parentChange: { parentId: string | null; depth: number; path: string } | undefined;

    if (dto.parentId !== undefined) {
      const nextParentId = dto.parentId || null;

      if (nextParentId !== existing.parentId) {
        const parent = nextParentId ? await this.requireCategory(nextParentId) : null;

        if (parent) {
          // Walking the ancestor chain catches both A->B->A and longer cycles.
          // The database only rejects self-parenting; deeper loops need this.
          await this.assertNotDescendant(existing.id, parent.id);

          const subtreeDepth = await this.subtreeHeight(existing.id);
          if (parent.depth + subtreeDepth > MAX_CATEGORY_DEPTH) throw tooDeep();
        }

        parentChange = {
          parentId: parent?.id ?? null,
          depth: parent ? parent.depth + 1 : 1,
          path: parent ? joinPath(parent.path, parent.name) : '',
        };
      }
    }

    const name = dto.name !== undefined ? normalizeText(dto.name) : undefined;

    try {
      const updated = await this.prisma.db.category.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: categoryId } },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description ? normalizeText(dto.description) : null }
            : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(parentChange ?? {}),
        },
        select: CATEGORY_FIELDS,
      });

      // Moving or renaming a node invalidates every descendant's stored path.
      if (parentChange || (name !== undefined && name !== existing.name)) {
        await this.rebuildDescendantPaths(updated.id, tenant);
      }

      await this.audit.record({
        organizationId: tenant.organizationId,
        storeId: tenant.storeId,
        actorUserId: tenant.userId,
        action: 'category.updated',
        entityType: 'category',
        entityId: categoryId,
        metadata: { fields: Object.keys(dto), moved: Boolean(parentChange) },
      });

      return updated;
    } catch (error) {
      mapCatalogUniqueViolation(error);
    }
  }

  /**
   * Archive, never delete.
   *
   * A category is referenced by products, and those products are referenced by
   * sales that must still render years later. Deleting is refused outright
   * rather than cascading, which is why the foreign key is ON DELETE RESTRICT.
   */
  async archive(categoryId: string, tenant: TenantContext) {
    const category = await this.findOne(categoryId, tenant);

    if (category.childCount > 0) {
      throw new BusinessRuleException({
        code: ErrorCode.CATEGORY_HAS_CHILDREN,
        status: HttpStatus.CONFLICT,
        detail: `Bu kategoriyada ${category.childCount} ta ichki kategoriya bor. Avval ularni ko‘chiring.`,
      });
    }

    if (category.productCount > 0) {
      throw new BusinessRuleException({
        code: ErrorCode.CATEGORY_HAS_PRODUCTS,
        status: HttpStatus.CONFLICT,
        detail: `Bu kategoriyada ${category.productCount} ta mahsulot bor. Avval ularni boshqa kategoriyaga o‘tkazing.`,
      });
    }

    const archived = await this.prisma.db.category.update({
      where: { organizationId_id: { organizationId: tenant.organizationId, id: categoryId } },
      data: { archivedAt: new Date(), status: 'INACTIVE' },
      select: CATEGORY_FIELDS,
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      storeId: tenant.storeId,
      actorUserId: tenant.userId,
      action: 'category.archived',
      entityType: 'category',
      entityId: categoryId,
      metadata: { name: category.name },
    });

    return archived;
  }

  async restore(categoryId: string, tenant: TenantContext) {
    const category = await this.requireCategory(categoryId, { includeArchived: true });

    // A child cannot come back while its parent is still archived — that would
    // leave an orphan whose path points at something invisible.
    if (category.parentId) {
      const parent = await this.prisma.db.category.findFirst({
        where: { id: category.parentId },
        select: { archivedAt: true },
      });
      if (parent?.archivedAt) {
        throw new BusinessRuleException({
          code: ErrorCode.CATEGORY_HAS_CHILDREN,
          status: HttpStatus.CONFLICT,
          detail: 'Avval yuqoridagi kategoriyani tiklang.',
        });
      }
    }

    try {
      const restored = await this.prisma.db.category.update({
        where: { organizationId_id: { organizationId: tenant.organizationId, id: categoryId } },
        data: { archivedAt: null, status: 'ACTIVE' },
        select: CATEGORY_FIELDS,
      });

      await this.audit.record({
        organizationId: tenant.organizationId,
        actorUserId: tenant.userId,
        action: 'category.restored',
        entityType: 'category',
        entityId: categoryId,
        metadata: { name: category.name },
      });

      return restored;
    } catch (error) {
      // Another live sibling may have taken the name while this was archived.
      mapCatalogUniqueViolation(error);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async requireCategory(categoryId: string, options?: { includeArchived?: boolean }) {
    const category = await this.prisma.db.category.findFirst({
      where: { id: categoryId, ...(options?.includeArchived ? {} : { archivedAt: null }) },
      select: { id: true, name: true, parentId: true, depth: true, path: true },
    });
    if (!category) throw BusinessRuleException.notFound('Kategoriya', categoryId);
    return category;
  }

  /** Refuses a move that would make `candidateParent` sit under `categoryId`. */
  private async assertNotDescendant(categoryId: string, candidateParentId: string): Promise<void> {
    let cursor: string | null = candidateParentId;

    // Bounded by MAX_CATEGORY_DEPTH + 1, so a corrupted cycle already in the
    // data cannot spin forever.
    for (let hop = 0; cursor && hop <= MAX_CATEGORY_DEPTH + 1; hop += 1) {
      if (cursor === categoryId) {
        throw new BusinessRuleException({
          code: ErrorCode.CATEGORY_CYCLE,
          status: HttpStatus.CONFLICT,
          detail: 'Kategoriyani o‘zining ichki kategoriyasiga ko‘chirib bo‘lmaydi.',
        });
      }
      const parent: { parentId: string | null } | null = await this.prisma.db.category.findFirst({
        where: { id: cursor },
        select: { parentId: true },
      });
      cursor = parent?.parentId ?? null;
    }
  }

  /**
   * How many levels the subtree rooted at `categoryId` occupies (itself = 1).
   *
   * Walks down level by level rather than filtering on the stored `path`:
   * `path` holds NAMES, so a contains-check on an id would match nothing. The
   * loop is bounded by the depth cap, so it is at most three small queries.
   */
  private async subtreeHeight(categoryId: string): Promise<number> {
    let frontier = [categoryId];
    let height = 1;

    for (let level = 1; level < MAX_CATEGORY_DEPTH; level += 1) {
      const children = await this.prisma.db.category.findMany({
        where: { parentId: { in: frontier }, archivedAt: null },
        select: { id: true },
      });
      if (children.length === 0) break;

      height += 1;
      frontier = children.map((c) => c.id);
    }

    return height;
  }

  /**
   * Rewrites stored paths under a renamed or moved node.
   *
   * Bounded by MAX_CATEGORY_DEPTH levels and a handful of rows, so a loop of
   * small updates is clearer than a recursive CTE here.
   */
  private async rebuildDescendantPaths(rootId: string, tenant: TenantContext): Promise<void> {
    let frontier = [rootId];

    for (let level = 0; level < MAX_CATEGORY_DEPTH && frontier.length > 0; level += 1) {
      const parents = await this.prisma.db.category.findMany({
        where: { id: { in: frontier } },
        select: { id: true, name: true, path: true, depth: true },
      });

      const children = await this.prisma.db.category.findMany({
        where: { parentId: { in: frontier } },
        select: { id: true, parentId: true },
      });
      if (children.length === 0) return;

      const byId = new Map(parents.map((p) => [p.id, p]));

      await this.prisma.asSystem().$transaction(
        children.map((child) => {
          const parent = byId.get(child.parentId!)!;
          return this.prisma.asSystem().category.update({
            where: { id: child.id },
            data: { path: joinPath(parent.path, parent.name), depth: parent.depth + 1 },
          });
        }),
      );

      frontier = children.map((c) => c.id);
    }
    void tenant;
  }
}

function joinPath(parentPath: string, parentName: string): string {
  return parentPath ? `${parentPath} / ${parentName}` : parentName;
}

interface TreeItem {
  id: string;
  parentId: string | null;
  [key: string]: unknown;
}

/** Assembles a parent/child tree from a flat list in one pass. */
function buildTree<T extends TreeItem>(items: T[]): (T & { children: T[] })[] {
  const nodes = new Map<string, T & { children: T[] }>();
  for (const item of items) nodes.set(item.id, { ...item, children: [] });

  const roots: (T & { children: T[] })[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    // A child whose parent is filtered out surfaces at the root rather than
    // vanishing — a hidden row is worse than a misplaced one.
    else roots.push(node);
  }
  return roots;
}

function tooDeep(): BusinessRuleException {
  return new BusinessRuleException({
    code: ErrorCode.CATEGORY_TOO_DEEP,
    status: HttpStatus.CONFLICT,
    detail: `Kategoriyalar eng ko‘pi bilan ${MAX_CATEGORY_DEPTH} daraja bo‘lishi mumkin.`,
  });
}
