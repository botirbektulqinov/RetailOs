import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { ListQueryDto } from '../../common/dto/list-query.dto';

export const MOVEMENT_DIRECTIONS = ['IN', 'OUT'] as const;
export const MOVEMENT_TYPES = ['DROP', 'PAYOUT', 'EXPENSE', 'CORRECTION', 'OTHER'] as const;

export class CreateRegisterDto {
  @ApiProperty({ example: 'KASSA-1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  @ApiProperty({ example: 'Asosiy kassa' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ description: "Berilmasa — joriy sessiyaning do'koni." })
  @IsOptional()
  @IsUUID()
  storeId?: string;
}

export class UpdateRegisterDto extends PartialType(CreateRegisterDto) {}

export class OpenShiftDto {
  @ApiProperty()
  @IsUUID()
  registerId!: string;

  @ApiProperty({ description: "Boshlang'ich naqd qoldiq, so'mda.", example: 200_000 })
  @IsInt()
  @Min(0)
  openingAmount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CloseShiftDto {
  @ApiProperty({ description: 'Sanab chiqilgan haqiqiy naqd pul.', example: 1_240_000 })
  @IsInt()
  @Min(0)
  countedCashAmount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CashMovementDto {
  @ApiProperty({ enum: MOVEMENT_DIRECTIONS })
  @IsIn(MOVEMENT_DIRECTIONS)
  direction!: (typeof MOVEMENT_DIRECTIONS)[number];

  @ApiProperty({
    enum: MOVEMENT_TYPES,
    description:
      "DROP — seyfga topshirish, PAYOUT — to'lov, EXPENSE — mayda xarajat, " +
      'CORRECTION — tuzatish.',
  })
  @IsIn(MOVEMENT_TYPES)
  type!: (typeof MOVEMENT_TYPES)[number];

  @ApiProperty({ example: 500_000 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ description: 'Sabab majburiy va bazada tekshiriladi.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListShiftsDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  registerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  openedBy?: string;

  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED'] })
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';
}
