import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { BusinessRuleException } from '../common/exceptions/business-rule.exception';
import { ErrorCode } from '../common/exceptions/error-codes';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CancelSaleDto, CheckoutDto, ListSalesDto } from './dto/sale.dto';
import { SalesService } from './sales.service';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiTags('sales')
@ApiBearerAuth('bearer')
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post('checkout')
  @RequirePermissions('sales.create')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      "UUID v4. Bir xil kalit bilan ikkinchi so'rov yangi savdo yaratmaydi — " +
      'birinchisining javobi qaytariladi.',
  })
  @ApiOperation({
    summary: 'Savdoni yakunlash',
    description:
      "Server hamma summani o'zi hisoblaydi. Mijoz yuborgan jami, oraliq jami yoki " +
      "chegirma umuman o'qilmaydi — narx katalogdan, tannarx qoldiqdan olinadi. " +
      "Savdo, satrlar, qoldiq harakatlari, to'lovlar va qarz bitta tranzaksiyada.",
  })
  @ApiUnprocessableEntityResponse({
    description: 'PAYMENT_MISMATCH · CREDIT_WITHOUT_CUSTOMER',
  })
  @ApiConflictResponse({
    description:
      'INSUFFICIENT_STOCK · CREDIT_LIMIT_EXCEEDED · IDEMPOTENCY_KEY_REUSED · REQUEST_IN_PROGRESS',
  })
  checkout(
    @Body() dto: CheckoutDto,
    @CurrentUser() user: TenantContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.sales.checkout(dto, user, requireIdempotencyKey(key));
  }

  @Get()
  @RequirePermissions('sales.read')
  @ApiOperation({
    summary: 'Savdolar',
    description:
      "Sana, kassir, mijoz, to'lov usuli, holat, do'kon va summa oralig'i bo'yicha " +
      'filtrlanadi. Barchasi bazada. Sarlavha uchun kunlik tushum va marja ham qaytadi.',
  })
  list(@Query() query: ListSalesDto) {
    return this.sales.list(query);
  }

  @Get(':id')
  @RequirePermissions('sales.read')
  @ApiOperation({ summary: 'Savdo tafsiloti' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.sales.findOne(id);
  }

  @Get(':id/receipt')
  @RequirePermissions('sales.read')
  @ApiOperation({
    summary: 'Chek',
    description:
      'Butunlay savdo saqlagan qiymatlardan quriladi, katalogdan emas — bir yildan ' +
      "keyin qayta chop etilgan chek o'sha kungi narxni ko'rsatishi kerak.",
  })
  receipt(@Param('id', ParseUUIDPipe) id: string) {
    return this.sales.receipt(id);
  }

  @Post(':id/cancel')
  @RequirePermissions('sales.cancel')
  @ApiOperation({
    summary: 'Savdoni bekor qilish',
    description:
      "Savdo o'chirilmaydi va raqamlari qayta yozilmaydi. Holat CANCELLED bo'ladi, " +
      "qoldiq RETURN harakati bilan qaytadi, to'lovlar teskari yo'nalishdagi to'lov " +
      'bilan qoplanadi. Qaytarish qilingan savdo bekor qilinmaydi.',
  })
  @ApiConflictResponse({
    description: 'SALE_NOT_COMPLETED · SALE_ALREADY_CANCELLED · SALE_HAS_RETURNS',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelSaleDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.sales.cancel(id, dto, user);
  }
}

/**
 * The header is mandatory on checkout — docs/ARCHITECTURE.md §26.2.
 *
 * Required rather than optional-with-a-fallback: a server-generated key makes
 * every request unique, which is exactly the property idempotency exists to
 * remove. A client that cannot be bothered to send one gets a 400 telling it
 * why, not a silently duplicated sale.
 */
function requireIdempotencyKey(key: string | undefined): string {
  if (!key?.trim()) {
    throw new BusinessRuleException({
      code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      status: 400,
      detail: 'Idempotency-Key sarlavhasi majburiy (UUID v4).',
    });
  }
  if (!UUID_V4.test(key.trim())) {
    throw new BadRequestException("Idempotency-Key UUID v4 bo'lishi kerak.");
  }
  return key.trim();
}
