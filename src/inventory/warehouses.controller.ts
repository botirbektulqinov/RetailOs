import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CreateWarehouseDto, ListWarehousesDto, UpdateWarehouseDto } from './dto/inventory.dto';
import { WarehousesService } from './warehouses.service';

@ApiTags('warehouses')
@ApiBearerAuth('bearer')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  // Reading warehouses is reading stock structure, so it rides on
  // inventory.read rather than a new permission nobody's role has yet.
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Omborlar' })
  list(@Query() query: ListWarehousesDto) {
    return this.warehouses.list(query);
  }

  @Get(':id')
  @RequirePermissions('inventory.read')
  @ApiOperation({ summary: 'Ombor tafsiloti', description: 'Qoldiq jamlanmasi bilan.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.warehouses.findOne(id);
  }

  @Post()
  // Creating one changes how a store is structured, which is stores.manage.
  @RequirePermissions('stores.manage')
  @ApiOperation({
    summary: 'Yangi ombor',
    description: "storeId bo'sh bo'lsa — markaziy ombor, hech qaysi filialga biriktirilmagan.",
  })
  @ApiConflictResponse({ description: 'DUPLICATE_RESOURCE' })
  create(@Body() dto: CreateWarehouseDto, @CurrentUser() user: TenantContext) {
    return this.warehouses.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Omborni tahrirlash' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.warehouses.update(id, dto, user);
  }

  @Patch(':id/archive')
  @RequirePermissions('stores.manage')
  @ApiOperation({
    summary: 'Omborni arxivlash',
    description:
      "O'chirilmaydi — har bir harakat unga havola qiladi. Qoldig'i bor ombor arxivlanmaydi.",
  })
  @ApiConflictResponse({ description: 'WAREHOUSE_HAS_STOCK' })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.warehouses.archive(id, user);
  }

  @Patch(':id/restore')
  @RequirePermissions('stores.manage')
  @ApiOperation({ summary: 'Arxivdan tiklash' })
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.warehouses.restore(id, user);
  }
}
