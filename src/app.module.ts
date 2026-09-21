import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';

import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildLoggerOptions } from './common/logging/logger.options';
import { AppConfig, ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/prisma.module';
import { EmployeesModule } from './employees/employees.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { RbacModule } from './rbac/rbac.module';
import { StoresModule } from './stores/stores.module';

@Module({
  imports: [
    ConfigModule,
    // AsyncLocalStorage for the tenant context. It has to be request-scoped
    // storage rather than a parameter because the Prisma extension runs far
    // below the controller and has no other way to learn whose request it is
    // serving (docs/ARCHITECTURE.md §4.3).
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        buildLoggerOptions({
          NODE_ENV: config.get('NODE_ENV'),
          LOG_LEVEL: config.get('LOG_LEVEL'),
        }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.get('RATE_LIMIT_TTL_SECONDS') * 1000,
            limit: config.get('RATE_LIMIT_LIMIT'),
          },
        ],
      }),
    }),
    DatabaseModule,
    AuditModule,
    AuthModule,
    OrganizationsModule,
    StoresModule,
    RbacModule,
    EmployeesModule,
    CatalogModule,
    InventoryModule,
    HealthModule,
  ],
  providers: [
    // Order matters. Throttling first so a flood is rejected before it costs a
    // token verification or a database round trip; authentication next, so the
    // permission guard can rely on a tenant context existing.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
