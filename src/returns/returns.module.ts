import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { InventoryModule } from '../inventory/inventory.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ExchangesController, ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';

/**
 * Returns and exchanges.
 *
 * SalesModule is deliberately NOT imported. An exchange writes its replacement
 * sale directly rather than calling checkout: checkout owns its own
 * idempotency and balances payments against the gross total, while an exchange
 * settles the net. What matters — server-resolved prices, the cost snapshot,
 * the stock guard, the document counter — is the same code path either way.
 */
@Module({
  imports: [InventoryModule, LoyaltyModule],
  controllers: [ReturnsController, ExchangesController],
  providers: [ReturnsService, IdempotencyService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
