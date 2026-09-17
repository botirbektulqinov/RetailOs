import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SwitchStoreDto {
  @ApiProperty({ description: "O'tiladigan do'kon. A'zolik tekshiriladi." })
  @IsUUID()
  storeId!: string;
}
