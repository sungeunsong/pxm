import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { EngineController } from './engine.controller';

@Module({
  imports: [DbModule],
  controllers: [EngineController],
})
export class EngineModule {}
