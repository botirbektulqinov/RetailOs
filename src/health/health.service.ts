import { Injectable, Logger } from '@nestjs/common';

import { AppConfig } from '../config/config.module';
import { PrismaService } from '../database/prisma.service';
import type { DependencyCheckDto, HealthResponseDto, ReadinessResponseDto } from './health.dto';

/** A hung database must fail the probe, not hold the connection open forever. */
const DB_CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly version: string = process.env['npm_package_version'] ?? '0.1.0';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  liveness(): HealthResponseDto {
    return this.base('ok');
  }

  async readiness(): Promise<ReadinessResponseDto> {
    const database = await this.checkDatabase();
    const checks = { database };
    const healthy = Object.values(checks).every((check) => check.status === 'up');

    return { ...this.base(healthy ? 'ok' : 'degraded'), checks };
  }

  private base(status: 'ok' | 'degraded'): HealthResponseDto {
    return {
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
      version: this.version,
      environment: this.config.get('NODE_ENV'),
    };
  }

  private async checkDatabase(): Promise<DependencyCheckDto> {
    const startedAt = process.hrtime.bigint();

    try {
      await this.withTimeout(this.prisma.ping(), DB_CHECK_TIMEOUT_MS);
      return { status: 'up', latencyMs: this.elapsedMs(startedAt) };
    } catch (error) {
      // The real error goes to the log; the response says only that it is down.
      // A probe body is unauthenticated, so it must not describe the failure.
      this.logger.error({ err: error }, 'Database health check failed');
      return {
        status: 'down',
        latencyMs: this.elapsedMs(startedAt),
        error: 'unreachable',
      };
    }
  }

  private elapsedMs(startedAt: bigint): number {
    return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
