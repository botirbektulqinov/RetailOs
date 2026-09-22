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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { requireIdempotencyKey } from '../common/idempotency/idempotency-key';
import type { TenantContext } from '../common/tenant/tenant-context';
import {
  CancelPurchaseDto,
  CreatePurchaseDto,
  CreateSupplierDto,
  ListPurchasesDto,
  ListSuppliersDto,
  ReceivePurchaseDto,
  SupplierPaymentDto,
  UpdatePurchaseDto,
  UpdateSupplierDto,
} from './dto/purchase.dto';
import { PurchasesService } from './purchases.service';
import { SuppliersService } from './suppliers.service';

@ApiTags('suppliers')
@ApiBearerAuth('bearer')
@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly purchases: PurchasesService,
  ) {}

  @Get()
  @RequirePermissions('suppliers.read')
  @ApiOperation({
    summary: "Ta'minotchilar",
    description:
      "Har bir satrda qarzdorlik: hisob-fakturalar bo'yicha qolgan summa minus " +
      "hujjatga biriktirilmagan oldindan to'lov. Hammasi bitta so'rovda.",
  })
  list(@Query() query: ListSuppliersDto, @CurrentUser() user: TenantContext) {
    return this.suppliers.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('suppliers.read')
  @ApiOperation({ summary: "Ta'minotchi kartasi", description: 'Qarzdorlik balansi bilan.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.findOne(id);
  }

  @Get(':id/balance')
  @RequirePermissions('suppliers.read')
  @ApiOperation({
    summary: 'Qarzdorlik',
    description:
      "Har safar hujjatlardan hisoblanadi. supplier.balance ustuni yo'q — " +
      "o'zgaruvchan balans o'z tarixi bilan jimgina ziddiyatga tushadi.",
  })
  balance(@Param('id', ParseUUIDPipe) id: string) {
    return this.suppliers.balanceOf(id);
  }

  @Get(':id/purchases')
  @RequirePermissions('purchases.read')
  @ApiOperation({ summary: "Ta'minotchining xaridlari" })
  purchasesOf(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListPurchasesDto) {
    return this.purchases.list({ ...query, supplierId: id });
  }

  @Get(':id/payments')
  @RequirePermissions('purchases.read')
  @ApiOperation({ summary: "To'lovlar tarixi" })
  paymentsOf(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListQueryDto) {
    return this.suppliers.payments(id, query.limit, query.offset);
  }

  @Get(':id/statement')
  @RequirePermissions('purchases.read')
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiOperation({
    summary: 'Hisobot varaqasi',
    description:
      "Xaridlar (debet) va to'lovlar (kredit) xronologik tartibda, yuguruvchi qoldiq " +
      "bilan. Bitta UNION ALL dan quriladi — orqasida hech qanday jadval yo'q.",
  })
  statement(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.suppliers.statement(id, from, to);
  }

  @Post()
  @RequirePermissions('suppliers.create')
  @ApiOperation({ summary: "Yangi ta'minotchi" })
  @ApiConflictResponse({ description: 'DUPLICATE_RESOURCE' })
  create(@Body() dto: CreateSupplierDto, @CurrentUser() user: TenantContext) {
    return this.suppliers.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('suppliers.update')
  @ApiOperation({ summary: "Ta'minotchini tahrirlash" })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.suppliers.update(id, dto, user);
  }

  @Patch(':id/archive')
  @RequirePermissions('suppliers.update')
  @ApiOperation({
    summary: "Ta'minotchini arxivlash",
    description: "Qarzdorligimiz bor ta'minotchi arxivlanmaydi.",
  })
  @ApiConflictResponse({ description: 'SUPPLIER_HAS_PAYABLE' })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.suppliers.archive(id, user);
  }

  @Patch(':id/restore')
  @RequirePermissions('suppliers.update')
  @ApiOperation({ summary: 'Arxivdan tiklash' })
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.suppliers.restore(id, user);
  }

  @Post('payments')
  @RequirePermissions('purchases.pay')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4.' })
  @ApiOperation({
    summary: "Ta'minotchiga to'lov",
    description:
      'purchaseId berilsa — aniq hisob-fakturaga, uning jamidan oshmaydigan qilib. ' +
      "Berilmasa — hisobga to'lov: umumiy qarzdorlikni kamaytiradi va biriktirilmagan " +
      "kredit sifatida ko'rinadi. To'lov yozuvi o'zgartirilmaydi.",
  })
  @ApiConflictResponse({ description: 'SUPPLIER_OVERPAYMENT' })
  pay(
    @Body() dto: SupplierPaymentDto,
    @CurrentUser() user: TenantContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.suppliers.pay(dto, user, requireIdempotencyKey(key));
  }
}

