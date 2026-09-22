import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ListQueryDto } from '../../common/dto/list-query.dto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../auth/password.service';

export const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
export type UserStatusValue = (typeof USER_STATUSES)[number];

export class ListEmployeesDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsEnum(USER_STATUSES)
  status?: UserStatusValue;

  @ApiPropertyOptional({ description: "Faqat shu do'konga biriktirilgan xodimlar." })
  @IsOptional()
  @IsUUID()
  storeId?: string;
}

export class CreateEmployeeDto {
  @ApiProperty({ example: 'Sevara Tursunova' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ example: '+998 90 123 45 67' })
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  @ApiPropertyOptional({ example: 'sevara@retail.uz' })
  @IsOptional()
  @IsEmail()
  @MaxLength(180)
  email?: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, description: 'Boshlang\u2018ich parol.' })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ description: "Xodim biriktiriladigan do'kon." })
  @IsUUID()
  storeId!: string;

  @ApiProperty({ description: 'Rol — GET /api/v1/roles dan olinadi.' })
  @IsUUID()
  roleId!: string;
}

export class UpdateEmployeeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(180)
  email?: string;

  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsEnum(USER_STATUSES)
  status?: UserStatusValue;

  @ApiPropertyOptional({ description: "Xodimning asosiy do'kondagi roli." })
  @IsOptional()
  @IsUUID()
  roleId?: string;
}

export class AssignStoreDto {
  @ApiProperty()
  @IsUUID()
  storeId!: string;

  @ApiProperty({
    description: "Shu do'kondagi rol. Ayni odam boshqa filialda boshqa rolda bo'lishi mumkin.",
  })
  @IsUUID()
  roleId!: string;

  @ApiPropertyOptional({
    description: "Yangi sessiya qaysi do'konga tushadi. Faqat bittasi asosiy bo'la oladi.",
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class ResetPasswordDto {
  @ApiProperty({
    description:
      "Administrator yangi parolni o'zi beradi va xodimga tizimdan tashqari yetkazadi. " +
      'Javobda ham, auditda ham parol qaytarilmaydi.',
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}
