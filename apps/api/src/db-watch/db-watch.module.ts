import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { DbWatchController } from './db-watch.controller';
import { DbWatchService } from './db-watch.service';

@Module({
  imports: [DbModule, CredentialsModule],
  controllers: [DbWatchController],
  providers: [DbWatchService],
  exports: [DbWatchService],
})
export class DbWatchModule {}
