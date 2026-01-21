import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/pg.provider';

export type OutboxRow = {
  id: number;
  instance_id: string;
  event_type: string;
  payload: any;
  created_at: string;
};

@Injectable()
export class OutboxService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async fetchAfter(
    instanceId: string,
    afterId: number,
    limit = 100,
  ): Promise<OutboxRow[]> {
    const { rows } = await this.pool.query(
      `
  select
    id,
    instance_id,
    type as event_type,
    payload,
    created_at
  from event_outbox
  where instance_id = $1::uuid
    and id > $2
  order by id asc
  limit $3
  `,
      [instanceId, afterId, limit],
    );
    return rows;
  }
}
