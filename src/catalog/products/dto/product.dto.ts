import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ListQueryDto } from '../../../common/dto/list-query.dto';

export const PRODUCT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const UNITS = ['PIECE', 'KG', 'LITRE', 'METRE', 'PACK'] as const;
export const PRODUCT_SORT_FIELDS = [
  'createdAt:desc',
  'createdAt:asc',
  'updatedAt:desc',
  'updatedAt:asc',
  'name:asc',
  'name:desc',
] as const;

export type ProductStatusValue = (typeof PRODUCT_STATUSES)[number];
export type UnitValue = (typeof UNITS)[number];

const toBoolean = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  );

/**
 * Money arrives as an integer number of minor units (UZS exponent 0), matching
 * how it is serialized back out. A decimal string would invite a float on the
 * client; a float would be wrong before it ever reached us.
 */
const MoneyProperty = (description: string, example: number) =>
  ApiProperty({
    type: Number,
    description: `${description} (eng kichik birlikda, UZS uchun so'm)`,
    example,
  });

export class ListProductsDto extends ListQueryDto {
  @ApiPropertyOptional({
    description: "Nom, brend, SKU yoki shtrix-kod bo'yicha qidiruv. Barchasi bazada filtrlanadi.",
    example: 'choy',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  // Initialised because the base class declares it too; without a value
  // useDefineForClassFields would leave the subclass field shadowing it.
  override q?: string = undefined;

  @ApiPropertyOptional({ enum: PRODUCT_SORT_FIELDS, default: 'createdAt:desc' })
  @IsOptional()
  @IsEnum(PRODUCT_SORT_FIELDS)
  override sort?: (typeof PRODUCT_SORT_FIELDS)[number] = undefined;

  @ApiPropertyOptional({ enum: PRODUCT_STATUSES })
  @IsOptional()
  @IsEnum(PRODUCT_STATUSES)
  status?: ProductStatusValue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'Artel' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional({ description: 'Faqat variantli / variantsiz mahsulotlar.' })
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  hasVariants?: boolean;

  @ApiPropertyOptional({ default: false, description: 'Arxivlanganlarni ham qaytarish.' })
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({ description: "Eng past sotuv narxi (so'm).", example: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ description: "Eng yuqori sotuv narxi (so'm).", example: 500000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;
}

/**
 * Creating a product also creates its first (default) variant, so the SKU,
 * barcode and prices live on this DTO even though they are stored on the
 * variant. The client never has to know that for a simple product.
 */
export class CreateProductDto {
  @ApiProperty({ example: 'Safia qora choy 100g' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 'Safia' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional({ description: 'Kategoriya. Bir tashkilot ichida bo‘lishi shart.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    example: 'CH-021',
    description: "Tashkilot ichida noyob. Saqlashda trim qilinadi va BOSH HARFGA o'tkaziladi.",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  sku!: string;

  @ApiPropertyOptional({
    example: '4780012345678',
    description:
      "Faqat raqamlar (6–20). Boshqa belgilar olib tashlanadi, bo'sh qolsa null bo'ladi.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[\d\s-]*$/, { message: 'Shtrix-kod faqat raqamlardan iborat bo‘lishi kerak' })
  @MaxLength(30)
  barcode?: string;

  @MoneyProperty('Sotuv narxi', 24000)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sellingPrice!: number;

  @ApiPropertyOptional({ type: Number, description: "Xarid narxi (so'm).", example: 17500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePrice?: number;

  @ApiPropertyOptional({
    example: '5.000',
    description: "Minimal qoldiq. O'nlik satr — 3 kasr xonagacha.",
  })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  minStock?: string;

  @ApiPropertyOptional({ enum: UNITS, default: 'PIECE' })
  @IsOptional()
  @IsEnum(UNITS)
  unit?: UnitValue;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description: 'Rasm URL manzillari. Fayllarning o‘zi obyekt xotirasida saqlanadi.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUrl({ require_tld: false }, { each: true })
  imageUrls?: string[];
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional({ description: "Bo'sh satr — kategoriyani olib tashlash." })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ enum: PRODUCT_STATUSES })
  @IsOptional()
  @IsEnum(PRODUCT_STATUSES)
  status?: ProductStatusValue;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUrl({ require_tld: false }, { each: true })
  imageUrls?: string[];

  @ApiPropertyOptional({
    type: Number,
    description: 'Sotuv narxi. Variantsiz mahsulot uchun standart variantga yoziladi.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sellingPrice?: number;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePrice?: number;

  @ApiPropertyOptional({ example: '5.000' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  minStock?: string;

  @ApiPropertyOptional({
    type: Number,
    description:
      "Optimistik qulf. Yuborilsa va mahsulot shu orada o'zgargan bo'lsa — 409 CONCURRENT_MODIFICATION.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version?: number;
}

export class CreateVariantDto {
  @ApiProperty({ example: 'FT-Q-S' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  sku!: string;

  @ApiPropertyOptional({ example: '4780012345679' })
  @IsOptional()
  @IsString()
  @Matches(/^[\d\s-]*$/, { message: 'Shtrix-kod faqat raqamlardan iborat bo‘lishi kerak' })
  @MaxLength(30)
  barcode?: string;

  @ApiPropertyOptional({
    example: 'Qora / S',
    description: 'Ko\'rsatilmasa atributlardan tuziladi: { Rang, O\'lcham } -> "Qora / S".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    type: Object,
    example: { Rang: 'Qora', "O'lcham": 'S' },
    description: 'Variant kombinatsiyasi. Variant ekranidagi tanlovlar shundan hosil qilinadi.',
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @MoneyProperty('Sotuv narxi', 129000)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sellingPrice!: number;

  @ApiPropertyOptional({ type: Number, example: 90000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePrice?: number;

  @ApiPropertyOptional({ example: '2.000' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  minStock?: string;

  @ApiPropertyOptional({ enum: UNITS, default: 'PIECE' })
  @IsOptional()
  @IsEnum(UNITS)
  unit?: UnitValue;
}

export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  sku?: string;

  @ApiPropertyOptional({ description: "Bo'sh satr — shtrix-kodni olib tashlash." })
  @IsOptional()
  @IsString()
  @Matches(/^[\d\s-]*$/, { message: 'Shtrix-kod faqat raqamlardan iborat bo‘lishi kerak' })
  @MaxLength(30)
  barcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: Object, example: { Rang: 'Oq', "O'lcham": 'L' } })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sellingPrice?: number;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  purchasePrice?: number;

  @ApiPropertyOptional({ example: '2.000' })
  @IsOptional()
  @IsNumberString({ no_symbols: false })
  minStock?: string;

  @ApiPropertyOptional({ enum: UNITS })
  @IsOptional()
  @IsEnum(UNITS)
  unit?: UnitValue;

  @ApiPropertyOptional({ enum: PRODUCT_STATUSES })
  @IsOptional()
  @IsEnum(PRODUCT_STATUSES)
  status?: ProductStatusValue;
}
