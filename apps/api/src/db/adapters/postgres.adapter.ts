import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../pg.provider';
import {
  WorkflowDefinitionMetadata,
  WorkflowRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowTaskRepositoryPort,
  OutboxRepositoryPort,
  EngineQueueRepositoryPort,
  WorkflowScheduleJob,
  WorkflowScheduleRepositoryPort,
  WorkflowScheduleStatus,
} from '../ports/db.ports';

@Injectable()
export class PostgresAdapter
  implements
    WorkflowRepositoryPort,
    WorkflowInstanceRepositoryPort,
    WorkflowTaskRepositoryPort,
    OutboxRepositoryPort,
    EngineQueueRepositoryPort,
    WorkflowScheduleRepositoryPort
{
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  private scheduleTableReady = false;

  private async loadNodeLabels(instanceId: string): Promise<Map<string, string>> {
    const { rows } = await this.pool.query(
      `
      SELECT n.node_id, n.label, n.config
      FROM v2_process_instances i
      JOIN v2_definition_nodes n ON n.definition_id = i.process_definition_id
      WHERE i.id = $1::uuid
      `,
      [instanceId],
    );

    return new Map(
      rows.map((row) => [
        row.node_id,
        row.label ||
          row.config?.label ||
          row.config?.ui_node?.data?.label ||
          row.node_id,
      ]),
    );
  }

  // ==========================================
  // WorkflowRepositoryPort 구현 (V2 정의 대응)
  // ==========================================
  async createDefinition(
    id: string,
    name: string,
    nodes: any[],
    edges: any[],
    metadata: WorkflowDefinitionMetadata = {},
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. v2_process_definitions 삽입
      await client.query(
        `INSERT INTO v2_process_definitions (id, definition_key, version, name, status, metadata, created_at, updated_at)
         VALUES ($1::uuid, $1, 1, $2, 'ACTIVE', $3::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET name = $2, metadata = $3::jsonb, updated_at = NOW()`,
        [id, name, JSON.stringify(metadata)],
      );

      // 2. 기존 노드 삭제 후 재생성 (V2 배포 정규화 구조)
      await client.query(
        `DELETE FROM v2_definition_nodes WHERE definition_id = $1::uuid`,
        [id],
      );
      for (const node of nodes) {
        await client.query(
          `INSERT INTO v2_definition_nodes (definition_id, node_id, node_type, label, config)
           VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
          [
            id,
            node.id,
            node.data?.nodeType || 'task',
            node.data?.label || null,
            JSON.stringify({
              ...(node.data || {}),
              ui_node: node,
            }),
          ],
        );
      }

      // 3. 기존 엣지 삭제 후 재생성
      await client.query(
        `DELETE FROM v2_definition_edges WHERE definition_id = $1::uuid`,
        [id],
      );
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        await client.query(
          `INSERT INTO v2_definition_edges (definition_id, source_node_id, target_node_id, condition_expr, is_default, eval_order, metadata)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            id,
            edge.source,
            edge.target,
            edge.data?.condition || null,
            edge.data?.isDefault || false,
            i,
            JSON.stringify({ ui_edge: edge }),
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listDefinitions(): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM v2_process_definitions ORDER BY created_at DESC`,
    );
    return rows;
  }

  async getDefinition(id: string): Promise<any> {
    const defRes = await this.pool.query(
      `SELECT * FROM v2_process_definitions WHERE id = $1`,
      [id],
    );
    if (defRes.rows.length === 0) return null;

    const definition = defRes.rows[0];

    const nodesRes = await this.pool.query(
      `SELECT * FROM v2_definition_nodes WHERE definition_id = $1`,
      [id],
    );
    const edgesRes = await this.pool.query(
      `SELECT * FROM v2_definition_edges WHERE definition_id = $1 ORDER BY eval_order ASC`,
    );

    return {
      ...definition,
      description: definition.metadata?.description || '',
      group: definition.metadata?.group || '',
      tags: definition.metadata?.tags || [],
      version_note: definition.metadata?.version_note || '',
      nodes: nodesRes.rows.map((n) => n.config),
      edges: edgesRes.rows.map((e) => ({
        id: e.id,
        source: e.source_node_id,
        target: e.target_node_id,
        data: {
          condition: e.condition_expr,
          isDefault: e.is_default,
        },
      })),
    };
  }

  // ==========================================
  // WorkflowInstanceRepositoryPort 구현 (V2 인스턴스 대응)
  // ==========================================
  async createInstance(
    id: string,
    definitionId: string,
    status: string,
    ctx: any,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO v2_process_instances (id, process_definition_id, state, context, started_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, NOW(), NOW(), NOW())`,
      [id, definitionId, status, JSON.stringify(ctx)],
    );
  }

  async listInstances(): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT i.*, d.name as template_name
       FROM v2_process_instances i
       LEFT JOIN v2_process_definitions d ON i.process_definition_id = d.id
       ORDER BY i.created_at DESC LIMIT 50`,
    );
    return rows.map((r) => ({
      ...r,
      // V1 하위 호환성 필드 매핑
      template_id: r.process_definition_id,
      definition_id: r.process_definition_id,
      status: r.state,
      ctx: r.context,
    }));
  }

  async getInstance(id: string): Promise<any> {
    const { rows } = await this.pool.query(
      `SELECT * FROM v2_process_instances WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return {
      ...rows[0],
      // V1 호환 필드 매핑
      template_id: rows[0].process_definition_id,
      definition_id: rows[0].process_definition_id,
      status: rows[0].state,
      ctx: rows[0].context,
    };
  }

  async updateInstanceStatus(id: string, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE v2_process_instances SET state = $1, updated_at = NOW() WHERE id = $2`,
      [status, id],
    );
  }

  async updateInstanceCtx(id: string, ctx: any): Promise<void> {
    await this.pool.query(
      `UPDATE v2_process_instances SET context = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(ctx), id],
    );
  }

  async createToken(token: {
    id: string;
    instanceId: string;
    nodeId: string;
    status: string;
    parentTokenId?: string;
    scopeKey?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO v2_tokens (id, instance_id, node_id, status, parent_token_id, scope_key, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, NOW(), NOW())`,
      [
        token.id,
        token.instanceId,
        token.nodeId,
        token.status,
        token.parentTokenId || null,
        token.scopeKey || null,
      ],
    );
  }

  async createJob(job: {
    instanceId: string;
    tokenId?: string | null;
    type: string;
    runAt: Date;
    payload: any;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO v2_engine_jobs (instance_id, token_id, type, run_at, attempt, status, payload, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 0, 'QUEUED', $5::jsonb, NOW(), NOW())`,
      [
        job.instanceId,
        job.tokenId || null,
        job.type,
        job.runAt,
        JSON.stringify(job.payload),
      ],
    );
  }

  async getQueueStats(): Promise<{
    by_status: Record<string, number>;
    queued: number;
    running: number;
    failed: number;
    completed: number;
    oldest_queued_at: string | null;
    oldest_queued_age_ms: number | null;
    running_workers: Array<{
      worker_id: string;
      running_jobs: number;
      last_updated_at: string | null;
    }>;
    worker_heartbeats: Array<{
      worker_id: string;
      last_heartbeat_at: string | null;
      locked_instances: number;
    }>;
    max_attempt: number;
  }> {
    const statusResult = await this.pool.query(
      `SELECT status, count(*)::int AS count FROM v2_engine_jobs GROUP BY status`,
    );
    const byStatus = Object.fromEntries(
      statusResult.rows.map((row) => [row.status || 'UNKNOWN', Number(row.count)]),
    );

    const oldestResult = await this.pool.query(
      `
      SELECT run_at, EXTRACT(EPOCH FROM (NOW() - run_at)) * 1000 AS age_ms
      FROM v2_engine_jobs
      WHERE status = 'QUEUED'
      ORDER BY run_at ASC, id ASC
      LIMIT 1
      `,
    );
    const oldest = oldestResult.rows[0];

    const workersResult = await this.pool.query(
      `
      SELECT COALESCE(lock_owner, 'unknown') AS worker_id,
             count(*)::int AS running_jobs,
             max(updated_at) AS last_updated_at
      FROM v2_engine_jobs
      WHERE status = 'RUNNING'
      GROUP BY COALESCE(lock_owner, 'unknown')
      ORDER BY running_jobs DESC
      `,
    );

    const maxAttemptResult = await this.pool.query(
      `SELECT COALESCE(max(attempt), 0)::int AS max_attempt FROM v2_engine_jobs`,
    );
    const heartbeatsResult = await this.pool.query(
      `
      SELECT COALESCE(lock_owner, 'unknown') AS worker_id,
             max(heartbeat_at) AS last_heartbeat_at,
             count(*)::int AS locked_instances
      FROM v2_process_instances
      WHERE lock_owner IS NOT NULL
      GROUP BY COALESCE(lock_owner, 'unknown')
      ORDER BY locked_instances DESC
      `,
    );

    return {
      by_status: byStatus,
      queued: byStatus.QUEUED || 0,
      running: byStatus.RUNNING || 0,
      failed: byStatus.FAILED || 0,
      completed: byStatus.COMPLETED || 0,
      oldest_queued_at: oldest?.run_at?.toISOString?.() || oldest?.run_at || null,
      oldest_queued_age_ms:
        oldest?.age_ms == null ? null : Math.max(0, Number(oldest.age_ms)),
      running_workers: workersResult.rows.map((row) => ({
        worker_id: row.worker_id,
        running_jobs: Number(row.running_jobs),
        last_updated_at:
          row.last_updated_at?.toISOString?.() || row.last_updated_at || null,
      })),
      worker_heartbeats: heartbeatsResult.rows.map((row) => ({
        worker_id: row.worker_id,
        last_heartbeat_at:
          row.last_heartbeat_at?.toISOString?.() || row.last_heartbeat_at || null,
        locked_instances: Number(row.locked_instances),
      })),
      max_attempt: Number(maxAttemptResult.rows[0]?.max_attempt || 0),
    };
  }

  async replaceDefinitionSchedules(
    definitionId: string,
    jobs: WorkflowScheduleJob[],
  ): Promise<void> {
    await this.ensureScheduleTable();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const activeIds = jobs.map((job) => job.id);
      await client.query(
        `
        UPDATE v2_schedule_jobs
        SET active = false, status = 'DISABLED', updated_at = NOW()
        WHERE definition_id = $1::uuid
          AND (cardinality($2::text[]) = 0 OR id <> ALL($2::text[]))
        `,
        [definitionId, activeIds],
      );

      for (const job of jobs) {
        await client.query(
          `
          INSERT INTO v2_schedule_jobs (
            id, definition_id, definition_name, start_node_id, schedule_type,
            interval_seconds, cron_expression, input, next_run_at, active,
            status, lock_owner, locked_until, created_at, updated_at
          )
          VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
                  $11, NULL, NULL, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            definition_name = EXCLUDED.definition_name,
            start_node_id = EXCLUDED.start_node_id,
            schedule_type = EXCLUDED.schedule_type,
            interval_seconds = EXCLUDED.interval_seconds,
            cron_expression = EXCLUDED.cron_expression,
            input = EXCLUDED.input,
            next_run_at = EXCLUDED.next_run_at,
            active = EXCLUDED.active,
            status = EXCLUDED.status,
            lock_owner = NULL,
            locked_until = NULL,
            updated_at = NOW()
          `,
          [
            job.id,
            job.definitionId,
            job.definitionName,
            job.startNodeId,
            job.scheduleType,
            job.intervalSeconds ?? null,
            job.cronExpression ?? null,
            JSON.stringify(job.input || {}),
            job.nextRunAt,
            job.active,
            job.active ? 'WAITING' : 'DISABLED',
          ],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimDueSchedules(
    now: Date,
    owner: string,
    limit: number,
  ): Promise<WorkflowScheduleJob[]> {
    await this.ensureScheduleTable();
    const { rows } = await this.pool.query(
      `
      UPDATE v2_schedule_jobs job
      SET status = 'RUNNING',
          lock_owner = $2,
          locked_until = $1::timestamptz + interval '60 seconds',
          updated_at = NOW()
      WHERE job.id IN (
        SELECT id
        FROM v2_schedule_jobs
        WHERE active = true
          AND status = 'WAITING'
          AND next_run_at <= $1
          AND (locked_until IS NULL OR locked_until < $1 OR lock_owner = $2)
        ORDER BY next_run_at ASC, id ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
      `,
      [now, owner, limit],
    );

    return rows.map(mapScheduleRow);
  }

  async markScheduleSuccess(
    id: string,
    nextRunAt: Date,
    instanceId: string,
  ): Promise<void> {
    await this.ensureScheduleTable();
    const current = await this.pool.query(
      `SELECT definition_id, next_run_at FROM v2_schedule_jobs WHERE id = $1`,
      [id],
    );
    await this.pool.query(
      `
      UPDATE v2_schedule_jobs
      SET status = 'WAITING',
          next_run_at = $2,
          last_run_at = NOW(),
          last_instance_id = $3,
          last_error = NULL,
          lock_owner = NULL,
          locked_until = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, nextRunAt, instanceId],
    );
    await this.pool.query(
      `
      INSERT INTO v2_schedule_runs (
        schedule_job_id, definition_id, instance_id, scheduled_for, fired_at, status, error, created_at
      )
      VALUES ($1, $2::uuid, $3::uuid, $4, NOW(), 'STARTED', NULL, NOW())
      `,
      [
        id,
        current.rows[0]?.definition_id,
        instanceId,
        current.rows[0]?.next_run_at || new Date(),
      ],
    );
  }

  async markScheduleFailure(
    id: string,
    error: string,
    nextRunAt: Date,
  ): Promise<void> {
    await this.ensureScheduleTable();
    const current = await this.pool.query(
      `SELECT definition_id, next_run_at FROM v2_schedule_jobs WHERE id = $1`,
      [id],
    );
    await this.pool.query(
      `
      UPDATE v2_schedule_jobs
      SET status = 'WAITING',
          next_run_at = $2,
          last_error = $3,
          lock_owner = NULL,
          locked_until = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [id, nextRunAt, error],
    );
    await this.pool.query(
      `
      INSERT INTO v2_schedule_runs (
        schedule_job_id, definition_id, instance_id, scheduled_for, fired_at, status, error, created_at
      )
      VALUES ($1, $2::uuid, NULL, $3, NOW(), 'FAILED', $4, NOW())
      `,
      [id, current.rows[0]?.definition_id, current.rows[0]?.next_run_at || new Date(), error],
    );
  }

  async getDefinitionScheduleStatus(
    definitionId: string,
    limit = 10,
  ): Promise<WorkflowScheduleStatus> {
    await this.ensureScheduleTable();
    const jobResult = await this.pool.query(
      `
      SELECT *
      FROM v2_schedule_jobs
      WHERE definition_id = $1::uuid
      ORDER BY updated_at DESC
      LIMIT 1
      `,
      [definitionId],
    );
    const runsResult = await this.pool.query(
      `
      SELECT *
      FROM v2_schedule_runs
      WHERE definition_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT $2
      `,
      [definitionId, limit],
    );

    return {
      job: jobResult.rows[0] ? mapScheduleRow(jobResult.rows[0]) : null,
      runs: runsResult.rows.map((row) => ({
        id: String(row.id),
        scheduleJobId: row.schedule_job_id,
        definitionId: row.definition_id,
        instanceId: row.instance_id || null,
        scheduledFor: row.scheduled_for?.toISOString?.() || row.scheduled_for,
        firedAt: row.fired_at?.toISOString?.() || row.fired_at,
        status: row.status,
        error: row.error || null,
        createdAt: row.created_at?.toISOString?.() || row.created_at,
      })),
    };
  }

  private async ensureScheduleTable(): Promise<void> {
    if (this.scheduleTableReady) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS v2_schedule_jobs (
        id text PRIMARY KEY,
        definition_id uuid NOT NULL,
        definition_name text NOT NULL,
        start_node_id text NOT NULL,
        schedule_type text NOT NULL CHECK (schedule_type IN ('interval', 'cron')),
        interval_seconds integer NULL,
        cron_expression text NULL,
        input jsonb NOT NULL DEFAULT '{}'::jsonb,
        next_run_at timestamptz NOT NULL,
        active boolean NOT NULL DEFAULT true,
        status text NOT NULL DEFAULT 'WAITING',
        lock_owner text NULL,
        locked_until timestamptz NULL,
        last_run_at timestamptz NULL,
        last_instance_id uuid NULL,
        last_error text NULL,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS v2_schedule_runs (
        id bigserial PRIMARY KEY,
        schedule_job_id text NOT NULL,
        definition_id uuid NOT NULL,
        instance_id uuid NULL,
        scheduled_for timestamptz NOT NULL,
        fired_at timestamptz NOT NULL,
        status text NOT NULL CHECK (status IN ('STARTED', 'FAILED')),
        error text NULL,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_v2_schedule_jobs_due ON v2_schedule_jobs (active, status, next_run_at)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_v2_schedule_jobs_definition ON v2_schedule_jobs (definition_id)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_v2_schedule_runs_definition ON v2_schedule_runs (definition_id, created_at DESC)`,
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_v2_schedule_runs_job ON v2_schedule_runs (schedule_job_id, created_at DESC)`,
    );
    this.scheduleTableReady = true;
  }

  // ==========================================
  // WorkflowTaskRepositoryPort 구현 (V2 태스크 대응)
  // ==========================================
  async createTask(
    id: string,
    instanceId: string,
    nodeId: string,
    assignee: string,
    status: string,
    payload: any,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO v2_tasks (id, instance_id, token_id, node_id, assignee, status, payload, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, null, $3, $4, $5, $6::jsonb, NOW(), NOW())`,
      [id, instanceId, nodeId, assignee, status, JSON.stringify(payload)],
    );
  }

  async listTasks(assignee = 'admin'): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT t.*, 
              i.id as instance_id, 
              i.process_definition_id,
              i.status as instance_status,
              i.context->>'template_name' as template_name,
              COALESCE((i.context->'data'->'formData')::jsonb, (i.context->'formData')::jsonb, '{}'::jsonb) as form_data
       FROM v2_tasks t
       JOIN v2_process_instances i ON t.instance_id = i.id
       WHERE t.assignee = $1 AND t.status = 'OPEN'
       ORDER BY t.created_at DESC`,
      [assignee],
    );
    return rows;
  }

  async getTask(id: string): Promise<any> {
    const { rows } = await this.pool.query(
      `SELECT * FROM v2_tasks WHERE id = $1`,
      [id],
    );
    return rows[0] || null;
  }

  async updateTaskStatus(id: string, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE v2_tasks SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id],
    );
  }

  async fetchAfter(
    instanceId: string,
    afterId: number,
    limit = 100,
  ): Promise<any[]> {
    const nodeLabels = await this.loadNodeLabels(instanceId);
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM (
        SELECT
          row_number() OVER (ORDER BY created_at ASC, source ASC, source_id ASC)::int as id,
          source,
          source_id,
          instance_id,
          token_id,
          node_id,
          event_type,
          payload,
          created_at
        FROM (
          SELECT
            id::text as source_id,
            'execution_log' as source,
            instance_id,
            token_id,
            node_id,
            event_type,
            payload,
            created_at
          FROM v2_execution_logs
          WHERE instance_id = $1::uuid

          UNION ALL

          SELECT
            id::text as source_id,
            'outbox' as source,
            instance_id,
            token_id,
            node_id,
            event_type,
            payload,
            created_at
          FROM v2_event_outbox
          WHERE instance_id = $1::uuid
        ) events
      ) trace
      WHERE id > $2
      ORDER BY id ASC
      LIMIT $3
      `,
      [instanceId, afterId, limit],
    );

    return rows.map((row) => ({
      ...row,
      node_label: row.node_id ? nodeLabels.get(row.node_id) || row.node_id : null,
      type: row.event_type,
      payload: row.payload || {},
    }));
  }

  async fetchTrace(instanceId: string, limit = 200): Promise<any[]> {
    const nodeLabels = await this.loadNodeLabels(instanceId);
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM (
        SELECT
          id::text as source_id,
          'execution_log' as source,
          instance_id,
          token_id,
          node_id,
          event_type,
          payload,
          created_at
        FROM v2_execution_logs
        WHERE instance_id = $1::uuid

        UNION ALL

        SELECT
          id::text as source_id,
          'outbox' as source,
          instance_id,
          token_id,
          node_id,
          event_type,
          payload,
          created_at
        FROM v2_event_outbox
        WHERE instance_id = $1::uuid
      ) trace
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [instanceId, limit],
    );

    return rows.map((row, idx) => ({
      id: idx + 1,
      source_id: row.source_id,
      source: row.source,
      instance_id: row.instance_id,
      token_id: row.token_id,
      node_id: row.node_id,
      node_label: row.node_id ? nodeLabels.get(row.node_id) || row.node_id : null,
      event_type: row.event_type,
      type: row.event_type,
      payload: row.payload || {},
      created_at: row.created_at,
    }));
  }

  async appendEvent(
    instanceId: string,
    eventType: string,
    payload: any,
  ): Promise<any> {
    const { rows } = await this.pool.query(
      `
      INSERT INTO v2_event_outbox (instance_id, event_type, payload)
      VALUES ($1::uuid, $2, $3::jsonb)
      RETURNING id
      `,
      [instanceId, eventType, JSON.stringify(payload)],
    );
    return { ok: true, id: rows[0].id };
  }
}

function mapScheduleRow(row: any): WorkflowScheduleJob {
  return {
    id: row.id,
    definitionId: row.definition_id,
    definitionName: row.definition_name,
    startNodeId: row.start_node_id,
    scheduleType: row.schedule_type,
    intervalSeconds: row.interval_seconds ?? null,
    cronExpression: row.cron_expression ?? null,
    input: row.input || {},
    nextRunAt: row.next_run_at instanceof Date ? row.next_run_at : new Date(row.next_run_at),
    active: Boolean(row.active),
    status: row.status || null,
    lastRunAt: row.last_run_at?.toISOString?.() || row.last_run_at || null,
    lastInstanceId: row.last_instance_id || null,
    lastError: row.last_error || null,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at || null,
    createdAt: row.created_at?.toISOString?.() || row.created_at || null,
  };
}
