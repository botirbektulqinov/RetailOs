import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
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
import { PAYMENT_METHODS } from '../../sales/dto/sale.dto';
import type { PaymentMethodValue } from '../../sales/dto/sale.dto';

const QUANTITY_MESSAGE = {
  message: "Miqdor o'nlik satr bo'lishi kerak, 3 kasr xonagacha",
};

const PHONE = /^\+[0-9]{9,15}$/;

// ── Suppliers ──────────────────────────────────────────────────────────────

export class CreateSupplierDto {
  @ApiProperty({ example: 'Nestle Uzbekistan' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional({ example: '+998712001020' })
  @IsOptional()
  @Matches(PHONE, { message: "Telefon +998712001020 ko'rinishida bo'lishi kerak" })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ description: "To'lov muddati, kunlarda.", default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  paymentTermDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * PartialType, not `extends` with a redeclared field.
 *
 * `declare name: string` changes the TypeScript type but leaves the inherited
 * `@IsNotEmpty()` in place, so a PATCH that only changes the payment term is
 * rejected for not sending a name. PartialType rewrites the validation
 * metadata, which is the thing that actually decides.
 */
export class UpdateSupplierDto extends PartialType(CreateSupplierDto) {}

export class ListSuppliersDto extends ListQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({ description: "Faqat qarzdorlik bor ta'minotchilar." })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  hasPayable?: boolean;

  @ApiPropertyOptional({ description: 'name:asc | payable:desc' })
  declare sort?: string;
}

// ── Purchases ──────────────────────────────────────────────────────────────

export class PurchaseLineDto {
  @ApiProperty()
  @IsUUID()
  variantId!: string;

  @ApiProperty({ example: '100.000' })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  quantity!: string;

  @ApiProperty({ description: "Ta'minotchining birlik narxi, so'mda.", example: 12000 })
  @IsInt()
  @Min(0)
  unitCost!: number;
}

export class CreatePurchaseDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiPropertyOptional({ description: "Qaysi omborga keladi. Berilmasa do'konning standarti." })
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiProperty({ type: [PurchaseLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  items!: PurchaseLineDto[];

  @ApiPropertyOptional({ description: "Chegirma, so'mda. Tannarxga taqsimlanmaydi (§15.5)." })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({ description: "Yetkazib berish, so'mda. Tannarxga taqsimlanmaydi." })
  @IsOptional()
  @IsInt()
  @Min(0)
  shippingAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierInvoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expectedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    default: false,
    description: "true — darhol ORDERED holatiga o'tadi, DRAFT bosqichisiz.",
  })
  @IsOptional()
  @IsBoolean()
  order?: boolean;
}

export class UpdatePurchaseDto {
  @ApiPropertyOptional({ type: [PurchaseLineDto], description: 'Butunlay almashtiradi.' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  items?: PurchaseLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  shippingAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierInvoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expectedAt?: string;

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

  @ApiProperty({ description: 'Shu yetkazishda kelgan miqdor.', example: '60.000' })
  @IsString()
  @Matches(QUANTITY_PATTERN, QUANTITY_MESSAGE)
  quantity!: string;

  @ApiPropertyOptional({
    description: 'Haqiqiy tannarx, agar buyurtmadagidan farq qilsa.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitCost?: number;
}

export class ReceivePurchaseDto {
  @ApiPropertyOptional({
    type: [ReceiveLineDto],
    description: 'Berilmasa qolgan hamma miqdor qabul qilingan deb hisoblanadi.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  items?: ReceiveLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierInvoiceNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CancelPurchaseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListPurchasesDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({
    enum: ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  })
  @IsOptional()
  @IsIn(['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'])
  status?: 'DRAFT' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';

  @ApiPropertyOptional({ description: "Faqat to'lanmagan qismi borlar." })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unpaid?: boolean;

  @ApiPropertyOptional({ description: 'createdAt:desc | total:desc | purchaseNumber:asc' })
  declare sort?: string;
}

// ── Supplier payments ──────────────────────────────────────────────────────

export class SupplierPaymentDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiProperty({ description: "Summa, so'mda.", example: 3_000_000 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethodValue;

  @ApiPropertyOptional({
    description:
      "Qaysi xarid uchun. Berilmasa — hisobga to'lov: umumiy qarzdorlikni kamaytiradi, " +
      'lekin hech bir hujjatga biriktirilmaydi.',
  })
  @IsOptional()
  @IsUUID()
  purchaseId?: string;

  @ApiPropertyOptional({ description: "To'lov topshirig'i raqami." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
