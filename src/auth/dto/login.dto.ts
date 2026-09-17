import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: '+998 90 123 45 67',
    description:
      'Telefon raqami. Har qanday formatda yuborilishi mumkin — server E.164 ga keltiradi.',
  })
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  @ApiProperty({ example: 'Parol12345', minLength: 8 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({
    description:
      'Login ekranidagi "Eslab qolish". Yoqilsa, refresh token to\'liq muddatga, aks holda 12 soatga beriladi.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  rememberDevice?: boolean;

  @ApiPropertyOptional({
    description:
      "Kirishda tanlanadigan do'kon. Ko'rsatilmasa asosiy (primary) do'kon tanlanadi. " +
      "Foydalanuvchi a'zo bo'lmagan do'kon 403 qaytaradi.",
  })
  @IsOptional()
  @IsUUID()
  storeId?: string;
}
