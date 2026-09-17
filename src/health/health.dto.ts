import { ApiProperty } from '@nestjs/swagger';

export type HealthStatus = 'ok' | 'degraded';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded'] })
  status!: HealthStatus;

  @ApiProperty({ example: '2026-09-17T10:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: 42.5, description: 'Process uptime in seconds.' })
  uptimeSeconds!: number;

  @ApiProperty({ example: '0.1.0' })
  version!: string;

  @ApiProperty({ example: 'development' })
  environment!: string;
}

export class DependencyCheckDto {
  @ApiProperty({ enum: ['up', 'down'] })
  status!: 'up' | 'down';

  @ApiProperty({ example: 3, description: 'Check duration in milliseconds.' })
  latencyMs!: number;

  @ApiProperty({
    required: false,
    description: 'Generic failure reason. Never contains connection strings or driver detail.',
  })
  error?: string;
}

export class ReadinessResponseDto extends HealthResponseDto {
  @ApiProperty({
    type: DependencyCheckDto,
    isArray: false,
    description: 'One entry per required dependency, keyed by name (e.g. "database").',
    additionalProperties: { $ref: '#/components/schemas/DependencyCheckDto' },
  })
  checks!: Record<string, DependencyCheckDto>;
}
