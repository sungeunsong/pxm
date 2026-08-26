import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { PublicApiExceptionFilter } from './public-api-exception.filter';

@Module({
  providers: [
    CorrelationIdMiddleware,
    { provide: APP_FILTER, useClass: PublicApiExceptionFilter },
  ],
})
export class HttpObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
