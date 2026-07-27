import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../pg.provider';
import { WorkflowDefinitionMetadata, WorkflowRepositoryPort, WorkflowInstanceRepositoryPort, WorkflowTaskRepositoryPort, OutboxRepositoryPort, EngineQueueRepositoryPort, WorkflowScheduleJob, WorkflowScheduleRepositoryPort, WorkflowScheduleStatus, WorkflowHistoryActor, WorkflowInstanceAccess, WorkflowDefinitionVersion, WorkflowInputPreset, WorkflowInputPresetRepositoryPort, UpsertWorkflowInputPreset, AppendPxmApiKeyUsageLog, AuthzRepositoryPort, CreatePxmApiKey, CreatePxmSession, PxmApiKey, PxmApiKeyUsageLog, PxmGroup, PxmServiceAccount, PxmUser, PxmSession, PxmSessionSecurityPolicy, UpsertPxmGroup, UpsertPxmServiceAccount, UpsertPxmUser, UpsertPxmSessionSecurityPolicy, CompleteWorkflowTaskCommand, CompleteWorkflowTaskResult, ExternalApprovalClaim, ExternalApprovalDeliveryToken, ExternalApprovalOtp, ExternalApprovalTask, WorkflowTaskHistoryItem, WorkflowTaskHistoryPage, WorkflowTaskHistoryQuery, IdempotentWorkflowStart, IdempotentWorkflowStartResult, IdempotentInstanceCommand, IdempotentInstanceCommandResult, ExistingIdempotentInstanceCommandResult, WorkflowInstanceMutation } from '../ports/db.ports';

@Injectable()
export class PostgresAdapter implements WorkflowRepositoryPort, WorkflowInstanceRepositoryPort, WorkflowTaskRepositoryPort, OutboxRepositoryPort, EngineQueueRepositoryPort, WorkflowScheduleRepositoryPort, WorkflowInputPresetRepositoryPort, AuthzRepositoryPort {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  private scheduleTableReady = false;
  private definitionVersionTableReady = false;
  private inputPresetTableReady = false;
  private authzTablesReady = false;
  private taskRuntimeColumnsReady = false;
  private startIdempotencyTableReady = false;
  private instanceCommandIdempotencyTableReady = false;

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

