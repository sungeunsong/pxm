import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { ResourceRequestsService, type CreateResourceRequest, type ResourceRequestStatus } from './resource-requests.service';

/** 콘솔 전용. 공개 API(/api/v1)에는 노출하지 않는다. */
@Controller('resource-requests')
export class ResourceRequestsController {
  constructor(private readonly service: ResourceRequestsService) {}

  @Get()
  list(@Query('scope') scope: string | undefined, @Query('status') status: string | undefined, @Req() req: Request) {
    const normalizedStatus = ['pending', 'approved', 'rejected', 'cancelled'].includes(String(status))
      ? (status as ResourceRequestStatus)
      : undefined;
    return this.service.list(scope === 'to_me' ? 'to_me' : 'mine', actorFromRequest(req), normalizedStatus);
  }

  @Post()
  create(@Body() body: CreateResourceRequest, @Req() req: Request) {
    return this.service.create(body || {}, actorFromRequest(req));
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() body: { comment?: string } | undefined, @Req() req: Request) {
    return this.service.decide(id, 'approve', body?.comment, actorFromRequest(req));
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() body: { comment?: string } | undefined, @Req() req: Request) {
    return this.service.decide(id, 'reject', body?.comment, actorFromRequest(req));
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Req() req: Request) {
    return this.service.cancel(id, actorFromRequest(req));
  }
}
