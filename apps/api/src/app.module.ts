import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InstancesModule } from './instances/instances.module';
import { DebugModule } from './debug/debug.module';
import { TemplatesModule } from './templates/templates.module';
import { TasksModule } from './tasks/tasks.module';

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
  ],
})
export class AppModule {}
