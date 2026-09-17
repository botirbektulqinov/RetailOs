import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshDto {
  @ApiProperty({ description: 'Login yoki oldingi refresh javobida berilgan token.' })
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  refreshToken!: string;
}
