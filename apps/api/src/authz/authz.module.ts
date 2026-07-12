import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ApiKeyAuthMiddleware } from './api-key-auth.middleware';
import { AuthzController } from './authz.controller';
import { AuthzService } from './authz.service';

@Module({
  imports: [DbModule],
  controllers: [AuthzController],
  providers: [AuthzService, ApiKeyAuthMiddleware],
  exports: [AuthzService],
})
export class AuthzModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ApiKeyAuthMiddleware).forRoutes('*');
  }
}
