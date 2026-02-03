import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/pg.provider';
import { CreateInstanceDto } from './dto/create-instance.dto';
import { randomUUID } from 'crypto';

@Injectable()
export class InstancesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createInstance(dto: CreateInstanceDto) {
    const instanceId = randomUUID();
    const templateId = dto.template_id ?? randomUUID();
    const ctx = dto.ctx ?? {};

    const client = await this.pool.connect();
    try {
      await client.query('begin');

      // 1) instance row
      await client.query(
        `
        insert into process_instance (id, template_id, status, ctx)
        values ($1::uuid, $2::uuid, $3, $4::jsonb)
        `,
        [instanceId, templateId, 'CREATED', JSON.stringify(ctx)],
      );

      // 2) engine job START
      const jobRes = await client.query(
        `
        insert into engine_jobs (instance_id, type, run_at, status, payload)
        values ($1::uuid, $2, now(), 'READY', $3::jsonb)
        returning id
        `,
        [instanceId, 'START', JSON.stringify({ reason: 'api_create' })],
      );
      const jobId = jobRes.rows[0]?.id;

      // 3) outbox event (UI가 바로 반응하도록)
      await client.query(
        `
        insert into event_outbox (instance_id, type, payload)
        values ($1::uuid, $2, $3::jsonb)
        `,
        [
          instanceId,
          'INSTANCE_CREATED',
          JSON.stringify({
            instance_id: instanceId,
            status: 'CREATED',
            job_id: jobId,
            timestamp: new Date().toISOString(),
          }),
        ],
      );

      await client.query('commit');
      return { instance_id: instanceId };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
  async findAll() {
    const { rows } = await this.pool.query(`
      SELECT 
        pi.id, 
        pi.template_id, 
        pi.status, 
        pi.created_at, 
        pi.updated_at,
        wt.name as template_name
      FROM process_instance pi
      LEFT JOIN workflow_templates wt ON pi.template_id = wt.id
      ORDER BY pi.created_at DESC
      LIMIT 50
    `);
    return rows;
  }

  async findOne(id: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM process_instance WHERE id = $1`,
      [id]
    );
    return rows[0];
  }
}
