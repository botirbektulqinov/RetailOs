import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import type { TenantContext } from '../common/tenant/tenant-context';
import { ExportQueryDto, ReportQueryDto } from './dto/report.dto';
import { ReportsService } from './reports.service';

/**
 * Twelve reports and one dashboard — docs/ARCHITECTURE.md §28.
 *
 * Every endpoint takes the same filter, so a client builds the query string
 * once. `reports.read` is the gate; the store a caller may read is decided in
 * the service from their memberships, because a permission says *what* not
 * *whose* (§20.4).
 */
@ApiTags('reports')
@ApiBearerAuth('bearer')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Sotuv hisoboti',
    description:
      "Tushum = sotuv − qaytarish. Kunlik qator do'kon vaqt mintaqasi bo'yicha, UTC emas.",
  })
  sales(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.sales(query, user);
  }

  @Get('products')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Mahsulot hisoboti',
    description: 'Qaytarilgani ayrilgan holda — qaytarilgan qator sotilgan qator emas.',
  })
  products(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.products(query, user);
  }

  @Get('employees')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Xodimlar hisoboti',
    description: 'Kim qancha sotdi va qancha chegirma berdi.',
  })
  employees(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.employees(query, user);
  }

  @Get('payments')
  @RequirePermissions('reports.read')
  @ApiOperation({ summary: "To'lov usullari bo'yicha" })
  payments(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.payments(query, user);
  }

  @Get('debt')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Qarzdorlik hisoboti',
    description: "Muddat bo'yicha guruhlash bugungi sanaga nisbatan hisoblanadi, saqlanmaydi.",
  })
  debt(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.debt(query, user);
  }

  @Get('cash')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Kassa hisoboti',
    description: 'Smenalar va ularning farqi — kamomad manfiy, ortiqcha musbat.',
  })
  cash(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.cash(query, user);
  }

  @Get('inventory')
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: 'Ombor hisoboti',
    description: "Zaxira qiymati o'rtacha tannarx bo'yicha (§8.6).",
  })
  inventory(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.inventory(query, user);
  }

  @Get('suppliers')
  @RequirePermissions('reports.read')
  @ApiOperation({ summary: 'Yetkazib beruvchilar hisoboti' })
  suppliers(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.suppliers(query, user);
  }

  @Get('returns')
  @RequirePermissions('reports.read')
  @ApiOperation({ summary: 'Qaytarishlar hisoboti' })
  returns(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.returns(query, user);
  }

  @Get('customers')
  @RequirePermissions('reports.read')
  @ApiOperation({ summary: 'Mijozlar hisoboti' })
  customers(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.customers(query, user);
  }

  /**
   * CSV, generated inline.
   *
   * No export job table, no worker, no download link: every report here is
   * capped at 500 rows by the filter, and a few hundred rows is a response,
   * not a background job. See ReportsService.exportCsv for when that changes.
   */
  @Get('export')
  @RequirePermissions('reports.export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="retailos-report.csv"')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'CSV eksport' })
  @ApiOkResponse({ description: 'CSV matn' })
  export(@Query() query: ExportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.exportCsv(query, user);
  }
}

/**
 * The home screen, in one request.
 *
 * Separate from `/reports` because it is a different question: a report is
 * "show me this period", the dashboard is "what is happening right now".
 */
@ApiTags('dashboard')
@ApiBearerAuth('bearer')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @RequirePermissions('reports.read')
  @ApiOperation({
    summary: "Bosh sahifa ko'rsatkichlari",
    description:
      "Bugungi tushum, sotuvlar soni, o'rtacha chek, kam qolgan tovarlar, qarzdorlik, " +
      "to'lov taqsimoti, kassa va oxirgi sotuvlar — bitta so'rovda.",
  })
  dashboard(@Query() query: ReportQueryDto, @CurrentUser() user: TenantContext) {
    return this.reports.dashboard(query, user);
  }
}
