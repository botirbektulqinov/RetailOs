import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { requireIdempotencyKey } from '../common/idempotency/idempotency-key';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CustomersService } from './customers.service';
import { DebtsService } from './debts.service';
import {
  AddNoteDto,
  CreateCustomerDto,
  CreateDebtDto,
  CreateGroupDto,
  DebtPaymentDto,
  ListCustomersDto,
  ListDebtsDto,
  UpdateCustomerDto,
  UpdateGroupDto,
  WriteOffDto,
} from './dto/customer.dto';

@ApiTags('customers')
@ApiBearerAuth('bearer')
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly debts: DebtsService,
  ) {}

  @Get()
  @RequirePermissions('customers.read')
  @ApiOperation({
    summary: 'Mijozlar',
    description:
      "Har bir satrda qarz qoldig'i va savdo tarixi bor — hammasi bitta so'rovda " +
      "hisoblanadi, N+1 yo'q. hasDebt va overdue filtrlari, debt bo'yicha saralash.",
  })
  list(@Query() query: ListCustomersDto, @CurrentUser() user: TenantContext) {
    return this.customers.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('customers.read')
  @ApiOperation({
    summary: 'Mijoz kartasi',
    description: 'Profil, amaldagi qarz chegarasi, balans va izohlar.',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(id);
  }

  @Get(':id/balance')
  @RequirePermissions('debt.read')
  @ApiOperation({
    summary: 'Qarz balansi',
    description:
      "Har safar qarz hujjatlaridan hisoblanadi. customer.debt ustuni yo'q va " +
      "bo'lmaydi — o'zgaruvchan balans o'zi umumlashtirgan hujjatlardan uzoqlashadi.",
  })
  balance(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.balanceOf(id);
  }

  @Get(':id/sales')
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'Mijozning savdolari' })
  sales(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListQueryDto) {
    return this.customers.sales(id, query.limit, query.offset);
  }

  @Get(':id/payments')
  @RequirePermissions('debt.read')
  @ApiOperation({
    summary: "To'lovlar tarixi",
    description: "Har bir to'lov nimani yopganini ko'rsatadi — savdoni yoki qarzni.",
  })
  payments(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListQueryDto) {
    return this.customers.payments(id, query.limit, query.offset);
  }

  @Get(':id/debts')
  @RequirePermissions('debt.read')
  @ApiOperation({ summary: 'Mijozning qarzlari' })
  debtsOf(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListDebtsDto) {
    return this.debts.list({ ...query, customerId: id });
  }

  @Post()
  @RequirePermissions('customers.create')
  @ApiOperation({ summary: 'Yangi mijoz' })
  @ApiConflictResponse({ description: 'PHONE_ALREADY_USED' })
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: TenantContext) {
    return this.customers.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('customers.update')
  @ApiOperation({ summary: 'Mijozni tahrirlash' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.customers.update(id, dto, user);
  }

  @Post(':id/notes')
  @RequirePermissions('customers.update')
  @ApiOperation({
    summary: "Izoh qo'shish",
    description:
      "Izohlar jurnal — qo'shiladi, tahrirlanmaydi. \"Qo'ng'iroq qilindi, juma kuni " +
      "to'lashga va'da berdi\" yozuvi va'da bajarilmaganda eng muhim yozuvga aylanadi.",
  })
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.customers.addNote(id, dto, user);
  }

  @Patch(':id/archive')
  @RequirePermissions('customers.delete')
  @ApiOperation({
    summary: 'Mijozni arxivlash',
    description:
      "O'chirilmaydi — savdolari va qarzlari unga havola qiladi. Qarzi bor mijoz " +
      "arxivlanmaydi: qarzdorni yashirish — qarzni undirishni to'xtatishning eng " +
      "oson yo'li.",
  })
  @ApiConflictResponse({ description: 'CUSTOMER_HAS_DEBT' })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.customers.archive(id, user);
  }

  @Patch(':id/restore')
  @RequirePermissions('customers.update')
  @ApiOperation({ summary: 'Arxivdan tiklash' })
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.customers.restore(id, user);
  }
}

