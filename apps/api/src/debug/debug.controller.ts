import { Body, Controller, Post, Get, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { Inject } from '@nestjs/common';
import { PG_POOL } from '../db/pg.provider';

@Controller('/debug')
export class DebugController {
  private flakyCounter = new Map<string, number>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post('/outbox')
  async insertOutbox(@Body() body: any) {
    const instanceId = body.instance_id; // uuid string
    const eventType = body.event_type ?? 'NODE_STARTED';
    const payload = body.payload ?? {};

    const { rows } = await this.pool.query(
      `
  insert into event_outbox (instance_id, type, payload)
  values ($1::uuid, $2, $3::jsonb)
  returning id
  `,
      [instanceId, eventType, JSON.stringify(payload)],
    );

    return { ok: true, id: rows[0].id };
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
