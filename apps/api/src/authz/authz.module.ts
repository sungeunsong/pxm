import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ApiKeyAuthMiddleware } from './api-key-auth.middleware';
import { SessionAuthController } from './session-auth.controller';
import { SessionAuthMiddleware } from './session-auth.middleware';
import { SessionAuthService } from './session-auth.service';
import { AuthzController } from './authz.controller';
import { AuthzService } from './authz.service';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { CredentialsModule } from '../credentials/credentials.module';

@Module({
  imports: [DbModule, ManagementAuditModule, CredentialsModule],
  controllers: [AuthzController, SessionAuthController],
  providers: [AuthzService, ApiKeyAuthMiddleware, SessionAuthMiddleware, SessionAuthService],
  exports: [AuthzService],
})
export class AuthzModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(SessionAuthMiddleware, ApiKeyAuthMiddleware).forRoutes('*');
  }
}
