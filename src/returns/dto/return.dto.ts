import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { ListQueryDto } from '../../common/dto/list-query.dto';
import { QUANTITY_PATTERN } from '../../common/quantity';
import { PAYMENT_METHODS } from '../../sales/dto/sale.dto';
import type { PaymentMethodValue } from '../../sales/dto/sale.dto';

export const RETURN_REASONS = [
  'DEFECTIVE',
  'WRONG_ITEM',
  'CHANGED_MIND',
  'EXPIRED',
  'OTHER',
] as const;
export type ReturnReasonValue = (typeof RETURN_REASONS)[number];

export const ITEM_CONDITIONS = ['SELLABLE', 'DAMAGED'] as const;

const QUANTITY_MESSAGE = {
  message: "Miqdor o'nlik satr bo'lishi kerak, 3 kasr xonagacha",
};

export class ReturnLineDto {
  @ApiProperty({ description: 'Qaysi savdo qatori qaytarilmoqda.' })
  @IsUUID()
  saleItemId!: string;

  @ApiProperty({ example: '1.000' })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  quantity!: string;

  @ApiPropertyOptional({
    default: true,
    description: "Javonga qaytadimi. DAMAGED bo'lsa har doim false.",
  })
  @IsOptional()
  @IsBoolean()
  restock?: boolean;

  @ApiPropertyOptional({ enum: ITEM_CONDITIONS, default: 'SELLABLE' })
  @IsOptional()
  @IsIn(ITEM_CONDITIONS)
  condition?: (typeof ITEM_CONDITIONS)[number];
}

export class CreateReturnDto {
  @ApiProperty()
  @IsUUID()
  saleId!: string;

  @ApiProperty({ type: [ReturnLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items!: ReturnLineDto[];

  @ApiProperty({ enum: RETURN_REASONS })
  @IsIn(RETURN_REASONS)
  reason!: ReturnReasonValue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonNote?: string;

  @ApiPropertyOptional({
    enum: PAYMENT_METHODS,
    default: 'CASH',
    description: "Pul qaysi usulda qaytariladi. Qarz hisobiga o'tkazilgan qism bundan tashqari.",
  })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  refundMethod?: PaymentMethodValue;

  @ApiPropertyOptional({ description: 'Qaysi omborga qaytadi. Berilmasa savdoniki.' })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ExchangeLineDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({ example: '1.000' })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  quantity!: string;

  @ApiPropertyOptional({ description: 'sales.override_price ruxsati kerak.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitPrice?: number;
}

export class CreateExchangeDto {
  @ApiProperty({ description: 'Qaytarilayotgan savdo.' })
  @IsUUID()
  saleId!: string;

  @ApiProperty({ type: [ReturnLineDto], description: 'Qaytarilayotgan qatorlar.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  returnItems!: ReturnLineDto[];

  @ApiProperty({ type: [ExchangeLineDto], description: 'Oʻrniga beriladigan mahsulotlar.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ExchangeLineDto)
  replacementItems!: ExchangeLineDto[];

  @ApiProperty({ enum: RETURN_REASONS })
  @IsIn(RETURN_REASONS)
  reason!: ReturnReasonValue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reasonNote?: string;

  @ApiPropertyOptional({
    enum: PAYMENT_METHODS,
    default: 'CASH',
    description: "Farqni qaysi usulda to'laydi yoki oladi.",
  })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  settlementMethod?: PaymentMethodValue;

  @ApiPropertyOptional({
    description: "Farqni qarzga yozish. Mijoz ko'rsatilgan bo'lishi va debt.create ruxsati kerak.",
  })
  @IsOptional()
  @IsBoolean()
  onCredit?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListReturnsDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  saleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({ enum: RETURN_REASONS })
  @IsOptional()
  @IsIn(RETURN_REASONS)
  reason?: ReturnReasonValue;

  @ApiPropertyOptional({ description: 'createdAt:desc | refund:desc' })
  declare sort?: string;
}

export class ReturnableQueryDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsUUID()
  saleId!: string;
}
