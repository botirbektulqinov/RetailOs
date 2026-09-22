import { Module } from '@nestjs/common';

import { LoyaltyController, PromotionsController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { PromotionsService } from './promotions.service';

/**
 * Promotions and loyalty.
 *
 * Both are read by checkout, so both are exported. Neither imports SalesModule
 * — the dependency runs one way, which is what keeps the pricing pipeline free
 * of a circular import.
 */
@Module({
  controllers: [PromotionsController, LoyaltyController],
  providers: [PromotionsService, LoyaltyService],
  exports: [PromotionsService, LoyaltyService],
})
export class LoyaltyModule {}
