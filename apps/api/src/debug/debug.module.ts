import { Module } from '@nestjs/common';
import { DebugController } from './debug.controller';
import { DbModule } from '../db/db.module';

@Module({
  imports: [DbModule], // PG_POOL 쓰려면 필요
  controllers: [DebugController],
})
export class DebugModule {}
