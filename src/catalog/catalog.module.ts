import { Module } from '@nestjs/common';

import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';

/**
 * Catalog: categories, products and variants in one module.
 *
 * A category exists only to organise products, and a variant only exists
 * inside a product — splitting them into peer modules would create a circular
 * import on day two (docs/ARCHITECTURE.md §30.1).
 *
 * The catalog is ORGANIZATION-level, not store-level. A product is the same
 * product in every branch; per-store price and availability are the real
 * variations and both are additive later without moving the product itself.
 * Store-scoping products now would duplicate SKUs across branches and break
 * barcode lookup, which must resolve to exactly one row.
 */
@Module({
  controllers: [CategoriesController, ProductsController],
  providers: [CategoriesService, ProductsService],
  exports: [CategoriesService, ProductsService],
})
export class CatalogModule {}
