import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { ListQueryDto } from '../common/dto/list-query.dto';
import type { TenantContext } from '../common/tenant/tenant-context';
import {
  AdjustPointsDto,
  CreatePromotionDto,
  ListPromotionsDto,
  UpdatePromotionDto,
} from './dto/loyalty.dto';
import { LoyaltyService } from './loyalty.service';
import { PromotionsService } from './promotions.service';

@ApiTags('promotions')
@ApiBearerAuth('bearer')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @RequirePermissions('promotions.read')
  @ApiOperation({
    summary: 'Aksiyalar',
    description: 'activeNow=true — hozir amal qilayotganlari.',
  })
  list(@Query() query: ListPromotionsDto) {
    return this.promotions.list(query);
  }

  @Get(':id')
  @RequirePermissions('promotions.read')
  @ApiOperation({ summary: 'Aksiya tafsiloti' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.findOne(id);
  }

  @Post()
  @RequirePermissions('promotions.manage')
  @ApiOperation({
    summary: 'Yangi aksiya',
    description:
      'ITEM — har bir mos qatorga, ORDER — butun chekka. Aksiyalar bir-birining ' +
      "ustiga qo'shilmaydi: har bir darajada bittasi yutadi (priority, keyin summa). " +
      "Yig'ish uchun birikuv matritsasi va qo'llash tartibi kerak — ularsiz kassir " +
      'narxni oldindan ayta olmaydi.',
  })
  @ApiConflictResponse({ description: 'DUPLICATE_RESOURCE' })
  create(@Body() dto: CreatePromotionDto, @CurrentUser() user: TenantContext) {
    return this.promotions.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('promotions.manage')
  @ApiOperation({ summary: 'Aksiyani tahrirlash' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.promotions.update(id, dto, user);
  }

  @Patch(':id/deactivate')
  @RequirePermissions('promotions.manage')
  @ApiOperation({
    summary: "Aksiyani o'chirish",
    description:
      "Yozuv o'chirilmaydi — savdolar qaysi aksiya narxlaganiga havola qiladi, va " +
      "keyin topib bo'lmaydigan kampaniya — tushuntirib bo'lmaydigan chegirma.",
  })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.promotions.deactivate(id, user);
  }
}

@ApiTags('loyalty')
@ApiBearerAuth('bearer')
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get(':customerId')
  @RequirePermissions('loyalty.read')
  @ApiOperation({
    summary: 'Ball balansi',
    description:
      'Balans — kesh; haqiqat esa daftar. redeemableAmount — shu ballar kassada ' +
      'qancha turishi, shunda POS konvertatsiya qoidasini bilishi shart emas.',
  })
  balance(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.loyalty.balance(customerId);
  }

  @Get(':customerId/history')
  @RequirePermissions('loyalty.read')
  @ApiOperation({
    summary: 'Ballar tarixi',
    description: "Append-only daftar: har bir satr o'zidan keyingi balansni saqlaydi.",
  })
  history(@Param('customerId', ParseUUIDPipe) customerId: string, @Query() query: ListQueryDto) {
    return this.loyalty.history(customerId, query.limit, query.offset);
  }

  @Post(':customerId/adjust')
  @RequirePermissions('loyalty.adjust')
  @ApiOperation({
    summary: 'Ballarni qo‘lda tuzatish',
    description: 'Sabab majburiy va bazada tekshiriladi.',
  })
  @ApiConflictResponse({ description: 'INSUFFICIENT_POINTS' })
  adjust(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: AdjustPointsDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.loyalty.adjust(customerId, dto, user);
  }
}
