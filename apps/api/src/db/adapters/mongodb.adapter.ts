import { Inject, Injectable } from '@nestjs/common';
import { Db } from 'mongodb';
import { MONGO_DB } from '../mongo.provider';
import {
  WorkflowDefinitionMetadata,
  WorkflowRepositoryPort,
  WorkflowInstanceRepositoryPort,
  WorkflowTaskRepositoryPort,
  OutboxRepositoryPort,
} from '../ports/db.ports';

@Injectable()
export class MongodbAdapter
  implements
    WorkflowRepositoryPort,
    WorkflowInstanceRepositoryPort,
    WorkflowTaskRepositoryPort,
    OutboxRepositoryPort
{
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

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

    await this.db.collection<any>('v2_process_definitions').updateOne(
      { _id: id },
      {
        $set: {
          name,
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
  }

  async listDefinitions(): Promise<any[]> {
    const docs = await this.db
      .collection<any>('v2_process_definitions')
      .find({})
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
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }));
  }

  async getDefinition(id: string): Promise<any> {
    const doc = await this.db
      .collection<any>('v2_process_definitions')
      .findOne({ _id: id });

    if (!doc) return null;

    return {
      id: doc._id,
      name: doc.name,
      description: doc.description || doc.metadata?.description || '',
      group: doc.group || doc.metadata?.group || '',
      tags: doc.tags || doc.metadata?.tags || [],
      version_note: doc.version_note || doc.metadata?.version_note || '',
      metadata: doc.metadata || {},
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
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.collection<any>('v2_process_instances').insertOne({
      _id: id,
      process_definition_id: definitionId,
      state: status,
      status: status,
      context: ctx,
      lock_owner: null,
      lock_until: null,
      heartbeat_at: null,
      created_at: now,
      updated_at: now,
    });
  }

  async listInstances(): Promise<any[]> {
    const instances = await this.db
      .collection<any>('v2_process_instances')
      .find({})
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
        status: inst.status,
        context: inst.context,
        created_at: inst.created_at,
        updated_at: inst.updated_at,
        template_name: templateName,
        template_id: inst.process_definition_id,
        ctx: inst.context,
      });
    }
    return result;
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
      status: inst.status,
      context: inst.context,
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
}
