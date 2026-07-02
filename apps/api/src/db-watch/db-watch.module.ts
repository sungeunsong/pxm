import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { DbWatchService } from './db-watch.service';

@Module({
  imports: [DbModule],
  providers: [DbWatchService],
  exports: [DbWatchService],
})
export class DbWatchModule {}
