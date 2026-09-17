import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class LogoutDto {
  @ApiPropertyOptional({
    description:
      'Bekor qilinadigan refresh token. Yuborilmasa faqat access token bekor qilinadi ' +
      '(sessiya serverda ochiq qoladi), shuning uchun uni yuborish tavsiya etiladi.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}
