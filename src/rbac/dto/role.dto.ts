import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { ALL_PERMISSIONS } from '../permissions';

export class UpdateRolePermissionsDto {
  @ApiProperty({
    isArray: true,
    type: String,
    description:
      "Rolga beriladigan ruxsatlarning TO'LIQ ro'yxati — qo'shiladigan emas, o'rnini bosadigan. " +
      "Ro'yxatda yo'q ruxsat olib tashlanadi.",
    example: ['sales.read', 'sales.create', 'reports.read'],
  })
  @IsArray()
  @ArrayMaxSize(ALL_PERMISSIONS.length)
  @IsString({ each: true })
  permissions!: string[];
}

export class CreateRoleDto {
  @ApiProperty({ example: 'Katta kassir' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: 'Savdo va qaytarishlar' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  description?: string;

  @ApiProperty({ isArray: true, type: String, example: ['sales.read', 'sales.create'] })
  @IsArray()
  @ArrayMaxSize(ALL_PERMISSIONS.length)
  @IsString({ each: true })
  permissions!: string[];
}
