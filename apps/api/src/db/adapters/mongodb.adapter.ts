import { Inject, Injectable } from '@nestjs/common';
import { ClientSession, Db } from 'mongodb';
import { MONGO_DB } from '../mongo.provider';
import { WorkflowDefinitionMetadata, WorkflowRepositoryPort, WorkflowInstanceRepositoryPort, WorkflowTaskRepositoryPort, OutboxRepositoryPort, EngineQueueRepositoryPort, WorkflowScheduleJob, WorkflowScheduleRepositoryPort, WorkflowScheduleStatus, WorkflowHistoryActor, WorkflowInstanceAccess, WorkflowDefinitionVersion, WorkflowInputPreset, WorkflowInputPresetRepositoryPort, UpsertWorkflowInputPreset, AppendPxmApiKeyUsageLog, AuthzRepositoryPort, CreatePxmApiKey, CreatePxmSession, PxmApiKey, PxmApiKeyUsageLog, PxmGroup, PxmServiceAccount, PxmUser, PxmSession, PxmSessionSecurityPolicy, UpsertPxmGroup, UpsertPxmServiceAccount, UpsertPxmUser, UpsertPxmSessionSecurityPolicy, CompleteWorkflowTaskCommand, CompleteWorkflowTaskResult, ExternalApprovalClaim, ExternalApprovalDeliveryToken, ExternalApprovalOtp, ExternalApprovalTask, WorkflowTaskHistoryItem, WorkflowTaskHistoryPage, WorkflowTaskHistoryQuery, IdempotentWorkflowStart, IdempotentWorkflowStartResult, IdempotentInstanceCommand, IdempotentInstanceCommandResult, ExistingIdempotentInstanceCommandResult, WorkflowInstanceMutation } from '../ports/db.ports';