    return new Map(rows.map((row) => [row.node_id, row.label || row.config?.label || row.config?.ui_node?.data?.label || row.node_id]));
  }

  // ==========================================
  // WorkflowRepositoryPort 구현 (V2 정의 대응)
  // ==========================================
  async createDefinition(id: string, name: string, nodes: any[], edges: any[], metadata: WorkflowDefinitionMetadata = {}): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureDefinitionVersionTable(client);

      const currentRes = await client.query(`SELECT version FROM v2_process_definitions WHERE id = $1::uuid`, [id]);
      const nextVersion = Number(currentRes.rows[0]?.version || 0) + 1;

      // 1. v2_process_definitions 삽입
      await client.query(
        `INSERT INTO v2_process_definitions (id, definition_key, version, name, status, metadata, created_at, updated_at)
         VALUES ($1::uuid, $1, $4, $2, 'ACTIVE', $3::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET version = $4, name = $2, metadata = $3::jsonb, updated_at = NOW()`,
        [id, name, JSON.stringify(metadata), nextVersion],
      );

      // 2. 기존 노드 삭제 후 재생성 (V2 배포 정규화 구조)
      await client.query(`DELETE FROM v2_definition_nodes WHERE definition_id = $1::uuid`, [id]);
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
      await client.query(`DELETE FROM v2_definition_edges WHERE definition_id = $1::uuid`, [id]);
      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        await client.query(
          `INSERT INTO v2_definition_edges (definition_id, source_node_id, target_node_id, condition_expr, is_default, eval_order, metadata)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)`,
          [id, edge.source, edge.target, edge.data?.condition || null, edge.data?.isDefault || false, i, JSON.stringify({ ui_edge: edge })],
        );
      }

      await client.query(
        `INSERT INTO v2_process_definition_versions
          (definition_id, version, name, metadata, nodes, edges, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, NOW(), NOW())`,
        [id, nextVersion, name, JSON.stringify(metadata), JSON.stringify(nodes || []), JSON.stringify(edges || [])],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listDefinitions(): Promise<any[]> {
    const { rows } = await this.pool.query(`SELECT * FROM v2_process_definitions WHERE status <> 'DELETED' ORDER BY created_at DESC`);
    return rows;
  }

  async getDefinition(id: string): Promise<any> {
    const defRes = await this.pool.query(`SELECT * FROM v2_process_definitions WHERE id = $1 AND status <> 'DELETED'`, [id]);
    if (defRes.rows.length === 0) return null;

    const definition = defRes.rows[0];

    const nodesRes = await this.pool.query(`SELECT * FROM v2_definition_nodes WHERE definition_id = $1`, [id]);
    const edgesRes = await this.pool.query(`SELECT * FROM v2_definition_edges WHERE definition_id = $1 ORDER BY eval_order ASC`, [id]);

    return {
      ...definition,
      description: definition.metadata?.description || '',
      group: definition.metadata?.group || '',
      group_id: definition.metadata?.group_id || null,
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

  async getPublishedDefinition(id: string): Promise<any> {
    const current = await this.getDefinition(id);
    if (!current) return null;
    const status = current.metadata?.lifecycle_status || 'PUBLISHED';
    if (status !== 'PUBLISHED') return null;
    const version = Number(current.metadata?.active_published_version || current.version || 1);
    const snapshot = await this.getDefinitionVersion(id, version);
    const published = snapshot || (version === Number(current.version) ? current : null);
    return published
      ? {
          ...published,
          lifecycle_status: status,
          active_published_version: version,
          published_at: current.metadata?.published_at || null,
          published_by: current.metadata?.published_by || null,
        }
      : null;
  }

  async setDefinitionLifecycle(id: string, lifecycle: import('../ports/db.ports').WorkflowLifecycleUpdate): Promise<any> {
    const current = await this.getDefinition(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const previousActiveVersion = current.metadata?.active_published_version ?? null;
    const activeVersion =
      lifecycle.active_published_version ??
      previousActiveVersion ??
      (lifecycle.status === 'PUBLISHED' ? current.version : null);
    const metadata = {
      ...(current.metadata || {}),
      lifecycle_status: lifecycle.status,
      active_published_version: activeVersion,
      published_at: lifecycle.status === 'PUBLISHED' ? now : current.metadata?.published_at || null,
      published_by: lifecycle.status === 'PUBLISHED' ? lifecycle.actor_id || null : current.metadata?.published_by || null,
    };
    await this.pool.query(
      `UPDATE v2_process_definitions
       SET metadata = $2::jsonb, updated_at = NOW()
       WHERE id = $1::uuid AND status <> 'DELETED'`,
      [id, JSON.stringify(metadata)],
    );
    return this.getDefinition(id);
  }

  async listDefinitionVersions(id: string): Promise<WorkflowDefinitionVersion[]> {
    await this.ensureDefinitionVersionTable();
    const { rows } = await this.pool.query(
      `SELECT definition_id, version, name, metadata, nodes, edges, created_at, updated_at
       FROM v2_process_definition_versions
       WHERE definition_id = $1::uuid
       ORDER BY version DESC`,
      [id],
    );

    return rows.map((row) => ({
      definition_id: row.definition_id,
      version: row.version,
      name: row.name,
      description: row.metadata?.description || '',
      group: row.metadata?.group || '',
      group_id: row.metadata?.group_id || null,
      tags: row.metadata?.tags || [],
      version_note: row.metadata?.version_note || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      node_count: Array.isArray(row.nodes) ? row.nodes.length : 0,
      edge_count: Array.isArray(row.edges) ? row.edges.length : 0,
    }));
  }

  async getDefinitionVersion(id: string, version: number): Promise<any> {
    await this.ensureDefinitionVersionTable();
    const { rows } = await this.pool.query(
      `SELECT definition_id, version, name, metadata, nodes, edges, created_at, updated_at
       FROM v2_process_definition_versions
       WHERE definition_id = $1::uuid AND version = $2`,
      [id, version],
    );
    const row = rows[0];
    if (!row) return null;

    return {
      id: row.definition_id,
      definition_id: row.definition_id,
      version: row.version,
      name: row.name,
      description: row.metadata?.description || '',
      group: row.metadata?.group || '',
      group_id: row.metadata?.group_id || null,
      tags: row.metadata?.tags || [],
      version_note: row.metadata?.version_note || '',
      metadata: row.metadata || {},
      created_at: row.created_at,
      updated_at: row.updated_at,
      nodes: row.nodes || [],
      edges: row.edges || [],
    };
  }

  async restoreDefinitionVersion(id: string, version: number, metadata: WorkflowDefinitionMetadata = {}): Promise<any> {
    const snapshot = await this.getDefinitionVersion(id, version);
    if (!snapshot) return null;

    await this.createDefinition(id, snapshot.name, snapshot.nodes || [], snapshot.edges || [], {
      ...(snapshot.metadata || {}),
      ...metadata,
      version_note: metadata.version_note || `Rollback to v${version}${snapshot.version_note ? `: ${snapshot.version_note}` : ''}`,
    });

    return this.getDefinition(id);
  }

  async deleteDefinition(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE v2_process_definitions
       SET status = 'DELETED', updated_at = NOW()
       WHERE id = $1::uuid AND status <> 'DELETED'`,
      [id],
    );
    return (rowCount || 0) > 0;
  }

  private async ensureDefinitionVersionTable(client?: { query: (sql: string, values?: any[]) => Promise<any> }) {
    if (this.definitionVersionTableReady) return;
    const runner = client || this.pool;
    await runner.query(`
      CREATE TABLE IF NOT EXISTS v2_process_definition_versions (
        id BIGSERIAL PRIMARY KEY,
        definition_id UUID NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
        edges JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(definition_id, version)
      )
    `);
    this.definitionVersionTableReady = true;
  }

  // ==========================================
  // WorkflowInstanceRepositoryPort 구현 (V2 인스턴스 대응)
  // ==========================================
  async createIdempotentStart(input: IdempotentWorkflowStart): Promise<IdempotentWorkflowStartResult> {
    await this.ensureStartIdempotencyTable();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM v2_start_idempotency WHERE key_hash = $1 AND expires_at <= NOW()`, [input.key_hash]);
      const inserted = await client.query(
        `INSERT INTO v2_start_idempotency (key_hash, request_hash, instance_id, definition_id, expires_at)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5)
         ON CONFLICT (key_hash) DO NOTHING
         RETURNING instance_id`,
        [input.key_hash, input.request_hash, input.instance.id, input.instance.definition_id, input.expires_at],
      );

      if (inserted.rowCount === 0) {
        const existing = await client.query(`SELECT request_hash, instance_id FROM v2_start_idempotency WHERE key_hash = $1`, [input.key_hash]);
        await client.query('COMMIT');
        return {
          outcome: existing.rows[0]?.request_hash === input.request_hash ? 'replayed' : 'conflict',
          instance_id: existing.rows[0]?.instance_id,
        };
      }

      const normalizedAccess = normalizeAccess(input.instance.context, input.instance.access);
      const nextCtx = normalizedAccess ? applyAccessToContext(input.instance.context, normalizedAccess) : input.instance.context;
      await client.query(
        `INSERT INTO v2_process_instances (id, process_definition_id, state, context, started_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, NOW(), NOW(), NOW())`,
        [input.instance.id, input.instance.definition_id, input.instance.status, JSON.stringify(nextCtx)],
      );
      await client.query(
        `INSERT INTO v2_engine_jobs (instance_id, token_id, type, run_at, attempt, status, payload, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 0, 'QUEUED', $5::jsonb, NOW(), NOW())`,
        [input.instance.id, null, input.job.type, input.job.run_at, JSON.stringify(input.job.payload)],
      );
      await client.query(
        `INSERT INTO v2_tokens (id, instance_id, node_id, status, parent_token_id, scope_key, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, NULL, NULL, NOW(), NOW())`,
        [input.token.id, input.instance.id, input.token.node_id, input.token.status],
      );
      await client.query('COMMIT');
      return { outcome: 'created', instance_id: input.instance.id };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureStartIdempotencyTable(): Promise<void> {
    if (this.startIdempotencyTableReady) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS v2_start_idempotency (
        key_hash TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        instance_id UUID NOT NULL,
        definition_id UUID NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_start_idempotency_expires_at ON v2_start_idempotency (expires_at)`);
    this.startIdempotencyTableReady = true;
  }

  async executeIdempotentCommand(input: IdempotentInstanceCommand): Promise<IdempotentInstanceCommandResult> {
    await this.ensureInstanceCommandIdempotencyTable();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM v2_instance_command_idempotency WHERE key_hash = $1 AND expires_at <= NOW()`, [input.key_hash]);
      const inserted = await client.query(
        `INSERT INTO v2_instance_command_idempotency (key_hash, request_hash, result, expires_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (key_hash) DO NOTHING
         RETURNING result`,
        [input.key_hash, input.request_hash, JSON.stringify(input.result), input.expires_at],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query(`SELECT request_hash, result FROM v2_instance_command_idempotency WHERE key_hash = $1`, [input.key_hash]);
        await client.query('COMMIT');
        return {
          outcome: existing.rows[0]?.request_hash === input.request_hash ? 'replayed' : 'conflict',
          result: existing.rows[0]?.result || {},
        };
      }

      for (const instance of input.create_instances || []) {
        const access = normalizeAccess(instance.context, instance.access);
        const context = access ? applyAccessToContext(instance.context, access) : instance.context;
        await client.query(
          `INSERT INTO v2_process_instances (id, process_definition_id, state, context, started_at, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, NOW(), NOW(), NOW())`,
          [instance.id, instance.definition_id, instance.status, JSON.stringify(context)],
        );
      }
      for (const update of input.update_instances || []) {
        await client.query(
          `UPDATE v2_process_instances
           SET state = COALESCE($1, state),
               context = COALESCE($2::jsonb, context),
               is_paused = COALESCE($3::boolean, is_paused),
               paused_at = CASE WHEN $3::boolean IS NULL THEN paused_at WHEN $3 THEN NOW() ELSE NULL END,
               paused_by = CASE WHEN $3::boolean IS NULL THEN paused_by WHEN $3 THEN $4 ELSE NULL END,
               pause_origin_instance_id = CASE WHEN $3::boolean IS NULL THEN pause_origin_instance_id WHEN $3 THEN $5::uuid ELSE NULL END,
               updated_at = NOW()
           WHERE id = $6::uuid`,
          [
            update.status || null,
            update.context === undefined ? null : JSON.stringify(update.context),
            update.paused === undefined ? null : update.paused,
            update.paused_by || null,
            update.pause_origin_instance_id || null,
            update.id,
          ],
        );
        if (update.complete_jobs) {
          await client.query(
            `UPDATE v2_engine_jobs SET status = 'COMPLETED', updated_at = NOW()
             WHERE instance_id = $1::uuid AND status IN ('QUEUED', 'RUNNING')`,
            [update.id],
          );
        }
      }
      for (const token of input.tokens || []) {
        await client.query(
          `INSERT INTO v2_tokens (id, instance_id, node_id, status, parent_token_id, scope_key, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, NULL, NULL, NOW(), NOW())`,
          [token.id, token.instance_id, token.node_id, token.status],
        );
      }
      for (const job of input.jobs || []) {
        await client.query(
          `INSERT INTO v2_engine_jobs (instance_id, token_id, type, run_at, attempt, status, payload, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, 0, 'QUEUED', $5::jsonb, NOW(), NOW())`,
          [job.instance_id, job.token_id || null, job.type, job.run_at, JSON.stringify(job.payload)],
        );
      }
      for (const event of input.events || []) {
        await client.query(
          `INSERT INTO v2_event_outbox (instance_id, event_type, payload)
           VALUES ($1::uuid, $2, $3::jsonb)`,
          [event.instance_id, event.event_type, JSON.stringify(event.payload)],
        );
      }
      await client.query('COMMIT');
      return { outcome: 'created', result: input.result };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getIdempotentCommand(keyHash: string, requestHash: string): Promise<ExistingIdempotentInstanceCommandResult> {
    await this.ensureInstanceCommandIdempotencyTable();
    const { rows } = await this.pool.query(
      `SELECT request_hash, result FROM v2_instance_command_idempotency WHERE key_hash = $1 AND expires_at > NOW()`,
      [keyHash],
    );
    if (!rows[0]) return { outcome: 'missing', result: {} };
    return {
      outcome: rows[0].request_hash === requestHash ? 'replayed' : 'conflict',
      result: rows[0].result || {},
    };
  }

  async executeInstanceMutation(input: WorkflowInstanceMutation): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyInstanceMutation(input, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyInstanceMutation(input: WorkflowInstanceMutation, client: PoolClient): Promise<void> {
    for (const instance of input.create_instances || []) {
      const access = normalizeAccess(instance.context, instance.access);
      const context = access ? applyAccessToContext(instance.context, access) : instance.context;
      await client.query(
        `INSERT INTO v2_process_instances (id, process_definition_id, state, context, started_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, NOW(), NOW(), NOW())`,
        [instance.id, instance.definition_id, instance.status, JSON.stringify(context)],
      );
    }
    for (const update of input.update_instances || []) {
      await client.query(
        `UPDATE v2_process_instances
         SET state = COALESCE($1, state),
             context = COALESCE($2::jsonb, context),
             is_paused = COALESCE($3::boolean, is_paused),
             paused_at = CASE WHEN $3::boolean IS NULL THEN paused_at WHEN $3 THEN NOW() ELSE NULL END,
             paused_by = CASE WHEN $3::boolean IS NULL THEN paused_by WHEN $3 THEN $4 ELSE NULL END,
             pause_origin_instance_id = CASE WHEN $3::boolean IS NULL THEN pause_origin_instance_id WHEN $3 THEN $5::uuid ELSE NULL END,
             updated_at = NOW()
         WHERE id = $6::uuid`,
        [
          update.status || null,
          update.context === undefined ? null : JSON.stringify(update.context),
          update.paused === undefined ? null : update.paused,
          update.paused_by || null,
          update.pause_origin_instance_id || null,
          update.id,
        ],
      );
      if (update.complete_jobs) {
        await client.query(
          `UPDATE v2_engine_jobs SET status = 'COMPLETED', updated_at = NOW()
           WHERE instance_id = $1::uuid AND status IN ('QUEUED', 'RUNNING')`,
          [update.id],
        );
      }
    }
    for (const token of input.tokens || []) {
      await client.query(
        `INSERT INTO v2_tokens (id, instance_id, node_id, status, parent_token_id, scope_key, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, NULL, NULL, NOW(), NOW())`,
        [token.id, token.instance_id, token.node_id, token.status],
      );
    }
    for (const job of input.jobs || []) {
      await client.query(
        `INSERT INTO v2_engine_jobs (instance_id, token_id, type, run_at, attempt, status, payload, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 0, 'QUEUED', $5::jsonb, NOW(), NOW())`,
        [job.instance_id, job.token_id || null, job.type, job.run_at, JSON.stringify(job.payload)],
      );
    }
    for (const event of input.events || []) {
      await client.query(
        `INSERT INTO v2_event_outbox (instance_id, event_type, payload)
         VALUES ($1::uuid, $2, $3::jsonb)`,
        [event.instance_id, event.event_type, JSON.stringify(event.payload)],
      );
    }
  }

  private async ensureInstanceCommandIdempotencyTable(): Promise<void> {
    if (this.instanceCommandIdempotencyTableReady) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS v2_instance_command_idempotency (
        key_hash TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        result JSONB NOT NULL DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_instance_command_idempotency_expires_at ON v2_instance_command_idempotency (expires_at)`);
    this.instanceCommandIdempotencyTableReady = true;
  }

  async createInstance(id: string, definitionId: string, status: string, ctx: any, access?: WorkflowInstanceAccess): Promise<void> {
    const normalizedAccess = normalizeAccess(ctx, access);
    const nextCtx = normalizedAccess ? applyAccessToContext(ctx, normalizedAccess) : ctx;
    await this.pool.query(
      `INSERT INTO v2_process_instances (id, process_definition_id, state, context, started_at, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, NOW(), NOW(), NOW())`,
      [id, definitionId, status, JSON.stringify(nextCtx)],
    );
  }

  async listInstances(actor?: WorkflowHistoryActor): Promise<any[]> {
    const scope = buildPostgresHistoryScope(actor);
    const { rows } = await this.pool.query(
      `SELECT i.*, d.name as template_name
       FROM v2_process_instances i
       LEFT JOIN v2_process_definitions d ON i.process_definition_id = d.id
       ${scope.where}
       ORDER BY i.created_at DESC LIMIT 50`,
      scope.params,
    );
    return rows.map((r) => ({
      ...r,
      // V1 하위 호환성 필드 매핑
      template_id: r.process_definition_id,
      definition_id: r.process_definition_id,
      status: r.state,
      ctx: r.context,
      ...accessProjection(r),
    }));
  }

  async listChildInstances(parentInstanceId: string): Promise<any[]> {
    const { rows } = await this.pool.query(
      `SELECT *
       FROM v2_process_instances
       WHERE context->'runtime'->>'parent_instance_id' = $1
       ORDER BY created_at DESC`,
      [parentInstanceId],
    );
    return rows.map((r) => ({
      ...r,
      template_id: r.process_definition_id,
      definition_id: r.process_definition_id,
      status: r.state,
      ctx: r.context,
      ...accessProjection(r),
    }));
  }

  async getInstance(id: string): Promise<any> {
    const { rows } = await this.pool.query(`SELECT * FROM v2_process_instances WHERE id = $1`, [id]);
    if (rows.length === 0) return null;
    return {
      ...rows[0],
      // V1 호환 필드 매핑
      template_id: rows[0].process_definition_id,
      definition_id: rows[0].process_definition_id,
      status: rows[0].state,
      ctx: rows[0].context,
      ...accessProjection(rows[0]),
    };
  }

  async updateInstanceStatus(id: string, status: string): Promise<void> {
    await this.pool.query(`UPDATE v2_process_instances SET state = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
  }

  async updateInstanceCtx(id: string, ctx: any): Promise<void> {
    await this.pool.query(`UPDATE v2_process_instances SET context = $1::jsonb, updated_at = NOW() WHERE id = $2`, [JSON.stringify(ctx), id]);
  }

  async completeJobsForInstance(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE v2_engine_jobs
       SET status = 'COMPLETED', updated_at = NOW()
       WHERE instance_id = $1::uuid AND status IN ('QUEUED', 'RUNNING')`,
      [id],
    );
  }

  async createToken(token: { id: string; instanceId: string; nodeId: string; status: string; parentTokenId?: string; scopeKey?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO v2_tokens (id, instance_id, node_id, status, parent_token_id, scope_key, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, NOW(), NOW())`,
      [token.id, token.instanceId, token.nodeId, token.status, token.parentTokenId || null, token.scopeKey || null],
    );
  }

  async createJob(job: { instanceId: string; tokenId?: string | null; type: string; runAt: Date; payload: any }): Promise<void> {
    await this.pool.query(
      `INSERT INTO v2_engine_jobs (instance_id, token_id, type, run_at, attempt, status, payload, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 0, 'QUEUED', $5::jsonb, NOW(), NOW())`,
      [job.instanceId, job.tokenId || null, job.type, job.runAt, JSON.stringify(job.payload)],
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
    const statusResult = await this.pool.query(`SELECT status, count(*)::int AS count FROM v2_engine_jobs GROUP BY status`);
    const byStatus = Object.fromEntries(statusResult.rows.map((row) => [row.status || 'UNKNOWN', Number(row.count)]));

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

    const maxAttemptResult = await this.pool.query(`SELECT COALESCE(max(attempt), 0)::int AS max_attempt FROM v2_engine_jobs`);
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
      oldest_queued_age_ms: oldest?.age_ms == null ? null : Math.max(0, Number(oldest.age_ms)),
      running_workers: workersResult.rows.map((row) => ({
        worker_id: row.worker_id,
        running_jobs: Number(row.running_jobs),
        last_updated_at: row.last_updated_at?.toISOString?.() || row.last_updated_at || null,
      })),
      worker_heartbeats: heartbeatsResult.rows.map((row) => ({
        worker_id: row.worker_id,
        last_heartbeat_at: row.last_heartbeat_at?.toISOString?.() || row.last_heartbeat_at || null,
        locked_instances: Number(row.locked_instances),
      })),
      max_attempt: Number(maxAttemptResult.rows[0]?.max_attempt || 0),
    };
  }

  async replaceDefinitionSchedules(definitionId: string, jobs: WorkflowScheduleJob[]): Promise<void> {
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
          [job.id, job.definitionId, job.definitionName, job.startNodeId, job.scheduleType, job.intervalSeconds ?? null, job.cronExpression ?? null, JSON.stringify(job.input || {}), job.nextRunAt, job.active, job.active ? 'WAITING' : 'DISABLED'],
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

  async claimDueSchedules(now: Date, owner: string, limit: number): Promise<WorkflowScheduleJob[]> {
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

  async markScheduleSuccess(id: string, nextRunAt: Date, instanceId: string): Promise<void> {
    await this.ensureScheduleTable();
    const current = await this.pool.query(`SELECT definition_id, next_run_at FROM v2_schedule_jobs WHERE id = $1`, [id]);
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
      [id, current.rows[0]?.definition_id, instanceId, current.rows[0]?.next_run_at || new Date()],
    );
  }

  async markScheduleFailure(id: string, error: string, nextRunAt: Date): Promise<void> {
    await this.ensureScheduleTable();
    const current = await this.pool.query(`SELECT definition_id, next_run_at FROM v2_schedule_jobs WHERE id = $1`, [id]);
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

  async getDefinitionScheduleStatus(definitionId: string, limit = 10): Promise<WorkflowScheduleStatus> {
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
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_schedule_jobs_due ON v2_schedule_jobs (active, status, next_run_at)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_schedule_jobs_definition ON v2_schedule_jobs (definition_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_schedule_runs_definition ON v2_schedule_runs (definition_id, created_at DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_schedule_runs_job ON v2_schedule_runs (schedule_job_id, created_at DESC)`);
    this.scheduleTableReady = true;
  }

  // ==========================================
  // WorkflowTaskRepositoryPort 구현 (V2 태스크 대응)
  // ==========================================
  async createTask(id: string, instanceId: string, nodeId: string, assignee: string, status: string, payload: any): Promise<void> {
    await this.ensureTaskRuntimeColumns();
    await this.pool.query(
      `INSERT INTO v2_tasks (id, instance_id, token_id, node_id, assignee, status, payload, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, null, $3, $4, $5, $6::jsonb, NOW(), NOW())`,
      [id, instanceId, nodeId, assignee, status, JSON.stringify(payload)],
    );
  }

  async listTasks(assignee: string): Promise<any[]> {
    await this.ensureTaskRuntimeColumns();
    const { rows } = await this.pool.query(
      `SELECT t.*, 
              i.id as instance_id, 
              i.process_definition_id,
              i.state as instance_status,
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
    await this.ensureTaskRuntimeColumns();
    const { rows } = await this.pool.query(`SELECT * FROM v2_tasks WHERE id = $1`, [id]);
    return rows[0] || null;
  }

  async listTaskHistory(query: WorkflowTaskHistoryQuery): Promise<WorkflowTaskHistoryPage> {
    await this.ensureTaskRuntimeColumns();
    const params: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.statuses?.length) where.push(`t.status = ANY(${bind(query.statuses)}::text[])`);
    if (query.workflow_id) where.push(`i.process_definition_id = ${bind(query.workflow_id)}::uuid`);
    if (query.instance_id) where.push(`t.instance_id = ${bind(query.instance_id)}::uuid`);
    if (query.assignee) where.push(`t.assignee = ${bind(query.assignee)}`);
    if (query.approver_channel) where.push(`COALESCE(t.payload->>'approver_channel', 'pxm_user') = ${bind(query.approver_channel)}`);
    if (query.from) where.push(`t.created_at >= ${bind(query.from)}::timestamptz`);
    if (query.to) where.push(`t.created_at <= ${bind(query.to)}::timestamptz`);
    if (query.group_ids) where.push(`COALESCE(i.context->'runtime'->'access'->>'group_id', i.context->'runtime'->'snapshot'->'group'->>'id') = ANY(${bind(query.group_ids)}::text[])`);
    if (query.allowed_workflow_ids) where.push(`i.process_definition_id = ANY(${bind(query.allowed_workflow_ids)}::uuid[])`);
    if (query.cursor) {
      const createdParam = bind(query.cursor.created_at);
      const idParam = bind(query.cursor.id);
      where.push(`(t.created_at < ${createdParam}::timestamptz OR (t.created_at = ${createdParam}::timestamptz AND t.id < ${idParam}::uuid))`);
    }
    const limitParam = bind(query.limit + 1);
    const { rows } = await this.pool.query(
      `SELECT t.*, i.process_definition_id,
              COALESCE(i.context->'runtime'->'access'->>'group_id', i.context->'runtime'->'snapshot'->'group'->>'id') AS group_id,
              i.context->'runtime'->'snapshot'->'workflow'->>'version' AS workflow_version_id,
              i.context,
              d.name AS workflow_name, d.version AS workflow_version, d.nodes AS definition_nodes
       FROM v2_tasks t
       JOIN v2_process_instances i ON i.id = t.instance_id
       LEFT JOIN v2_process_definitions d ON d.id = i.process_definition_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ${limitParam}`,
      params,
    );
    return {
      items: rows.slice(0, query.limit).map(mapTaskHistoryPostgres),
      has_more: rows.length > query.limit,
    };
  }

  async getTaskHistoryItem(id: string): Promise<WorkflowTaskHistoryItem | null> {
    await this.ensureTaskRuntimeColumns();
    const { rows } = await this.pool.query(
      `SELECT t.*, i.process_definition_id,
              COALESCE(i.context->'runtime'->'access'->>'group_id', i.context->'runtime'->'snapshot'->'group'->>'id') AS group_id,
              i.context->'runtime'->'snapshot'->'workflow'->>'version' AS workflow_version_id,
              i.context,
              d.name AS workflow_name, d.version AS workflow_version, d.nodes AS definition_nodes
       FROM v2_tasks t
       JOIN v2_process_instances i ON i.id = t.instance_id
       LEFT JOIN v2_process_definitions d ON d.id = i.process_definition_id
       WHERE t.id = $1::uuid`,
      [id],
    );
    return rows[0] ? mapTaskHistoryPostgres(rows[0]) : null;
  }

  async claimExternalApprovalTasks(owner: string, now: Date, claimUntil: Date, limit: number): Promise<ExternalApprovalClaim[]> {
    await this.ensureTaskRuntimeColumns();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM v2_tasks
         WHERE status = 'OPEN'
           AND payload->>'approver_channel' = 'external_email'
           AND COALESCE((payload->'external_approval'->>'attempt_count')::int, 0) < 10
           AND (
             payload->'external_approval'->>'delivery_status' IS NULL
             OR payload->'external_approval'->>'delivery_status' = 'PENDING'
             OR (payload->'external_approval'->>'delivery_status' = 'FAILED'
                 AND COALESCE(payload->'external_approval'->>'retry_at', '') <= $1)
             OR (payload->'external_approval'->>'delivery_status' = 'CLAIMED'
                 AND COALESCE(payload->'external_approval'->>'claim_until', '') <= $1)
           )
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [now.toISOString(), limit],
      );
      const claims: ExternalApprovalClaim[] = [];
      for (const task of rows) {
        const current = task.payload?.external_approval || {};
        const attemptCount = Number(current.attempt_count || 0) + 1;
        const externalApproval = {
          ...current,
          delivery_status: 'CLAIMED',
          claim_owner: owner,
          claim_until: claimUntil.toISOString(),
          attempt_count: attemptCount,
          updated_at: now.toISOString(),
        };
        await client.query(`UPDATE v2_tasks SET payload = $1::jsonb, updated_at = NOW() WHERE id = $2::uuid`, [
          JSON.stringify({
            ...(task.payload || {}),
            external_approval: externalApproval,
          }),
          task.id,
        ]);
        claims.push({
          task_id: String(task.id),
          instance_id: String(task.instance_id),
          email: String(task.assignee),
          require_otp: task.payload?.external_require_otp !== false,
          expires_in_hours: Math.min(168, Math.max(1, Number(task.payload?.external_expires_in_hours) || 24)),
          attempt_count: attemptCount,
        });
      }
      await client.query('COMMIT');
      return claims;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setExternalApprovalDeliveryToken(taskId: string, owner: string, input: ExternalApprovalDeliveryToken): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || task.status !== 'OPEN' || task.payload?.external_approval?.claim_owner !== owner) return false;
    const externalApproval = {
      ...(task.payload?.external_approval || {}),
      email: input.email,
      token_hash: input.token_hash,
      token_expires_at: input.token_expires_at,
      require_otp: input.require_otp,
      attempt_count: input.attempt_count,
      otp_hash: null,
      otp_attempts: 0,
      consumed_at: null,
      updated_at: new Date().toISOString(),
    };
    const result = await this.pool.query(
      `UPDATE v2_tasks SET payload = $1::jsonb, updated_at = NOW()
       WHERE id = $2::uuid AND status = 'OPEN' AND payload->'external_approval'->>'claim_owner' = $3`,
      [
        JSON.stringify({
          ...(task.payload || {}),
          external_approval: externalApproval,
        }),
        taskId,
        owner,
      ],
    );
    return result.rowCount === 1;
  }

  async markExternalApprovalDelivery(
    taskId: string,
    owner: string,
    status: 'SENT' | 'FAILED',
    input: {
      sent_at?: string | null;
      retry_at?: string | null;
      error?: string | null;
    },
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || task.payload?.external_approval?.claim_owner !== owner) return;
    const externalApproval = {
      ...task.payload.external_approval,
      delivery_status: status,
      sent_at: input.sent_at || null,
      retry_at: input.retry_at || null,
      last_error: input.error || null,
      claim_owner: null,
      claim_until: null,
      updated_at: new Date().toISOString(),
    };
    await this.pool.query(
      `UPDATE v2_tasks SET payload = $1::jsonb, updated_at = NOW()
       WHERE id = $2::uuid AND payload->'external_approval'->>'claim_owner' = $3`,
      [
        JSON.stringify({
          ...(task.payload || {}),
          external_approval: externalApproval,
        }),
        taskId,
        owner,
      ],
    );
  }

  async requeueExternalApproval(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task || task.status !== 'OPEN' || task.payload?.approver_channel !== 'external_email') return false;
    const now = new Date().toISOString();
    const externalApproval = {
      ...(task.payload?.external_approval || {}),
      delivery_status: 'PENDING',
      attempt_count: 0,
      sent_at: null,
      retry_at: null,
      last_error: null,
      claim_owner: null,
      claim_until: null,
      token_hash: null,
      token_expires_at: null,
      otp_hash: null,
      otp_expires_at: null,
      otp_sent_at: null,
      otp_next_send_at: null,
      otp_attempts: 0,
      consumed_at: null,
      requeued_at: now,
      updated_at: now,
    };
    const result = await this.pool.query(
      `UPDATE v2_tasks SET payload = $1::jsonb, updated_at = NOW()
       WHERE id = $2::uuid AND status = 'OPEN'
         AND payload->>'approver_channel' = 'external_email'`,
      [
        JSON.stringify({
          ...(task.payload || {}),
          external_approval: externalApproval,
        }),
        taskId,
      ],
    );
    return result.rowCount === 1;
  }

  async findExternalApprovalByTokenHash(tokenHash: string): Promise<ExternalApprovalTask | null> {
    await this.ensureTaskRuntimeColumns();
    const { rows } = await this.pool.query(`SELECT * FROM v2_tasks WHERE payload->'external_approval'->>'token_hash' = $1 LIMIT 1`, [tokenHash]);
    return (rows[0] as ExternalApprovalTask | undefined) || null;
  }

  async setExternalApprovalOtp(taskId: string, tokenHash: string, input: ExternalApprovalOtp): Promise<boolean> {
    const task = await this.getTask(taskId);
    const externalApproval = task?.payload?.external_approval;
    if (!task || task.status !== 'OPEN' || externalApproval?.token_hash !== tokenHash) return false;
    if (externalApproval.otp_next_send_at && externalApproval.otp_next_send_at > new Date().toISOString()) return false;
    const next = {
      ...externalApproval,
      otp_hash: input.otp_hash,
      otp_expires_at: input.otp_expires_at,
      otp_sent_at: input.otp_sent_at,
      otp_next_send_at: input.otp_next_send_at,
      otp_attempts: 0,
    };
    const result = await this.pool.query(
      `UPDATE v2_tasks SET payload = $1::jsonb, updated_at = NOW()
       WHERE id = $2::uuid AND status = 'OPEN'
         AND payload->'external_approval'->>'token_hash' = $3
         AND (payload->'external_approval'->>'otp_next_send_at' IS NULL
              OR payload->'external_approval'->>'otp_next_send_at' <= $4)`,
      [JSON.stringify({ ...(task.payload || {}), external_approval: next }), taskId, tokenHash, new Date().toISOString()],
    );
    return result.rowCount === 1;
  }

  async incrementExternalApprovalOtpFailures(taskId: string, tokenHash: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT * FROM v2_tasks WHERE id = $1::uuid FOR UPDATE`, [taskId]);
      const task = rows[0];
      if (!task || task.status !== 'OPEN' || task.payload?.external_approval?.token_hash !== tokenHash) {
        await client.query('COMMIT');
        return 0;
      }
      const attempts = Number(task.payload.external_approval.otp_attempts || 0) + 1;
      const payload = {
        ...(task.payload || {}),
        external_approval: {
          ...task.payload.external_approval,
          otp_attempts: attempts,
        },
      };
      await client.query(`UPDATE v2_tasks SET payload = $1::jsonb, updated_at = NOW() WHERE id = $2::uuid`, [JSON.stringify(payload), taskId]);
      await client.query('COMMIT');
      return attempts;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async clearExternalApprovalOtp(taskId: string, tokenHash: string, otpHash: string): Promise<void> {
    const task = await this.getTask(taskId);
    const external = task?.payload?.external_approval;
    if (!task || task.status !== 'OPEN' || external?.token_hash !== tokenHash || external?.otp_hash !== otpHash) return;
    const payload = {
      ...(task.payload || {}),
      external_approval: {
        ...external,
        otp_hash: null,
        otp_expires_at: null,
        otp_sent_at: null,
        otp_next_send_at: null,
        otp_attempts: 0,
      },
    };
    await this.pool.query(
      `UPDATE v2_tasks SET payload = $1::jsonb, updated_at = NOW()
       WHERE id = $2::uuid AND status = 'OPEN'
         AND payload->'external_approval'->>'token_hash' = $3
         AND payload->'external_approval'->>'otp_hash' = $4`,
      [JSON.stringify(payload), taskId, tokenHash, otpHash],
    );
  }

  async completeTask(command: CompleteWorkflowTaskCommand): Promise<CompleteWorkflowTaskResult> {
    await this.ensureTaskRuntimeColumns();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT * FROM v2_tasks WHERE id = $1::uuid FOR UPDATE`, [command.task_id]);
      const task = rows[0];
      if (!task) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found', task: null };
      }
      if (task.status !== 'OPEN') {
        await client.query('COMMIT');
        const sameKey = sameTaskCompletion(task.payload?.completion, command);
        return { outcome: sameKey ? 'idempotent' : 'already_completed', task };
      }

      const completedAt = new Date().toISOString();
      const completion = taskCompletion(command, completedAt);
      if (command.external_approval) {
        const external = task.payload?.external_approval;
        if (external?.token_hash !== command.external_approval.token_hash || external?.consumed_at) {
          await client.query('COMMIT');
          return { outcome: 'already_completed', task };
        }
      }
      const externalApproval = command.external_approval
        ? {
            ...(task.payload?.external_approval || {}),
            consumed_at: completedAt,
            auth_method: command.external_approval.auth_method,
            completed_email: command.external_approval.email,
          }
        : task.payload?.external_approval;
      const payload = {
        ...(task.payload || {}),
        completion,
        ...(externalApproval ? { external_approval: externalApproval } : {}),
      };
      await client.query(`UPDATE v2_tasks SET status = $1, payload = $2::jsonb, updated_at = NOW() WHERE id = $3::uuid`, [command.status, JSON.stringify(payload), command.task_id]);
      await client.query(
        `INSERT INTO v2_engine_jobs (instance_id, token_id, type, run_at, attempt, status, payload, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'RESUME', NOW(), 0, 'QUEUED', $3::jsonb, NOW(), NOW())`,
        [
          task.instance_id,
          task.token_id || null,
          JSON.stringify({
            action: command.action,
            completed_node_id: task.node_id,
            task_id: command.task_id,
            result: command.result || null,
            comment: command.comment || null,
          }),
        ],
      );
      await client.query(`UPDATE v2_process_instances SET state = 'RUNNING', updated_at = NOW() WHERE id = $1::uuid`, [task.instance_id]);
      await client.query(
        `INSERT INTO v2_event_outbox (instance_id, token_id, node_id, event_type, payload, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, NOW())`,
        [
          task.instance_id,
          task.token_id || null,
          task.node_id,
          command.action === 'approve' ? 'TASK_APPROVED' : 'TASK_REJECTED',
          JSON.stringify({
            task_id: command.task_id,
            action: command.action,
            status: command.status,
            actor_id: command.actor_id,
            approval_channel: command.external_approval ? 'external_email' : 'pxm_user',
          }),
        ],
      );
      await client.query('COMMIT');
      return {
        outcome: 'completed',
        task: { ...task, status: command.status, payload },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureTaskRuntimeColumns() {
    if (this.taskRuntimeColumnsReady) return;
    await this.pool.query(`ALTER TABLE v2_tasks ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_tasks_assignee_status ON v2_tasks (assignee, status, created_at DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_tasks_history ON v2_tasks (status, created_at DESC, id DESC)`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_v2_tasks_external_approval_token_hash ON v2_tasks ((payload->'external_approval'->>'token_hash')) WHERE payload->'external_approval'->>'token_hash' IS NOT NULL`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_tasks_external_approval_dispatch ON v2_tasks (status, (payload->>'approver_channel'), (payload->'external_approval'->>'delivery_status'), created_at)`);
    this.taskRuntimeColumnsReady = true;
  }

  async fetchAfter(instanceId: string, afterId: number, limit = 100): Promise<any[]> {
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

  async appendEvent(instanceId: string, eventType: string, payload: any): Promise<any> {
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

  async listInputPresets(workflowId: string): Promise<WorkflowInputPreset[]> {
    await this.ensureInputPresetTable();
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM workflow_input_presets
      WHERE workflow_id = $1 AND enabled = true
      ORDER BY updated_at DESC
      `,
      [workflowId],
    );
    return rows.map(mapInputPresetRow);
  }

  async listAllInputPresets(): Promise<WorkflowInputPreset[]> {
    await this.ensureInputPresetTable();
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM workflow_input_presets
      WHERE enabled = true
      ORDER BY updated_at DESC
      `,
    );
    return rows.map(mapInputPresetRow);
  }

  async getInputPreset(workflowId: string, idOrAlias: string): Promise<WorkflowInputPreset | null> {
    await this.ensureInputPresetTable();
    const { rows } = await this.pool.query(
      `
      SELECT *
      FROM workflow_input_presets
      WHERE workflow_id = $1 AND enabled = true AND (id = $2 OR alias = $2)
      LIMIT 1
      `,
      [workflowId, idOrAlias],
    );
    return rows[0] ? mapInputPresetRow(rows[0]) : null;
  }

  async upsertInputPreset(workflowId: string, preset: UpsertWorkflowInputPreset): Promise<WorkflowInputPreset> {
    await this.ensureInputPresetTable();
    const alias = preset.alias || slugifyPresetAlias(preset.name);
    const id = preset.id || crypto.randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO workflow_input_presets
        (id, workflow_id, alias, name, description, values, scope, group_id, shared_group_ids, enabled, created_by, updated_by, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, true, $10, $10, NOW(), NOW())
      ON CONFLICT (workflow_id, alias)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        values = EXCLUDED.values,
        scope = EXCLUDED.scope,
        group_id = EXCLUDED.group_id,
        shared_group_ids = EXCLUDED.shared_group_ids,
        enabled = true,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
      `,
      [id, workflowId, alias, preset.name.trim(), preset.description || '', JSON.stringify(preset.values || {}), preset.scope || 'private', preset.group_id || null, JSON.stringify(preset.shared_group_ids || []), preset.actor || null],
    );
    return mapInputPresetRow(rows[0]);
  }

  async deleteInputPreset(workflowId: string, presetId: string): Promise<boolean> {
    await this.ensureInputPresetTable();
    const { rowCount } = await this.pool.query(
      `
      UPDATE workflow_input_presets
      SET enabled = false, updated_at = NOW()
      WHERE workflow_id = $1 AND id = $2
      `,
      [workflowId, presetId],
    );
    return (rowCount || 0) > 0;
  }

  async upsertGroup(group: UpsertPxmGroup): Promise<PxmGroup> {
    await this.ensureAuthzTables();
    const id = group.id || crypto.randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO pxm_groups
        (id, name, description, status, created_by, updated_by, created_at, updated_at)
      VALUES
        ($1, $2, $3, 'active', $4, $4, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        status = 'active',
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
      `,
      [id, group.name.trim(), group.description || '', group.actor || null],
    );
    return mapGroupRow(rows[0]);
  }

  async listGroups(includeDeleted = false): Promise<PxmGroup[]> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(
      `
      SELECT * FROM pxm_groups
      ${includeDeleted ? '' : `WHERE status <> 'deleted'`}
      ORDER BY created_at DESC
      `,
    );
    return rows.map(mapGroupRow);
  }

  async getGroup(id: string): Promise<PxmGroup | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_groups WHERE id = $1`, [id]);
    return rows[0] ? mapGroupRow(rows[0]) : null;
  }

  async softDeleteGroup(id: string, actor?: string | null): Promise<boolean> {
    await this.ensureAuthzTables();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `
        UPDATE pxm_groups
        SET status = 'deleted', deleted_at = NOW(), updated_by = $2, updated_at = NOW()
        WHERE id = $1 AND status <> 'deleted'
        `,
        [id, actor || null],
      );
      if ((rowCount || 0) > 0) {
        await client.query(
          `
          UPDATE pxm_api_keys
          SET status = 'disabled', disabled_at = NOW(), updated_at = NOW()
          WHERE group_id = $1 AND status = 'active'
          `,
          [id],
        );
      }
      await client.query('COMMIT');
      return (rowCount || 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async restoreGroup(id: string, actor?: string | null): Promise<boolean> {
    await this.ensureAuthzTables();
    const { rowCount } = await this.pool.query(
      `
      UPDATE pxm_groups
      SET status = 'active', deleted_at = NULL, updated_by = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'deleted'
      `,
      [id, actor || null],
    );
    return (rowCount || 0) > 0;
  }

  async upsertUser(user: UpsertPxmUser): Promise<PxmUser> {
    await this.ensureAuthzTables();
    const id = user.id || crypto.randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO pxm_users
        (id, display_name, email, role, group_ids, memberships, status, created_by, updated_by, created_at, updated_at, password_hash)
      VALUES
        ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $8, NOW(), NOW(), $9)
      ON CONFLICT (id)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        role = EXCLUDED.role,
        group_ids = EXCLUDED.group_ids,
        memberships = EXCLUDED.memberships,
        status = EXCLUDED.status,
        updated_by = EXCLUDED.updated_by,
        password_hash = COALESCE(EXCLUDED.password_hash, pxm_users.password_hash),
        updated_at = NOW()
      RETURNING *
      `,
      [id, user.display_name.trim(), user.email || null, user.role || 'user', JSON.stringify(user.group_ids || []), JSON.stringify(user.memberships || []), user.status || 'active', user.actor || null, user.password_hash || null],
    );
    return mapUserRow(rows[0]);
  }

  async listUsers(groupId?: string): Promise<PxmUser[]> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(
      `
      SELECT * FROM pxm_users
      ${groupId ? `WHERE group_ids ? $1` : ''}
      ORDER BY created_at DESC
      `,
      groupId ? [groupId] : [],
    );
    return rows.map(mapUserRow);
  }

  async getUser(id: string): Promise<PxmUser | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_users WHERE id = $1`, [id]);
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  async getUserPasswordHash(id: string): Promise<string | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT password_hash FROM pxm_users WHERE id = $1`, [id]);
    return rows[0]?.password_hash || null;
  }

  async updateUserPasswordHash(id: string, passwordHash: string, actor?: string | null): Promise<boolean> {
    await this.ensureAuthzTables();
    const { rowCount } = await this.pool.query(`UPDATE pxm_users SET password_hash=$2, updated_by=$3, updated_at=NOW() WHERE id=$1 AND status='active'`, [id, passwordHash, actor || id]);
    return (rowCount || 0) > 0;
  }

  async updateUserProfile(id: string, displayName: string, email?: string | null): Promise<PxmUser | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`UPDATE pxm_users SET display_name=$2, email=$3, updated_by=$1, updated_at=NOW() WHERE id=$1 AND status='active' RETURNING *`, [id, displayName, email || null]);
    return rows[0] ? mapUserRow(rows[0]) : null;
  }

  async createSession(session: CreatePxmSession): Promise<PxmSession> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`INSERT INTO pxm_sessions (id, token_hash, csrf_hash, user_id, ip, user_agent, idle_expires_at, absolute_expires_at, idle_timeout_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [session.id, session.token_hash, session.csrf_hash, session.user_id, session.ip || null, session.user_agent || null, session.idle_expires_at, session.absolute_expires_at, session.idle_timeout_minutes || null]);
    return mapSessionRow(rows[0]);
  }
  async findSessionByTokenHash(tokenHash: string): Promise<PxmSession | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_sessions WHERE token_hash = $1`, [tokenHash]);
    return rows[0] ? mapSessionRow(rows[0]) : null;
  }
  async touchSession(id: string, lastSeenAt: string, idleExpiresAt: string): Promise<void> {
    await this.pool.query(`UPDATE pxm_sessions SET last_seen_at=$2, idle_expires_at=$3 WHERE id=$1 AND revoked_at IS NULL`, [id, lastSeenAt, idleExpiresAt]);
  }
  async revokeSession(id: string, reason: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`UPDATE pxm_sessions SET revoked_at=NOW(), revoke_reason=$2 WHERE id=$1 AND revoked_at IS NULL`, [id, reason]);
    return (rowCount || 0) > 0;
  }
  async revokeUserSessions(userId: string, reason: string, exceptId?: string): Promise<number> {
    const { rowCount } = await this.pool.query(`UPDATE pxm_sessions SET revoked_at=NOW(), revoke_reason=$2 WHERE user_id=$1 AND revoked_at IS NULL AND ($3::text IS NULL OR id <> $3)`, [userId, reason, exceptId || null]);
    return rowCount || 0;
  }
  async revokeAllSessions(reason: string, exceptId?: string): Promise<number> {
    const { rowCount } = await this.pool.query(`UPDATE pxm_sessions SET revoked_at=NOW(), revoke_reason=$1 WHERE revoked_at IS NULL AND ($2::text IS NULL OR id <> $2)`, [reason, exceptId || null]);
    return rowCount || 0;
  }
  async listUserSessions(userId: string): Promise<PxmSession[]> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_sessions WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return rows.map(mapSessionRow);
  }
  async getSessionSecurityPolicy(): Promise<PxmSessionSecurityPolicy | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_security_policies WHERE id='session'`);
    return rows[0] ? mapSessionSecurityPolicyRow(rows[0]) : null;
  }
  async upsertSessionSecurityPolicy(policy: UpsertPxmSessionSecurityPolicy): Promise<PxmSessionSecurityPolicy> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(
      `INSERT INTO pxm_security_policies (id, idle_timeout_minutes, absolute_timeout_hours, updated_by, created_at, updated_at)
       VALUES ('session', $1, $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET idle_timeout_minutes=EXCLUDED.idle_timeout_minutes, absolute_timeout_hours=EXCLUDED.absolute_timeout_hours, updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING *`,
      [policy.idle_timeout_minutes, policy.absolute_timeout_hours, policy.updated_by],
    );
    return mapSessionSecurityPolicyRow(rows[0]);
  }

  async upsertServiceAccount(account: UpsertPxmServiceAccount): Promise<PxmServiceAccount> {
    await this.ensureAuthzTables();
    const id = account.id || crypto.randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO pxm_service_accounts
        (id, name, group_id, description, status, created_by, updated_by, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $6, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        name = EXCLUDED.name,
        group_id = EXCLUDED.group_id,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING *
      `,
      [id, account.name.trim(), account.group_id, account.description || '', account.status || 'active', account.actor || null],
    );
    return mapServiceAccountRow(rows[0]);
  }

  async listServiceAccounts(groupId?: string): Promise<PxmServiceAccount[]> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(
      `
      SELECT * FROM pxm_service_accounts
      ${groupId ? `WHERE group_id = $1` : ''}
      ORDER BY created_at DESC
      `,
      groupId ? [groupId] : [],
    );
    return rows.map(mapServiceAccountRow);
  }

  async getServiceAccount(id: string): Promise<PxmServiceAccount | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_service_accounts WHERE id = $1`, [id]);
    return rows[0] ? mapServiceAccountRow(rows[0]) : null;
  }

  async createApiKey(key: CreatePxmApiKey): Promise<PxmApiKey> {
    await this.ensureAuthzTables();
    const id = key.id || crypto.randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO pxm_api_keys
        (id, name, owner_type, owner_id, group_id, key_prefix, key_hash, scopes, allowed_workflow_ids, ip_allowlist, rate_limit_per_minute, status, expires_at, created_by, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, 'active', $12, $13, NOW(), NOW())
      RETURNING *
      `,
      [id, key.name.trim(), key.owner_type, key.owner_id, key.group_id, key.key_prefix, key.key_hash, JSON.stringify(key.scopes || []), JSON.stringify(key.allowed_workflow_ids || []), JSON.stringify(key.ip_allowlist || []), key.rate_limit_per_minute || null, key.expires_at || null, key.actor || null],
    );
    return mapApiKeyRow(rows[0]);
  }

  async listApiKeys(groupId?: string): Promise<PxmApiKey[]> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(
      `
      SELECT * FROM pxm_api_keys
      ${groupId ? `WHERE group_id = $1` : ''}
      ORDER BY created_at DESC
      `,
      groupId ? [groupId] : [],
    );
    return rows.map(mapApiKeyRow);
  }

  async getApiKey(id: string): Promise<PxmApiKey | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_api_keys WHERE id = $1`, [id]);
    return rows[0] ? mapApiKeyRow(rows[0]) : null;
  }

  async findApiKeyByHash(keyHash: string): Promise<PxmApiKey | null> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT * FROM pxm_api_keys WHERE key_hash = $1`, [keyHash]);
    return rows[0] ? mapApiKeyRow(rows[0]) : null;
  }

  async disableApiKey(id: string, actor?: string | null): Promise<boolean> {
    await this.ensureAuthzTables();
    const { rowCount } = await this.pool.query(
      `
      UPDATE pxm_api_keys
      SET status = 'disabled', disabled_at = NOW(), updated_by = $2, updated_at = NOW()
      WHERE id = $1 AND status <> 'disabled'
      `,
      [id, actor || null],
    );
    return (rowCount || 0) > 0;
  }

  async touchApiKey(id: string, usedAt: string): Promise<void> {
    await this.ensureAuthzTables();
    await this.pool.query(`UPDATE pxm_api_keys SET last_used_at = $2, updated_at = $2 WHERE id = $1`, [id, usedAt]);
  }

  async appendApiKeyUsageLog(log: AppendPxmApiKeyUsageLog): Promise<PxmApiKeyUsageLog> {
    await this.ensureAuthzTables();
    const id = log.id || crypto.randomUUID();
    const { rows } = await this.pool.query(
      `
      INSERT INTO pxm_api_key_usage_logs
        (id, api_key_id, owner_type, owner_id, group_id, endpoint, workflow_id, instance_id, request_id, ip, user_agent, business_actor, created_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())
      RETURNING *
      `,
      [id, log.api_key_id, log.owner_type, log.owner_id, log.group_id, log.endpoint, log.workflow_id || null, log.instance_id || null, log.request_id || null, log.ip || null, log.user_agent || null, JSON.stringify(log.business_actor || null)],
    );
    return mapApiKeyUsageLogRow(rows[0]);
  }

  async countApiKeyUsageSince(apiKeyId: string, since: string): Promise<number> {
    await this.ensureAuthzTables();
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS count FROM pxm_api_key_usage_logs WHERE api_key_id = $1 AND created_at >= $2`, [apiKeyId, since]);
    return Number(rows[0]?.count || 0);
  }

  private async ensureInputPresetTable(): Promise<void> {
    if (this.inputPresetTableReady) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_input_presets (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        values JSONB NOT NULL DEFAULT '{}'::jsonb,
        scope TEXT NOT NULL DEFAULT 'private',
        group_id TEXT NULL,
        shared_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_by TEXT NULL,
        updated_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (workflow_id, alias)
      )
    `);
    await this.pool.query(`ALTER TABLE workflow_input_presets ADD COLUMN IF NOT EXISTS shared_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_workflow_input_presets_workflow_updated
      ON workflow_input_presets (workflow_id, updated_at DESC)
    `);
    this.inputPresetTableReady = true;
  }

  private async ensureAuthzTables(): Promise<void> {
    if (this.authzTablesReady) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pxm_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NULL,
        updated_by TEXT NULL,
        deleted_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pxm_users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        email TEXT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        memberships JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NULL,
        updated_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`ALTER TABLE pxm_users ADD COLUMN IF NOT EXISTS password_hash TEXT NULL`);
    await this.pool.query(`ALTER TABLE pxm_users ADD COLUMN IF NOT EXISTS memberships JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS pxm_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, user_id TEXT NOT NULL, ip TEXT NULL, user_agent TEXT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), idle_expires_at TIMESTAMPTZ NOT NULL, absolute_expires_at TIMESTAMPTZ NOT NULL, idle_timeout_minutes INTEGER NULL, revoked_at TIMESTAMPTZ NULL, revoke_reason TEXT NULL)`);
    await this.pool.query(`ALTER TABLE pxm_sessions ADD COLUMN IF NOT EXISTS idle_timeout_minutes INTEGER NULL`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_pxm_sessions_user_created ON pxm_sessions (user_id, created_at DESC)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS pxm_security_policies (id TEXT PRIMARY KEY, idle_timeout_minutes INTEGER NOT NULL, absolute_timeout_hours INTEGER NOT NULL, updated_by TEXT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pxm_service_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_id TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NULL,
        updated_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pxm_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
        allowed_workflow_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        ip_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb,
        rate_limit_per_minute INTEGER NULL,
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TIMESTAMPTZ NULL,
        last_used_at TIMESTAMPTZ NULL,
        created_by TEXT NULL,
        updated_by TEXT NULL,
        disabled_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pxm_api_key_usage_logs (
        id TEXT PRIMARY KEY,
        api_key_id TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        workflow_id TEXT NULL,
        instance_id TEXT NULL,
        request_id TEXT NULL,
        ip TEXT NULL,
        user_agent TEXT NULL,
        business_actor JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`ALTER TABLE pxm_api_keys ADD COLUMN IF NOT EXISTS ip_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await this.pool.query(`ALTER TABLE pxm_api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER NULL`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_pxm_users_group_ids ON pxm_users USING GIN (group_ids)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_pxm_service_accounts_group ON pxm_service_accounts (group_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_pxm_api_keys_group_status ON pxm_api_keys (group_id, status)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_pxm_usage_logs_key_created ON pxm_api_key_usage_logs (api_key_id, created_at DESC)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_pxm_usage_logs_group_created ON pxm_api_key_usage_logs (group_id, created_at DESC)`);
    this.authzTablesReady = true;
  }
}

