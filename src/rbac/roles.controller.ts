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
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { CreateRoleDto, UpdateRolePermissionsDto } from './dto/role.dto';
import { RolesService } from './roles.service';

@ApiTags('roles')
@ApiBearerAuth('bearer')
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'Rollar ro\u2018yxati',
    description: 'Rollar ekrani: nom, izoh va har bir rolga biriktirilgan xodimlar soni.',
  })
  list() {
    return this.roles.list();
  }

  @Get('permissions/catalogue')
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'Barcha mavjud ruxsatlar',
    description: 'Guruhlangan to\u2018liq ruxsatlar katalogi — rol muharriri uchun.',
  })
  catalogue() {
    return this.roles.catalogue();
  }

  @Get(':id/permissions')
  @RequirePermissions('roles.read')
  @ApiOperation({
    summary: 'Rol ruxsatlari',
    description: 'Ruxsatlar ekrani: har bir ruxsat va uning yoqilgan/o\u2018chirilgan holati.',
  })
  permissions(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.getPermissions(id);
  }

  @Put(':id/permissions')
  @RequirePermissions('roles.manage')
  @ApiOperation({
    summary: 'Rol ruxsatlarini saqlash',
    description:
      "Yuborilgan ro'yxat mavjudlarining o'rnini bosadi. O'zgarish darhol kuchga kiradi — " +
      'mavjud tokenlar ham qayta tekshiriladi.',
  })
  @ApiConflictResponse({ description: 'ROLE_IMMUTABLE — Administrator roli tahrirlanmaydi.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRolePermissionsDto,
    @CurrentUser() user: TenantContext,
  ) {
    return this.roles.updatePermissions(id, dto, user);
  }

  @Post()
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: 'Yangi rol yaratish' })
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: TenantContext) {
    return this.roles.create(dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('roles.manage')
  @ApiOperation({ summary: "Rolni o'chirish" })
  @ApiConflictResponse({ description: 'ROLE_IN_USE · ROLE_IMMUTABLE' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: TenantContext,
  ): Promise<void> {
    await this.roles.remove(id, user);
  }
}
