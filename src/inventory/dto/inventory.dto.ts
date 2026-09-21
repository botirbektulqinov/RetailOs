import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  Matches,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { ListQueryDto } from '../../common/dto/list-query.dto';
import { QUANTITY_PATTERN } from '../../common/quantity';
import { ADJUSTMENT_REASONS } from '../inventory.service';
import type { AdjustmentReason } from '../inventory.service';

/**
 * Quantities arrive as decimal strings — the contract the rest of the API
 * already uses (`product_variant.minStock` is `"5.000"`). One message,
 * declared once: a rule copied onto eight fields is a rule that will disagree
 * with itself on the ninth.
 */
const QUANTITY_MESSAGE = {
  message: 'Miqdor o\'nlik satr bo\'lishi kerak, 3 kasr xonagacha — masalan "1.500"',
};

export const STOCK_STATUSES = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'] as const;

export class ListStockDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Bitta ombor bilan cheklash.' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ description: "Do'konning barcha omborlari." })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional({ enum: STOCK_STATUSES })
  @IsOptional()
  @IsIn(STOCK_STATUSES)
  status?: (typeof STOCK_STATUSES)[number];

  @ApiPropertyOptional({
    description:
      "Buyurtma ro'yxati: tugagan yoki minimal qoldiqqa tushgan. status dan ustun turadi.",
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  lowStock?: boolean;

  @ApiPropertyOptional({ description: 'name | sku | quantity | value | updatedAt, :asc/:desc' })
  declare sort?: string;
}

export class ListMovementsDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({
    enum: [
      'INITIAL',
      'PURCHASE',
      'SALE',
      'RETURN',
      'ADJUSTMENT',
      'DAMAGE',
      'WRITE_OFF',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'COUNT_CORRECTION',
    ],
  })
  @IsOptional()
  @IsIn([
    'INITIAL',
    'PURCHASE',
    'SALE',
    'RETURN',
    'ADJUSTMENT',
    'DAMAGE',
    'WRITE_OFF',
    'TRANSFER_OUT',
    'TRANSFER_IN',
    'COUNT_CORRECTION',
  ])
  type?:
    | 'INITIAL'
    | 'PURCHASE'
    | 'SALE'
    | 'RETURN'
    | 'ADJUSTMENT'
    | 'DAMAGE'
    | 'WRITE_OFF'
    | 'TRANSFER_OUT'
    | 'TRANSFER_IN'
    | 'COUNT_CORRECTION';

  @ApiPropertyOptional({ description: "Hujjat turi: 'sale', 'stock_transfer', 'adjustment'…" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sourceType?: string;

  @ApiPropertyOptional({ description: 'Bitta hujjatning ikkala oyog‘i ham shu id bilan topiladi.' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;
}

export class AdjustLineDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({
    description: "Ishorali o'nlik satr: musbat — qo'shish, manfiy — ayirish. Nol qabul qilinmaydi.",
    example: '-3.000',
  })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  quantity!: string;

  @ApiProperty({ enum: ADJUSTMENT_REASONS })
  @IsIn(ADJUSTMENT_REASONS)
  reason!: AdjustmentReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdjustStockDto {
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;

  @ApiProperty({ type: [AdjustLineDto], description: 'Hammasi birga bajariladi yoki hech biri.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AdjustLineDto)
  lines!: AdjustLineDto[];

  @ApiPropertyOptional({ description: 'Butun tuzatishga umumiy izoh.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ── Warehouses ─────────────────────────────────────────────────────────────

export class CreateWarehouseDto {
  @ApiProperty({ example: 'CHORSU-MAIN' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  @ApiProperty({ example: 'Asosiy ombor' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    description: "Bo'sh qoldirilsa — markaziy ombor, hech qaysi do'konga biriktirilmagan.",
  })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({ description: "Do'konning standart ombori." })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description: 'null — tashkilot sozlamasidan meros. true — manfiy qoldiqqa ruxsat.',
  })
  @IsOptional()
  @IsBoolean()
  allowNegativeStock?: boolean | null;
}

export class UpdateWarehouseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowNegativeStock?: boolean | null;
}

export class ListWarehousesDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean;
}

// ── Inventory counts ───────────────────────────────────────────────────────

export const COUNT_SCOPES = ['FULL', 'PARTIAL', 'CATEGORY'] as const;

export class CreateCountDto {
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;

  @ApiPropertyOptional({
    enum: COUNT_SCOPES,
    default: 'FULL',
    description:
      "FULL — omborda qoldig'i bo'lgan hamma variant. CATEGORY — bitta kategoriya. " +
      'PARTIAL — faqat sanab chiqilgan variantlar.',
  })
  @IsOptional()
  @IsIn(COUNT_SCOPES)
  scope?: (typeof COUNT_SCOPES)[number];

  @ApiPropertyOptional({ description: 'scope=CATEGORY uchun majburiy.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ type: [String], description: 'scope=PARTIAL uchun majburiy.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsUUID('4', { each: true })
  variantIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CountEntryDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({ description: 'Haqiqatda sanalgan miqdor.', example: '47.000' })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  countedQuantity!: string;
}

export class SubmitCountDto {
  @ApiProperty({ type: [CountEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CountEntryDto)
  items!: CountEntryDto[];
}

export class ListCountsDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ enum: ['DRAFT', 'COUNTING', 'FINALIZED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'COUNTING', 'FINALIZED', 'CANCELLED'])
  status?: 'DRAFT' | 'COUNTING' | 'FINALIZED' | 'CANCELLED';
}

export class FinalizeCountDto {
  @ApiPropertyOptional({ description: 'Yakunlash sababi yoki izohi.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ── Transfers ──────────────────────────────────────────────────────────────

export class TransferLineDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({ example: '10.000' })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  quantity!: string;
}

export class CreateTransferDto {
  @ApiProperty()
  @IsUUID()
  fromWarehouseId!: string;

  @ApiProperty()
  @IsUUID()
  toWarehouseId!: string;

  @ApiProperty({ type: [TransferLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  items!: TransferLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReceiveLineDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({
    description: "Haqiqatda kelgan miqdor. Yuborilgandan ko'p bo'la olmaydi.",
    example: '8.000',
  })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  receivedQuantity!: string;
}

export class ReceiveTransferDto {
  @ApiPropertyOptional({
    type: [ReceiveLineDto],
    description: "Berilmasa — hamma narsa to'liq qabul qilindi deb hisoblanadi.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  items?: ReceiveLineDto[];

  @ApiPropertyOptional({
    description: "Kam kelgan bo'lsa majburiy — yo'qolgan tovar tushuntirilishi kerak.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListTransfersDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ enum: ['DRAFT', 'SENT', 'RECEIVED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'SENT', 'RECEIVED', 'CANCELLED'])
  status?: 'DRAFT' | 'SENT' | 'RECEIVED' | 'CANCELLED';

  @ApiPropertyOptional({ description: 'Yo‘nalish: OUT — bizdan, IN — bizga.' })
  @IsOptional()
  @IsIn(['OUT', 'IN'])
  direction?: 'OUT' | 'IN';
}
