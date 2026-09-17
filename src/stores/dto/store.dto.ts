import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Mirrors the "Rekvizitlar" block on the store screen: legal entity name,
 * STIR (Uzbek taxpayer id), contact phone and opening hours.
 */
export class UpdateStoreDto {
  @ApiPropertyOptional({ example: 'RetailOS Chorsu' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: "Beruniy ko'chasi 12, Toshkent" })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  address?: string;

  @ApiPropertyOptional({ example: '+998 71 200 20 20' })
  @IsOptional()
  @IsString()
  @MaxLength(25)
  phone?: string;

  @ApiPropertyOptional({ example: 'Retail Systems MChJ' })
  @IsOptional()
  @IsString()
  @MaxLength(180)
  legalName?: string;

  @ApiPropertyOptional({ example: '309456789', description: 'STIR — 9 raqam.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxId?: string;

  @ApiPropertyOptional({ example: '09:00–22:00 · har kuni' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  workingHours?: string;

  @ApiPropertyOptional({ example: 'Asia/Tashkent' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;
}
