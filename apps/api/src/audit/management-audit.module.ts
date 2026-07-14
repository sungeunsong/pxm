import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ManagementAuditController } from './management-audit.controller';
import { ManagementAuditService } from './management-audit.service';

@Module({
  imports: [DbModule],
  controllers: [ManagementAuditController],
  providers: [ManagementAuditService],
  exports: [ManagementAuditService],
})
export class ManagementAuditModule {}
