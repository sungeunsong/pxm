import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { DbModule } from '../db/db.module';
import { InstancesModule } from '../instances/instances.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { DbWatchModule } from '../db-watch/db-watch.module';

@Module({
  imports: [DbModule, InstancesModule, SchedulesModule, DbWatchModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
