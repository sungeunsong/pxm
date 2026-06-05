import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../pg.provider';
import {
  WorkflowRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowTaskRepositoryPort,
  OutboxRepositoryPort,
} from '../ports/db.ports';

@Injectable()
export class PostgresAdapter
  implements
    WorkflowRepositoryPort,
    WorkflowInstanceRepositoryPort,
    WorkflowTaskRepositoryPort,
    OutboxRepositoryPort
{
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. v2_process_definitions 삽입
      await client.query(
        `INSERT INTO v2_process_definitions (id, definition_key, version, name, status, created_at, updated_at)
         VALUES ($1::uuid, $1, 1, $2, 'ACTIVE', NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET name = $2, updated_at = NOW()`,
        [id, name],
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
              COALESCE((i.context->'formData')::jsonb, '{}'::jsonb) as form_data
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
