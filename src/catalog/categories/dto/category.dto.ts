import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** `?flag=true` arrives as a string; class-validator needs a real boolean. */
const toBoolean = () =>
  Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  );

export class ListCategoriesDto {
  @ApiPropertyOptional({ description: 'Nom bo\u2018yicha qidiruv.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({
    description:
      "Faqat shu kategoriyaning bevosita bolalari. Bo'sh satr yuborilsa — faqat ildiz kategoriyalar.",
  })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ default: false, description: 'Arxivlanganlarni ham qaytarish.' })
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  includeArchived?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: "true — daraxt emas, tekis ro'yxat. Mobil qidiruv uchun qulay.",
  })
  @IsOptional()
  @toBoolean()
  @IsBoolean()
  flat?: boolean;
}

export class CreateCategoryDto {
  @ApiProperty({ example: 'Choy va qahva' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Issiq ichimliklar uchun' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: "Yuqori kategoriya. Ko'rsatilmasa — ildiz kategoriya." })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: "Boshqa kategoriya ostiga ko'chirish. Bo'sh satr — ildizga chiqarish.",
  })
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
