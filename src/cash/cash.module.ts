import { Module } from '@nestjs/common';

import { CashRegistersController, ShiftsController } from './cash.controller';
import { CashService } from './cash.service';

/**
 * The cash drawer.
 *
 * Exported because checkout and debt collection attach their payments to the
 * open shift. The dependency runs one way: this module never imports sales.
 */
@Module({
  controllers: [CashRegistersController, ShiftsController],
  providers: [CashService],
  exports: [CashService],
})
export class CashModule {}
