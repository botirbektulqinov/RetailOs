import { Module } from '@nestjs/common';

import { CountsController } from './counts.controller';
import { CountsService } from './counts.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

/**
 * Inventory: warehouses, levels, the movement ledger, counts and transfers.
 *
 * One module, because every one of these is a caller of
 * `InventoryService.apply()` and splitting them into peer modules would make
 * that dependency a circular import on day two (docs/ARCHITECTURE.md §30.1).
 *
 * `InventoryService` is exported: Sprint 5's checkout, Sprint 7's receiving
 * and Sprint 8's returns all move stock, and they must do it through the same
 * write path rather than each inventing one. Nothing else in the system is
 * allowed to touch `inventory_level`.
 */
@Module({
  controllers: [InventoryController, WarehousesController, CountsController, TransfersController],
  providers: [InventoryService, WarehousesService, CountsService, TransfersService],
  exports: [InventoryService, WarehousesService],
})
export class InventoryModule {}
