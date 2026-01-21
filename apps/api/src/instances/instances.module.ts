import { Module } from '@nestjs/common';
import { InstancesController } from './instances.controller';
import { OutboxService } from '../outbox/outbox.service';
import { DbModule } from '../db/db.module';

@Module({
  imports: [DbModule], // <-- 중요
  controllers: [InstancesController],
  providers: [OutboxService],
})
export class InstancesModule {}
