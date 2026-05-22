import { Body, Controller, Post, Get, Query } from '@nestjs/common';
import { OutboxRepositoryPort } from '../db/ports/db.ports';

@Controller('/debug')
export class DebugController {
  private flakyCounter = new Map<string, number>();

  constructor(private readonly outboxRepo: OutboxRepositoryPort) {}

  @Post('/outbox')
  async insertOutbox(@Body() body: any) {
    const instanceId = body.instance_id; // uuid string
    const eventType = body.event_type ?? 'NODE_STARTED';
    const payload = body.payload ?? {};

    return this.outboxRepo.appendEvent(instanceId, eventType, payload);
  }

  // Flaky endpoint - GET/POST 모두 지원
  @Get('/flaky')
  getFlakyEndpoint(@Query('key') key: string, @Query('fail') fail: string) {
    return this.handleFlaky(key, fail);
  }

  @Post('/flaky')
  postFlakyEndpoint(@Query('key') key: string, @Query('fail') fail: string, @Body() body: any) {
    console.log('[DEBUG] POST /debug/flaky - body:', body);
    return this.handleFlaky(key, fail);
  }

  private handleFlaky(key: string, fail: string) {
    const failCount = parseInt(fail || '0', 10);
    const currentCount = this.flakyCounter.get(key) || 0;

    console.log(`[DEBUG] /flaky - key=${key}, fail=${failCount}, current=${currentCount}`);

    if (currentCount < failCount) {
      this.flakyCounter.set(key, currentCount + 1);
      throw new Error(`Simulated failure ${currentCount + 1}/${failCount}`);
    }

    // 성공
    this.flakyCounter.delete(key);
    return { ok: true, message: 'Success after retries', attempts: currentCount + 1 };
  }
}
