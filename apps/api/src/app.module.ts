import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { InstancesModule } from './instances/instances.module';
import { DebugModule } from './debug/debug.module';
import { TemplatesModule } from './templates/templates.module';
import { TasksModule } from './tasks/tasks.module';
import { PluginsModule } from './plugins/plugins.module';
import { CredentialsModule } from './credentials/credentials.module';
import { EngineModule } from './engine/engine.module';
import { SchedulesModule } from './schedules/schedules.module';
import { CommandsModule } from './commands/commands.module';
import { DbWatchModule } from './db-watch/db-watch.module';
import { AuthzModule } from './authz/authz.module';
import { AuthenticatedGuard } from './authz/authenticated.guard';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'], // apps/api/.env
    }),
    InstancesModule,
    DebugModule,
    TemplatesModule,
    TasksModule,
    PluginsModule,
    CredentialsModule,
    CommandsModule,
    EngineModule,
    SchedulesModule,
    DbWatchModule,
    AuthzModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthenticatedGuard,
    },
  ],
})
export class AppModule {}
