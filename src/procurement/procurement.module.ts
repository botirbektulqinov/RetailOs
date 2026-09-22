import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchasesController, SuppliersController } from './procurement.controller';
import { PurchasesService } from './purchases.service';
import { SuppliersService } from './suppliers.service';

/**
 * Suppliers, purchases and payables.
 *
 * Imports InventoryModule because receiving goods moves stock, and it must do
 * so through InventoryService.apply() like everything else — a receipt that
 * wrote a level directly would be invisible to the reconciliation query.
 */
@Module({
  imports: [InventoryModule],
  controllers: [SuppliersController, PurchasesController],
  providers: [SuppliersService, PurchasesService, IdempotencyService],
  exports: [SuppliersService, PurchasesService],
})
export class ProcurementModule {}
