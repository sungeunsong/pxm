import { Module } from '@nestjs/common';
import { InstancesController } from './instances.controller';
import { OutboxService } from '../outbox/outbox.service';
import { DbModule } from '../db/db.module';
import { InstancesService } from './instances.service';

@Module({
  imports: [DbModule], // <-- 중요
  controllers: [InstancesController],
  providers: [OutboxService, InstancesService],
  exports: [InstancesService],
})
export class InstancesModule {}
