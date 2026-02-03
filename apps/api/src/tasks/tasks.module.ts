import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { DbModule } from '../db/db.module';

@Module({
  imports: [DbModule],
  controllers: [TasksController],
})
export class TasksModule {}
