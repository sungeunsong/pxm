import { Inject, Injectable } from '@nestjs/common';
import { Db } from 'mongodb';
import { MONGO_DB } from '../mongo.provider';
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
  WorkflowHistoryActor,
  WorkflowInstanceAccess,
  WorkflowDefinitionVersion,
  WorkflowInputPreset,
  WorkflowInputPresetRepositoryPort,
  UpsertWorkflowInputPreset,
} from '../ports/db.ports';

@Injectable()
export class MongodbAdapter
  implements
    WorkflowRepositoryPort,
    WorkflowInstanceRepositoryPort,
    WorkflowTaskRepositoryPort,
    OutboxRepositoryPort,
    EngineQueueRepositoryPort,
    WorkflowScheduleRepositoryPort,
    WorkflowInputPresetRepositoryPort
{
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}
  private inputPresetIndexesReady = false;

  private async loadNodeLabels(instanceId: string): Promise<Map<string, string>> {
    const inst = await this.db
      .collection<any>('v2_process_instances')
      .findOne({ _id: instanceId });
    if (!inst?.process_definition_id) {
      return new Map();
    }

    const def = await this.db
      .collection<any>('v2_process_definitions')
      .findOne({ _id: inst.process_definition_id });

    return new Map(
      (def?.nodes || []).map((node: any) => [
        node.node_id,
        node.config?.label ||
          node.config?.ui_node?.data?.label ||
          node.label ||
          node.node_id,
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
    const formattedNodes = nodes.map((n) => ({
      node_id: n.id,
      node_type: n.data?.nodeType || 'task',
      config: {
        ...(n.data || {}),
        ui_node: n,
      },
    }));

    const formattedEdges = edges.map((e, idx) => ({
      id: e.id || crypto.randomUUID(),
      source_node_id: e.source,
      target_node_id: e.target,
      condition_expr: e.data?.condition || null,
      is_default: e.data?.isDefault || false,
      eval_order: idx,
      ui_edge: e,
    }));

    const now = new Date().toISOString();
    const existing = await this.db
      .collection<any>('v2_process_definitions')
      .findOne({ _id: id }, { projection: { version: 1 } });
    const nextVersion = Number(existing?.version || 0) + 1;

    await this.db.collection<any>('v2_process_definitions').updateOne(
      { _id: id },
      {
        $set: {
          name,
          status: 'ACTIVE',
          version: nextVersion,
          description: metadata.description || '',
          group: metadata.group || '',
          tags: metadata.tags || [],
          version_note: metadata.version_note || '',
          metadata,
          nodes: formattedNodes,
          edges: formattedEdges,
          updated_at: now,
        },
        $setOnInsert: {
          created_at: now,
        },
      },
      { upsert: true },
    );

    await this.db.collection<any>('v2_process_definition_versions').insertOne({
      _id: `${id}:${nextVersion}`,
      definition_id: id,
      version: nextVersion,
      name,
      description: metadata.description || '',
      group: metadata.group || '',
      tags: metadata.tags || [],
      version_note: metadata.version_note || '',
      metadata,
      nodes: formattedNodes,
      edges: formattedEdges,
      created_at: now,
      updated_at: now,
    });
  }

  async listDefinitions(): Promise<any[]> {
    const docs = await this.db
      .collection<any>('v2_process_definitions')
      .find({ status: { $ne: 'DELETED' } })
      .sort({ created_at: -1 })
      .toArray();

    return docs.map((doc) => ({
      id: doc._id,
      name: doc.name,
      description: doc.description || doc.metadata?.description || '',
      group: doc.group || doc.metadata?.group || '',
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      metadata: doc.metadata || {},
      version: doc.version || 1,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }));
  }

  async getDefinition(id: string): Promise<any> {
    const doc = await this.db
      .collection<any>('v2_process_definitions')
      .findOne({ _id: id, status: { $ne: 'DELETED' } });

    if (!doc) return null;

    return {
      id: doc._id,
      name: doc.name,
      description: doc.description || doc.metadata?.description || '',
      group: doc.group || doc.metadata?.group || '',
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      metadata: doc.metadata || {},
      version: doc.version || 1,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      nodes: (doc.nodes || []).map(
        (n: any) =>
          n.config?.ui_node || {
            id: n.node_id,
            data: n.config || {},
          },
      ),
      edges: (doc.edges || []).map(
        (e: any) =>
          e.ui_edge || {
            id: e.id,
            source: e.source_node_id,
            target: e.target_node_id,
            data: {
              condition: e.condition_expr,
              isDefault: e.is_default,
            },
          },
      ),
    };
  }

  async listDefinitionVersions(id: string): Promise<WorkflowDefinitionVersion[]> {
    const docs = await this.db
      .collection<any>('v2_process_definition_versions')
      .find({ definition_id: id })
      .sort({ version: -1 })
      .toArray();

    return docs.map((doc) => ({
      definition_id: doc.definition_id,
      version: doc.version,
      name: doc.name,
      description: doc.description || doc.metadata?.description || '',
      group: doc.group || doc.metadata?.group || '',
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      node_count: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
      edge_count: Array.isArray(doc.edges) ? doc.edges.length : 0,
    }));
  }

  async getDefinitionVersion(id: string, version: number): Promise<any> {
    const doc = await this.db
      .collection<any>('v2_process_definition_versions')
      .findOne({ definition_id: id, version });

    return doc ? this.mapDefinitionDocument(doc) : null;
  }

  async restoreDefinitionVersion(
    id: string,
    version: number,
    metadata: WorkflowDefinitionMetadata = {},
  ): Promise<any> {
    const snapshot = await this.getDefinitionVersion(id, version);
    if (!snapshot) return null;

    await this.createDefinition(
      id,
      snapshot.name,
      snapshot.nodes || [],
      snapshot.edges || [],
      {
        ...(snapshot.metadata || {}),
        ...metadata,
        version_note:
          metadata.version_note ||
          `Rollback to v${version}${snapshot.version_note ? `: ${snapshot.version_note}` : ''}`,
      },
    );

    return this.getDefinition(id);
  }

  async deleteDefinition(id: string): Promise<boolean> {
    const result = await this.db.collection<any>('v2_process_definitions').updateOne(
      { _id: id, status: { $ne: 'DELETED' } },
      {
        $set: {
          status: 'DELETED',
          updated_at: new Date().toISOString(),
        },
      },
    );

    return result.matchedCount > 0;
  }

  private mapDefinitionDocument(doc: any): any {
    return {
      id: doc.definition_id || doc._id,
      definition_id: doc.definition_id || doc._id,
      name: doc.name,
      description: doc.description || doc.metadata?.description || '',
      group: doc.group || doc.metadata?.group || '',
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      metadata: doc.metadata || {},
      version: doc.version || 1,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      nodes: (doc.nodes || []).map(
        (n: any) =>
          n.config?.ui_node || {
            id: n.node_id,
            data: n.config || {},
          },
      ),
      edges: (doc.edges || []).map(
        (e: any) =>
          e.ui_edge || {
            id: e.id,
            source: e.source_node_id,
            target: e.target_node_id,
            data: {
              condition: e.condition_expr,
              isDefault: e.is_default,
            },
          },
      ),
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
    access?: WorkflowInstanceAccess,
  ): Promise<void> {
    const now = new Date().toISOString();
    const normalizedAccess = normalizeAccess(ctx, access);
    await this.db.collection<any>('v2_process_instances').insertOne({
      _id: id,
      process_definition_id: definitionId,
      state: status,
      status: status,
      context: normalizedAccess ? applyAccessToContext(ctx, normalizedAccess) : ctx,
      workspace_id: normalizedAccess?.workspace_id,
      requester_id: normalizedAccess?.requester_id,
      client_id: normalizedAccess?.client_id,
      approver_ids: normalizedAccess?.approver_ids || [],
      lock_owner: null,
      lock_until: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });
  }

  async listInstances(actor?: WorkflowHistoryActor): Promise<any[]> {
    const instances = await this.db
      .collection<any>('v2_process_instances')
      .find(buildMongoHistoryFilter(actor))
      .sort({ created_at: -1 })
      .limit(50)
      .toArray();

    const result: any[] = [];
    for (const inst of instances) {
      let templateName = 'Unknown';
      if (inst.process_definition_id) {
        const def = await this.db
          .collection<any>('v2_process_definitions')
          .findOne({ _id: inst.process_definition_id });
        if (def) {
          templateName = def.name;
        }
      }

      result.push({
        id: inst._id,
        definition_id: inst.process_definition_id,
        state: inst.state,
        status: inst.state || inst.status,
        context: inst.context,
        workspace_id: inst.workspace_id || inst.context?.runtime?.access?.workspace_id || 'default',
        requester_id: inst.requester_id || inst.context?.runtime?.access?.requester_id || null,
        client_id: inst.client_id || inst.context?.runtime?.access?.client_id || null,
        approver_ids: inst.approver_ids || inst.context?.runtime?.access?.approver_ids || [],
        created_at: inst.created_at,
        updated_at: inst.updated_at,
        template_name: templateName,
        template_id: inst.process_definition_id,
        ctx: inst.context,
      });
    }
    return result;
  }

  async listChildInstances(parentInstanceId: string): Promise<any[]> {
    const children = await this.db
      .collection<any>('v2_process_instances')
      .find({ 'context.runtime.parent_instance_id': parentInstanceId })
      .toArray();

    return children.map((inst) => ({
      id: inst._id,
      definition_id: inst.process_definition_id,
      state: inst.state,
      status: inst.state || inst.status,
      context: inst.context,
      workspace_id: inst.workspace_id || inst.context?.runtime?.access?.workspace_id || 'default',
      requester_id: inst.requester_id || inst.context?.runtime?.access?.requester_id || null,
      client_id: inst.client_id || inst.context?.runtime?.access?.client_id || null,
      approver_ids: inst.approver_ids || inst.context?.runtime?.access?.approver_ids || [],
      created_at: inst.created_at,
      updated_at: inst.updated_at,
      template_id: inst.process_definition_id,
      ctx: inst.context,
    }));
  }

  async getInstance(id: string): Promise<any> {
    const inst = await this.db
      .collection<any>('v2_process_instances')
      .findOne({ _id: id });

    if (!inst) return null;

    return {
      id: inst._id,
      definition_id: inst.process_definition_id,
      state: inst.state,
      status: inst.state || inst.status,
      context: inst.context,
      workspace_id: inst.workspace_id || inst.context?.runtime?.access?.workspace_id || 'default',
      requester_id: inst.requester_id || inst.context?.runtime?.access?.requester_id || null,
      client_id: inst.client_id || inst.context?.runtime?.access?.client_id || null,
      approver_ids: inst.approver_ids || inst.context?.runtime?.access?.approver_ids || [],
      created_at: inst.created_at,
      updated_at: inst.updated_at,
      template_id: inst.process_definition_id,
      ctx: inst.context,
    };
  }

  async updateInstanceStatus(id: string, status: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.collection<any>('v2_process_instances').updateOne(
      { _id: id },
      {
        $set: {
          state: status,
          status: status,
          updated_at: now,
        },
      },
    );
  }

  async updateInstanceCtx(id: string, ctx: any): Promise<void> {
    const now = new Date().toISOString();
    await this.db.collection<any>('v2_process_instances').updateOne(
      { _id: id },
      {
        $set: {
          context: ctx,
          updated_at: now,
        },
      },
    );
  }

  async completeJobsForInstance(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.collection<any>('v2_engine_jobs').updateMany(
      {
        instance_id: id,
        status: { $in: ['QUEUED', 'RUNNING'] },
      },
      {
        $set: {
          status: 'COMPLETED',
          updated_at: now,
        },
      },
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
    const now = new Date().toISOString();
    await this.db.collection<any>('v2_tokens').insertOne({
      _id: token.id,
      instance_id: token.instanceId,
      node_id: token.nodeId,
      status: token.status === 'READY' ? 'ACTIVE' : token.status,
      parent_token_id: token.parentTokenId || null,
      scope_key: token.scopeKey || null,
      created_at: now,
      updated_at: now,
    });
  }

  async createJob(job: {
    instanceId: string;
    tokenId?: string | null;
    type: string;
    runAt: Date;
    payload: any;
  }): Promise<void> {
    const now = new Date().toISOString();
    // Atomic sequence 발급
    const counterDoc = await this.db
      .collection<any>('v2_counters')
      .findOneAndUpdate(
        { _id: 'v2_engine_jobs' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );

    let seq = Date.now();
    if (counterDoc) {
      if ('value' in counterDoc && counterDoc.value) {
        seq = (counterDoc.value as any).seq;
      } else if ('seq' in counterDoc) {
        seq = (counterDoc as any).seq;
      }
    }

    await this.db.collection<any>('v2_engine_jobs').insertOne({
      _id: seq,
      instance_id: job.instanceId,
      token_id: job.tokenId || null,
      job_type: job.type,
      run_at: job.runAt.toISOString(),
      attempt: 0,
      status: 'QUEUED',
      payload: job.payload,
      created_at: now,
      updated_at: now,
    });
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
    const jobs = this.db.collection<any>('v2_engine_jobs');
    const statusRows = await jobs
      .aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();
    const byStatus = Object.fromEntries(
      statusRows.map((row) => [row._id || 'UNKNOWN', row.count]),
    );

    const oldestQueued = await jobs.findOne(
      { status: 'QUEUED' },
      { sort: { run_at: 1, _id: 1 }, projection: { run_at: 1 } },
    );
    const oldestQueuedAt = oldestQueued?.run_at || null;
    const oldestQueuedAgeMs = oldestQueuedAt
      ? Math.max(0, Date.now() - Date.parse(oldestQueuedAt))
      : null;

    const runningWorkers = await jobs
      .aggregate<{
        _id: string | null;
        running_jobs: number;
        last_updated_at: string | null;
      }>([
        { $match: { status: 'RUNNING' } },
        {
          $group: {
            _id: '$lock_owner',
            running_jobs: { $sum: 1 },
            last_updated_at: { $max: '$updated_at' },
          },
        },
        { $sort: { running_jobs: -1 } },
      ])
      .toArray();

    const maxAttemptRow = await jobs
      .aggregate<{ _id: null; max_attempt: number }>([
        { $group: { _id: null, max_attempt: { $max: '$attempt' } } },
      ])
      .next();
    const workerHeartbeats = await this.db
      .collection<any>('v2_process_instances')
      .aggregate<{
        _id: string | null;
        last_heartbeat_at: string | null;
        locked_instances: number;
      }>([
        { $match: { lock_owner: { $ne: null } } },
        {
          $group: {
            _id: '$lock_owner',
            last_heartbeat_at: { $max: '$heartbeat_at' },
            locked_instances: { $sum: 1 },
          },
        },
        { $sort: { locked_instances: -1 } },
      ])
      .toArray();

    return {
      by_status: byStatus,
      queued: byStatus.QUEUED || 0,
      running: byStatus.RUNNING || 0,
      failed: byStatus.FAILED || 0,
      completed: byStatus.COMPLETED || 0,
      oldest_queued_at: oldestQueuedAt,
      oldest_queued_age_ms: oldestQueuedAgeMs,
      running_workers: runningWorkers.map((row) => ({
        worker_id: row._id || 'unknown',
        running_jobs: row.running_jobs,
        last_updated_at: row.last_updated_at || null,
      })),
      worker_heartbeats: workerHeartbeats.map((row) => ({
        worker_id: row._id || 'unknown',
        last_heartbeat_at: row.last_heartbeat_at || null,
        locked_instances: row.locked_instances,
      })),
      max_attempt: maxAttemptRow?.max_attempt || 0,
    };
  }

  async replaceDefinitionSchedules(
    definitionId: string,
    jobs: WorkflowScheduleJob[],
  ): Promise<void> {
    const now = new Date().toISOString();
    const collection = this.db.collection<any>('v2_schedule_jobs');
    const activeIds = jobs.map((job) => job.id);

    await collection.updateMany(
      {
        definition_id: definitionId,
        ...(activeIds.length ? { _id: { $nin: activeIds } } : {}),
      },
      {
        $set: {
          active: false,
          status: 'DISABLED',
          updated_at: now,
        },
      },
    );

    for (const job of jobs) {
      await collection.updateOne(
        { _id: job.id },
        {
          $set: {
            definition_id: job.definitionId,
            definition_name: job.definitionName,
            start_node_id: job.startNodeId,
            schedule_type: job.scheduleType,
            interval_seconds: job.intervalSeconds ?? null,
            cron_expression: job.cronExpression ?? null,
            input: job.input || {},
            next_run_at: job.nextRunAt.toISOString(),
            active: job.active,
            status: job.active ? 'WAITING' : 'DISABLED',
            lock_owner: null,
            locked_until: null,
            updated_at: now,
          },
          $setOnInsert: {
            last_run_at: null,
            last_instance_id: null,
            last_error: null,
            created_at: now,
          },
        },
        { upsert: true },
      );
    }
  }

  async claimDueSchedules(
    now: Date,
    owner: string,
    limit: number,
  ): Promise<WorkflowScheduleJob[]> {
    const collection = this.db.collection<any>('v2_schedule_jobs');
    const claimed: WorkflowScheduleJob[] = [];
    const nowIso = now.toISOString();
    const lockedUntil = new Date(now.getTime() + 60_000).toISOString();

    for (let i = 0; i < limit; i += 1) {
      const result = await collection.findOneAndUpdate(
        {
          active: true,
          status: 'WAITING',
          next_run_at: { $lte: nowIso },
          $or: [
            { locked_until: null },
            { locked_until: { $lt: nowIso } },
            { lock_owner: owner },
          ],
        },
        {
          $set: {
            status: 'RUNNING',
            lock_owner: owner,
            locked_until: lockedUntil,
            updated_at: nowIso,
          },
        },
        {
          sort: { next_run_at: 1, _id: 1 },
          returnDocument: 'after',
        },
      );

      const doc = (result as any)?.value || result;
      if (!doc?._id) break;
      claimed.push(mapScheduleDoc(doc));
    }

    return claimed;
  }

  async markScheduleSuccess(
    id: string,
    nextRunAt: Date,
    instanceId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const current = await this.db.collection<any>('v2_schedule_jobs').findOne({ _id: id });
    await this.db.collection<any>('v2_schedule_jobs').updateOne(
      { _id: id },
      {
        $set: {
          status: 'WAITING',
          next_run_at: nextRunAt.toISOString(),
          last_run_at: now,
          last_instance_id: instanceId,
          last_error: null,
          lock_owner: null,
          locked_until: null,
          updated_at: now,
        },
      },
    );
    await this.db.collection<any>('v2_schedule_runs').insertOne({
      _id: crypto.randomUUID(),
      schedule_job_id: id,
      definition_id: current?.definition_id || '',
      instance_id: instanceId,
      scheduled_for: current?.next_run_at || now,
      fired_at: now,
      status: 'STARTED',
      error: null,
      created_at: now,
    });
  }

  async markScheduleFailure(
    id: string,
    error: string,
    nextRunAt: Date,
  ): Promise<void> {
    const now = new Date().toISOString();
    const current = await this.db.collection<any>('v2_schedule_jobs').findOne({ _id: id });
    await this.db.collection<any>('v2_schedule_jobs').updateOne(
      { _id: id },
      {
        $set: {
          status: 'WAITING',
          next_run_at: nextRunAt.toISOString(),
          last_error: error,
          lock_owner: null,
          locked_until: null,
          updated_at: now,
        },
      },
    );
    await this.db.collection<any>('v2_schedule_runs').insertOne({
      _id: crypto.randomUUID(),
      schedule_job_id: id,
      definition_id: current?.definition_id || '',
      instance_id: null,
      scheduled_for: current?.next_run_at || now,
      fired_at: now,
      status: 'FAILED',
      error,
      created_at: now,
    });
  }

  async getDefinitionScheduleStatus(
    definitionId: string,
    limit = 10,
  ): Promise<WorkflowScheduleStatus> {
    const jobDoc = await this.db
      .collection<any>('v2_schedule_jobs')
      .findOne({ definition_id: definitionId }, { sort: { updated_at: -1 } });
    const runs = await this.db
      .collection<any>('v2_schedule_runs')
      .find({ definition_id: definitionId })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    return {
      job: jobDoc ? mapScheduleDoc(jobDoc) : null,
      runs: runs.map((doc) => ({
        id: doc._id,
        scheduleJobId: doc.schedule_job_id,
        definitionId: doc.definition_id,
        instanceId: doc.instance_id || null,
        scheduledFor: doc.scheduled_for,
        firedAt: doc.fired_at,
        status: doc.status,
        error: doc.error || null,
        createdAt: doc.created_at,
      })),
    };
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
    const now = new Date().toISOString();
    await this.db.collection<any>('v2_tasks').insertOne({
      _id: id,
      instance_id: instanceId,
      token_id: null,
      node_id: nodeId,
      assignee: assignee,
      status: status,
      payload: payload,
      created_at: now,
      updated_at: now,
    });
  }

  async listTasks(assignee = 'admin'): Promise<any[]> {
    const tasks = await this.db
      .collection<any>('v2_tasks')
      .find({ assignee, status: 'OPEN' })
      .sort({ created_at: -1 })
      .toArray();

    const result: any[] = [];
    for (const t of tasks) {
      const inst = await this.db
        .collection<any>('v2_process_instances')
        .findOne({ _id: t.instance_id });

      result.push({
        id: t._id,
        instance_id: t.instance_id,
        token_id: t.token_id,
        node_id: t.node_id,
        assignee: t.assignee,
        status: t.status,
        payload: t.payload,
        process_definition_id: inst?.process_definition_id || null,
        template_name: inst?.context?.template_name || null,
        instance_status: inst?.status || null,
        created_at: t.created_at,
        updated_at: t.updated_at,
        form_data: inst?.context?.data?.formData || inst?.context?.formData || {},
      });
    }

    return result;
  }

  async getTask(id: string): Promise<any> {
    const t = await this.db.collection<any>('v2_tasks').findOne({ _id: id });
    if (!t) return null;
    return {
      id: t._id,
      instance_id: t.instance_id,
      token_id: t.token_id,
      node_id: t.node_id,
      assignee: t.assignee,
      status: t.status,
      payload: t.payload,
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  async updateTaskStatus(id: string, status: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.collection<any>('v2_tasks').updateOne(
      { _id: id },
      {
        $set: {
          status: status,
          updated_at: now,
        },
      },
    );
  }

  async fetchAfter(
    instanceId: string,
    afterId: number,
    limit = 100,
  ): Promise<any[]> {
    const nodeLabels = await this.loadNodeLabels(instanceId);
    const [logs, outbox] = await Promise.all([
      this.db
        .collection<any>('v2_execution_logs')
        .find({ instance_id: instanceId })
        .sort({ created_at: 1 })
        .toArray(),
      this.db
        .collection<any>('v2_event_outbox')
        .find({ instance_id: instanceId })
        .sort({ created_at: 1 })
        .toArray(),
    ]);

    return [
      ...logs.map((doc) => ({ ...doc, source: 'execution_log' })),
      ...outbox.map((doc) => ({ ...doc, source: 'outbox' })),
    ]
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((doc, idx) => {
        const nodeId = doc.node_id || doc.payload?.node_id || null;
        return {
          id: idx + 1,
          source: doc.source,
          instance_id: doc.instance_id,
          token_id: doc.token_id || null,
          node_id: nodeId,
          node_label: nodeId ? nodeLabels.get(nodeId) || nodeId : null,
          event_type: doc.event_type,
          type: doc.event_type,
          payload: doc.payload || {},
          created_at: doc.created_at,
        };
      })
      .filter((item) => item.id > afterId)
      .slice(0, limit);
  }

  async fetchTrace(instanceId: string, limit = 200): Promise<any[]> {
    const nodeLabels = await this.loadNodeLabels(instanceId);
    const [logs, outbox] = await Promise.all([
      this.db
        .collection<any>('v2_execution_logs')
        .find({ instance_id: instanceId })
        .sort({ created_at: 1 })
        .limit(limit)
        .toArray(),
      this.db
        .collection<any>('v2_event_outbox')
        .find({ instance_id: instanceId })
        .sort({ created_at: 1 })
        .limit(limit)
        .toArray(),
    ]);

    return [
      ...logs.map((doc) => ({ ...doc, source: 'execution_log' })),
      ...outbox.map((doc) => ({ ...doc, source: 'outbox' })),
    ]
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(0, limit)
      .map((doc, idx) => {
        const nodeId = doc.node_id || doc.payload?.node_id || null;
        return {
          id: idx + 1,
          source: doc.source,
          instance_id: doc.instance_id,
          token_id: doc.token_id || null,
          node_id: nodeId,
          node_label: nodeId ? nodeLabels.get(nodeId) || nodeId : null,
          event_type: doc.event_type,
          type: doc.event_type,
          payload: doc.payload || {},
          created_at: doc.created_at,
        };
      });
  }

  async appendEvent(
    instanceId: string,
    eventType: string,
    payload: any,
  ): Promise<any> {
    const now = new Date().toISOString();
    const result = await this.db.collection<any>('v2_event_outbox').insertOne({
      instance_id: instanceId,
      token_id: null,
      node_id: null,
      event_type: eventType,
      payload: payload,
      created_at: now,
    });
    return { ok: true, id: result.insertedId.toString() };
  }

  async listInputPresets(workflowId: string): Promise<WorkflowInputPreset[]> {
    await this.ensureInputPresetIndexes();
    const docs = await this.db
      .collection<any>('workflow_input_presets')
      .find({ workflow_id: workflowId, enabled: { $ne: false } })
      .sort({ updated_at: -1 })
      .toArray();

    return docs.map(mapInputPresetDoc);
  }

  async getInputPreset(workflowId: string, idOrAlias: string): Promise<WorkflowInputPreset | null> {
    await this.ensureInputPresetIndexes();
    const doc = await this.db.collection<any>('workflow_input_presets').findOne({
      workflow_id: workflowId,
      enabled: { $ne: false },
      $or: [{ _id: idOrAlias }, { alias: idOrAlias }],
    });

    return doc ? mapInputPresetDoc(doc) : null;
  }

  async upsertInputPreset(
    workflowId: string,
    preset: UpsertWorkflowInputPreset,
  ): Promise<WorkflowInputPreset> {
    await this.ensureInputPresetIndexes();
    const now = new Date().toISOString();
    const alias = preset.alias || slugifyPresetAlias(preset.name);
    const filter = preset.id
      ? { _id: preset.id, workflow_id: workflowId }
      : { workflow_id: workflowId, alias };
    const id = preset.id || crypto.randomUUID();

    await this.db.collection<any>('workflow_input_presets').updateOne(
      filter,
      {
        $set: {
          workflow_id: workflowId,
          alias,
          name: preset.name.trim(),
          description: preset.description || '',
          values: preset.values || {},
          scope: preset.scope || 'private',
          group_id: preset.group_id || null,
          enabled: true,
          updated_by: preset.actor || null,
          updated_at: now,
        },
        $setOnInsert: {
          _id: id,
          created_by: preset.actor || null,
          created_at: now,
        },
      },
      { upsert: true },
    );

    const saved = await this.db.collection<any>('workflow_input_presets').findOne(
      preset.id ? { _id: preset.id, workflow_id: workflowId } : { workflow_id: workflowId, alias },
    );
    return mapInputPresetDoc(saved);
  }

  async deleteInputPreset(workflowId: string, presetId: string): Promise<boolean> {
    await this.ensureInputPresetIndexes();
    const result = await this.db
      .collection<any>('workflow_input_presets')
      .updateOne(
        { _id: presetId, workflow_id: workflowId },
        { $set: { enabled: false, updated_at: new Date().toISOString() } },
      );
    return result.matchedCount > 0;
  }

  private async ensureInputPresetIndexes(): Promise<void> {
    if (this.inputPresetIndexesReady) return;
    const collection = this.db.collection<any>('workflow_input_presets');
    await collection.createIndex({ workflow_id: 1, alias: 1 }, { unique: true });
    await collection.createIndex({ workflow_id: 1, updated_at: -1 });
    this.inputPresetIndexesReady = true;
  }
}

function mapInputPresetDoc(doc: any): WorkflowInputPreset {
  return {
    id: doc._id,
    workflow_id: doc.workflow_id,
    alias: doc.alias,
    name: doc.name,
    description: doc.description || '',
    values: doc.values || {},
    scope: doc.scope || 'private',
    group_id: doc.group_id || null,
    enabled: doc.enabled !== false,
    created_by: doc.created_by || null,
    updated_by: doc.updated_by || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
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

function mapScheduleDoc(doc: any): WorkflowScheduleJob {
  return {
    id: doc._id,
    definitionId: doc.definition_id,
    definitionName: doc.definition_name,
    startNodeId: doc.start_node_id,
    scheduleType: doc.schedule_type,
    intervalSeconds: doc.interval_seconds ?? null,
    cronExpression: doc.cron_expression ?? null,
    input: doc.input || {},
    nextRunAt: new Date(doc.next_run_at),
    active: Boolean(doc.active),
    status: doc.status || null,
    lastRunAt: doc.last_run_at || null,
    lastInstanceId: doc.last_instance_id || null,
    lastError: doc.last_error || null,
    updatedAt: doc.updated_at || null,
    createdAt: doc.created_at || null,
  };
}

function normalizeAccess(ctx: any, access?: WorkflowInstanceAccess): WorkflowInstanceAccess | null {
  const existing = ctx?.runtime?.access || {};
  const merged = {
    ...existing,
    ...(access || {}),
  };
  if (!merged.workspace_id && !merged.requester_id && !merged.client_id && !merged.approver_ids) {
    return null;
  }
  return {
    workspace_id: merged.workspace_id || 'default',
    requester_id: merged.requester_id || null,
    client_id: merged.client_id || null,
    approver_ids: Array.isArray(merged.approver_ids) ? merged.approver_ids : [],
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

function buildMongoHistoryFilter(actor?: WorkflowHistoryActor): Record<string, any> {
  if (!actor || actor.roles.includes('admin')) {
    return {};
  }

  const or: Record<string, any>[] = [];
  const actorId = actor.actor_id;

  if (actor.roles.includes('operator')) {
    const workspaceIds = actor.workspace_ids.length ? actor.workspace_ids : ['default'];
    or.push({ workspace_id: { $in: workspaceIds } });
    or.push({ 'context.runtime.access.workspace_id': { $in: workspaceIds } });
    if (workspaceIds.includes('default')) {
      or.push({ workspace_id: { $exists: false }, 'context.runtime.access.workspace_id': { $exists: false } });
    }
  }

  if (actor.roles.includes('workflow_owner') && actor.owned_workflow_ids.length > 0) {
    or.push({ process_definition_id: { $in: actor.owned_workflow_ids } });
  }

  if (actorId && actor.roles.includes('requester')) {
    or.push({ requester_id: actorId });
    or.push({ 'context.runtime.access.requester_id': actorId });
  }

  if (actorId && actor.roles.includes('approver')) {
    or.push({ approver_ids: actorId });
    or.push({ 'context.runtime.access.approver_ids': actorId });
  }

  if (actor.roles.includes('api_client')) {
    if (actorId) {
      or.push({ client_id: actorId });
      or.push({ 'context.runtime.access.client_id': actorId });
    }
    if (actor.allowed_instance_ids.length > 0) {
      or.push({ _id: { $in: actor.allowed_instance_ids } });
    }
    if (actor.allowed_workflow_ids.length > 0) {
      or.push({ process_definition_id: { $in: actor.allowed_workflow_ids } });
    }
  }

  return or.length > 0 ? { $or: or } : { _id: '__no_authorized_instances__' };
}
