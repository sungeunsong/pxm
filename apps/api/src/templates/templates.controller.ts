import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';
import { WorkflowInstanceRepositoryPort } from '../db/ports/db.ports';
import { randomUUID } from 'crypto';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
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
    @Body() body: { name?: string; nodes: any[]; edges: any[] },
  ) {
    const template = await this.templatesService.update(id, {
      name: body.name,
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
    @Body() body?: { formData?: Record<string, any> },
  ) {
    // 템플릿 조회
    const template = await this.templatesService.findOne(id);
    if (!template) {
      throw new Error('Template not found');
    }

    // 실행 요청마다 새로운 인스턴스를 발급한다
    const instanceId = randomUUID();
    
    // 시작 노드 찾기
    const startNode = template.nodes.find((n: any) => n.data?.nodeType === 'start');
    if (!startNode) {
      throw new Error('Start node not found in template');
    }

    // ctx 구조: Rust Engine이 기대하는 실행 컨텍스트
    const ctx = {
      cursor: startNode.id, // 시작 노드 ID
      nodes: template.nodes,
      edges: template.edges,
      template_id: template.id,
      template_name: template.name,
      ...(body?.formData && { formData: body.formData }),
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

    return {
      instance_id: instanceId,
      template_id: template.id,
      template_name: template.name,
      status: 'CREATED',
    };
  }
}
