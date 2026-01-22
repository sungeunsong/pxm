import { Module } from '@nestjs/common';
import { DebugController } from './debug.controller';
import { DbModule } from '../db/db.module';
import { FlakyController } from './flaky.controller';

@Module({
  imports: [DbModule], // PG_POOL 쓰려면 필요
  controllers: [DebugController, FlakyController],
})
export class DebugModule {}
