import { Module } from '@nestjs/common';

import { IdempotencyService } from '../common/idempotency/idempotency.service';
import {
  CustomerGroupsController,
  CustomersController,
  DebtsController,
} from './customers.controller';
import { CustomersService } from './customers.service';
import { DebtsService } from './debts.service';

/**
 * Customers, groups and receivables in one module.
 *
 * A debt exists only because a customer owes it, and the customer screen leads
 * with the balance — splitting them into peer modules would create a circular
 * import on day two (docs/ARCHITECTURE.md §30.1).
 *
 * Sales are NOT imported. A sale's receivable is created inside the checkout
 * transaction, where it commits with the sale that caused it; this module only
 * ever reads sales.
 */
@Module({
  controllers: [CustomersController, CustomerGroupsController, DebtsController],
  providers: [CustomersService, DebtsService, IdempotencyService],
  exports: [CustomersService, DebtsService],
})
export class CustomersModule {}
