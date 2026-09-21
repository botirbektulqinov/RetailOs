import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CreateTransferDto, ListTransfersDto, ReceiveTransferDto } from './dto/inventory.dto';
import { TransfersService } from './transfers.service';

@ApiTags('transfers')
@ApiBearerAuth('bearer')
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Transferlar' })
  list(@Query() query: ListTransfersDto) {
    return this.transfers.list(query);
  }

  @Get(':id')
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Transfer tafsiloti' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.findOne(id);
  }

  @Post()
  @RequirePermissions('inventory.transfer')
  @ApiOperation({
    summary: 'Transfer yaratish va yuborish',
    description:
      "Qoldiq darhol manba ombordan chiqadi — yo'ldagi tovar hech qaysi omborning " +
      "sotiladigan qoldig'i emas. Mavjuddan ko'p yuborish rad etiladi.",
  })
  @ApiConflictResponse({
    description: 'INSUFFICIENT_STOCK · TRANSFER_SAME_WAREHOUSE · WAREHOUSE_ARCHIVED',
  })
  create(@Body() dto: CreateTransferDto, @CurrentUser() user: TenantContext) {
    return this.transfers.create(dto, user);
  }

  @Post(':id/receive')
  @RequirePermissions('inventory.transfer')
  @ApiOperation({
    summary: 'Transferni qabul qilish',
    description:
      "items berilmasa — hammasi to'liq keldi deb hisoblanadi. Kam kelgan bo'lsa izoh " +
      'majburiy. Kam kelgan farq manbadan qayta ayirilmaydi: u allaqachon yuborishda ' +
      'chiqarilgan.',
  })
  @ApiConflictResponse({ description: 'TRANSFER_NOT_SENT' })
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceiveTransferDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.transfers.receive(id, dto, user);
  }

  @Post(':id/cancel')
  @RequirePermissions('inventory.transfer')
  @ApiOperation({
    summary: 'Transferni bekor qilish',
    description: "Tovar manba omborga TRANSFER_IN sifatida qaytadi — daftar o'chirilmaydi.",
  })
  @ApiConflictResponse({ description: 'TRANSFER_NOT_SENT' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.transfers.cancel(id, user);
  }
}
