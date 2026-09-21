import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { ListQueryDto } from '../../common/dto/list-query.dto';
import { PAYMENT_METHODS } from '../../sales/dto/sale.dto';
import type { PaymentMethodValue } from '../../sales/dto/sale.dto';

/** E.164, the same shape the login phone uses. */
const PHONE = /^\+[0-9]{9,15}$/;

export class CreateCustomerDto {
  @ApiProperty({ example: 'Dilnoza Karimova' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName!: string;

  @ApiPropertyOptional({ example: '+998901112233' })
  @IsOptional()
  @Matches(PHONE, { message: "Telefon +998901112233 ko'rinishida bo'lishi kerak" })
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

  @ApiPropertyOptional({ description: 'ISO sana. Tug‘ilgan kun aksiyalari uchun.' })
  @IsOptional()
  @IsISO8601()
  birthDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerGroupId?: string;

  @ApiPropertyOptional({
    description: "Shaxsiy qarz chegarasi, so'mda. Berilmasa guruhniki, u ham bo'lmasa cheksiz.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  creditLimit?: number;

  @ApiPropertyOptional({ description: 'Birinchi izoh.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(PHONE, { message: "Telefon +998901112233 ko'rinishida bo'lishi kerak" })
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  birthDate?: string;

  @ApiPropertyOptional({ description: 'null yuborilsa guruhdan chiqariladi.' })
  @IsOptional()
  @IsUUID()
  customerGroupId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  creditLimit?: number | null;
}

export class ListCustomersDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Ism yoki telefon bo‘yicha qidiruv.' })
  declare q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerGroupId?: string;

  @ApiPropertyOptional({ description: 'Faqat qarzi borlar.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  hasDebt?: boolean;

  @ApiPropertyOptional({ description: "Faqat muddati o'tgan qarzi borlar." })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({ description: 'name:asc | debt:desc | createdAt:desc' })
  declare sort?: string;
}

export class AddNoteDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body!: string;
}

// ── Groups ─────────────────────────────────────────────────────────────────

export class CreateGroupDto {
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Sprint 9 dan boshlab kassada qo‘llanadi.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  creditLimit?: number;
}

export class UpdateGroupDto extends CreateGroupDto {
  @ApiPropertyOptional()
  declare name: string;
}

// ── Debts ──────────────────────────────────────────────────────────────────

export const DEBT_FILTERS = [
  'overdue',
  'due_today',
  'due_soon',
  'unpaid',
  'partially_paid',
  'paid',
  'written_off',
] as const;

export class ListDebtsDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    enum: DEBT_FILTERS,
    description: "OVERDUE holat emas — u remaining > 0 AND due_date < bugun, so'rovda hisoblanadi.",
  })
  @IsOptional()
  @IsIn(DEBT_FILTERS)
  filter?: (typeof DEBT_FILTERS)[number];

  @ApiPropertyOptional({ description: 'dueDate:asc | amount:desc | createdAt:desc' })
  declare sort?: string;
}

export class CreateDebtDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiProperty({ description: "Qarz summasi, so'mda.", example: 450000 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiPropertyOptional({
    enum: ['OPENING_BALANCE', 'MANUAL'],
    default: 'MANUAL',
    description: "Savdodan kelgan qarz bu yerda yaratilmaydi — u checkout ichida tug'iladi.",
  })
  @IsOptional()
  @IsIn(['OPENING_BALANCE', 'MANUAL'])
  origin?: 'OPENING_BALANCE' | 'MANUAL';

  @ApiPropertyOptional({ description: 'Berilmasa tashkilot sozlamasidagi muddat.' })
  @IsOptional()
  @IsISO8601()
  dueDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DebtPaymentDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiProperty({ description: "To'lov summasi, so'mda.", example: 100000 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method!: PaymentMethodValue;

  @ApiPropertyOptional({
    type: [String],
    description: "Qaysi qarzlarga. Berilmasa muddati bo'yicha eng eskisidan boshlab taqsimlanadi.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  receivableIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class WriteOffDto {
  @ApiProperty({ description: 'Sabab majburiy — hisobdan chiqarish moliyaviy hodisa.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Qisman hisobdan chiqarish. Berilmasa qolgan summaning hammasi.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;
}
