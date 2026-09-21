import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CountsService } from './counts.service';
import {
  CreateCountDto,
  FinalizeCountDto,
  ListCountsDto,
  SubmitCountDto,
} from './dto/inventory.dto';

@ApiTags('inventory-counts')
@ApiBearerAuth('bearer')
@Controller('inventory-counts')
export class CountsController {
  constructor(private readonly counts: CountsService) {}

  @Get()
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Inventarizatsiyalar' })
  list(@Query() query: ListCountsDto) {
    return this.counts.list(query);
  }

  @Get(':id')
  @RequirePermissions('inventory.read')
  @ApiOperation({
    summary: 'Inventarizatsiya tafsiloti',
    description:
      'Har bir satr uchun kutilgan, sanalgan va farq. Yakunlangandan keyin appliedDelta ' +
      "ham bo'ladi — bu jonli qoldiqqa nisbatan haqiqatda qo'llangan tuzatish.",
  })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.counts.findOne(id);
  }

  @Post()
  @RequirePermissions('inventory.count')
  @ApiOperation({
    summary: 'Sanoq ochish',
    description:
      'Satrlar joriy qoldiqdan suratga olinadi. Bitta omborda bir vaqtda faqat bitta ' +
      'ochiq sanoq bo‘lishi mumkin — buni baza indeksi kafolatlaydi.',
  })
  @ApiConflictResponse({ description: 'COUNT_ALREADY_OPEN · COUNT_EMPTY · WAREHOUSE_ARCHIVED' })
  create(@Body() dto: CreateCountDto, @CurrentUser() user: TenantContext) {
    return this.counts.create(dto, user);
  }

  @Patch(':id/items')
  @RequirePermissions('inventory.count')
  @ApiOperation({
    summary: 'Sanalgan miqdorlarni kiritish',
    description: 'Qayta yuborilsa ustiga yoziladi. Qoldiq bu bosqichda qimirlamaydi.',
  })
  @ApiConflictResponse({ description: 'COUNT_NOT_OPEN' })
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitCountDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.counts.submit(id, dto, user);
  }

  @Post(':id/finalize')
  @RequirePermissions('inventory.count')
  @ApiOperation({
    summary: 'Sanoqni yakunlash',
    description:
      "Tuzatishlar bitta tranzaksiyada qo'llanadi. Farq jonli qoldiqqa nisbatan " +
      'hisoblanadi, suratga olingan qiymatga emas — aks holda sanoq davomida ' +
      "qilingan har bir savdo bekor bo'lardi. Sanalmagan satrlar o'tkazib yuboriladi.",
  })
  @ApiConflictResponse({ description: 'COUNT_NOT_OPEN · INSUFFICIENT_STOCK' })
  finalize(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FinalizeCountDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.counts.finalize(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermissions('inventory.count')
  @ApiOperation({ summary: 'Sanoqni bekor qilish', description: 'Qoldiqqa ta’sir qilmaydi.' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.counts.cancel(id, user);
  }
}
