import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Sse } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { OutboxService } from '../outbox/outbox.service';
import { actorFromRequest, instanceAccessFromRequest } from './history-auth';
import { InstancesService } from './instances.service';

type SseMessage = {
  id?: string;
  event?: string;
  data: any;
};

@Controller()
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
  async findAll(@Req() req: Request) {
    return this.instances.findAll(actorFromRequest(req));
  }

  @Get('/instances/:id')
  async findOne(@Param('id') id: string, @Req() req: Request) {
    return this.instances.findOne(id, actorFromRequest(req));
  }

  @Get('/instances/:id/result')
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
    @Req() req?: Request,
  ) {
    return this.instances.retryInstance(
      id,
      body?.mode === 'failed_node' ? 'failed_node' : 'full_instance',
      actorFromRequest(req),
    );
  }

  @Post('/instances/:id/terminate')
  async terminate(@Param('id') id: string, @Req() req: Request) {
    return this.instances.terminateInstance(id, actorFromRequest(req));
  }

  @Get('/instances/:id/trace')
  async trace(@Param('id') id: string, @Req() req: Request) {
    await this.instances.ensureReadableInstance(id, actorFromRequest(req));
    return this.outbox.fetchTrace(id, 200);
  }

  @Sse('/instances/:id/stream')
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
