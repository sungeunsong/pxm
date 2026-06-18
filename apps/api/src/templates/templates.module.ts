import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { DbModule } from '../db/db.module';
import { InstancesModule } from '../instances/instances.module';

@Module({
  imports: [DbModule, InstancesModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
