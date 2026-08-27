import { Body, Controller, Get, Headers, NotFoundException, Param, Post, Query, Req, Res, Sse, Version } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { OutboxService } from '../outbox/outbox.service';
import { actorFromRequest, instanceAccessFromRequest } from './history-auth';
import { InstancesService } from './instances.service';
import { PUBLIC_API_VERSIONS } from '../public-api-version';
import { ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { PublicApiController, PublicApiErrors } from '../openapi/public-api.decorators';
import { InstanceDto, InstanceResultDto, TraceEventDto } from '../openapi/public-api.dto';

type SseMessage = {
  id?: string;
  event?: string;
  data: any;
};

@Controller()
@ApiTags('Instances')
@PublicApiController()
export class InstancesController {
  constructor(
    private readonly outbox: OutboxService,
    private readonly instances: InstancesService,
  ) {}

  @Post('/instances')
  async create(@Body() body: any, @Req() req: Request) {
    // dto를 엄격히 하고 싶으면 CreateInstanceDto로 바꿔도 OK
    return this.instances.createInstance({
      template_id: body?.template_id,
      ctx: body?.ctx,
    }, instanceAccessFromRequest(req, body?.ctx?.data?.formData || body?.ctx?.data || body?.ctx));
  }

  @Get('/instances')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '접근 가능한 실행 목록 조회' })
  @ApiOkResponse({ type: InstanceDto, isArray: true })
  @PublicApiErrors()
  async findAll(@Req() req: Request) {
    return this.instances.findAll(actorFromRequest(req));
  }

  @Get('/instances/:id')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '실행 상태 조회' })
  @ApiParam({ name: 'id', description: '인스턴스 ID' })
  @ApiOkResponse({ type: InstanceDto })
  @PublicApiErrors()
  async findOne(@Param('id') id: string, @Req() req: Request) {
    return this.instances.findOne(id, actorFromRequest(req));
  }

  @Get('/instances/:id/result')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '실행 결과 조회' })
  @ApiParam({ name: 'id', description: '인스턴스 ID' })
  @ApiOkResponse({ type: InstanceResultDto })
  @PublicApiErrors()
  async result(@Param('id') id: string, @Req() req: Request) {
    const result = await this.instances.getResult(id, actorFromRequest(req));
    if (!result) {
      throw new NotFoundException('Instance not found');
    }
    return result;
  }

  @Get('/instances/:id/retry/preview')
  async retryPreview(
    @Param('id') id: string,
    @Query('mode') mode?: 'full_instance' | 'failed_node',
    @Req() req?: Request,
  ) {
    return this.instances.previewRetry(
      id,
      mode === 'failed_node' ? 'failed_node' : 'full_instance',
      actorFromRequest(req),
    );
  }

  @Post('/instances/:id/retry')
  async retry(
    @Param('id') id: string,
    @Body() body?: { mode?: 'full_instance' | 'failed_node' },
    @Headers('idempotency-key') idempotencyKey?: string,
    @Req() req?: Request,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const result = await this.instances.retryInstance(
      id,
      body?.mode === 'failed_node' ? 'failed_node' : 'full_instance',
      actorFromRequest(req),
      idempotencyKey,
    );
    if (result.idempotent_replay) res?.setHeader('Idempotency-Replayed', 'true');
    return result;
  }

  @Post('/instances/:id/terminate')
  async terminate(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res?: Response) {
    const result = await this.instances.terminateInstance(id, actorFromRequest(req), idempotencyKey);
    if (result.idempotent_replay) res?.setHeader('Idempotency-Replayed', 'true');
    return result;
  }

  @Post('/instances/:id/pause')
  async pause(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res?: Response) {
    const result = await this.instances.setInstancePaused(id, true, actorFromRequest(req), idempotencyKey);
    if (result.idempotent_replay) res?.setHeader('Idempotency-Replayed', 'true');
    return result;
  }

  @Post('/instances/:id/resume')
  async resume(@Param('id') id: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res?: Response) {
    const result = await this.instances.setInstancePaused(id, false, actorFromRequest(req), idempotencyKey);
    if (result.idempotent_replay) res?.setHeader('Idempotency-Replayed', 'true');
    return result;
  }

  @Get('/instances/:id/trace')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '실행 Trace 조회' })
  @ApiParam({ name: 'id', description: '인스턴스 ID' })
  @ApiOkResponse({ type: TraceEventDto, isArray: true })
  @PublicApiErrors()
  async trace(@Param('id') id: string, @Req() req: Request) {
    await this.instances.ensureReadableInstance(id, actorFromRequest(req));
    return this.outbox.fetchTrace(id, 200);
  }

  @Get('/instances/:id/terminal-outputs')
  async terminalOutputs(
    @Param('id') id: string,
    @Query('node_id') nodeId: string | undefined,
    @Query('after') after: string | undefined,
    @Req() req: Request,
  ) {
    return this.instances.getTerminalOutputs(id, {
      nodeId,
      after: after ? Number(after) : undefined,
      actor: actorFromRequest(req),
    });
  }

  @Post('/instances/terminal-outputs/retention/scrub')
  async scrubTerminalOutputs(
    @Body() body: {
      instance_id?: string;
      older_than_days?: number;
      dry_run?: boolean;
      limit?: number;
    },
    @Req() req: Request,
  ) {
    return this.instances.scrubTerminalOutputs({
      instanceId: body?.instance_id,
      olderThanDays: body?.older_than_days,
      dryRun: body?.dry_run === true,
      limit: body?.limit,
      actor: actorFromRequest(req),
    });
  }

  @Sse('/instances/:id/stream')
  @Version(PUBLIC_API_VERSIONS)
  @ApiOperation({ summary: '실행 이벤트 스트림 구독' })
  @ApiParam({ name: 'id', description: '인스턴스 ID' })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'Server-Sent Events stream', schema: { type: 'string' } })
  @PublicApiErrors()
  async stream(
    @Param('id') instanceId: string,
    @Req() req: Request,
  ): Promise<Observable<MessageEvent>> {
    await this.instances.ensureReadableInstance(instanceId, actorFromRequest(req));

    // SSE 표준: Last-Event-ID 헤더로 재연결 커서 전달
    const lastEventIdHeader =
      req.header('last-event-id') ?? req.header('Last-Event-ID');
    let cursor = Number(lastEventIdHeader ?? 0);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

    const pollMs = Number(process.env.SSE_POLL_MS ?? 700);
    const pingMs = Number(process.env.SSE_PING_MS ?? 15000);

    return new Observable<MessageEvent>((subscriber) => {
      let alive = true;
      let polling = false;

      const send = (msg: SseMessage) => {
        subscriber.next({
          // Nest의 MessageEvent 타입은 사실상 아래 shape을 허용
          // id/event는 SSE 필드로 나감
          data: msg.data,
          id: msg.id,
          type: msg.event,
        } as any);
      };

      // 1) keepalive ping
      const pingTimer = setInterval(() => {
        if (!alive) return;
        send({
          event: 'ping',
          id: String(cursor),
          data: { ok: true, ts: new Date().toISOString() },
        });
      }, pingMs);

      // 2) polling loop
      const pollTimer = setInterval(async () => {
        if (!alive) return;
        if (polling) return; // 중복 폴링 방지
        polling = true;

        try {
          const rows = await this.outbox.fetchAfter(instanceId, cursor, 200);

          for (const r of rows) {
            cursor = r.id;
            send({
              id: String(r.id),
              event: r.event_type, // NODE_STARTED 같은 타입이 event명이 됨
              data: {
                id: r.id,
                source: r.source,
                instance_id: r.instance_id,
                token_id: r.token_id,
                node_id: r.node_id,
                node_label: r.node_label,
                type: r.event_type,  // type으로 통일
                payload: r.payload,
                created_at: r.created_at,
              },
            });
          }
        } catch (e: any) {
          // 연결을 끊지 않고, 에러 이벤트를 한번 쏘고 계속
          send({
            event: 'error',
            id: String(cursor),
            data: { message: e?.message ?? 'poll error' },
          });
        } finally {
          polling = false;
        }
      }, pollMs);

      // 3) 첫 진입 즉시 한 번 당겨오기 (체감 “탁”)
      (async () => {
        try {
          const rows = await this.outbox.fetchAfter(instanceId, cursor, 200);
          for (const r of rows) {
            cursor = r.id;
            send({
              id: String(r.id),
              event: r.event_type,
              data: {
                id: r.id,
                source: r.source,
                instance_id: r.instance_id,
                token_id: r.token_id,
                node_id: r.node_id,
                node_label: r.node_label,
                type: r.event_type,  // type으로 통일
                payload: r.payload,
                created_at: r.created_at,
              },
            });
          }
        } catch {
          // 무시
        }
      })();

      // cleanup
      req.on('close', () => {
        alive = false;
        clearInterval(pollTimer);
        clearInterval(pingTimer);
        subscriber.complete();
      });

      return () => {
        alive = false;
        clearInterval(pollTimer);
        clearInterval(pingTimer);
      };
    });
  }
}
