import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { ManagementAuditService } from './management-audit.service';

@Controller('audit/management')
export class ManagementAuditController {
  constructor(private readonly audit: ManagementAuditService) {}

  @Get()
  list(
    @Req() req: Request,
    @Query('groupId') groupId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.list(actorFromRequest(req), groupId, Number(limit || 200));
  }
}
