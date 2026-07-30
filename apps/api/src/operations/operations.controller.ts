import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { OperationsOverviewQueryDto, RuntimeOperationDto } from './dto/operations.dto';
import { OperationsService } from './operations.service';

@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('overview')
  overview(@Query() query: OperationsOverviewQueryDto, @Req() req: Request) {
    return this.operations.overview(
      actorFromRequest(req),
      query.waiting_threshold_minutes || 60,
      query.limit || 100,
    );
  }

  @Post('jobs/:id/retry')
  retryJob(@Param('id') id: string, @Body() body: RuntimeOperationDto, @Req() req: Request) {
    return this.operations.retryJob(id, body.reason, actorFromRequest(req));
  }

  @Post('instances/:id/reclaim-lock')
  reclaimLock(@Param('id') id: string, @Body() body: RuntimeOperationDto, @Req() req: Request) {
    return this.operations.reclaimLock(id, body.reason, actorFromRequest(req));
  }

  @Post('outbox/:id/retry')
  retryOutbox(@Param('id') id: string, @Body() body: RuntimeOperationDto, @Req() req: Request) {
    return this.operations.retryOutbox(id, body.reason, actorFromRequest(req));
  }
}
