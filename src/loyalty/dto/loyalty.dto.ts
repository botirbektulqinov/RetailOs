import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { ListQueryDto } from '../../common/dto/list-query.dto';

export const PROMOTION_TYPES = ['PERCENT_OFF', 'FIXED_OFF'] as const;
export const PROMOTION_SCOPES = ['ITEM', 'ORDER'] as const;
export const PROMOTION_TARGETS = ['ALL', 'CATEGORY', 'PRODUCT'] as const;

export class CreatePromotionDto {
  @ApiProperty({ example: 'Yozgi 10%' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: PROMOTION_TYPES })
  @IsIn(PROMOTION_TYPES)
  type!: (typeof PROMOTION_TYPES)[number];

  @ApiProperty({
    enum: PROMOTION_SCOPES,
    description: 'ITEM — har bir qatorga, ORDER — butun chekka.',
  })
  @IsIn(PROMOTION_SCOPES)
  scope!: (typeof PROMOTION_SCOPES)[number];

  @ApiProperty({
    description: "PERCENT_OFF uchun foiz (2 kasr), FIXED_OFF uchun so'm.",
    example: 10,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  value!: number;

  @ApiPropertyOptional({ description: 'ORDER uchun eng kam chek summasi.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minSubtotal?: number;

  @ApiPropertyOptional({
    description: "Foizli chegirmaning yuqori chegarasi — katta savatda cheksiz bo'lmasligi uchun.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDiscount?: number;

  @ApiPropertyOptional({ enum: PROMOTION_TARGETS, default: 'ALL' })
  @IsOptional()
  @IsIn(PROMOTION_TARGETS)
  appliesTo?: (typeof PROMOTION_TARGETS)[number];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  productIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      "Bo'sh bo'lsa hammaga. To'ldirilsa faqat shu guruhlarga — va hech qachon " +
      "ko'cha mijoziga.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  customerGroupIds?: string[];

  @ApiProperty({ description: 'ISO vaqt.' })
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional({ description: 'Berilmasa — muddatsiz.' })
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional({ default: 0, description: 'Kattasi avval yutadi.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxUses?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePromotionDto extends PartialType(CreatePromotionDto) {}

export class ListPromotionsDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: PROMOTION_SCOPES })
  @IsOptional()
  @IsIn(PROMOTION_SCOPES)
  scope?: (typeof PROMOTION_SCOPES)[number];

  @ApiPropertyOptional({ description: 'Faqat hozir amal qiladiganlar.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  activeNow?: boolean;
}

export class AdjustPointsDto {
  @ApiProperty({
    description: "Ishorali: musbat — qo'shish, manfiy — ayirish.",
    example: -500,
  })
  @IsInt()
  points!: number;

  @ApiProperty({ description: 'Sabab majburiy.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