function mapInputPresetRow(row: any): WorkflowInputPreset {
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    alias: row.alias,
    name: row.name,
    description: row.description || '',
    values: row.values || {},
    scope: row.scope || 'private',
    group_id: row.group_id || null,
    shared_group_ids: Array.isArray(row.shared_group_ids) ? row.shared_group_ids : [],
    enabled: row.enabled !== false,
    created_by: row.created_by || null,
    updated_by: row.updated_by || null,
    created_at: row.created_at?.toISOString?.() || row.created_at,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

function mapGroupRow(row: any): PxmGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    status: row.status || 'active',
    created_by: row.created_by || null,
    updated_by: row.updated_by || null,
    deleted_at: row.deleted_at?.toISOString?.() || row.deleted_at || null,
    created_at: row.created_at?.toISOString?.() || row.created_at,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

function mapUserRow(row: any): PxmUser {
  const groupIds = Array.isArray(row.group_ids) ? row.group_ids : [];
  const memberships =
    Array.isArray(row.memberships) && row.memberships.length > 0
      ? row.memberships.filter((item: any) => item?.group_id && (item.role === 'group_manager' || item.role === 'user'))
      : groupIds.map((group_id: string) => ({
          group_id,
          role: row.role === 'group_manager' ? ('group_manager' as const) : ('user' as const),
        }));
  return {
    id: row.id,
    display_name: row.display_name,
    email: row.email || null,
    role: row.role || 'user',
    group_ids: memberships.map((membership: any) => membership.group_id),
    memberships,
    status: row.status || 'active',
    created_by: row.created_by || null,
    updated_by: row.updated_by || null,
    created_at: row.created_at?.toISOString?.() || row.created_at,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

function mapSessionRow(row: any): PxmSession {
  const iso = (v: any) => v?.toISOString?.() || v;
  return {
    id: row.id,
    token_hash: row.token_hash,
    csrf_hash: row.csrf_hash,
    user_id: row.user_id,
    ip: row.ip || null,
    user_agent: row.user_agent || null,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at),
    idle_expires_at: iso(row.idle_expires_at),
    absolute_expires_at: iso(row.absolute_expires_at),
    idle_timeout_minutes: Number(row.idle_timeout_minutes) || undefined,
    revoked_at: iso(row.revoked_at) || null,
    revoke_reason: row.revoke_reason || null,
  };
}

function mapSessionSecurityPolicyRow(row: any): PxmSessionSecurityPolicy {
  return {
    idle_timeout_minutes: Number(row.idle_timeout_minutes),
    absolute_timeout_hours: Number(row.absolute_timeout_hours),
    updated_by: row.updated_by || null,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

function mapServiceAccountRow(row: any): PxmServiceAccount {
  return {
    id: row.id,
    name: row.name,
    group_id: row.group_id,
    description: row.description || '',
    status: row.status || 'active',
    created_by: row.created_by || null,
    updated_by: row.updated_by || null,
    created_at: row.created_at?.toISOString?.() || row.created_at,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

function mapApiKeyRow(row: any): PxmApiKey {
  return {
    id: row.id,
    name: row.name,
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    group_id: row.group_id,
    key_prefix: row.key_prefix,
    key_hash: row.key_hash,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    allowed_workflow_ids: Array.isArray(row.allowed_workflow_ids) ? row.allowed_workflow_ids : [],
    ip_allowlist: Array.isArray(row.ip_allowlist) ? row.ip_allowlist : [],
    rate_limit_per_minute: Number(row.rate_limit_per_minute) > 0 ? Number(row.rate_limit_per_minute) : null,
    status: row.status || 'active',
    expires_at: row.expires_at?.toISOString?.() || row.expires_at || null,
    last_used_at: row.last_used_at?.toISOString?.() || row.last_used_at || null,
    created_by: row.created_by || null,
    disabled_at: row.disabled_at?.toISOString?.() || row.disabled_at || null,
    created_at: row.created_at?.toISOString?.() || row.created_at,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at,
  };
}

function mapApiKeyUsageLogRow(row: any): PxmApiKeyUsageLog {
  return {
    id: row.id,
    api_key_id: row.api_key_id,
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    group_id: row.group_id,
    endpoint: row.endpoint,
    workflow_id: row.workflow_id || null,
    instance_id: row.instance_id || null,
    request_id: row.request_id || null,
    ip: row.ip || null,
    user_agent: row.user_agent || null,
    business_actor: row.business_actor || null,
    created_at: row.created_at?.toISOString?.() || row.created_at,
  };
}

function slugifyPresetAlias(value: string): string {
  const alias = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return alias || `preset-${Date.now()}`;
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

function normalizeAccess(ctx: any, access?: WorkflowInstanceAccess): WorkflowInstanceAccess | null {
  const existing = ctx?.runtime?.access || {};
  const merged = {
    ...existing,
    ...(access || {}),
  };
  if (!merged.workspace_id && !merged.group_id && !merged.requester_id && !merged.client_id && !merged.approver_ids && !merged.caller && !merged.business_actor && !merged.workflow_version_id) {
    return null;
  }
  return {
    workspace_id: merged.workspace_id || 'default',
    group_id: merged.group_id || null,
    requester_id: merged.requester_id || null,
    client_id: merged.client_id || null,
    approver_ids: Array.isArray(merged.approver_ids) ? merged.approver_ids : [],
    caller: merged.caller || null,
    business_actor: merged.business_actor || null,
    workflow_version_id: merged.workflow_version_id || null,
  };
}

function applyAccessToContext(ctx: any, access: WorkflowInstanceAccess): any {
  return {
    ...ctx,
    runtime: {
      ...(ctx?.runtime || {}),
      access,
    },
  };
}

function accessProjection(row: any): WorkflowInstanceAccess {
  const access = row.context?.runtime?.access || {};
  return {
    workspace_id: access.workspace_id || 'default',
    group_id: access.group_id || null,
    requester_id: access.requester_id || null,
    client_id: access.client_id || null,
    approver_ids: Array.isArray(access.approver_ids) ? access.approver_ids : [],
    caller: access.caller || null,
    business_actor: access.business_actor || null,
    workflow_version_id: access.workflow_version_id || null,
  };
}

function buildPostgresHistoryScope(actor?: WorkflowHistoryActor): {
  where: string;
  params: any[];
} {
  if (!actor || actor.roles.includes('admin')) {
    return { where: '', params: [] };
  }

  const clauses: string[] = [];
  const params: any[] = [];
  const actorId = actor.actor_id;

  const addParam = (value: any) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (actor.roles.includes('operator')) {
    const workspaceIds = actor.workspace_ids.length ? actor.workspace_ids : ['default'];
    const param = addParam(workspaceIds);
    clauses.push(`COALESCE(i.context->'runtime'->'access'->>'workspace_id', 'default') = ANY(${param}::text[])`);
  }

  const manageableGroups = actorManagerGroupIds(actor);
  if (manageableGroups.length > 0) {
    const param = addParam(manageableGroups);
    clauses.push(`COALESCE(i.context->'runtime'->'access'->>'group_id', '') = ANY(${param}::text[])`);
  }

  if (actor.roles.includes('workflow_owner') && actor.owned_workflow_ids.length > 0) {
    const param = addParam(actor.owned_workflow_ids);
    clauses.push(`i.process_definition_id::text = ANY(${param}::text[])`);
  }

  const isSessionUser = !actor.api_key_id && actor.roles.includes('user');
  if (actorId && (actor.roles.includes('requester') || isSessionUser)) {
    const param = addParam(actorId);
    clauses.push(`i.context->'runtime'->'access'->>'requester_id' = ${param}`);
  }

  if (actorId && actor.roles.includes('approver')) {
    const param = addParam(actorId);
    clauses.push(`COALESCE(i.context->'runtime'->'access'->'approver_ids', '[]'::jsonb) ? ${param}`);
  }

  if (actor.roles.includes('api_client')) {
    if (actorId) {
      const param = addParam(actorId);
      clauses.push(`i.context->'runtime'->'access'->>'client_id' = ${param}`);
    }
    if (actor.allowed_instance_ids.length > 0) {
      const param = addParam(actor.allowed_instance_ids);
      clauses.push(`i.id::text = ANY(${param}::text[])`);
    }
    if (actor.allowed_workflow_ids.length > 0) {
      const param = addParam(actor.allowed_workflow_ids);
      clauses.push(`i.process_definition_id::text = ANY(${param}::text[])`);
    }
  }

  if ((actor.roles.includes('user') || actor.actor_type === 'service_account') && (actor.scopes || []).includes('workflow:read') && actor.allowed_workflow_ids.length > 0) {
    const param = addParam(actor.allowed_workflow_ids);
    clauses.push(`i.process_definition_id::text = ANY(${param}::text[])`);
  }

  return clauses.length > 0
    ? {
        where: `WHERE ${clauses.map((clause) => `(${clause})`).join(' OR ')}`,
        params,
      }
    : { where: 'WHERE false', params: [] };
}

function actorManagerGroupIds(actor: WorkflowHistoryActor): string[] {
  if (actor.group_roles) {
    return Object.entries(actor.group_roles)
      .filter(([, role]) => role === 'group_manager')
      .map(([groupId]) => groupId);
  }
  return actor.roles.includes('group_manager') ? actor.group_ids || [] : [];
}

function taskCompletion(command: CompleteWorkflowTaskCommand, completedAt: string) {
  return {
    action: command.action,
    actor_id: command.actor_id,
    api_key_id: command.api_key_id || null,
    business_actor: command.business_actor || null,
    comment: command.comment || null,
    result: command.result || null,
    idempotency_key: command.idempotency_key || null,
    completed_at: completedAt,
  };
}

function sameTaskCompletion(completion: any, command: CompleteWorkflowTaskCommand): boolean {
  return Boolean(command.idempotency_key && completion?.idempotency_key === command.idempotency_key && completion?.actor_id === command.actor_id && completion?.action === command.action);
}

function mapTaskHistoryPostgres(task: any): WorkflowTaskHistoryItem {
  const completion = task.payload?.completion || task.completion || null;
  const external = task.payload?.external_approval || null;
  const node = (task.definition_nodes || []).find((item: any) => item.node_id === task.node_id);
  return {
    task_id: String(task.id),
    instance_id: String(task.instance_id),
    workflow_id: task.process_definition_id ? String(task.process_definition_id) : null,
    workflow_name: task.context?.template_name || task.workflow_name || null,
    workflow_version: task.workflow_version_id || task.workflow_version || null,
    group_id: task.group_id ? String(task.group_id) : null,
    node_id: String(task.node_id),
    node_label: node?.config?.label || node?.config?.ui_node?.data?.label || task.node_id || null,
    status: task.status,
    approver_channel: task.payload?.approver_channel === 'external_email' ? 'external_email' : 'pxm_user',
    assignee: String(task.assignee),
    action: completion?.action === 'approve' || completion?.action === 'reject' ? completion.action : null,
    comment: typeof completion?.comment === 'string' ? completion.comment : null,
    result: completion?.result && typeof completion.result === 'object' ? completion.result : null,
    authentication_method: external?.auth_method || (completion?.api_key_id ? 'api_key' : completion ? 'pxm_session' : null),
    delivery_status: external?.delivery_status || null,
    delivery_attempt_count: Number(external?.attempt_count || 0),
    delivery_last_error: typeof external?.last_error === 'string' ? external.last_error : null,
    link_expires_at: external?.token_expires_at ? String(external.token_expires_at) : null,
    created_at: new Date(task.created_at).toISOString(),
    updated_at: new Date(task.updated_at || task.created_at).toISOString(),
    completed_at: completion?.completed_at ? new Date(completion.completed_at).toISOString() : null,
  };
}
