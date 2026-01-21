import { Body, Controller, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { Inject } from '@nestjs/common';
import { PG_POOL } from '../db/pg.provider';

@Controller('/debug')
export class DebugController {
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
}
