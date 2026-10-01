import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  Version,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  actorFromRequest,
  instanceAccessFromRequest,
} from '../instances/history-auth';
import { correlationIdFromRequest } from '../observability/correlation-id.middleware';
import { PUBLIC_API_VERSIONS } from '../public-api-version';
import {
  PublicApiController,
  PublicApiErrors,
} from '../openapi/public-api.decorators';
import {
  ToolDefinitionDto,
  ToolInvokeDto,
  ToolInvokeResponseDto,
  ToolListResponseDto,
} from '../openapi/public-api.dto';
import { ToolsService, type ToolInvokeBody } from './tools.service';

/** AI 하네스용 Tool 공개 API. 게시·관리는 /api/entry-points */
@Controller('tools')
@ApiTags('Tools')
@PublicApiController()
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Get()
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({
    summary: 'Tool 목록',
    description:
      'tool:read 권한 범위가 필요합니다. 응답은 LLM tool 정의로 바로 바꿀 수 있는 모양입니다. ' +
      'naming=auto(기본)는 이름이 겹치는 Tool만 한정 이름을 씁니다. 여러 턴에 걸쳐 이름을 캐시하면 naming=qualified를 쓰세요.',
  })
  @ApiQuery({
    name: 'naming',
    required: false,
    enum: ['auto', 'qualified', 'plain'],
  })
  @ApiQuery({
    name: 'side_effect',
    required: false,
    description: '쉼표로 여러 값',
  })
  @ApiQuery({
    name: 'tags',
    required: false,
    description: '쉼표로 여러 값. 하나라도 맞으면 포함',
  })
  @ApiOkResponse({ type: ToolListResponseDto })
  @PublicApiErrors()
  list(
    @Query('naming') naming: string | undefined,
    @Query('side_effect') sideEffect: string | undefined,
    @Query('tags') tags: string | undefined,
    @Req() req: Request,
  ) {
    return this.tools.list(actorFromRequest(req), {
      naming,
      side_effect: sideEffect,
      tags,
    });
  }

  @Get('invocations/:instance_id')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({
    summary: 'Tool 호출 결과 확인',
    description:
      'tool:invoke 권한 범위가 필요합니다. 202(pending_approval·running)를 받은 뒤 이 주소로 결과를 확인합니다. 응답 모양은 실행 API와 같습니다.',
  })
  @ApiParam({ name: 'instance_id' })
  @ApiOkResponse({
    type: ToolInvokeResponseDto,
    description: '완료 또는 업무 실패',
  })
  @ApiResponse({
    status: 202,
    type: ToolInvokeResponseDto,
    description: '결재 대기 또는 진행 중',
  })
  @PublicApiErrors()
  async invocation(
    @Param('instance_id') instanceId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const outcome = await this.tools.invocation(
      actorFromRequest(req),
      instanceId,
      correlationIdFromRequest(req),
    );
    for (const [header, value] of Object.entries(outcome.headers))
      res.setHeader(header, value);
    res.status(outcome.http_status);
    return outcome.body;
  }

  @Get(':name')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({
    summary: 'Tool 상세',
    description:
      'tool:read 권한 범위가 필요합니다. 이름은 Tool 이름 또는 한정 이름입니다.',
  })
  @ApiParam({ name: 'name' })
  @ApiQuery({ name: 'group_id', required: false })
  @ApiOkResponse({ type: ToolDefinitionDto })
  @PublicApiErrors()
  describe(
    @Param('name') name: string,
    @Query('group_id') groupId: string | undefined,
    @Req() req: Request,
  ) {
    return this.tools.describe(
      actorFromRequest(req),
      name,
      groupId?.trim() || undefined,
    );
  }

  @Post(':name/invoke')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({
    summary: 'Tool 실행',
    description:
      'tool:invoke 권한 범위가 필요합니다. Tool에 고정된 워크플로우 버전을 실행합니다. ' +
      '200 ok(완료) / 200 error(업무 실패, 재시도하지 않음) / 202 pending_approval(결재 대기) / 202 running(진행 중). ' +
      '실행 실패는 원인별 HTTP 코드와 failure_type·retryable을 줍니다. 자동 재시도는 HTTP 코드가 아니라 retryable로 판단하고, ' +
      'side_effect가 read_only가 아니면 첫 호출과 같은 Idempotency-Key로 재시도하세요.',
  })
  @ApiParam({ name: 'name' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: '1~200자의 중복 실행 방지 키',
  })
  @ApiBody({ type: ToolInvokeDto, required: false })
  @ApiOkResponse({
    type: ToolInvokeResponseDto,
    description: '완료 또는 업무 실패',
  })
  @ApiResponse({
    status: 202,
    type: ToolInvokeResponseDto,
    description: '결재 대기 또는 진행 중',
  })
  @PublicApiErrors()
  async invoke(
    @Param('name') name: string,
    @Body() body: ToolInvokeBody | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const outcome = await this.tools.invoke(
      actorFromRequest(req),
      name,
      body || {},
      {
        idempotencyKey,
        access: (formData) => instanceAccessFromRequest(req, formData),
        requestId: correlationIdFromRequest(req),
      },
    );
    for (const [header, value] of Object.entries(outcome.headers))
      res.setHeader(header, value);
    res.status(outcome.http_status);
    return outcome.body;
  }
}
