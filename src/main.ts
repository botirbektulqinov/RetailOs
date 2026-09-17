import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { applyGlobalSetup } from './bootstrap';
import { AppConfig } from './config/config.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Defer all logging to pino so nothing is written in a second format before
    // the real logger is attached.
    bufferLogs: true,
  });

  app.useLogger(app.get(PinoLogger));
  applyGlobalSetup(app);

  const config = app.get(AppConfig);
  const logger = new Logger('Bootstrap');
  const port = config.get('PORT');
  const prefix = config.get('API_PREFIX');

  await app.listen(port, '0.0.0.0');

  logger.log(`RetailOS API listening on port ${port} (${config.get('NODE_ENV')})`);
  logger.log(`Health:  http://localhost:${port}/${prefix}/v1/health`);
  if (config.get('SWAGGER_ENABLED')) {
    logger.log(`Swagger: http://localhost:${port}/${prefix}/docs`);
  }
}

void bootstrap().catch((error: unknown) => {
  // Config validation runs before the logger exists, so this uses console and
  // exits non-zero — a container that cannot boot must not look healthy.
  console.error('Failed to start RetailOS API:', error instanceof Error ? error.message : error);
  process.exit(1);
});
