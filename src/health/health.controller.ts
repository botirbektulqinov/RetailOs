import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/decorators/public.decorator';

import { HealthResponseDto, ReadinessResponseDto } from './health.dto';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
// Probes run before anyone has a token, and a load balancer cannot hold one.
@Public()
// Monitoring probes poll far more often than a human client and must not be
// throttled into failing, which would look like an outage.
@SkipThrottle()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Reports that the process is up and serving. Does not touch the database — ' +
      'used by Docker HEALTHCHECK and the load balancer, which must not restart ' +
      'the container because a dependency is briefly unavailable.',
  })
  @ApiOkResponse({ type: HealthResponseDto })
  live(): HealthResponseDto {
    return this.health.liveness();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Reports whether the application can actually serve traffic: database ' +
      'reachable and responsive. Returns 503 when any required dependency is down, ' +
      'so a deploy gate fails instead of routing traffic to a broken instance.',
  })
  @ApiOkResponse({ type: ReadinessResponseDto })
  @ApiServiceUnavailableResponse({ type: ReadinessResponseDto })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponseDto> {
    const report = await this.health.readiness();

    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
