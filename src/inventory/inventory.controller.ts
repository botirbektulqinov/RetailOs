import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { AdjustStockDto, ListMovementsDto, ListStockDto } from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@ApiBearerAuth('bearer')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('inventory.read')
  @ApiOperation({
    summary: 'Qoldiqlar',
    description:
      "Har bir variant bo'yicha qoldiq. warehouseId yoki storeId bilan cheklanadi, " +
      "aks holda barcha omborlar yig'indisi. Hech qachon qoldig'i bo'lmagan variant ham " +
      "ro'yxatda bo'ladi — aynan o'shalar buyurtma qilinishi kerak. " +
      'Barcha filtrlar, LOW_STOCK ham, bazada hisoblanadi.',
  })
  list(@Query() query: ListStockDto) {
    return this.inventory.list(query);
  }

  @Get('movements')
  @RequirePermissions('inventory.read')
  @ApiOperation({
    summary: 'Qoldiq harakatlari',
    description:
      "Append-only daftar. Har bir satr qaysi hujjat sababli yozilganini ko'rsatadi " +
      '(sourceType + sourceId), shuning uchun har qanday raqam bitta so‘rovda hujjatgacha ' +
      'kuzatiladi.',
  })
  movements(@Query() query: ListMovementsDto) {
    return this.inventory.movements(query);
  }

  @Get(':variantId')
  @RequirePermissions('inventory.read')
  @ApiOperation({
    summary: 'Variant qoldig‘i omborlar kesimida',
    description: 'Jami, har bir ombordagi miqdor va har biri uchun holat.',
  })
  findOne(@Param('variantId', ParseUUIDPipe) variantId: string) {
    return this.inventory.findOne(variantId);
  }

  @Post('adjustments')
  @RequirePermissions('inventory.adjust')
  @ApiOperation({
    summary: 'Qoldiqni qo‘lda tuzatish',
    description:
      "Ishorali miqdor: musbat — qo'shish, manfiy — ayirish. Sabab majburiy va bazada " +
      'tekshiriladi. Hamma satr bitta tranzaksiyada — yoki hammasi, yoki hech biri.',
  })
  @ApiConflictResponse({ description: 'INSUFFICIENT_STOCK · WAREHOUSE_ARCHIVED' })
  adjust(@Body() dto: AdjustStockDto, @CurrentUser() user: TenantContext) {
    return this.inventory.adjust(dto, user);
  }
}
