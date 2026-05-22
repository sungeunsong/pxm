import { Inject, Injectable } from '@nestjs/common';
import { Db } from 'mongodb';
import { MONGO_DB } from '../mongo.provider';
import {
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

  // ==========================================
  // WorkflowRepositoryPort 구현 (V2 정의 대응)
  // ==========================================
  async createDefinition(
    id: string,
    name: string,
    nodes: any[],
    edges: any[],
  ): Promise<void> {
    const formattedNodes = nodes.map((n) => ({
      node_id: n.id,
      node_type: n.data?.nodeType || 'task',
      config: n,
    }));

    const formattedEdges = edges.map((e, idx) => ({
      id: e.id || crypto.randomUUID(),
      source_node_id: e.source,
      target_node_id: e.target,
      condition_expr: e.data?.condition || null,
      is_default: e.data?.isDefault || false,
      eval_order: idx,
    }));

    const now = new Date().toISOString();

    await this.db.collection<any>('v2_process_definitions').updateOne(
      { _id: id },
      {
        $set: {
          name,
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
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      nodes: (doc.nodes || []).map((n: any) => n.config),
      edges: (doc.edges || []).map((e: any) => ({
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
      status: token.status,
      parent_token_id: token.parentTokenId || null,
      scope_key: token.scopeKey || null,
      created_at: now,
      updated_at: now,
    });
  }

  async createJob(job: {
    instanceId: string;
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
      token_id: null,
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
        created_at: t.created_at,
        updated_at: t.updated_at,
        form_data: inst?.context?.formData || null,
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
    const docs = await this.db
      .collection<any>('v2_event_outbox')
      .find({ instance_id: instanceId })
      .sort({ created_at: 1 })
      .toArray();

    const mapped = docs.map((doc, idx) => {
      const virtualId = idx + 1;
      return {
        id: virtualId,
        instance_id: doc.instance_id,
        event_type: doc.event_type,
        payload: doc.payload,
        created_at: doc.created_at,
      };
    });

    return mapped.filter((item) => item.id > afterId).slice(0, limit);
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
