import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, ListCategoriesDto, UpdateCategoryDto } from './dto/category.dto';

@ApiTags('categories')
@ApiBearerAuth('bearer')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: 'Kategoriyalar',
    description:
      "Standart holatda daraxt ko'rinishida, har bir kategoriya uchun mahsulotlar soni bilan. " +
      "Butun daraxt bitta so'rovda yig'iladi — N+1 yo'q. flat=true tekis ro'yxat qaytaradi.",
  })
  list(@Query() query: ListCategoriesDto) {
    return this.categories.list(query);
  }

  @Get(':id')
  @RequirePermissions('products.read')
  @ApiOperation({ summary: 'Kategoriya tafsiloti' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.categories.findOne(id, user);
  }

  @Post()
  @RequirePermissions('products.create')
  @ApiOperation({ summary: 'Yangi kategoriya' })
  @ApiConflictResponse({ description: 'CATEGORY_NAME_TAKEN · CATEGORY_TOO_DEEP' })
  create(@Body() dto: CreateCategoryDto, @CurrentUser() user: TenantContext) {
    return this.categories.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('products.update')
  @ApiOperation({
    summary: "Kategoriyani tahrirlash yoki ko'chirish",
    description:
      "Ota-ona o'zgarsa, ichki kategoriyalarning yo'li ham qayta hisoblanadi. " +
      "Halqa hosil qiluvchi ko'chirish rad etiladi.",
  })
  @ApiConflictResponse({ description: 'CATEGORY_CYCLE · CATEGORY_TOO_DEEP · CATEGORY_NAME_TAKEN' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.categories.update(id, dto, user);
  }

  @Patch(':id/archive')
  @RequirePermissions('products.delete')
  @ApiOperation({
    summary: 'Kategoriyani arxivlash',
    description:
      "O'chirilmaydi — tarixiy mahsulotlar unga havola qiladi. " +
      "Ichida kategoriya yoki mahsulot bo'lsa rad etiladi.",
  })
  @ApiConflictResponse({ description: 'CATEGORY_HAS_CHILDREN · CATEGORY_HAS_PRODUCTS' })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.categories.archive(id, user);
  }

  @Patch(':id/restore')
  @RequirePermissions('products.update')
  @ApiOperation({ summary: 'Arxivdan tiklash' })
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.categories.restore(id, user);
  }
}
