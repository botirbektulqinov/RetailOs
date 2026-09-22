import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { InventoryModule } from '../inventory/inventory.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

/**
 * Sales and checkout.
 *
 * Imports InventoryModule rather than touching stock itself: every deduction
 * goes through InventoryService.apply(), which is what keeps "the ledger
 * explains every number" true across module boundaries as well as inside one.
 *
 * Customer CRUD is deliberately NOT here. Sprint 5 needs only the relationship
 * — a credit sale must have somebody who owes the money — so it creates the
 * table and the foreign key and stops. The screens come with Sprint 6, which
 * owns the customer domain.
 */
@Module({
  imports: [InventoryModule, LoyaltyModule],
  controllers: [SalesController],
  providers: [SalesService, IdempotencyService],
  exports: [SalesService, IdempotencyService],
})
export class SalesModule {}
