import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { UpdateStoreDto } from './dto/store.dto';
import { StoresService } from './stores.service';

@ApiTags('stores')
@ApiBearerAuth('bearer')
@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @ApiOperation({
    summary: "Mavjud do'konlar",
    description:
      "Faqat foydalanuvchi a'zo bo'lgan do'konlar. Ruxsat talab qilinmaydi — bu foydalanuvchining " +
      "o'z konteksti, va do'kon almashtirish uchun kerak.",
  })
  list(@CurrentUser() user: TenantContext) {
    return this.stores.listForUser(user);
  }

  @Get(':id')
  @RequirePermissions('stores.read')
  @ApiOperation({
    summary: "Do'kon ma'lumotlari",
    description:
      "Do'kon ekrani: filial kodi, manzil va rekvizitlar (yuridik nom, STIR, ish vaqti).",
  })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.stores.findOne(id, user);
  }

  @Patch(':id')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: "Do'kon ma'lumotlarini tahrirlash" })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStoreDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.stores.update(id, dto, user);
  }
}
