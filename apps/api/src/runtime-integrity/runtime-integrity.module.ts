import { Module } from '@nestjs/common';
import { ManagementAuditModule } from '../audit/management-audit.module';
import { DbModule } from '../db/db.module';
import { RuntimeIntegrityController } from './runtime-integrity.controller';
import { RuntimeIntegrityService } from './runtime-integrity.service';

@Module({
  imports: [DbModule, ManagementAuditModule],
  controllers: [RuntimeIntegrityController],
  providers: [RuntimeIntegrityService],
  exports: [RuntimeIntegrityService],
})
export class RuntimeIntegrityModule {}
