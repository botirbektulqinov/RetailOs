import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { OrganizationsService } from './organizations.service';

@ApiTags('organizations')
@ApiBearerAuth('bearer')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get('current')
  @ApiOperation({
    summary: 'Joriy tashkilot',
    description:
      "Tashkilot tokendan aniqlanadi — id parametri qabul qilinmaydi, chunki u faqat o'ziniki " +
      "yoki birovniki bo'lishi mumkin, birinchisi ortiqcha, ikkinchisi esa hujum.",
  })
  current(@CurrentUser() user: TenantContext) {
    return this.organizations.current(user);
  }
}
