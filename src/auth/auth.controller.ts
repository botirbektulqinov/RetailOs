import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Req } from '@nestjs/common';

import { AuthService } from './auth.service';
import type { RequestMeta } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { LogoutDto } from './dto/logout.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SwitchStoreDto } from './dto/switch-store.dto';
import type { TenantContext } from '../common/tenant/tenant-context';

/**
 * Budget for the endpoints that accept a password or a refresh token.
 *
 * Read from process.env rather than AppConfig because @Throttle needs a value
 * at decoration time, before the DI container exists. env.schema.ts declares
 * and validates the same variables, so this is not an undocumented back door.
 */
const AUTH_THROTTLE = {
  default: {
    limit: Number(process.env['AUTH_RATE_LIMIT'] ?? 5),
    ttl: Number(process.env['AUTH_RATE_LIMIT_TTL_SECONDS'] ?? 900) * 1000,
  },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Keyed per client rather than per account, so a spray across many accounts
  // is throttled too. Failed attempts are also written to the audit log, so a
  // distributed attempt is visible even when no single IP crosses a threshold.
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Telefon raqami va parol bilan kirish',
    description:
      'Muvaffaqiyatli kirishdan keyin access va refresh token qaytariladi. ' +
      "Do'kon ko'rsatilmasa foydalanuvchining asosiy do'koni tanlanadi.",
  })
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS — raqam yoki parol xato.' })
  @ApiForbiddenResponse({
    description: 'USER_INACTIVE · ORGANIZATION_SUSPENDED · NO_STORE_ACCESS · STORE_ACCESS_DENIED',
  })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMIT_EXCEEDED — 15 daqiqada 5 urinish.' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, requestMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Sessiyani yangilash',
    description:
      'Refresh token rotatsiya qilinadi: eskisi bekor qilinib, yangisi beriladi. ' +
      "Bekor qilingan token qayta ishlatilsa — o'g'irlangan deb hisoblanib, butun sessiya oilasi bekor qilinadi.",
  })
  @ApiUnauthorizedResponse({ description: 'REFRESH_TOKEN_INVALID · REFRESH_TOKEN_EXPIRED' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, requestMeta(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Joriy sessiyadan chiqish',
    description:
      'Refresh token serverda bekor qilinadi. Bir necha marta chaqirish xavfsiz — takroriy chaqiruv ham 200 qaytaradi.',
  })
  @ApiOkResponse({ schema: { example: { revoked: 1 } } })
  async logout(
    @Body() dto: LogoutDto,
    @CurrentUser('userId') userId: string,
  ): Promise<{ revoked: number }> {
    return this.auth.logout(dto.refreshToken, userId);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Barcha qurilmalardan chiqish',
    description:
      'Xavfsizlik ekranidagi "Barcha qurilmalardan chiqish". Barcha refresh tokenlar bekor qilinadi ' +
      'va token_version oshiriladi, shuning uchun mavjud access tokenlar ham darhol yaroqsiz bo‘ladi.',
  })
  logoutAll(@CurrentUser() user: TenantContext, @Req() req: Request) {
    return this.auth.logoutAll(user.userId, user.organizationId, requestMeta(req));
  }

  @Get('me')
  @SkipThrottle()
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Joriy foydalanuvchi',
    description:
      "Foydalanuvchi, tashkilot, mavjud do'konlar, joriy rol va ruxsatlar ro'yxati. " +
      'Ruxsatlar kengaytirilgan holda qaytariladi — mijozda `*` ni izohlash shart emas.',
  })
  me(@CurrentUser('userId') userId: string) {
    return this.auth.describeUser(userId);
  }

  @Post('switch-store')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: "Do'konni almashtirish",
    description:
      "Yangi access token beriladi. Do'kon konteksti imzolangan token ichida bo'ladi, " +
      "shuning uchun mijoz uni o'zgartira olmaydi. Refresh token o'zgarmaydi.",
  })
  @ApiForbiddenResponse({ description: "STORE_ACCESS_DENIED — bu do'konga a'zo emassiz." })
  switchStore(
    @Body() dto: SwitchStoreDto,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.auth.switchStore(userId, dto.storeId, requestMeta(req));
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(AUTH_THROTTLE)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Parolni almashtirish',
    description:
      'Muvaffaqiyatli almashtirilgandan keyin BARCHA sessiyalar bekor qilinadi, joriy sessiya ham. ' +
      'Parol almashtirish — u oshkor bo‘lgan deb hisoblanadigan holat, shuning uchun boshqa qurilmalar ochiq qolmasligi kerak.',
  })
  @ApiUnauthorizedResponse({ description: "INVALID_CREDENTIALS — joriy parol noto'g'ri." })
  @ApiConflictResponse({ description: 'WEAK_PASSWORD — parol talablarga javob bermaydi.' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: TenantContext,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.changePassword(user.userId, user.organizationId, dto, requestMeta(req));
  }

  @Get('sessions')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Faol qurilmalar',
    description: 'Xavfsizlik ekranidagi "Faol qurilmalar" ro‘yxati.',
  })
  sessions(@CurrentUser('userId') userId: string) {
    return this.auth.listSessions(userId);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('bearer')
  @ApiOperation({ summary: 'Bitta qurilmani chiqarish' })
  async revokeSession(
    @Param('id', ParseUUIDPipe) sessionId: string,
    @CurrentUser('userId') userId: string,
  ): Promise<void> {
    await this.auth.revokeSession(userId, sessionId);
  }
}

function requestMeta(req: Request): RequestMeta {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    requestId: req.requestId,
  };
}
