import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
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

export const PAYMENT_METHODS = [
  'CASH',
  'CARD',
  'CLICK',
  'PAYME',
  'UZUM',
  'TRANSFER',
  'LOYALTY',
  'OTHER',
] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

const QUANTITY_MESSAGE = {
  message: 'Miqdor o\'nlik satr bo\'lishi kerak, 3 kasr xonagacha — masalan "1.500"',
};

export class CheckoutLineDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({ example: '2.000' })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  quantity!: string;

  @ApiPropertyOptional({
    description:
      'Narxni bekor qilish. sales.override_price ruxsati talab qilinadi; ' +
      'aks holda 403. Berilmasa katalog narxi olinadi.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitPrice?: number;

  @ApiPropertyOptional({
    description: "Satrga chegirma, so'mda. sales.discount_item ruxsati kerak.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountAmount?: number;
}

export class CheckoutPaymentDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethodValue;

  @ApiProperty({ description: "Summa, so'mda. Har doim musbat.", example: 200000 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({ description: 'Provayderning tashqi tranzaksiya raqami.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerRef?: string;

  @ApiPropertyOptional({ description: 'Oflayn qurilma bergan id — takrorni to‘sadi.' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CheckoutDto {
  @ApiProperty({ type: [CheckoutLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CheckoutLineDto)
  items!: CheckoutLineDto[];

  @ApiProperty({ type: [CheckoutPaymentDto], description: "Aralash to'lov uchun bir nechta." })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CheckoutPaymentDto)
  payments!: CheckoutPaymentDto[];

  @ApiPropertyOptional({
    description:
      "Qarzga qoldiriladigan summa. Mijoz ko'rsatilishi shart. " + "To'lovlar + qarz = jami, aniq.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  creditAmount?: number;

  @ApiPropertyOptional({ description: 'Qarz muddati, ISO sana. Berilmasa tashkilot sozlamasi.' })
  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: "Qaysi ombordan sotiladi. Berilmasa do'konning standarti." })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({
    description: "Chekka chegirma, so'mda. sales.discount_order ruxsati kerak.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  orderDiscountAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  discountReason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: 'Oflayn qurilma bergan id. Tashkilot ichida noyob.' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional({ description: "Qurilma soati bo'yicha yaratilgan vaqt." })
  @IsOptional()
  @IsISO8601()
  clientCreatedAt?: string;
}

export class CancelSaleDto {
  @ApiProperty({ description: 'Bekor qilish sababi majburiy.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListSalesDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({ description: 'Kassir.' })
  @IsOptional()
  @IsUUID()
  cashierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ enum: ['DRAFT', 'COMPLETED', 'CANCELLED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'COMPLETED', 'CANCELLED'])
  status?: 'DRAFT' | 'COMPLETED' | 'CANCELLED';

  @ApiPropertyOptional({ enum: PAYMENT_METHODS })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethodValue;

  @ApiPropertyOptional({ description: "Eng kam summa, so'mda." })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minAmount?: number;

  @ApiPropertyOptional({ description: "Eng ko'p summa, so'mda." })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxAmount?: number;

  @ApiPropertyOptional({ description: 'Faqat qarzi bor savdolar.' })
  @IsOptional()
  @IsIn(['true', 'false'])
  onCredit?: string;

  @ApiPropertyOptional({
    description: 'total:desc | total:asc | completedAt:desc | saleNumber:asc',
  })
  declare sort?: string;
}
