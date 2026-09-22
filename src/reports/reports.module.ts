import { Module } from '@nestjs/common';

import { EmployeesModule } from '../employees/employees.module';
import { DashboardController, ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/** EmployeesModule is imported for AssignmentsService — the store-scope check. */
@Module({
  imports: [EmployeesModule],
  controllers: [ReportsController, DashboardController],
  providers: [ReportsService, ReportsRepository],
  exports: [ReportsService],
})
export class ReportsModule {}
