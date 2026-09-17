import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../../common/tenant/tenant-context';
import {
  CreateProductDto,
  CreateVariantDto,
  ListProductsDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product.dto';
import { ProductsService } from './products.service';

@ApiTags('products')
@ApiBearerAuth('bearer')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: "Mahsulotlar ro'yxati",
    description:
      "Qidiruv nom, brend, SKU va shtrix-kod bo'yicha — barchasi bazada filtrlanadi. " +
      "Saralash faqat ruxsat etilgan maydonlar bo'yicha; limit 100 bilan cheklangan.",
  })
  list(@Query() query: ListProductsDto) {
    return this.products.list(query);
  }

  // Declared before ':id' so the literal path is not swallowed by the
  // parameter route.
  @Get('lookup')
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: "Shtrix-kod bo'yicha qidirish (POS)",
    description:
      'Bitta indeks o‘qishi: (organization_id, barcode). POS skaneri uchun. ' +
      'Arxivlangan yoki faol bo‘lmagan mahsulot topilmaydi.',
  })
  @ApiQuery({ name: 'barcode', example: '4780012345678' })
  @ApiNotFoundResponse({
    description: "RESOURCE_NOT_FOUND — bu shtrix-kod bo'yicha mahsulot yo'q.",
  })
  lookup(@Query('barcode') barcode: string) {
    return this.products.lookupByBarcode(barcode ?? '');
  }

  @Get(':id')
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: 'Mahsulot tafsiloti',
    description: 'Variantlar va ulardan hosil qilingan tanlovlar bilan. Qoldiq — 4-sprint.',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.findOne(id);
  }

  @Post()
  @RequirePermissions('products.create')
  @ApiOperation({
    summary: 'Yangi mahsulot',
    description:
      'Mahsulot va uning birinchi (standart) varianti bitta tranzaksiyada yaratiladi. ' +
      'Oddiy mahsulot uchun mijoz variantlar borligini bilishi shart emas.',
  })
  @ApiConflictResponse({ description: 'SKU_ALREADY_USED · BARCODE_ALREADY_USED' })
  create(@Body() dto: CreateProductDto, @CurrentUser() user: TenantContext) {
    return this.products.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('products.update')
  @ApiOperation({
    summary: 'Mahsulotni tahrirlash',
    description:
      'version yuborilsa optimistik qulf ishlaydi. ' +
      "Narx o'zgarishi alohida audit hodisasi sifatida yoziladi.",
  })
  @ApiConflictResponse({ description: 'CONCURRENT_MODIFICATION · SKU_ALREADY_USED' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.products.update(id, dto, user);
  }

  @Patch(':id/archive')
  @RequirePermissions('products.delete')
  @ApiOperation({
    summary: 'Mahsulotni arxivlash',
    description:
      "O'chirilmaydi. Savdolar, xaridlar va qoldiq harakatlari unga abadiy havola qiladi — " +
      "o'tgan yilgi chek nima sotilganini ko'rsata olishi kerak. " +
      "Arxivlash SKU va shtrix-kodni qayta ishlatish uchun bo'shatadi.",
  })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.products.archive(id, user);
  }

  @Patch(':id/restore')
  @RequirePermissions('products.update')
  @ApiOperation({
    summary: 'Arxivdan tiklash',
    description: "SKU yoki shtrix-kodni shu orada boshqa mahsulot egallagan bo'lsa — 409.",
  })
  @ApiConflictResponse({ description: 'SKU_ALREADY_USED · BARCODE_ALREADY_USED' })
  restore(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantContext) {
    return this.products.restore(id, user);
  }

  // ── Variants ─────────────────────────────────────────────────────────────

  @Get(':id/variants')
  @RequirePermissions('products.read')
  @ApiOperation({
    summary: 'Mahsulot variantlari',
    description: 'Variantlar va ulardan hosil qilingan tanlovlar (Rang, O‘lcham).',
  })
  listVariants(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.listVariants(id);
  }

  @Post(':id/variants')
  @RequirePermissions('products.update')
  @ApiOperation({
    summary: "Variant qo'shish",
    description: "Birinchi qo'shimcha variant mahsulotni variantli qiladi.",
  })
  @ApiConflictResponse({
    description: 'SKU_ALREADY_USED · BARCODE_ALREADY_USED · PRODUCT_ARCHIVED',
  })
  createVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVariantDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.products.createVariant(id, dto, user);
  }

  @Patch(':id/variants/:variantId')
  @RequirePermissions('products.update')
  @ApiOperation({ summary: 'Variantni tahrirlash' })
  @ApiConflictResponse({ description: 'SKU_ALREADY_USED · BARCODE_ALREADY_USED' })
  updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.products.updateVariant(id, variantId, dto, user);
  }

  @Patch(':id/variants/:variantId/archive')
  @RequirePermissions('products.update')
  @ApiOperation({
    summary: 'Variantni arxivlash',
    description: "Oxirgi variantni arxivlab bo'lmaydi — mahsulotning o'zini arxivlang.",
  })
  @ApiConflictResponse({ description: 'LAST_VARIANT' })
  archiveVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @CurrentUser() user: TenantContext,
  ) {
    return this.products.archiveVariant(id, variantId, user);
  }
}