@Injectable()
export class MongodbAdapter implements WorkflowRepositoryPort, WorkflowInstanceRepositoryPort, WorkflowTaskRepositoryPort, OutboxRepositoryPort, EngineQueueRepositoryPort, WorkflowScheduleRepositoryPort, WorkflowInputPresetRepositoryPort, AuthzRepositoryPort {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}
  private inputPresetIndexesReady = false;
  private authzIndexesReady = false;
  private startIdempotencyIndexesReady = false;
  private instanceCommandIdempotencyIndexesReady = false;

  private async loadNodeLabels(instanceId: string): Promise<Map<string, string>> {
    const inst = await this.db.collection<any>('v2_process_instances').findOne({ _id: instanceId });
    if (!inst?.process_definition_id) {
      return new Map();
    }

    const def = await this.db.collection<any>('v2_process_definitions').findOne({ _id: inst.process_definition_id });

    return new Map((def?.nodes || []).map((node: any) => [node.node_id, node.config?.label || node.config?.ui_node?.data?.label || node.label || node.node_id]));
  }

  // ==========================================
  // WorkflowRepositoryPort 구현 (V2 정의 대응)
  // ==========================================
  async createDefinition(id: string, name: string, nodes: any[], edges: any[], metadata: WorkflowDefinitionMetadata = {}): Promise<void> {
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
    const existing = await this.db.collection<any>('v2_process_definitions').findOne({ _id: id }, { projection: { version: 1, created_by: 1 } });
    const nextVersion = Number(existing?.version || 0) + 1;
    const lifecycleStatus = metadata.lifecycle_status || 'DRAFT';

    await this.db.collection<any>('v2_process_definitions').updateOne(
      { _id: id },
      {
        $set: {
          name,
          status: 'ACTIVE',
          version: nextVersion,
          description: metadata.description || '',
          group: metadata.group || '',
          group_id: metadata.group_id || null,
          tags: metadata.tags || [],
          version_note: metadata.version_note || '',
          metadata,
          lifecycle_status: lifecycleStatus,
          active_published_version: metadata.active_published_version ?? null,
          published_at: metadata.published_at ?? null,
          published_by: metadata.published_by ?? null,
          updated_by: metadata.updated_by || null,
          nodes: formattedNodes,
          edges: formattedEdges,
          updated_at: now,
        },
        $setOnInsert: {
          created_at: now,
          created_by: metadata.created_by || metadata.updated_by || null,
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
      group_id: metadata.group_id || null,
      tags: metadata.tags || [],
      version_note: metadata.version_note || '',
      metadata,
      created_by: metadata.updated_by || metadata.created_by || null,
      updated_by: metadata.updated_by || null,
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
      group_id: doc.group_id || doc.metadata?.group_id || null,
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      metadata: doc.metadata || {},
      version: doc.version || 1,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      created_by: doc.created_by || doc.metadata?.created_by || null,
      updated_by: doc.updated_by || doc.metadata?.updated_by || null,
      lifecycle_status: doc.lifecycle_status || doc.metadata?.lifecycle_status,
      active_published_version: doc.active_published_version ?? doc.metadata?.active_published_version,
      published_at: doc.published_at || doc.metadata?.published_at || null,
      published_by: doc.published_by || doc.metadata?.published_by || null,
    }));
  }

  async getDefinition(id: string): Promise<any> {
    const doc = await this.db.collection<any>('v2_process_definitions').findOne({ _id: id, status: { $ne: 'DELETED' } });

    if (!doc) return null;

    return {
      id: doc._id,
      name: doc.name,
      description: doc.description || doc.metadata?.description || '',
      group: doc.group || doc.metadata?.group || '',
      group_id: doc.group_id || doc.metadata?.group_id || null,
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      metadata: doc.metadata || {},
      version: doc.version || 1,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      created_by: doc.created_by || doc.metadata?.created_by || null,
      updated_by: doc.updated_by || doc.metadata?.updated_by || null,
      lifecycle_status: doc.lifecycle_status || doc.metadata?.lifecycle_status,
      active_published_version: doc.active_published_version ?? doc.metadata?.active_published_version,
      published_at: doc.published_at || doc.metadata?.published_at || null,
      published_by: doc.published_by || doc.metadata?.published_by || null,
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

  async getPublishedDefinition(id: string): Promise<any> {
    const current = await this.getDefinition(id);
    if (!current) return null;
    const status = current.lifecycle_status || 'PUBLISHED';
    if (status !== 'PUBLISHED') return null;
    const version = Number(current.active_published_version || current.version || 1);
    const snapshot = await this.getDefinitionVersion(id, version);
    const published = snapshot || (version === Number(current.version) ? current : null);
    return published
      ? {
          ...published,
          lifecycle_status: status,
          active_published_version: version,
          published_at: current.published_at || null,
          published_by: current.published_by || null,
        }
      : null;
  }

  async setDefinitionLifecycle(id: string, lifecycle: import('../ports/db.ports').WorkflowLifecycleUpdate): Promise<any> {
    const current = await this.getDefinition(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const previousActiveVersion = current.active_published_version ?? null;
    const activeVersion =
      lifecycle.active_published_version ??
      previousActiveVersion ??
      (lifecycle.status === 'PUBLISHED' ? current.version : null);
    await this.db.collection<any>('v2_process_definitions').updateOne(
      { _id: id, status: { $ne: 'DELETED' } },
      {
        $set: {
          lifecycle_status: lifecycle.status,
          active_published_version: activeVersion,
          published_at: lifecycle.status === 'PUBLISHED' ? now : current.published_at || null,
          published_by: lifecycle.status === 'PUBLISHED' ? lifecycle.actor_id || null : current.published_by || null,
          'metadata.lifecycle_status': lifecycle.status,
          'metadata.active_published_version': activeVersion,
          'metadata.published_at': lifecycle.status === 'PUBLISHED' ? now : current.published_at || null,
          'metadata.published_by': lifecycle.status === 'PUBLISHED' ? lifecycle.actor_id || null : current.published_by || null,
          updated_at: now,
        },
      },
    );
    return this.getDefinition(id);
  }

  async listDefinitionVersions(id: string): Promise<WorkflowDefinitionVersion[]> {
    const docs = await this.db.collection<any>('v2_process_definition_versions').find({ definition_id: id }).sort({ version: -1 }).toArray();

    return docs.map((doc) => ({
      definition_id: doc.definition_id,
      version: doc.version,
      name: doc.name,
      description: doc.description || doc.metadata?.description || '',
      group: doc.group || doc.metadata?.group || '',
      group_id: doc.group_id || doc.metadata?.group_id || null,
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      created_by: doc.created_by || doc.metadata?.created_by || null,
      updated_by: doc.updated_by || doc.metadata?.updated_by || null,
      lifecycle_status: doc.lifecycle_status || doc.metadata?.lifecycle_status,
      active_published_version: doc.active_published_version ?? doc.metadata?.active_published_version,
      node_count: Array.isArray(doc.nodes) ? doc.nodes.length : 0,
      edge_count: Array.isArray(doc.edges) ? doc.edges.length : 0,
    }));
  }

  async getDefinitionVersion(id: string, version: number): Promise<any> {
    const doc = await this.db.collection<any>('v2_process_definition_versions').findOne({ definition_id: id, version });

    return doc ? this.mapDefinitionDocument(doc) : null;
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
      group_id: doc.group_id || doc.metadata?.group_id || null,
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      metadata: doc.metadata || {},
      version: doc.version || 1,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      created_by: doc.created_by || doc.metadata?.created_by || null,
      updated_by: doc.updated_by || doc.metadata?.updated_by || null,
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
  async createIdempotentStart(input: IdempotentWorkflowStart): Promise<IdempotentWorkflowStartResult> {
    await this.ensureStartIdempotencyIndexes();
    const session = this.db.client.startSession();
    let result: IdempotentWorkflowStartResult = {
      outcome: 'created',
      instance_id: input.instance.id,
    };

    try {
      await session.withTransaction(async () => {
        const idempotency = this.db.collection<any>('v2_start_idempotency');
        const existing = await idempotency.findOne({ _id: input.key_hash }, { session });
        if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
          result = {
            outcome: existing.request_hash === input.request_hash ? 'replayed' : 'conflict',
            instance_id: existing.instance_id,
          };
          return;
        }
        if (existing) {
          await idempotency.deleteOne({ _id: input.key_hash }, { session });
        }

        const now = new Date().toISOString();
        const normalizedAccess = normalizeAccess(input.instance.context, input.instance.access);
        await idempotency.insertOne(
          {
            _id: input.key_hash,
            request_hash: input.request_hash,
            instance_id: input.instance.id,
            definition_id: input.instance.definition_id,
            expires_at: input.expires_at,
            created_at: new Date(),
          },
          { session },
        );
        await this.db.collection<any>('v2_process_instances').insertOne(
          {
            _id: input.instance.id,
            process_definition_id: input.instance.definition_id,
            state: input.instance.status,
            status: input.instance.status,
            context: normalizedAccess ? applyAccessToContext(input.instance.context, normalizedAccess) : input.instance.context,
            workspace_id: normalizedAccess?.workspace_id,
            group_id: normalizedAccess?.group_id || null,
            requester_id: normalizedAccess?.requester_id,
            client_id: normalizedAccess?.client_id,
            approver_ids: normalizedAccess?.approver_ids || [],
            caller: normalizedAccess?.caller || null,
            business_actor: normalizedAccess?.business_actor || null,
            workflow_version_id: normalizedAccess?.workflow_version_id || null,
            lock_owner: null,
            lock_until: null,
            heartbeat_at: null,
            created_at: now,
            updated_at: now,
          },
          { session },
        );
        const counterDoc = await this.db.collection<any>('v2_counters').findOneAndUpdate(
          { _id: 'v2_engine_jobs' },
          { $inc: { seq: 1 } },
          { upsert: true, returnDocument: 'after', session },
        );
        const jobId = Number((counterDoc as any)?.value?.seq ?? (counterDoc as any)?.seq ?? Date.now());
        await this.db.collection<any>('v2_engine_jobs').insertOne(
          {
            _id: jobId,
            instance_id: input.instance.id,
            token_id: null,
            job_type: input.job.type,
            run_at: input.job.run_at.toISOString(),
            attempt: 0,
            status: 'QUEUED',
            payload: input.job.payload,
            created_at: now,
            updated_at: now,
          },
          { session },
        );
        await this.db.collection<any>('v2_tokens').insertOne(
          {
            _id: input.token.id,
            instance_id: input.instance.id,
            node_id: input.token.node_id,
            status: input.token.status === 'READY' ? 'ACTIVE' : input.token.status,
            parent_token_id: null,
            scope_key: null,
            created_at: now,
            updated_at: now,
          },
          { session },
        );
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  private async ensureStartIdempotencyIndexes(): Promise<void> {
    if (this.startIdempotencyIndexesReady) return;
    await this.db.collection('v2_start_idempotency').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    this.startIdempotencyIndexesReady = true;
  }

  async executeIdempotentCommand(input: IdempotentInstanceCommand): Promise<IdempotentInstanceCommandResult> {
    await this.ensureInstanceCommandIdempotencyIndexes();
    const session = this.db.client.startSession();
    let result: IdempotentInstanceCommandResult = { outcome: 'created', result: input.result };
    try {
      await session.withTransaction(async () => {
        const idempotency = this.db.collection<any>('v2_instance_command_idempotency');
        const existing = await idempotency.findOne({ _id: input.key_hash }, { session });
        if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
          result = {
            outcome: existing.request_hash === input.request_hash ? 'replayed' : 'conflict',
            result: existing.result || {},
          };
          return;
        }
        if (existing) await idempotency.deleteOne({ _id: input.key_hash }, { session });

        const now = new Date().toISOString();
        await idempotency.insertOne(
          {
            _id: input.key_hash,
            request_hash: input.request_hash,
            result: input.result,
            expires_at: input.expires_at,
            created_at: new Date(),
          },
          { session },
        );

        for (const instance of input.create_instances || []) {
          const access = normalizeAccess(instance.context, instance.access);
          await this.db.collection<any>('v2_process_instances').insertOne(
            {
              _id: instance.id,
              process_definition_id: instance.definition_id,
              state: instance.status,
              status: instance.status,
              context: access ? applyAccessToContext(instance.context, access) : instance.context,
              workspace_id: access?.workspace_id,
              group_id: access?.group_id || null,
              requester_id: access?.requester_id,
              client_id: access?.client_id,
              approver_ids: access?.approver_ids || [],
              caller: access?.caller || null,
              business_actor: access?.business_actor || null,
              workflow_version_id: access?.workflow_version_id || null,
              lock_owner: null,
              lock_until: null,
              heartbeat_at: null,
              created_at: now,
              updated_at: now,
            },
            { session },
          );
        }
        for (const update of input.update_instances || []) {
          const fields: Record<string, any> = { updated_at: now };
          if (update.status) {
            fields.state = update.status;
            fields.status = update.status;
          }
          if (update.context !== undefined) fields.context = update.context;
          if (update.paused !== undefined) {
            fields.is_paused = update.paused;
            fields.paused_at = update.paused ? now : null;
            fields.paused_by = update.paused ? update.paused_by || null : null;
            fields.pause_origin_instance_id = update.paused ? update.pause_origin_instance_id || update.id : null;
          }
          await this.db.collection<any>('v2_process_instances').updateOne({ _id: update.id }, { $set: fields }, { session });
          if (update.complete_jobs) {
            await this.db.collection<any>('v2_engine_jobs').updateMany(
              { instance_id: update.id, status: { $in: ['QUEUED', 'RUNNING'] } },
              { $set: { status: 'COMPLETED', updated_at: now } },
              { session },
            );
          }
        }
        for (const token of input.tokens || []) {
          await this.db.collection<any>('v2_tokens').insertOne(
            {
              _id: token.id,
              instance_id: token.instance_id,
              node_id: token.node_id,
              status: token.status === 'READY' ? 'ACTIVE' : token.status,
              parent_token_id: null,
              scope_key: null,
              created_at: now,
              updated_at: now,
            },
            { session },
          );
        }
        for (const job of input.jobs || []) {
          const counter = await this.db.collection<any>('v2_counters').findOneAndUpdate(
            { _id: 'v2_engine_jobs' },
            { $inc: { seq: 1 } },
            { upsert: true, returnDocument: 'after', session },
          );
          const jobId = Number((counter as any)?.value?.seq ?? (counter as any)?.seq ?? Date.now());
          await this.db.collection<any>('v2_engine_jobs').insertOne(
            {
              _id: jobId,
              instance_id: job.instance_id,
              token_id: job.token_id || null,
              job_type: job.type,
              run_at: job.run_at.toISOString(),
              attempt: 0,
              status: 'QUEUED',
              payload: job.payload,
              created_at: now,
              updated_at: now,
            },
            { session },
          );
        }
        for (const event of input.events || []) {
          await this.db.collection<any>('v2_event_outbox').insertOne(
            {
              instance_id: event.instance_id,
              token_id: null,
              node_id: null,
              event_type: event.event_type,
              payload: event.payload,
              created_at: now,
            },
            { session },
          );
        }
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async getIdempotentCommand(keyHash: string, requestHash: string): Promise<ExistingIdempotentInstanceCommandResult> {
    await this.ensureInstanceCommandIdempotencyIndexes();
    const existing = await this.db.collection<any>('v2_instance_command_idempotency').findOne({ _id: keyHash });
    if (!existing || new Date(existing.expires_at).getTime() <= Date.now()) return { outcome: 'missing', result: {} };
    return {
      outcome: existing.request_hash === requestHash ? 'replayed' : 'conflict',
      result: existing.result || {},
    };
  }

  async executeInstanceMutation(input: WorkflowInstanceMutation): Promise<void> {
    const session = this.db.client.startSession();
    try {
      await session.withTransaction(() => this.applyInstanceMutation(input, session));
    } finally {
      await session.endSession();
    }
  }

  private async applyInstanceMutation(input: WorkflowInstanceMutation, session: ClientSession): Promise<void> {
    const now = new Date().toISOString();
    for (const instance of input.create_instances || []) {
      const access = normalizeAccess(instance.context, instance.access);
      await this.db.collection<any>('v2_process_instances').insertOne(
        {
          _id: instance.id,
          process_definition_id: instance.definition_id,
          state: instance.status,
          status: instance.status,
          context: access ? applyAccessToContext(instance.context, access) : instance.context,
          workspace_id: access?.workspace_id,
          group_id: access?.group_id || null,
          requester_id: access?.requester_id,
          client_id: access?.client_id,
          approver_ids: access?.approver_ids || [],
          caller: access?.caller || null,
          business_actor: access?.business_actor || null,
          workflow_version_id: access?.workflow_version_id || null,
          lock_owner: null,
          lock_until: null,
          heartbeat_at: null,
          created_at: now,
          updated_at: now,
        },
        { session },
      );
    }
    for (const update of input.update_instances || []) {
      const fields: Record<string, any> = { updated_at: now };
      if (update.status) {
        fields.state = update.status;
        fields.status = update.status;
      }
      if (update.context !== undefined) fields.context = update.context;
      if (update.paused !== undefined) {
        fields.is_paused = update.paused;
        fields.paused_at = update.paused ? now : null;
        fields.paused_by = update.paused ? update.paused_by || null : null;
        fields.pause_origin_instance_id = update.paused ? update.pause_origin_instance_id || update.id : null;
      }
      await this.db.collection<any>('v2_process_instances').updateOne({ _id: update.id }, { $set: fields }, { session });
      if (update.complete_jobs) {
        await this.db.collection<any>('v2_engine_jobs').updateMany(
          { instance_id: update.id, status: { $in: ['QUEUED', 'RUNNING'] } },
          { $set: { status: 'COMPLETED', updated_at: now } },
          { session },
        );
      }
    }
    for (const token of input.tokens || []) {
      await this.db.collection<any>('v2_tokens').insertOne(
        {
          _id: token.id,
          instance_id: token.instance_id,
          node_id: token.node_id,
          status: token.status === 'READY' ? 'ACTIVE' : token.status,
          parent_token_id: null,
          scope_key: null,
          created_at: now,
          updated_at: now,
        },
        { session },
      );
    }
    for (const job of input.jobs || []) {
      const counter = await this.db.collection<any>('v2_counters').findOneAndUpdate(
        { _id: 'v2_engine_jobs' },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after', session },
      );
      const jobId = Number((counter as any)?.value?.seq ?? (counter as any)?.seq ?? Date.now());
      await this.db.collection<any>('v2_engine_jobs').insertOne(
        {
          _id: jobId,
          instance_id: job.instance_id,
          token_id: job.token_id || null,
          job_type: job.type,
          run_at: job.run_at.toISOString(),
          attempt: 0,
          status: 'QUEUED',
          payload: job.payload,
          created_at: now,
          updated_at: now,
        },
        { session },
      );
    }
    for (const event of input.events || []) {
      await this.db.collection<any>('v2_event_outbox').insertOne(
        {
          instance_id: event.instance_id,
          token_id: null,
          node_id: null,
          event_type: event.event_type,
          payload: event.payload,
          created_at: now,
        },
        { session },
      );
    }
  }

  private async ensureInstanceCommandIdempotencyIndexes(): Promise<void> {
    if (this.instanceCommandIdempotencyIndexesReady) return;
    await this.db.collection('v2_instance_command_idempotency').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    this.instanceCommandIdempotencyIndexesReady = true;
  }

  async createInstance(id: string, definitionId: string, status: string, ctx: any, access?: WorkflowInstanceAccess): Promise<void> {
    const now = new Date().toISOString();
    const normalizedAccess = normalizeAccess(ctx, access);
    await this.db.collection<any>('v2_process_instances').insertOne({
      _id: id,
      process_definition_id: definitionId,
      state: status,
      status: status,
      context: normalizedAccess ? applyAccessToContext(ctx, normalizedAccess) : ctx,
      workspace_id: normalizedAccess?.workspace_id,
      group_id: normalizedAccess?.group_id || null,
      requester_id: normalizedAccess?.requester_id,
      client_id: normalizedAccess?.client_id,
      approver_ids: normalizedAccess?.approver_ids || [],
      caller: normalizedAccess?.caller || null,
      business_actor: normalizedAccess?.business_actor || null,
      workflow_version_id: normalizedAccess?.workflow_version_id || null,
      lock_owner: null,
      lock_until: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });
  }

  async listInstances(actor?: WorkflowHistoryActor): Promise<any[]> {
    const instances = await this.db.collection<any>('v2_process_instances').find(buildMongoHistoryFilter(actor)).sort({ created_at: -1 }).limit(50).toArray();

    const result: any[] = [];
    for (const inst of instances) {
      let templateName = inst.context?.runtime?.snapshot?.workflow?.name || 'Unknown';
      if (inst.process_definition_id) {
        const def = await this.db.collection<any>('v2_process_definitions').findOne({ _id: inst.process_definition_id });
        if (def) {
          templateName = def.name;
        }
      }

      result.push({
        id: inst._id,
        definition_id: inst.process_definition_id,
        state: inst.state,
        status: inst.state || inst.status,
        is_paused: inst.is_paused === true,
        paused_at: inst.paused_at || null,
        paused_by: inst.paused_by || null,
        pause_origin_instance_id: inst.pause_origin_instance_id || null,
        context: inst.context,
        workspace_id: inst.workspace_id || inst.context?.runtime?.access?.workspace_id || 'default',
        group_id: inst.group_id || inst.context?.runtime?.access?.group_id || null,
        requester_id: inst.requester_id || inst.context?.runtime?.access?.requester_id || null,
        client_id: inst.client_id || inst.context?.runtime?.access?.client_id || null,
        approver_ids: inst.approver_ids || inst.context?.runtime?.access?.approver_ids || [],
        caller: inst.caller || inst.context?.runtime?.access?.caller || null,
        business_actor: inst.business_actor || inst.context?.runtime?.access?.business_actor || null,
        workflow_version_id: inst.workflow_version_id || inst.context?.runtime?.access?.workflow_version_id || null,
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
    const children = await this.db.collection<any>('v2_process_instances').find({ 'context.runtime.parent_instance_id': parentInstanceId }).toArray();

    return children.map((inst) => ({
      id: inst._id,
      definition_id: inst.process_definition_id,
      state: inst.state,
      status: inst.state || inst.status,
      is_paused: inst.is_paused === true,
      paused_at: inst.paused_at || null,
      paused_by: inst.paused_by || null,
      pause_origin_instance_id: inst.pause_origin_instance_id || null,
      context: inst.context,
      workspace_id: inst.workspace_id || inst.context?.runtime?.access?.workspace_id || 'default',
      group_id: inst.group_id || inst.context?.runtime?.access?.group_id || null,
      requester_id: inst.requester_id || inst.context?.runtime?.access?.requester_id || null,
      client_id: inst.client_id || inst.context?.runtime?.access?.client_id || null,
      approver_ids: inst.approver_ids || inst.context?.runtime?.access?.approver_ids || [],
      caller: inst.caller || inst.context?.runtime?.access?.caller || null,
      business_actor: inst.business_actor || inst.context?.runtime?.access?.business_actor || null,
      workflow_version_id: inst.workflow_version_id || inst.context?.runtime?.access?.workflow_version_id || null,
      created_at: inst.created_at,
      updated_at: inst.updated_at,
      template_id: inst.process_definition_id,
      ctx: inst.context,
    }));
  }

  async getInstance(id: string): Promise<any> {
    const inst = await this.db.collection<any>('v2_process_instances').findOne({ _id: id });

    if (!inst) return null;

    return {
      id: inst._id,
      definition_id: inst.process_definition_id,
      state: inst.state,
      status: inst.state || inst.status,
      is_paused: inst.is_paused === true,
      paused_at: inst.paused_at || null,
      paused_by: inst.paused_by || null,
      pause_origin_instance_id: inst.pause_origin_instance_id || null,
      context: inst.context,
      workspace_id: inst.workspace_id || inst.context?.runtime?.access?.workspace_id || 'default',
      group_id: inst.group_id || inst.context?.runtime?.access?.group_id || null,
      requester_id: inst.requester_id || inst.context?.runtime?.access?.requester_id || null,
      client_id: inst.client_id || inst.context?.runtime?.access?.client_id || null,
      approver_ids: inst.approver_ids || inst.context?.runtime?.access?.approver_ids || [],
      caller: inst.caller || inst.context?.runtime?.access?.caller || null,
      business_actor: inst.business_actor || inst.context?.runtime?.access?.business_actor || null,
      workflow_version_id: inst.workflow_version_id || inst.context?.runtime?.access?.workflow_version_id || null,
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

  async createToken(token: { id: string; instanceId: string; nodeId: string; status: string; parentTokenId?: string; scopeKey?: string }): Promise<void> {
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

  async createJob(job: { instanceId: string; tokenId?: string | null; type: string; runAt: Date; payload: any }): Promise<void> {
    const now = new Date().toISOString();
    // Atomic sequence 발급
    const counterDoc = await this.db.collection<any>('v2_counters').findOneAndUpdate({ _id: 'v2_engine_jobs' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });

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
      .aggregate<{
        _id: string;
        count: number;
      }>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();
    const byStatus = Object.fromEntries(statusRows.map((row) => [row._id || 'UNKNOWN', row.count]));

    const oldestQueued = await jobs.findOne({ status: 'QUEUED' }, { sort: { run_at: 1, _id: 1 }, projection: { run_at: 1 } });
    const oldestQueuedAt = oldestQueued?.run_at || null;
    const oldestQueuedAgeMs = oldestQueuedAt ? Math.max(0, Date.now() - Date.parse(oldestQueuedAt)) : null;

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
      .aggregate<{
        _id: null;
        max_attempt: number;
      }>([{ $group: { _id: null, max_attempt: { $max: '$attempt' } } }])
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

  async replaceDefinitionSchedules(definitionId: string, jobs: WorkflowScheduleJob[]): Promise<void> {
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

  async claimDueSchedules(now: Date, owner: string, limit: number): Promise<WorkflowScheduleJob[]> {
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
          $or: [{ locked_until: null }, { locked_until: { $lt: nowIso } }, { lock_owner: owner }],
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

  async markScheduleSuccess(id: string, nextRunAt: Date, instanceId: string): Promise<void> {
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

  async markScheduleFailure(id: string, error: string, nextRunAt: Date): Promise<void> {
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

  async getDefinitionScheduleStatus(definitionId: string, limit = 10): Promise<WorkflowScheduleStatus> {
    const jobDoc = await this.db.collection<any>('v2_schedule_jobs').findOne({ definition_id: definitionId }, { sort: { updated_at: -1 } });
    const runs = await this.db.collection<any>('v2_schedule_runs').find({ definition_id: definitionId }).sort({ created_at: -1 }).limit(limit).toArray();

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
  async createTask(id: string, instanceId: string, nodeId: string, assignee: string, status: string, payload: any): Promise<void> {
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

  async listTasks(assignee: string): Promise<any[]> {
    const tasks = await this.db.collection<any>('v2_tasks').find({ assignee, status: 'OPEN' }).sort({ created_at: -1 }).toArray();

    const result: any[] = [];
    for (const t of tasks) {
      const inst = await this.db.collection<any>('v2_process_instances').findOne({ _id: t.instance_id });

      result.push({
        id: t._id,
        instance_id: t.instance_id,
        token_id: t.token_id,
        approval_request_id: t.approval_request_id || null,
        approval_step_id: t.approval_step_id || null,
        node_id: t.node_id,
        assignee: t.assignee,
        status: t.status,
        payload: t.payload,
        process_definition_id: inst?.process_definition_id || null,
        group_id: inst?.group_id || inst?.context?.runtime?.access?.group_id || null,
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
      approval_request_id: t.approval_request_id || null,
      approval_step_id: t.approval_step_id || null,
      node_id: t.node_id,
      assignee: t.assignee,
      status: t.status,
      payload: t.payload,
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  async listTaskHistory(query: WorkflowTaskHistoryQuery): Promise<WorkflowTaskHistoryPage> {
    const taskMatch: Record<string, any> = {};
    if (query.statuses?.length) taskMatch.status = { $in: query.statuses };
    if (query.instance_id) taskMatch.instance_id = query.instance_id;
    if (query.assignee) taskMatch.assignee = query.assignee;
    if (query.approver_channel) taskMatch['payload.approver_channel'] = query.approver_channel;
    if (query.from || query.to) {
      taskMatch.created_at = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    if (query.cursor) {
      taskMatch.$or = [{ created_at: { $lt: query.cursor.created_at } }, { created_at: query.cursor.created_at, _id: { $lt: query.cursor.id } }];
    }

    const joinedMatch: Record<string, any> = {};
    if (query.workflow_id) joinedMatch.effective_workflow_id = query.workflow_id;
    if (query.group_ids) joinedMatch.effective_group_id = { $in: query.group_ids };
    if (query.allowed_workflow_ids) joinedMatch.effective_workflow_id = { $in: query.allowed_workflow_ids };

    const rows = await this.db
      .collection<any>('v2_tasks')
      .aggregate([
        { $match: taskMatch },
        { $sort: { created_at: -1, _id: -1 } },
        {
          $lookup: {
            from: 'v2_process_instances',
            localField: 'instance_id',
            foreignField: '_id',
            as: 'instance',
          },
        },
        { $unwind: '$instance' },
        {
          $addFields: {
            effective_group_id: {
              $ifNull: ['$instance.group_id', '$instance.context.runtime.access.group_id'],
            },
            effective_workflow_id: {
              $ifNull: ['$instance.definition_id', '$instance.process_definition_id'],
            },
          },
        },
        ...(Object.keys(joinedMatch).length ? [{ $match: joinedMatch }] : []),
        {
          $lookup: {
            from: 'v2_process_definitions',
            localField: 'effective_workflow_id',
            foreignField: '_id',
            as: 'definition',
          },
        },
        { $unwind: { path: '$definition', preserveNullAndEmptyArrays: true } },
        { $limit: query.limit + 1 },
      ])
      .toArray();
    return {
      items: rows.slice(0, query.limit).map(mapTaskHistoryMongo),
      has_more: rows.length > query.limit,
    };
  }

  async getTaskHistoryItem(id: string): Promise<WorkflowTaskHistoryItem | null> {
    const rows = await this.db
      .collection<any>('v2_tasks')
      .aggregate([
        { $match: { _id: id } },
        {
          $lookup: {
            from: 'v2_process_instances',
            localField: 'instance_id',
            foreignField: '_id',
            as: 'instance',
          },
        },
        { $unwind: '$instance' },
        {
          $addFields: {
            effective_group_id: {
              $ifNull: ['$instance.group_id', '$instance.context.runtime.access.group_id'],
            },
            effective_workflow_id: {
              $ifNull: ['$instance.definition_id', '$instance.process_definition_id'],
            },
          },
        },
        {
          $lookup: {
            from: 'v2_process_definitions',
            localField: 'effective_workflow_id',
            foreignField: '_id',
            as: 'definition',
          },
        },
        { $unwind: { path: '$definition', preserveNullAndEmptyArrays: true } },
        { $limit: 1 },
      ])
      .toArray();
    return rows[0] ? mapTaskHistoryMongo(rows[0]) : null;
  }

  async claimExternalApprovalTasks(owner: string, now: Date, claimUntil: Date, limit: number): Promise<ExternalApprovalClaim[]> {
    const collection = this.db.collection<any>('v2_tasks');
    const claims: ExternalApprovalClaim[] = [];
    const nowIso = now.toISOString();
    for (let index = 0; index < limit; index += 1) {
      const task = await collection.findOneAndUpdate(
        {
          status: 'OPEN',
          'payload.approver_channel': 'external_email',
          $and: [
            {
              $or: [
                {
                  'payload.external_approval.attempt_count': { $exists: false },
                },
                { 'payload.external_approval.attempt_count': { $lt: 10 } },
              ],
            },
          ],
          $or: [
            { 'payload.external_approval.delivery_status': { $exists: false } },
            { 'payload.external_approval.delivery_status': 'PENDING' },
            {
              'payload.external_approval.delivery_status': 'FAILED',
              'payload.external_approval.retry_at': { $lte: nowIso },
            },
            {
              'payload.external_approval.delivery_status': 'CLAIMED',
              'payload.external_approval.claim_until': { $lte: nowIso },
            },
          ],
        },
        {
          $set: {
            'payload.external_approval.delivery_status': 'CLAIMED',
            'payload.external_approval.claim_owner': owner,
            'payload.external_approval.claim_until': claimUntil.toISOString(),
            'payload.external_approval.updated_at': nowIso,
          },
          $inc: { 'payload.external_approval.attempt_count': 1 },
        },
        { sort: { created_at: 1 }, returnDocument: 'after' },
      );
      if (!task) break;
      claims.push({
        task_id: String(task._id),
        instance_id: String(task.instance_id),
        email: String(task.assignee),
        require_otp: task.payload?.external_require_otp !== false,
        expires_in_hours: Math.min(168, Math.max(1, Number(task.payload?.external_expires_in_hours) || 24)),
        attempt_count: Number(task.payload?.external_approval?.attempt_count) || 1,
      });
    }
    return claims;
  }

  async setExternalApprovalDeliveryToken(taskId: string, owner: string, input: ExternalApprovalDeliveryToken): Promise<boolean> {
    const result = await this.db.collection<any>('v2_tasks').updateOne(
      {
        _id: taskId,
        status: 'OPEN',
        'payload.external_approval.delivery_status': 'CLAIMED',
        'payload.external_approval.claim_owner': owner,
      },
      {
        $set: {
          'payload.external_approval.email': input.email,
          'payload.external_approval.token_hash': input.token_hash,
          'payload.external_approval.token_expires_at': input.token_expires_at,
          'payload.external_approval.require_otp': input.require_otp,
          'payload.external_approval.attempt_count': input.attempt_count,
          'payload.external_approval.otp_hash': null,
          'payload.external_approval.otp_attempts': 0,
          'payload.external_approval.consumed_at': null,
          'payload.external_approval.updated_at': new Date().toISOString(),
        },
      },
    );
    return result.modifiedCount === 1;
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
    await this.db.collection<any>('v2_tasks').updateOne(
      { _id: taskId, 'payload.external_approval.claim_owner': owner },
      {
        $set: {
          'payload.external_approval.delivery_status': status,
          'payload.external_approval.sent_at': input.sent_at || null,
          'payload.external_approval.retry_at': input.retry_at || null,
          'payload.external_approval.last_error': input.error || null,
          'payload.external_approval.claim_owner': null,
          'payload.external_approval.claim_until': null,
          'payload.external_approval.updated_at': new Date().toISOString(),
        },
      },
    );
  }

  async requeueExternalApproval(taskId: string): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.collection<any>('v2_tasks').updateOne(
      {
        _id: taskId,
        status: 'OPEN',
        'payload.approver_channel': 'external_email',
      },
      {
        $set: {
          'payload.external_approval.delivery_status': 'PENDING',
          'payload.external_approval.attempt_count': 0,
          'payload.external_approval.sent_at': null,
          'payload.external_approval.retry_at': null,
          'payload.external_approval.last_error': null,
          'payload.external_approval.claim_owner': null,
          'payload.external_approval.claim_until': null,
          'payload.external_approval.token_hash': null,
          'payload.external_approval.token_expires_at': null,
          'payload.external_approval.otp_hash': null,
          'payload.external_approval.otp_expires_at': null,
          'payload.external_approval.otp_sent_at': null,
          'payload.external_approval.otp_next_send_at': null,
          'payload.external_approval.otp_attempts': 0,
          'payload.external_approval.consumed_at': null,
          'payload.external_approval.requeued_at': now,
          'payload.external_approval.updated_at': now,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async findExternalApprovalByTokenHash(tokenHash: string): Promise<ExternalApprovalTask | null> {
    const task = await this.db.collection<any>('v2_tasks').findOne({
      'payload.external_approval.token_hash': tokenHash,
    });
    return task ? (mapTaskDoc(task) as ExternalApprovalTask) : null;
  }

  async setExternalApprovalOtp(taskId: string, tokenHash: string, input: ExternalApprovalOtp): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.collection<any>('v2_tasks').updateOne(
      {
        _id: taskId,
        status: 'OPEN',
        'payload.external_approval.token_hash': tokenHash,
        $or: [{ 'payload.external_approval.otp_next_send_at': { $exists: false } }, { 'payload.external_approval.otp_next_send_at': null }, { 'payload.external_approval.otp_next_send_at': { $lte: now } }],
      },
      {
        $set: {
          'payload.external_approval.otp_hash': input.otp_hash,
          'payload.external_approval.otp_expires_at': input.otp_expires_at,
          'payload.external_approval.otp_sent_at': input.otp_sent_at,
          'payload.external_approval.otp_next_send_at': input.otp_next_send_at,
          'payload.external_approval.otp_attempts': 0,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async incrementExternalApprovalOtpFailures(taskId: string, tokenHash: string): Promise<number> {
    const task = await this.db.collection<any>('v2_tasks').findOneAndUpdate(
      {
        _id: taskId,
        status: 'OPEN',
        'payload.external_approval.token_hash': tokenHash,
      },
      { $inc: { 'payload.external_approval.otp_attempts': 1 } },
      { returnDocument: 'after' },
    );
    return Number(task?.payload?.external_approval?.otp_attempts) || 0;
  }

  async clearExternalApprovalOtp(taskId: string, tokenHash: string, otpHash: string): Promise<void> {
    await this.db.collection<any>('v2_tasks').updateOne(
      {
        _id: taskId,
        status: 'OPEN',
        'payload.external_approval.token_hash': tokenHash,
        'payload.external_approval.otp_hash': otpHash,
      },
      {
        $set: {
          'payload.external_approval.otp_hash': null,
          'payload.external_approval.otp_expires_at': null,
          'payload.external_approval.otp_sent_at': null,
          'payload.external_approval.otp_next_send_at': null,
          'payload.external_approval.otp_attempts': 0,
        },
      },
    );
  }

  async completeTask(command: CompleteWorkflowTaskCommand): Promise<CompleteWorkflowTaskResult> {
    const session = this.db.client.startSession();
    let result: CompleteWorkflowTaskResult = {
      outcome: 'not_found',
      task: null,
    };
    try {
      await session.withTransaction(async () => {
        const collection = this.db.collection<any>('v2_tasks');
        const task = await collection.findOne({ _id: command.task_id }, { session });
        if (!task) {
          result = { outcome: 'not_found', task: null };
          return;
        }
        if (task.status !== 'OPEN') {
          const sameKey = sameTaskCompletion(task.completion, command);
          result = {
            outcome: sameKey ? 'idempotent' : 'already_completed',
            task: mapTaskDoc(task),
          };
          return;
        }

        const now = new Date().toISOString();
        const completion = taskCompletion(command, now);
        const completionFilter: any = { _id: command.task_id, status: 'OPEN' };
        if (command.external_approval) {
          completionFilter['payload.external_approval.token_hash'] = command.external_approval.token_hash;
          completionFilter['payload.external_approval.consumed_at'] = null;
        }
        const completionSet: Record<string, unknown> = {
          status: command.status,
          completion,
          updated_at: now,
        };
        if (command.external_approval) {
          completionSet['payload.external_approval.consumed_at'] = now;
          completionSet['payload.external_approval.auth_method'] = command.external_approval.auth_method;
          completionSet['payload.external_approval.completed_email'] = command.external_approval.email;
        }
        const update = await collection.updateOne(completionFilter, { $set: completionSet }, { session });
        if (update.modifiedCount !== 1) {
          const current = await collection.findOne({ _id: command.task_id }, { session });
          const sameKey = sameTaskCompletion(current?.completion, command);
          result = {
            outcome: sameKey ? 'idempotent' : 'already_completed',
            task: current ? mapTaskDoc(current) : null,
          };
          return;
        }

        let shouldResume = !task.approval_request_id;
        if (task.approval_request_id) {
          const requestUpdate = await this.db.collection<any>('v2_approval_requests').updateOne(
            {
              _id: task.approval_request_id,
              instance_id: task.instance_id,
              token_id: task.token_id,
              status: 'IN_PROGRESS',
            },
            {
              $set: {
                status: command.status,
                result: {
                  action: command.action,
                  task_id: command.task_id,
                  comment: command.comment || null,
                  result: command.result || null,
                },
                completed_at: now,
                updated_at: now,
              },
              $inc: { version: 1 },
            },
            { session },
          );
          if (requestUpdate.modifiedCount !== 1) {
            const request = await this.db
              .collection<any>('v2_approval_requests')
              .findOne({ _id: task.approval_request_id }, { session });
            if (!request) {
              throw new Error(
                `Approval request ${task.approval_request_id} is missing for task ${task._id}`,
              );
            }
          }
          shouldResume = requestUpdate.modifiedCount === 1;

          if (task.approval_step_id) {
            await this.db.collection<any>('v2_approval_steps').updateOne(
              {
                _id: task.approval_step_id,
                request_id: task.approval_request_id,
                status: 'OPEN',
              },
              {
                $set: {
                  status: command.status,
                  completed_at: now,
                  updated_at: now,
                },
                $inc: { version: 1 },
              },
              { session },
            );
          }
        }

        if (shouldResume) {
          const counterDoc = await this.db.collection<any>('v2_counters').findOneAndUpdate({ _id: 'v2_engine_jobs' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after', session });
          const sequence = Number((counterDoc as any)?.seq || Date.now());
          await this.db.collection<any>('v2_engine_jobs').insertOne(
            {
              _id: sequence,
              instance_id: task.instance_id,
              token_id: task.token_id || null,
              job_type: 'RESUME',
              run_at: now,
              attempt: 0,
              status: 'QUEUED',
              payload: {
                action: command.action,
                completed_node_id: task.node_id,
                approval_request_id: task.approval_request_id || null,
                task_id: command.task_id,
                result: command.result || null,
                comment: command.comment || null,
              },
              created_at: now,
              updated_at: now,
            },
            { session },
          );
          await this.db.collection<any>('v2_process_instances').updateOne({ _id: task.instance_id }, { $set: { state: 'RUNNING', status: 'RUNNING', updated_at: now } }, { session });
        }
        await this.db.collection<any>('v2_event_outbox').insertOne(
          {
            instance_id: task.instance_id,
            token_id: task.token_id || null,
            node_id: task.node_id,
            event_type: command.action === 'approve' ? 'TASK_APPROVED' : 'TASK_REJECTED',
            payload: {
              task_id: command.task_id,
              action: command.action,
              status: command.status,
              actor_id: command.actor_id,
              approval_channel: command.external_approval ? 'external_email' : 'pxm_user',
            },
            created_at: now,
          },
          { session },
        );
        if (task.approval_request_id && shouldResume) {
          await this.db.collection<any>('v2_event_outbox').insertOne(
            {
              instance_id: task.instance_id,
              token_id: task.token_id || null,
              node_id: task.node_id,
              event_type: 'APPROVAL_REQUEST_COMPLETED',
              payload: {
                approval_request_id: task.approval_request_id,
                task_id: command.task_id,
                status: command.status,
              },
              created_at: now,
            },
            { session },
          );
        }
        result = {
          outcome: 'completed',
          task: mapTaskDoc({
            ...task,
            status: command.status,
            completion,
            updated_at: now,
          }),
        };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async fetchAfter(instanceId: string, afterId: number, limit = 100): Promise<any[]> {
    const nodeLabels = await this.loadNodeLabels(instanceId);
    const [logs, outbox] = await Promise.all([this.db.collection<any>('v2_execution_logs').find({ instance_id: instanceId }).sort({ created_at: 1 }).toArray(), this.db.collection<any>('v2_event_outbox').find({ instance_id: instanceId }).sort({ created_at: 1 }).toArray()]);

    return [...logs.map((doc) => ({ ...doc, source: 'execution_log' })), ...outbox.map((doc) => ({ ...doc, source: 'outbox' }))]
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
    const [logs, outbox] = await Promise.all([this.db.collection<any>('v2_execution_logs').find({ instance_id: instanceId }).sort({ created_at: 1 }).limit(limit).toArray(), this.db.collection<any>('v2_event_outbox').find({ instance_id: instanceId }).sort({ created_at: 1 }).limit(limit).toArray()]);

    return [...logs.map((doc) => ({ ...doc, source: 'execution_log' })), ...outbox.map((doc) => ({ ...doc, source: 'outbox' }))]
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

  async appendEvent(instanceId: string, eventType: string, payload: any): Promise<any> {
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

  async listAllInputPresets(): Promise<WorkflowInputPreset[]> {
    await this.ensureInputPresetIndexes();
    const docs = await this.db
      .collection<any>('workflow_input_presets')
      .find({ enabled: { $ne: false } })
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

  async upsertInputPreset(workflowId: string, preset: UpsertWorkflowInputPreset): Promise<WorkflowInputPreset> {
    await this.ensureInputPresetIndexes();
    const now = new Date().toISOString();
    const alias = preset.alias || slugifyPresetAlias(preset.name);
    const filter = preset.id ? { _id: preset.id, workflow_id: workflowId } : { workflow_id: workflowId, alias };
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
          shared_group_ids: preset.shared_group_ids || [],
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

    const saved = await this.db.collection<any>('workflow_input_presets').findOne(preset.id ? { _id: preset.id, workflow_id: workflowId } : { workflow_id: workflowId, alias });
    return mapInputPresetDoc(saved);
  }

  async deleteInputPreset(workflowId: string, presetId: string): Promise<boolean> {
    await this.ensureInputPresetIndexes();
    const result = await this.db.collection<any>('workflow_input_presets').updateOne({ _id: presetId, workflow_id: workflowId }, { $set: { enabled: false, updated_at: new Date().toISOString() } });
    return result.matchedCount > 0;
  }

  async upsertGroup(group: UpsertPxmGroup): Promise<PxmGroup> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const id = group.id || crypto.randomUUID();
    await this.db.collection<any>('pxm_groups').updateOne(
      { _id: id },
      {
        $set: {
          name: group.name.trim(),
          description: group.description || '',
          status: 'active',
          updated_by: group.actor || null,
          updated_at: now,
        },
        $setOnInsert: {
          _id: id,
          created_by: group.actor || null,
          created_at: now,
          deleted_at: null,
        },
      },
      { upsert: true },
    );
    return mapGroupDoc(await this.db.collection<any>('pxm_groups').findOne({ _id: id }));
  }

  async listGroups(includeDeleted = false): Promise<PxmGroup[]> {
    await this.ensureAuthzIndexes();
    const docs = await this.db
      .collection<any>('pxm_groups')
      .find(includeDeleted ? {} : { status: { $ne: 'deleted' } })
      .sort({ created_at: -1 })
      .toArray();
    return docs.map(mapGroupDoc);
  }

  async getGroup(id: string): Promise<PxmGroup | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_groups').findOne({ _id: id });
    return doc ? mapGroupDoc(doc) : null;
  }

  async softDeleteGroup(id: string, actor?: string | null): Promise<boolean> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const result = await this.db.collection<any>('pxm_groups').updateOne(
      { _id: id, status: { $ne: 'deleted' } },
      {
        $set: {
          status: 'deleted',
          deleted_at: now,
          updated_by: actor || null,
          updated_at: now,
        },
      },
    );
    if (result.matchedCount > 0) {
      await this.db.collection<any>('pxm_api_keys').updateMany(
        { group_id: id, status: 'active' },
        {
          $set: {
            status: 'disabled',
            disabled_at: now,
            updated_at: now,
          },
        },
      );
    }
    return result.matchedCount > 0;
  }

  async restoreGroup(id: string, actor?: string | null): Promise<boolean> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const result = await this.db.collection<any>('pxm_groups').updateOne(
      { _id: id, status: 'deleted' },
      {
        $set: {
          status: 'active',
          deleted_at: null,
          updated_by: actor || null,
          updated_at: now,
        },
      },
    );
    return result.matchedCount > 0;
  }

  async upsertUser(user: UpsertPxmUser): Promise<PxmUser> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const id = user.id || crypto.randomUUID();
    await this.db.collection<any>('pxm_users').updateOne(
      { _id: id },
      {
        $set: {
          display_name: user.display_name.trim(),
          email: user.email || null,
          role: user.role || 'user',
          group_ids: user.group_ids || [],
          memberships: user.memberships || [],
          status: user.status || 'active',
          updated_by: user.actor || null,
          updated_at: now,
          ...(user.password_hash ? { password_hash: user.password_hash } : {}),
        },
        $setOnInsert: {
          _id: id,
          created_by: user.actor || null,
          created_at: now,
        },
      },
      { upsert: true },
    );
    return mapUserDoc(await this.db.collection<any>('pxm_users').findOne({ _id: id }));
  }

  async listUsers(groupId?: string): Promise<PxmUser[]> {
    await this.ensureAuthzIndexes();
    const filter = groupId ? { group_ids: groupId } : {};
    const docs = await this.db.collection<any>('pxm_users').find(filter).sort({ created_at: -1 }).toArray();
    return docs.map(mapUserDoc);
  }

  async getUser(id: string): Promise<PxmUser | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_users').findOne({ _id: id });
    return doc ? mapUserDoc(doc) : null;
  }

  async getUserPasswordHash(id: string): Promise<string | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_users').findOne({ _id: id }, { projection: { password_hash: 1 } });
    return doc?.password_hash || null;
  }

  async updateUserPasswordHash(id: string, passwordHash: string, actor?: string | null): Promise<boolean> {
    const result = await this.db.collection<any>('pxm_users').updateOne(
      { _id: id, status: 'active' },
      {
        $set: {
          password_hash: passwordHash,
          updated_by: actor || id,
          updated_at: new Date().toISOString(),
        },
      },
    );
    return result.matchedCount > 0;
  }

  async updateUserProfile(id: string, displayName: string, email?: string | null): Promise<PxmUser | null> {
    const result = await this.db.collection<any>('pxm_users').findOneAndUpdate(
      { _id: id, status: 'active' },
      {
        $set: {
          display_name: displayName,
          email: email || null,
          updated_by: id,
          updated_at: new Date().toISOString(),
        },
      },
      { returnDocument: 'after' },
    );
    return result ? mapUserDoc(result) : null;
  }

  async createSession(session: CreatePxmSession): Promise<PxmSession> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const doc = {
      _id: session.id,
      ...session,
      created_at: now,
      last_seen_at: now,
      revoked_at: null,
      revoke_reason: null,
    };
    await this.db.collection<any>('pxm_sessions').insertOne(doc);
    return mapSessionDoc(doc);
  }
  async findSessionByTokenHash(tokenHash: string): Promise<PxmSession | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_sessions').findOne({ token_hash: tokenHash });
    return doc ? mapSessionDoc(doc) : null;
  }
  async touchSession(id: string, lastSeenAt: string, idleExpiresAt: string): Promise<void> {
    await this.db.collection<any>('pxm_sessions').updateOne({ _id: id, revoked_at: null }, { $set: { last_seen_at: lastSeenAt, idle_expires_at: idleExpiresAt } });
  }
  async revokeSession(id: string, reason: string): Promise<boolean> {
    const result = await this.db.collection<any>('pxm_sessions').updateOne(
      { _id: id, revoked_at: null },
      {
        $set: { revoked_at: new Date().toISOString(), revoke_reason: reason },
      },
    );
    return result.modifiedCount > 0;
  }
  async revokeUserSessions(userId: string, reason: string, exceptId?: string): Promise<number> {
    const filter: any = { user_id: userId, revoked_at: null };
    if (exceptId) filter._id = { $ne: exceptId };
    const result = await this.db.collection<any>('pxm_sessions').updateMany(filter, {
      $set: { revoked_at: new Date().toISOString(), revoke_reason: reason },
    });
    return result.modifiedCount;
  }
  async revokeAllSessions(reason: string, exceptId?: string): Promise<number> {
    const filter: any = { revoked_at: null };
    if (exceptId) filter._id = { $ne: exceptId };
    const result = await this.db.collection<any>('pxm_sessions').updateMany(filter, {
      $set: { revoked_at: new Date().toISOString(), revoke_reason: reason },
    });
    return result.modifiedCount;
  }
  async listUserSessions(userId: string): Promise<PxmSession[]> {
    await this.ensureAuthzIndexes();
    return (await this.db.collection<any>('pxm_sessions').find({ user_id: userId }).sort({ created_at: -1 }).toArray()).map(mapSessionDoc);
  }
  async getSessionSecurityPolicy(): Promise<PxmSessionSecurityPolicy | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_security_policies').findOne({ _id: 'session' });
    return doc ? mapSessionSecurityPolicyDoc(doc) : null;
  }
  async upsertSessionSecurityPolicy(policy: UpsertPxmSessionSecurityPolicy): Promise<PxmSessionSecurityPolicy> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const doc = await this.db.collection<any>('pxm_security_policies').findOneAndUpdate(
      { _id: 'session' },
      {
        $set: { ...policy, updated_at: now },
        $setOnInsert: { created_at: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
    return mapSessionSecurityPolicyDoc(doc);
  }

  async upsertServiceAccount(account: UpsertPxmServiceAccount): Promise<PxmServiceAccount> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const id = account.id || crypto.randomUUID();
    await this.db.collection<any>('pxm_service_accounts').updateOne(
      { _id: id },
      {
        $set: {
          name: account.name.trim(),
          group_id: account.group_id,
          description: account.description || '',
          status: account.status || 'active',
          updated_by: account.actor || null,
          updated_at: now,
        },
        $setOnInsert: {
          _id: id,
          created_by: account.actor || null,
          created_at: now,
        },
      },
      { upsert: true },
    );
    return mapServiceAccountDoc(await this.db.collection<any>('pxm_service_accounts').findOne({ _id: id }));
  }

  async listServiceAccounts(groupId?: string): Promise<PxmServiceAccount[]> {
    await this.ensureAuthzIndexes();
    const filter = groupId ? { group_id: groupId } : {};
    const docs = await this.db.collection<any>('pxm_service_accounts').find(filter).sort({ created_at: -1 }).toArray();
    return docs.map(mapServiceAccountDoc);
  }

  async getServiceAccount(id: string): Promise<PxmServiceAccount | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_service_accounts').findOne({ _id: id });
    return doc ? mapServiceAccountDoc(doc) : null;
  }

  async createApiKey(key: CreatePxmApiKey): Promise<PxmApiKey> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const id = key.id || crypto.randomUUID();
    const doc = {
      _id: id,
      name: key.name.trim(),
      owner_type: key.owner_type,
      owner_id: key.owner_id,
      group_id: key.group_id,
      key_prefix: key.key_prefix,
      key_hash: key.key_hash,
      scopes: key.scopes || [],
      allowed_workflow_ids: key.allowed_workflow_ids || [],
      ip_allowlist: key.ip_allowlist || [],
      rate_limit_per_minute: key.rate_limit_per_minute || null,
      status: 'active',
      expires_at: key.expires_at || null,
      last_used_at: null,
      created_by: key.actor || null,
      disabled_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.collection<any>('pxm_api_keys').insertOne(doc);
    return mapApiKeyDoc(doc);
  }

  async listApiKeys(groupId?: string): Promise<PxmApiKey[]> {
    await this.ensureAuthzIndexes();
    const filter = groupId ? { group_id: groupId } : {};
    const docs = await this.db.collection<any>('pxm_api_keys').find(filter).sort({ created_at: -1 }).toArray();
    return docs.map(mapApiKeyDoc);
  }

  async getApiKey(id: string): Promise<PxmApiKey | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_api_keys').findOne({ _id: id });
    return doc ? mapApiKeyDoc(doc) : null;
  }

  async findApiKeyByHash(keyHash: string): Promise<PxmApiKey | null> {
    await this.ensureAuthzIndexes();
    const doc = await this.db.collection<any>('pxm_api_keys').findOne({ key_hash: keyHash });
    return doc ? mapApiKeyDoc(doc) : null;
  }

  async disableApiKey(id: string, actor?: string | null): Promise<boolean> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const result = await this.db.collection<any>('pxm_api_keys').updateOne(
      { _id: id, status: { $ne: 'disabled' } },
      {
        $set: {
          status: 'disabled',
          disabled_at: now,
          updated_by: actor || null,
          updated_at: now,
        },
      },
    );
    return result.matchedCount > 0;
  }

  async touchApiKey(id: string, usedAt: string): Promise<void> {
    await this.ensureAuthzIndexes();
    await this.db.collection<any>('pxm_api_keys').updateOne({ _id: id }, { $set: { last_used_at: usedAt, updated_at: usedAt } });
  }

  async appendApiKeyUsageLog(log: AppendPxmApiKeyUsageLog): Promise<PxmApiKeyUsageLog> {
    await this.ensureAuthzIndexes();
    const now = new Date().toISOString();
    const doc = {
      _id: log.id || crypto.randomUUID(),
      ...log,
      created_at: now,
    };
    await this.db.collection<any>('pxm_api_key_usage_logs').insertOne(doc);
    return mapApiKeyUsageLogDoc(doc);
  }

  async countApiKeyUsageSince(apiKeyId: string, since: string): Promise<number> {
    await this.ensureAuthzIndexes();
    return this.db.collection<any>('pxm_api_key_usage_logs').countDocuments({
      api_key_id: apiKeyId,
      created_at: { $gte: since },
    });
  }

  private async ensureInputPresetIndexes(): Promise<void> {
    if (this.inputPresetIndexesReady) return;
    const collection = this.db.collection<any>('workflow_input_presets');
    await collection.createIndex({ workflow_id: 1, alias: 1 }, { unique: true });
    await collection.createIndex({ workflow_id: 1, updated_at: -1 });
    this.inputPresetIndexesReady = true;
  }

  private async ensureAuthzIndexes(): Promise<void> {
    if (this.authzIndexesReady) return;
    await this.db.collection<any>('pxm_groups').createIndex({ name: 1 }, { unique: true });
    await this.db.collection<any>('pxm_users').createIndex({ group_ids: 1 });
    await this.db.collection<any>('pxm_service_accounts').createIndex({ group_id: 1 });
    await this.db.collection<any>('pxm_api_keys').createIndex({ key_hash: 1 }, { unique: true });
    await this.db.collection<any>('pxm_api_keys').createIndex({ group_id: 1, status: 1 });
    await this.db.collection<any>('pxm_api_key_usage_logs').createIndex({ api_key_id: 1, created_at: -1 });
    await this.db.collection<any>('pxm_api_key_usage_logs').createIndex({ group_id: 1, created_at: -1 });
    await this.db.collection<any>('pxm_sessions').createIndex({ token_hash: 1 }, { unique: true });
    await this.db.collection<any>('pxm_sessions').createIndex({ user_id: 1, created_at: -1 });
    await this.db.collection<any>('pxm_sessions').createIndex({ absolute_expires_at: 1 }, { expireAfterSeconds: 86400 });
    this.authzIndexesReady = true;
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
    shared_group_ids: Array.isArray(doc.shared_group_ids) ? doc.shared_group_ids : [],
    enabled: doc.enabled !== false,
    created_by: doc.created_by || null,
    updated_by: doc.updated_by || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function mapGroupDoc(doc: any): PxmGroup {
  return {
    id: doc._id,
    name: doc.name,
    description: doc.description || '',
    status: doc.status || 'active',
    created_by: doc.created_by || null,
    updated_by: doc.updated_by || null,
    deleted_at: doc.deleted_at || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function mapUserDoc(doc: any): PxmUser {
  const groupIds = Array.isArray(doc.group_ids) ? doc.group_ids : [];
  const memberships = Array.isArray(doc.memberships)
    ? doc.memberships.filter((item: any) => item?.group_id && (item.role === 'group_manager' || item.role === 'user'))
    : groupIds.map((group_id: string) => ({
        group_id,
        role: doc.role === 'group_manager' ? ('group_manager' as const) : ('user' as const),
      }));
  return {
    id: doc._id,
    display_name: doc.display_name,
    email: doc.email || null,
    role: doc.role || 'user',
    group_ids: memberships.map((membership: any) => membership.group_id),
    memberships,
    status: doc.status || 'active',
    created_by: doc.created_by || null,
    updated_by: doc.updated_by || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function mapSessionDoc(doc: any): PxmSession {
  return {
    id: doc._id,
    token_hash: doc.token_hash,
    csrf_hash: doc.csrf_hash,
    user_id: doc.user_id,
    ip: doc.ip || null,
    user_agent: doc.user_agent || null,
    created_at: doc.created_at,
    last_seen_at: doc.last_seen_at,
    idle_expires_at: doc.idle_expires_at,
    absolute_expires_at: doc.absolute_expires_at,
    idle_timeout_minutes: Number(doc.idle_timeout_minutes) || undefined,
    revoked_at: doc.revoked_at || null,
    revoke_reason: doc.revoke_reason || null,
  };
}

function mapSessionSecurityPolicyDoc(doc: any): PxmSessionSecurityPolicy {
  return {
    idle_timeout_minutes: Number(doc.idle_timeout_minutes),
    absolute_timeout_hours: Number(doc.absolute_timeout_hours),
    updated_by: doc.updated_by || null,
    updated_at: doc.updated_at,
  };
}

function mapServiceAccountDoc(doc: any): PxmServiceAccount {
  return {
    id: doc._id,
    name: doc.name,
    group_id: doc.group_id,
    description: doc.description || '',
    status: doc.status || 'active',
    created_by: doc.created_by || null,
    updated_by: doc.updated_by || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function mapApiKeyDoc(doc: any): PxmApiKey {
  return {
    id: doc._id,
    name: doc.name,
    owner_type: doc.owner_type,
    owner_id: doc.owner_id,
    group_id: doc.group_id,
    key_prefix: doc.key_prefix,
    key_hash: doc.key_hash,
    scopes: Array.isArray(doc.scopes) ? doc.scopes : [],
    allowed_workflow_ids: Array.isArray(doc.allowed_workflow_ids) ? doc.allowed_workflow_ids : [],
    ip_allowlist: Array.isArray(doc.ip_allowlist) ? doc.ip_allowlist : [],
    rate_limit_per_minute: Number(doc.rate_limit_per_minute) > 0 ? Number(doc.rate_limit_per_minute) : null,
    status: doc.status || 'active',
    expires_at: doc.expires_at || null,
    last_used_at: doc.last_used_at || null,
    created_by: doc.created_by || null,
    disabled_at: doc.disabled_at || null,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

function mapApiKeyUsageLogDoc(doc: any): PxmApiKeyUsageLog {
  return {
    id: doc._id,
    api_key_id: doc.api_key_id,
    owner_type: doc.owner_type,
    owner_id: doc.owner_id,
    group_id: doc.group_id,
    endpoint: doc.endpoint,
    workflow_id: doc.workflow_id || null,
    instance_id: doc.instance_id || null,
    request_id: doc.request_id || null,
    ip: doc.ip || null,
    user_agent: doc.user_agent || null,
    business_actor: doc.business_actor || null,
    created_at: doc.created_at,
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
      or.push({
        workspace_id: { $exists: false },
        'context.runtime.access.workspace_id': { $exists: false },
      });
    }
  }

  const manageableGroups = actorManagerGroupIds(actor);
  if (manageableGroups.length > 0) {
    or.push({ group_id: { $in: manageableGroups } });
    or.push({ 'context.runtime.access.group_id': { $in: manageableGroups } });
  }

  if (actor.roles.includes('workflow_owner') && actor.owned_workflow_ids.length > 0) {
    or.push({ process_definition_id: { $in: actor.owned_workflow_ids } });
  }

  const isSessionUser = !actor.api_key_id && actor.roles.includes('user');
  if (actorId && (actor.roles.includes('requester') || isSessionUser)) {
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

  if ((actor.roles.includes('user') || actor.actor_type === 'service_account') && (actor.scopes || []).includes('workflow:read') && actor.allowed_workflow_ids.length > 0) {
    or.push({ process_definition_id: { $in: actor.allowed_workflow_ids } });
  }

  return or.length > 0 ? { $or: or } : { _id: '__no_authorized_instances__' };
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

function mapTaskDoc(task: any) {
  return {
    id: task._id,
    instance_id: task.instance_id,
    token_id: task.token_id,
    approval_request_id: task.approval_request_id || null,
    approval_step_id: task.approval_step_id || null,
    node_id: task.node_id,
    assignee: task.assignee,
    status: task.status,
    payload: task.payload,
    completion: task.completion || null,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

function mapTaskHistoryMongo(task: any): WorkflowTaskHistoryItem {
  const completion = task.completion || task.payload?.completion || null;
  const external = task.payload?.external_approval || null;
  const node = (task.definition?.nodes || []).find((item: any) => item.node_id === task.node_id);
  return {
    task_id: String(task._id),
    instance_id: String(task.instance_id),
    workflow_id: task.effective_workflow_id ? String(task.effective_workflow_id) : null,
    workflow_name: task.instance?.context?.template_name || task.definition?.name || null,
    workflow_version: task.instance?.context?.runtime?.snapshot?.workflow?.version || task.instance?.workflow_version_id || task.definition?.version || null,
    group_id: task.effective_group_id ? String(task.effective_group_id) : null,
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
    created_at: String(task.created_at),
    updated_at: String(task.updated_at || task.created_at),
    completed_at: completion?.completed_at ? String(completion.completed_at) : null,
  };
}
