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
import {
  AssignStoreDto,
  CreateEmployeeDto,
  ListEmployeesDto,
  ResetPasswordDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { AssignmentsService } from './assignments.service';
import { EmployeesService } from './employees.service';

@ApiTags('employees')
@ApiBearerAuth('bearer')
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly assignments: AssignmentsService,
  ) {}

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

  @Patch(':id/activate')
  @RequirePermissions('employees.manage')
  @ApiOperation({ summary: 'Xodimni qayta faollashtirish' })
  activate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.assignments.activate(id, user);
  }

  @Get(':id/assignments')
  @RequirePermissions('employees.read')
  @ApiOperation({
    summary: "Do'kon biriktiruvlari",
    description:
      "Xodimning vakolati har bir do'kon uchun alohida: ayni odam bir filialda " +
      "menejer, boshqasida kassir bo'lishi mumkin.",
  })
  listAssignments(@Param('id', ParseUUIDPipe) id: string) {
    return this.assignments.listAssignments(id);
  }

  @Post(':id/assignments')
  @RequirePermissions('employees.manage')
  @ApiOperation({
    summary: "Do'konga biriktirish",
    description:
      "Allaqachon biriktirilgan bo'lsa roli almashtiriladi. Vakolat o'zgargani uchun " +
      "barcha tokenlari darhol eskiradi — keyingi so'rovda rad etiladi.",
  })
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignStoreDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.assignments.assign(id, dto, user);
  }

  @Delete(':id/assignments/:storeId')
  @RequirePermissions('employees.manage')
  @ApiOperation({
    summary: 'Biriktiruvni olib tashlash',
    description:
      "Oxirgisini olib bo'lmaydi — hech qayerga kira olmaydigan hisob buzilgan " +
      'hisobga o‘xshaydi. Uning o‘rniga xodimni faolsizlantiring.',
  })
  @ApiConflictResponse({ description: 'LAST_STORE_ASSIGNMENT' })
  unassign(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @CurrentUser() user: TenantContext,
  ) {
    return this.assignments.unassign(id, storeId, user);
  }

  @Post(':id/reset-password')
  @RequirePermissions('employees.manage')
  @ApiOperation({
    summary: 'Parolni tiklash',
    description:
      "Administrator yangi parolni o'zi beradi va tizimdan tashqari yetkazadi. " +
      "Javobda ham, audit yozuvida ham parol qaytarilmaydi: JSON'da qaytarilgan " +
      'parol logga, proksi keshiga va skrinshotga tushadi. Barcha sessiyalar ' +
      'bekor qilinadi.',
  })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.assignments.resetPassword(id, dto, user);
  }

  @Post(':id/revoke-sessions')
  @RequirePermissions('employees.manage')
  @ApiOperation({
    summary: 'Barcha qurilmalardan chiqarish',
    description:
      "Refresh tokenlarni bekor qilishning o'zi joriy access tokenni tirik " +
      'qoldirardi, shuning uchun token versiyasi ham oshiriladi — "hozir" degani ' +
      "haqiqatan hozir bo'lishi uchun.",
  })
  revokeSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.assignments.revokeSessions(id, user);
  }

  @Get(':id/activity')
  @RequirePermissions('employees.read')
  @ApiOperation({
    summary: 'Faoliyat xulosasi',
    description:
      "Savdo, qaytarish, smena va qoldiq tuzatishlari bo'yicha jamlanma. Satrlar " +
      'emas, agregatlar: savol "bu kassir sotyaptimi" va "qancha chegirma berdi".',
  })
  activity(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.assignments.activity(id, from, to);
  }
}
