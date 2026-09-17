import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/**
 * Global because the guards it provides are registered application-wide in
 * AppModule and every future feature module depends on them.
 */
@Global()
@Module({
  imports: [AuditModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, TokenService, SessionService],
  exports: [AuthService, PasswordService, TokenService, SessionService],
})
export class AuthModule {}
