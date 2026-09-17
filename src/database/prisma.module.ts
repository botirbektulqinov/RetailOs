import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Global so every future feature module gets the same client without importing
 * DatabaseModule everywhere. One PrismaClient per process is the rule — a second
 * one silently doubles the connection pool.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
