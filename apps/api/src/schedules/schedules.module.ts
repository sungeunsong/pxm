import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { SchedulesService } from './schedules.service';

@Module({
  imports: [DbModule],
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