@ApiTags('purchases')
@ApiBearerAuth('bearer')
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  @RequirePermissions('purchases.read')
  @ApiOperation({ summary: 'Xaridlar' })
  list(@Query() query: ListPurchasesDto) {
    return this.purchases.list(query);
  }

  @Get(':id')
  @RequirePermissions('purchases.read')
  @ApiOperation({ summary: 'Xarid tafsiloti' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchases.findOne(id);
  }

  @Post()
  @RequirePermissions('purchases.create')
  @ApiOperation({
    summary: 'Yangi buyurtma',
    description:
      "order=true bo'lsa DRAFT bosqichisiz darhol ORDERED bo'ladi. Summalarni server " +
      'hisoblaydi: satr summasi bir marta yaxlitlanadi, chegirma va yetkazib berish ' +
      'sarlavhada qoladi va tannarxga taqsimlanmaydi (§15.5).',
  })
  create(@Body() dto: CreatePurchaseDto, @CurrentUser() user: TenantContext) {
    return this.purchases.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('purchases.create')
  @ApiOperation({
    summary: 'Buyurtmani tahrirlash',
    description: "Faqat DRAFT holatida — yuborilgan buyurtma o'zgartirilmaydi.",
  })
  @ApiConflictResponse({ description: 'PURCHASE_NOT_DRAFT' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.purchases.update(id, dto, user);
  }

  @Post(':id/order')
  @RequirePermissions('purchases.create')
  @ApiOperation({ summary: "Buyurtmani ta'minotchiga yuborish" })
  @ApiConflictResponse({ description: 'PURCHASE_NOT_DRAFT' })
  order(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.purchases.order(id, user);
  }

  @Post(':id/receive')
  @RequirePermissions('purchases.receive')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4.' })
  @ApiOperation({
    summary: 'Tovarni qabul qilish',
    description:
      'Takrorlanadi: bitta buyurtmaga uch marta yetkazilsa — uch marta chaqiriladi. ' +
      'items berilmasa qolgan hamma miqdor qabul qilingan deb hisoblanadi. ' +
      "Buyurtmadan ko'p qabul qilish rad etiladi — bu xarid tuzatishi, avtomatik " +
      'miqdor oshirish emas.',
  })
  @ApiConflictResponse({
    description: 'OVER_RECEIPT · PURCHASE_NOT_RECEIVABLE · NOTHING_TO_RECEIVE',
  })
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePurchaseDto,
    @CurrentUser() user: TenantContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.purchases.receive(id, dto, user, requireIdempotencyKey(key));
  }

  @Post(':id/cancel')
  @RequirePermissions('purchases.cancel')
  @ApiOperation({
    summary: 'Buyurtmani bekor qilish',
    description:
      "Faqat hech narsa qabul qilinmagan va to'lanmagan bo'lsa. Tovar kelgandan keyin " +
      "bekor qilish — yo arvoh qoldiq, yo haqiqiy qoldiqni jimgina o'chirish.",
  })
  @ApiConflictResponse({ description: 'PURCHASE_HAS_RECEIPTS · PURCHASE_HAS_PAYMENTS' })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelPurchaseDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.purchases.cancel(id, dto, user);
  }
}
