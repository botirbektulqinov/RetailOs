import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { requireIdempotencyKey } from '../common/idempotency/idempotency-key';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CreateExchangeDto, CreateReturnDto, ListReturnsDto } from './dto/return.dto';
import { ReturnsService } from './returns.service';

@ApiTags('returns')
@ApiBearerAuth('bearer')
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  @RequirePermissions('sales.read')
  @ApiOperation({ summary: 'Qaytarishlar' })
  list(@Query() query: ListReturnsDto) {
    return this.returns.list(query);
  }

  @Get('returnable/:saleId')
  @RequirePermissions('sales.read')
  @ApiOperation({
    summary: 'Nimani qaytarish mumkin',
    description:
      'Har bir qator uchun: sotilgan, allaqachon qaytarilgan va qolgan miqdor, ' +
      'hamda qaytariladigan summa. POS buni qaytarish ekranidan oldin chaqiradi, ' +
      "shunda kassir server rad etadigan miqdorni terib ham ko'rmaydi.",
  })
  returnable(@Param('saleId', ParseUUIDPipe) saleId: string) {
    return this.returns.returnable(saleId);
  }

  @Get(':id')
  @RequirePermissions('sales.read')
  @ApiOperation({ summary: 'Qaytarish tafsiloti' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.returns.findOne(id);
  }

  @Post()
  @RequirePermissions('sales.refund')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4.' })
  @ApiOperation({
    summary: 'Qaytarish',
    description:
      "Asl savdo hech qachon o'chirilmaydi va raqamlari qayta yozilmaydi. " +
      'Qaytariladigan summa qatorning SOF qiymatidan hisoblanadi — chegirma bilan ' +
      'olgan mijozga chegirma bilan qaytariladi. Qatorni yopadigan qaytarish ' +
      "qoldiqni butunlay supurib oladi, shunda bir so'm ham osilib qolmaydi. " +
      "Savdoda ochiq qarz bo'lsa, avval o'sha qoplanadi: hali qarzdor odamga " +
      'naqd pul qaytarish — tizim o‘zi qilmasligi kerak bo‘lgan xato.',
  })
  @ApiConflictResponse({
    description: 'RETURN_QUANTITY_EXCEEDED · REFUND_EXCEEDS_SALE · RETURN_WINDOW_EXPIRED',
  })
  create(
    @Body() dto: CreateReturnDto,
    @CurrentUser() user: TenantContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.returns.create(dto, user, requireIdempotencyKey(key));
  }
}

@ApiTags('exchanges')
@ApiBearerAuth('bearer')
@Controller('exchanges')
export class ExchangesController {
  constructor(private readonly returns: ReturnsService) {}

  @Post()
  @RequirePermissions('sales.refund')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4.' })
  @ApiOperation({
    summary: 'Almashtirish',
    description:
      'Qaytarish va yangi savdo bitta tranzaksiyada. Faqat FARQ pul sifatida ' +
      "harakatlanadi: to'liq qaytarish keyin to'liq to'lov yozilsa, kunlik tushum " +
      'ikki marta sanaladi va kassa hech qachon chiqmagan pulni kutadi. ' +
      "O'rnini bosuvchi mahsulot qoldiqda bo'lmasa — butun almashtirish bekor " +
      "bo'ladi va hech narsa yozilmaydi.",
  })
  @ApiConflictResponse({
    description: 'INSUFFICIENT_STOCK · RETURN_QUANTITY_EXCEEDED · CREDIT_WITHOUT_CUSTOMER',
  })
  create(
    @Body() dto: CreateExchangeDto,
    @CurrentUser() user: TenantContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.returns.exchange(dto, user, requireIdempotencyKey(key));
  }
}
