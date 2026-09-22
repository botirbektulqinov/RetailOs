import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { PAYMENT_METHODS } from '../../sales/dto/sale.dto';
import type { PaymentMethodValue } from '../../sales/dto/sale.dto';

/**
 * One filter shape for every report — docs/ARCHITECTURE.md §27.1.
 *
 * A consistent filter across twelve reports means a client builds the query
 * string once. Every report takes a date range; unspecified, it is the last 30
 * days, because an unbounded report is the one that takes the database down.
 */
export class ReportQueryDto {
  @ApiPropertyOptional({ description: 'ISO. Berilmasa — oxirgi 30 kun.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO. Berilmasa — hozir.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({ description: 'Kassir yoki sotuvchi.' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ enum: PAYMENT_METHODS })
  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethodValue;

  @ApiPropertyOptional({ default: 20, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 20;
}

/** The resolved filter every repository method takes. */
export interface ReportFilter {
  organizationId: string;
  from: Date;
  to: Date;
  /**
   * The stores the caller may see, already resolved from their memberships —
   * §20.4 layer 3. Empty means no restriction, which only a wildcard holder
   * gets. This is never taken from the query string unchecked.
   */
  storeIds: string[];
  warehouseId?: string | undefined;
  employeeId?: string | undefined;
  customerId?: string | undefined;
  categoryId?: string | undefined;
  productId?: string | undefined;
  paymentMethod?: string | undefined;
  limit: number;
}

export const EXPORTABLE = [
  'sales-by-day',
  'top-products',
  'employees',
  'low-stock',
  'top-debtors',
  'suppliers',
] as const;

export class ExportQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({ enum: EXPORTABLE })
  @IsOptional()
  @IsIn(EXPORTABLE)
  report?: (typeof EXPORTABLE)[number];
}
