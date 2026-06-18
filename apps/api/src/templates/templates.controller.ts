import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';
import { WorkflowInstanceRepositoryPort } from '../db/ports/db.ports';
import { InstancesService } from '../instances/instances.service';
import { randomUUID } from 'crypto';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
    private readonly instancesService: InstancesService,
  ) {}

  @Post()
  async create(@Body() dto: CreateTemplateDto) {
    return this.templatesService.create(dto);
  }

  @Get()
  async findAll(@Query('activeOnly') activeOnly?: string) {
    const active = activeOnly !== 'false';
    return this.templatesService.findAll(active);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const template = await this.templatesService.findOne(id);
    if (!template) {
      throw new Error('Template not found');
    }
    return template;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    const template = await this.templatesService.update(id, dto);
    if (!template) {
      throw new Error('Template not found');
    }
    return template;
  }

  @Post(':id/deploy')
  async deploy(
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      description?: string;
      group?: string;
      tags?: string[];
      version_note?: string;
      nodes: any[];
      edges: any[];
    },
  ) {
    const template = await this.templatesService.update(id, {
      name: body.name,
      description: body.description,
      group: body.group,
      tags: body.tags,
      version_note: body.version_note,
      nodes: body.nodes,
      edges: body.edges,
    });
    if (!template) {
      throw new Error('Template not found');
    }
    console.log(`[BFF] Template ${id} deployed. Nodes: ${body.nodes.length}, Edges: ${body.edges.length}`);
    return { success: true, template };
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    const success = await this.templatesService.delete(id);
    if (!success) {
      throw new Error('Template not found');
    }
    return { message: 'Template deleted successfully' };
  }

  @Post(':id/execute')
  async execute(
    @Param('id') id: string,
    @Body() body?: StartWorkflowRequest,
    @Res({ passthrough: true }) res?: Response,
  ) {
    return this.start(id, body, res);
  }

  @Post(':id/start')
  async start(
    @Param('id') id: string,
    @Body() body?: StartWorkflowRequest,
    @Res({ passthrough: true }) res?: Response,
  ) {
    // 템플릿 조회
    const template = await this.templatesService.findOne(id);
    if (!template) {
      throw new Error('Template not found');
    }

    // 실행 요청마다 새로운 인스턴스를 발급한다
    const instanceId = randomUUID();
    const mode = body?.mode === 'sync' ? 'sync' : 'async';

    // 시작 노드 찾기
    const startNode = template.nodes.find((n: any) => n.data?.nodeType === 'start');
    if (!startNode) {
      throw new Error('Start node not found in template');
    }

    // ctx 구조: Rust Engine이 기대하는 실행 컨텍스트
    const ctx = {
      runtime: {
        cursor: startNode.id,
        nodes: template.nodes,
        edges: template.edges,
        template_id: template.id,
        template_name: template.name,
      },
      data: {
        formData: body?.input || body?.formData || {},
        outputs: {},
      },
    };

    // 1) process_instance 생성
    await this.instanceRepo.createInstance(instanceId, template.id, 'CREATED', ctx);

    // 2) engine_jobs 생성 (START)
    await this.instanceRepo.createJob({
      instanceId,
      type: 'START',
      runAt: new Date(),
      payload: {
        node_id: startNode.id,
        reason: 'template_execute',
      },
    });

    // 3) 시작 토큰 발행
    const startTokenId = randomUUID();
    await this.instanceRepo.createToken({
      id: startTokenId,
      instanceId,
      nodeId: startNode.id,
      status: 'ACTIVE',
    });

    console.log(`[BFF] Executed template ${template.name}. instance_id=${instanceId}`);

    const acceptedResponse = {
      instance_id: instanceId,
      template_id: template.id,
      template_name: template.name,
      status: 'CREATED',
      mode,
      result_url: `/api/instances/${instanceId}/result`,
      trace_url: `/api/instances/${instanceId}/trace`,
      stream_url: `/api/instances/${instanceId}/stream`,
    };

    if (mode === 'async') {
      res?.status(HttpStatus.ACCEPTED);
      return acceptedResponse;
    }

    const waitResult = await this.waitForInstanceResult(
      instanceId,
      body?.sync_timeout_ms,
    );

    if (waitResult.timedOut) {
      res?.status(HttpStatus.ACCEPTED);
      return {
        ...acceptedResponse,
        status: waitResult.status || 'RUNNING',
        timed_out: true,
      };
    }

    res?.status(HttpStatus.OK);
    return {
      ...acceptedResponse,
      status: waitResult.status,
      result: waitResult.result,
      result_path: waitResult.result_path,
      completed_at: waitResult.completed_at,
      timed_out: false,
    };
  }

  private async waitForInstanceResult(
    instanceId: string,
    requestedTimeoutMs?: number,
  ): Promise<{
    timedOut: boolean;
    status?: string;
    result?: any;
    result_path?: string | null;
    completed_at?: string | null;
  }> {
    const timeoutMs = normalizeSyncTimeoutMs(requestedTimeoutMs);
    const pollMs = Number(process.env.START_SYNC_POLL_MS ?? 250);
    const deadline = Date.now() + timeoutMs;
    let latest: any = null;

    while (Date.now() <= deadline) {
      latest = await this.instancesService.getResult(instanceId);
      if (latest?.status === 'COMPLETED' || latest?.status === 'FAILED') {
        return { timedOut: false, ...latest };
      }
      await sleep(Math.max(50, pollMs));
    }

    latest = await this.instancesService.getResult(instanceId);
    return {
      timedOut: true,
      status: latest?.status,
      result_path: latest?.result_path,
      completed_at: latest?.completed_at,
    };
  }
}

type StartWorkflowRequest = {
  mode?: 'async' | 'sync';
  sync_timeout_ms?: number;
  input?: Record<string, any>;
  formData?: Record<string, any>;
};

function normalizeSyncTimeoutMs(value?: number): number {
  const defaultTimeout = Number(process.env.START_SYNC_TIMEOUT_MS ?? 10000);
  const maxTimeout = Number(process.env.START_SYNC_MAX_TIMEOUT_MS ?? 30000);
  const timeout = Number.isFinite(value) && value ? Number(value) : defaultTimeout;
  return Math.min(Math.max(timeout, 100), maxTimeout);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
