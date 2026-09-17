import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CreateEmployeeDto, ListEmployeesDto, UpdateEmployeeDto } from './dto/employee.dto';
import { EmployeesService } from './employees.service';

@ApiTags('employees')
@ApiBearerAuth('bearer')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermissions('employees.read')
  @ApiOperation({
    summary: 'Xodimlar ro\u2018yxati',
    description:
      "Xodimlar ekrani: ism yoki telefon bo'yicha qidiruv, faol xodimlar soni va tarif bo'yicha o'rinlar (\"8 / 10\").",
  })
  list(@Query() query: ListEmployeesDto, @CurrentUser() user: TenantContext) {
    return this.employees.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('employees.read')
  @ApiOperation({ summary: 'Xodim tafsilotlari' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.employees.findOne(id, user);
  }

  @Post()
  @RequirePermissions('employees.manage')
  @ApiOperation({
    summary: "Xodim qo'shish",
    description: "Foydalanuvchi va uning do'kon a'zoligi bitta tranzaksiyada yaratiladi.",
  })
  @ApiConflictResponse({ description: 'PHONE_ALREADY_USED · SEAT_LIMIT_REACHED' })
  create(@Body() dto: CreateEmployeeDto, @CurrentUser() user: TenantContext) {
    return this.employees.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('employees.manage')
  @ApiOperation({
    summary: 'Xodimni tahrirlash',
    description:
      "Holat yoki rol o'zgarsa, xodimning barcha sessiyalari bekor qilinadi va o'zgarish darhol kuchga kiradi.",
  })
  @ApiConflictResponse({
    description: 'LAST_ADMIN — oxirgi administratorni o\u2018chirib bo\u2018lmaydi.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.employees.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('employees.manage')
  @ApiOperation({
    summary: 'Xodimni faolsizlantirish',
    description:
      "Xodim o'chirilmaydi, INACTIVE holatiga o'tkaziladi — savdolar uni abadiy ko'rsatib turadi.",
  })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
  ): Promise<void> {
    await this.employees.deactivate(id, user);
  }
}