@ApiTags('customer-groups')
@ApiBearerAuth('bearer')
@Controller('customer-groups')
export class CustomerGroupsController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customers.read')
  @ApiOperation({ summary: 'Mijozlar guruhlari', description: 'VIP, Ulgurji, Doimiy.' })
  list() {
    return this.customers.listGroups();
  }

  @Post()
  @RequirePermissions('customers.update')
  @ApiOperation({ summary: 'Yangi guruh' })
  @ApiConflictResponse({ description: 'DUPLICATE_RESOURCE' })
  create(@Body() dto: CreateGroupDto, @CurrentUser() user: TenantContext) {
    return this.customers.createGroup(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('customers.update')
  @ApiOperation({ summary: 'Guruhni tahrirlash' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGroupDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.customers.updateGroup(id, dto, user);
  }
}

@ApiTags('debts')
@ApiBearerAuth('bearer')
@Controller('debts')
export class DebtsController {
  constructor(private readonly debts: DebtsService) {}

  @Get()
  @RequirePermissions('debt.read')
  @ApiOperation({
    summary: 'Qarzlar',
    description:
      'filter: overdue | due_today | due_soon | unpaid | partially_paid | paid | ' +
      "written_off. OVERDUE holat emas — u so'rovda hisoblanadi, chunki holat " +
      "bo'lsa uni har kecha yangilaydigan ish kerak bo'lardi va u ishlamaguncha " +
      "har bir satr yolg'on gapirardi.",
  })
  list(@Query() query: ListDebtsDto) {
    return this.debts.list(query);
  }

  @Get(':id')
  @RequirePermissions('debt.read')
  @ApiOperation({
    summary: 'Qarz tafsiloti',
    description: "To'lovlar tarixi bilan. Tarix hech qachon qayta yozilmaydi.",
  })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.debts.findOne(id);
  }

  @Post()
  @RequirePermissions('debt.create')
  @ApiOperation({
    summary: 'Qo‘lda qarz yoki boshlang‘ich qoldiq',
    description:
      'Savdodan kelgan qarz bu yerda yaratilmaydi — u checkout tranzaksiyasi ichida, ' +
      "o'zini keltirib chiqargan savdo bilan birga tug'iladi.",
  })
  create(@Body() dto: CreateDebtDto, @CurrentUser() user: TenantContext) {
    return this.debts.create(dto, user);
  }

  @Post('payments')
  @RequirePermissions('debt.pay')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4.' })
  @ApiOperation({
    summary: "Qarz to'lovi",
    description:
      "Bitta to'lov bir nechta qarzni yopishi mumkin. receivableIds berilmasa " +
      "muddati eng yaqin qarzdan boshlab taqsimlanadi. Qarzdan ortiq to'lov rad " +
      'etiladi, yutib yuborilmaydi.',
  })
  @ApiConflictResponse({ description: 'RECEIVABLE_OVERPAYMENT · NO_OPEN_RECEIVABLE' })
  pay(
    @Body() dto: DebtPaymentDto,
    @CurrentUser() user: TenantContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.debts.pay(dto, user, requireIdempotencyKey(key));
  }

  @Post(':id/write-off')
  @RequirePermissions('debt.write_off')
  @ApiOperation({
    summary: 'Qarzni hisobdan chiqarish',
    description:
      "Sabab majburiy. Hech qachon to'langan summaga qo'shilmaydi: hisobdan " +
      'chiqarish — zarar, undirish — tushum, ularni aralashtirgan hisobot zararni ' +
      'yashiradi.',
  })
  @ApiConflictResponse({ description: 'RECEIVABLE_CLOSED · RECEIVABLE_OVERPAYMENT' })
  writeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WriteOffDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.debts.writeOff(id, dto, user);
  }
}
