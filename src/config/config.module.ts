import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';

import type { Env } from './env.schema';
import { validateEnv } from './env.schema';

/**
 * Typed wrapper over Nest's ConfigService.
 *
 * `ConfigService.get()` returns `T | undefined` even for values that are
 * guaranteed present, which pushes non-null assertions into every caller.
 * Because validateEnv() has already defaulted and verified everything, this
 * wrapper can honestly promise the value exists.
 */
export class AppConfig {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }
}

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // .env is for local development only. In Docker and production the values
      // come from the environment itself, so a missing file is not an error.
      envFilePath: ['.env'],
      ignoreEnvFile: process.env['NODE_ENV'] === 'production',
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: AppConfig,
      useFactory: (config: ConfigService<Env, true>) => new AppConfig(config),
      inject: [ConfigService],
    },
  ],
  exports: [AppConfig],
})
export class ConfigModule {}
