import { Controller, Get, Post, Put, Delete, Body, Param, Query, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/pg.provider';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/template.dto';
import { randomUUID } from 'crypto';

@Controller('templates')
export class TemplatesController {
  constructor(
    private readonly templatesService: TemplatesService,
    @Inject(PG_POOL) private readonly pool: Pool,
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

    const instanceId = randomUUID();
    
    // 시작 노드 찾기
    const startNode = template.nodes.find((n: any) => n.data?.nodeType === 'start');
    if (!startNode) {
      throw new Error('Start node not found in template');
    }

    // ctx 구조: Rust Engine이 기대하는 형식
    const ctx = {
      cursor: startNode.id, // 시작 노드 ID
      nodes: template.nodes,
      edges: template.edges,
      template_id: template.id,
      template_name: template.name,
      // formData 추가 (있으면)
      ...(body?.formData && { formData: body.formData }),
    };

    const client = await this.pool.connect();
    try {
      await client.query('begin');

      // 1) process_instance 생성
      await client.query(
        `INSERT INTO process_instance (id, template_id, status, ctx)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`,
        [instanceId, template.id, 'CREATED', JSON.stringify(ctx)],
      );

      // 2) engine_jobs 생성 (START)
      const jobRes = await client.query(
        `INSERT INTO engine_jobs (instance_id, type, run_at, status, payload)
         VALUES ($1::uuid, $2, now(), 'READY', $3::jsonb)
         RETURNING id`,
        [
          instanceId,
          'START',
          JSON.stringify({
            node_id: startNode.id,
            reason: 'template_execute',
          }),
        ],
      );
      const jobId = jobRes.rows[0]?.id;

      // 3) event_outbox 생성
      await client.query(
        `INSERT INTO event_outbox (instance_id, type, payload)
         VALUES ($1::uuid, $2, $3::jsonb)`,
        [
          instanceId,
          'INSTANCE_CREATED',
          JSON.stringify({
            instance_id: instanceId,
            template_id: template.id,
            template_name: template.name,
            status: 'CREATED',
            job_id: jobId,
            timestamp: new Date().toISOString(),
          }),
        ],
      );

      await client.query('commit');

      return {
        instance_id: instanceId,
        template_id: template.id,
        template_name: template.name,
        status: 'CREATED',
        job_id: jobId,
      };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
}
