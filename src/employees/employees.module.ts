import { Module } from '@nestjs/common';

import { EmployeesController } from './employees.controller';
import { AssignmentsService } from './assignments.service';
import { EmployeesService } from './employees.service';

@Module({
  controllers: [EmployeesController],
  providers: [EmployeesService, AssignmentsService],
  exports: [EmployeesService, AssignmentsService],
})
export class EmployeesModule {}
