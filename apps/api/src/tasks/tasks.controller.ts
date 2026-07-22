import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { CompleteTaskDto } from './dto/task.dto';
import { TasksService } from './tasks.service';
import { TaskHistoryQueryDto } from './dto/task-history.dto';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  // 내 할 일 목록 조회
  @Get()
  async getTasks(@Req() req: Request) {
    return this.tasks.listOpenTasks(actorFromRequest(req));
  }

  @Get('history')
  history(@Query() query: TaskHistoryQueryDto, @Req() req: Request) {
    return this.tasks.listHistory(query, actorFromRequest(req));
  }

  @Get(':id')
  historyItem(@Param('id') id: string, @Req() req: Request) {
    return this.tasks.getHistoryItem(id, actorFromRequest(req));
  }

  // 승인/반려 처리
  @Post(':id/complete')
  async completeTask(
    @Param('id') id: string,
    @Body() body: CompleteTaskDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
  ) {
    return this.tasks.completeTask(
      id,
      body,
      actorFromRequest(req),
      idempotencyKey,
    );
  }

  @Post(':id/external-approval/retry')
  retryExternalApproval(@Param('id') id: string, @Req() req: Request) {
    return this.tasks.retryExternalApproval(id, actorFromRequest(req));
  }
}

@Controller('instances')
export class InstanceTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get(':instanceId/tasks')
  history(
    @Param('instanceId') instanceId: string,
    @Query() query: TaskHistoryQueryDto,
    @Req() req: Request,
  ) {
    return this.tasks.listHistory(query, actorFromRequest(req), instanceId);
  }
}
