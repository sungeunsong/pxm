import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Version,
} from '@nestjs/common';
import type { Request } from 'express';
import { actorFromRequest } from '../instances/history-auth';
import { CompleteTaskDto } from './dto/task.dto';
import { TasksService } from './tasks.service';
import { TaskHistoryQueryDto } from './dto/task-history.dto';
import { PUBLIC_API_VERSIONS } from '../public-api-version';
import { ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PublicApiController, PublicApiErrors } from '../openapi/public-api.decorators';
import { ApprovalTaskDto, ApprovalTaskPageDto, CompleteApprovalDto } from '../openapi/public-api.dto';

@Controller('tasks')
@ApiTags('Approvals')
@PublicApiController()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  // 내 할 일 목록 조회
  @Get()
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '내 결재 대기 목록 조회' })
  @ApiOkResponse({ type: ApprovalTaskDto, isArray: true })
  @PublicApiErrors()
  async getTasks(@Req() req: Request) {
    return this.tasks.listOpenTasks(actorFromRequest(req));
  }

  @Get('history')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '결재 이력 조회' })
  @ApiQuery({ name: 'status', required: false, example: 'OPEN,APPROVED,REJECTED' })
  @ApiQuery({ name: 'workflow_id', required: false })
  @ApiQuery({ name: 'instance_id', required: false })
  @ApiQuery({ name: 'assignee', required: false })
  @ApiQuery({ name: 'approver_channel', required: false, enum: ['pxm_user', 'external_email'] })
  @ApiQuery({ name: 'from', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'to', required: false, type: String, format: 'date-time' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiOkResponse({ type: ApprovalTaskPageDto })
  @PublicApiErrors()
  history(@Query() query: TaskHistoryQueryDto, @Req() req: Request) {
    return this.tasks.listHistory(query, actorFromRequest(req));
  }

  @Get(':id')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '결재 상세 조회' })
  @ApiParam({ name: 'id', description: '결재 Task ID' })
  @ApiOkResponse({ type: ApprovalTaskDto })
  @PublicApiErrors()
  historyItem(@Param('id') id: string, @Req() req: Request) {
    return this.tasks.getHistoryItem(id, actorFromRequest(req));
  }

  // 승인/반려 처리
  @Post(':id/complete')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '결재 승인 또는 반려' })
  @ApiParam({ name: 'id', description: '결재 Task ID' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: '중복 처리 방지 키' })
  @ApiBody({ type: CompleteApprovalDto })
  @ApiOkResponse({ type: ApprovalTaskDto })
  @PublicApiErrors()
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
@ApiTags('Approvals')
@PublicApiController()
export class InstanceTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get(':instanceId/tasks')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '인스턴스의 결재 이력 조회' })
  @ApiParam({ name: 'instanceId', description: '인스턴스 ID' })
  @ApiQuery({ name: 'status', required: false, example: 'OPEN,APPROVED,REJECTED' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 50 })
  @ApiOkResponse({ type: ApprovalTaskPageDto })
  @PublicApiErrors()
  history(
    @Param('instanceId') instanceId: string,
    @Query() query: TaskHistoryQueryDto,
    @Req() req: Request,
  ) {
    return this.tasks.listHistory(query, actorFromRequest(req), instanceId);
  }
}
