import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CashService } from './cash.service';
import {
  CashMovementDto,
  CloseShiftDto,
  CreateRegisterDto,
  ListShiftsDto,
  OpenShiftDto,
  UpdateRegisterDto,
} from './dto/cash.dto';

@ApiTags('cash-registers')
@ApiBearerAuth('bearer')
@Controller('cash-registers')
export class CashRegistersController {
  constructor(private readonly cash: CashService) {}

  @Get()
  @RequirePermissions('cash.read')
  @ApiOperation({
    summary: 'Kassalar',
    description: "Har biri uchun ochiq smena ham qaytadi — POS sotishdan oldin shuni so'raydi.",
  })
  list(@Query('storeId') storeId?: string) {
    return this.cash.listRegisters(storeId);
  }

  @Post()
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Yangi kassa' })
  @ApiConflictResponse({ description: 'DUPLICATE_RESOURCE' })
  create(@Body() dto: CreateRegisterDto, @CurrentUser() user: TenantContext) {
    return this.cash.createRegister(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Kassani tahrirlash' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRegisterDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.cash.updateRegister(id, dto, user);
  }

  @Patch(':id/archive')
  @RequirePermissions('stores.manage')
  @ApiOperation({
    summary: 'Kassani arxivlash',
    description: 'Ochiq smenasi bor kassa arxivlanmaydi — pul ichida qolib ketardi.',
  })
  @ApiConflictResponse({ description: 'SHIFT_STILL_OPEN' })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.cash.archiveRegister(id, user);
  }
}

@ApiTags('shifts')
@ApiBearerAuth('bearer')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly cash: CashService) {}

  @Get()
  @RequirePermissions('cash.read')
  @ApiOperation({ summary: 'Smenalar' })
  list(@Query() query: ListShiftsDto) {
    return this.cash.listShifts(query);
  }

  @Get('current')
  @RequirePermissions('cash.read')
  @ApiOperation({
    summary: "Joriy do'konning ochiq smenasi",
    description: "Ochiq smena bo'lmasa null qaytadi — bu xato emas.",
  })
  current(@CurrentUser() user: TenantContext) {
    return this.cash.currentShift(user.storeId);
  }

  @Get(':id/report')
  @RequirePermissions('cash.read')
  @ApiOperation({
    summary: 'Z-hisobot',
    description:
      "Har bir raqam smenaning o'z to'lovlari, savdolari va harakatlaridan hisoblanadi. " +
      "Hech narsa oldindan hisoblanmaydi: smena ma'lumoti kichik, eskirgan hisobot esa " +
      'sekin hisobotdan yomonroq. Kassa ochiq ekan kutilgan naqd jonli hisoblanadi; ' +
      'yopilgandan keyin — kassir imzo chekkan raqam.',
  })
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.cash.report(id);
  }

  @Post()
  @RequirePermissions('cash.open_shift')
  @ApiOperation({
    summary: 'Smena ochish',
    description:
      'Bitta kassada bir vaqtda faqat bitta ochiq smena — buni baza indeksi kafolatlaydi, ' +
      'xizmat metodi emas.',
  })
  @ApiConflictResponse({ description: 'SHIFT_ALREADY_OPEN · REGISTER_ARCHIVED' })
  open(@Body() dto: OpenShiftDto, @CurrentUser() user: TenantContext) {
    return this.cash.open(dto, user);
  }

  @Post(':id/movements')
  @RequirePermissions('cash.movement')
  @ApiOperation({
    summary: 'Kassa harakati',
    description:
      "Faqat qo'lda kiritiladigan harakatlar: seyfga topshirish, mayda xarajat, tuzatish. " +
      "Savdo, qaytarish va qarz yig'ish bu yerda yozilmaydi — ular to'lov yozuvlari va " +
      "kutilgan naqd ularni allaqachon o'qiydi; ikki marta yozish har so'mni ikkilantirardi.",
  })
  @ApiConflictResponse({ description: 'INSUFFICIENT_CASH_IN_DRAWER · SHIFT_ALREADY_CLOSED' })
  movement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CashMovementDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.cash.movement(id, dto, user);
  }

  @Post(':id/close')
  @RequirePermissions('cash.close_shift')
  @ApiOperation({
    summary: 'Smenani yopish',
    description:
      'Kutilgan naqd hisoblanadi, sanalgan bilan solishtiriladi, farq saqlanadi — ' +
      'manfiy kam, musbat ortiq, ikkalasi ham jimgina tuzatilmaydi. Tugallanmagan ' +
      'savdo qolgan bo‘lsa rad etiladi.',
  })
  @ApiConflictResponse({ description: 'SHIFT_ALREADY_CLOSED · OPEN_DRAFTS_EXIST' })
  close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.cash.close(id, dto, user);
  }
}
