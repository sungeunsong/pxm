import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateInstanceDto } from './dto/create-instance.dto';
import { randomUUID } from 'crypto';
import {
  OutboxRepositoryPort,
  WorkflowHistoryActor,
  WorkflowInstanceAccess,
  WorkflowInstanceRepositoryPort,
  WorkflowRepositoryPort,
} from '../db/ports/db.ports';

@Injectable()
export class InstancesService {
  constructor(
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
    private readonly workflowRepo: WorkflowRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
  ) {}

  async createInstance(dto: CreateInstanceDto, access?: WorkflowInstanceAccess) {
    const instanceId = randomUUID();
    const definitionId = dto.template_id ?? randomUUID();
    const ctx = withAccess(dto.ctx ?? {}, access);

    // 1) V2 process instance 생성
    await this.instanceRepo.createInstance(
      instanceId,
      definitionId,
      'CREATED',
      ctx,
      access,
    );

    // 2) V2 engine job START 생성
    await this.instanceRepo.createJob({
      instanceId,
      type: 'START',
      runAt: new Date(),
      payload: { reason: 'api_create' },
    });

    // 3) V2 시작 토큰 생성 (Explicit Token 기반 구동용)
    const tokenId = randomUUID();
    await this.instanceRepo.createToken({
      id: tokenId,
      instanceId,
      nodeId: 'start', // 기본 시작 지점
      status: 'READY',
    });

    return { instance_id: instanceId };
  }

  async findAll(actor?: WorkflowHistoryActor) {
    return this.instanceRepo.listInstances(actor);
  }

  async findOne(id: string, actor?: WorkflowHistoryActor) {
    return this.getReadableInstance(id, actor);
  }

  async getResult(id: string, actor?: WorkflowHistoryActor) {
    const instance = await this.getReadableInstanceOrNull(id, actor);
    if (!instance) {
      return null;
    }

    const context = instance.context ?? instance.ctx ?? {};
    const result = context.result ?? context.data?.result ?? null;
    return {
      instance_id: id,
      status: instance.state ?? instance.status,
      result,
      result_path: context.result_path ?? null,
      completed_at: instance.completed_at ?? null,
      updated_at: instance.updated_at ?? null,
    };
  }

  async terminateInstance(id: string, actor?: WorkflowHistoryActor) {
    await this.ensureReadableInstance(id, actor);
    const terminated = await this.terminateInstanceRecursive(id, new Set<string>());
    return { success: true, instance_id: id, terminated_instances: terminated };
  }

  private async terminateInstanceRecursive(id: string, visited: Set<string>): Promise<string[]> {
    if (visited.has(id)) {
      return [];
    }
    visited.add(id);

    const instance = await this.instanceRepo.getInstance(id);
    if (!instance) {
      throw new NotFoundException('Instance not found');
    }

    const terminated: string[] = [];
    const status = String(instance.state ?? instance.status ?? '').toUpperCase();
    if (!['COMPLETED', 'FAILED', 'TERMINATED'].includes(status)) {
      await this.instanceRepo.updateInstanceStatus(id, 'TERMINATED');
      await this.instanceRepo.completeJobsForInstance(id);
      await this.outboxRepo.appendEvent(id, 'INSTANCE_TERMINATED', {
        reason: 'operator_terminated',
      });
      terminated.push(id);
    } else {
      await this.instanceRepo.completeJobsForInstance(id);
    }

    const children = await this.instanceRepo.listChildInstances(id);
    for (const child of children) {
      terminated.push(...(await this.terminateInstanceRecursive(child.id, visited)));
    }

    return terminated;
  }

  async previewRetry(
    id: string,
    mode: 'full_instance' | 'failed_node' = 'full_instance',
    actor?: WorkflowHistoryActor,
  ) {
    const analysis = await this.analyzeRetryTarget(id, mode, actor);
    const sideEffectWarnings =
      mode === 'failed_node'
        ? analysis.targetNode
          ? buildSideEffectWarnings([analysis.targetNode])
          : []
        : buildSideEffectWarnings(analysis.definition.nodes || []);
    return {
      instance_id: id,
      template_id: analysis.definition.id,
      template_name: analysis.definition.name,
      status: analysis.status,
      retry_mode: mode,
      can_retry: analysis.canRetry,
      reason: analysis.reason,
      target_node: analysis.targetNode
        ? {
            id: analysis.targetNode.id,
            label: analysis.targetNode.data?.label || analysis.targetNode.label || analysis.targetNode.id,
            type: analysis.targetNodeType,
          }
        : null,
      failed_event: analysis.failedEvent
        ? {
            type: analysis.failedEvent.type || analysis.failedEvent.event_type,
            node_id: analysis.failedEvent.node_id || null,
            node_label: analysis.failedEvent.node_label || null,
            reason: analysis.failedEvent.payload?.reason || null,
            created_at: analysis.failedEvent.created_at || null,
          }
        : null,
      form_data: analysis.context.data?.formData || {},
      context_summary: {
        data_keys: Object.keys(analysis.context.data || {}),
        output_keys: Object.keys(analysis.context.data?.outputs || {}),
        retry_history_count: Array.isArray(analysis.context.runtime?.retry_history)
          ? analysis.context.runtime.retry_history.length
          : 0,
      },
      side_effect_warnings: sideEffectWarnings,
      requires_confirmation: sideEffectWarnings.some((warning) => warning.severity === 'high'),
    };
  }

  async retryInstance(
    id: string,
    mode: 'full_instance' | 'failed_node' = 'full_instance',
    actor?: WorkflowHistoryActor,
  ) {
    if (mode === 'failed_node') {
      return this.retryFailedNode(id, actor);
    }

    const source = await this.getReadableInstance(id, actor);
    if (!source) {
      throw new NotFoundException('Instance not found');
    }

    const sourceStatus = String(source.state ?? source.status ?? '').toUpperCase();
    if (sourceStatus !== 'FAILED') {
      throw new BadRequestException('Only FAILED instances can be retried');
    }

    const definitionId = source.template_id ?? source.definition_id ?? source.process_definition_id;
    if (!definitionId) {
      throw new BadRequestException('Source instance has no workflow definition');
    }

    const definition = await this.workflowRepo.getDefinition(definitionId);
    if (!definition) {
      throw new NotFoundException('Workflow definition not found');
    }

    const startNode = (definition.nodes || []).find((node: any) => node?.data?.nodeType === 'start');
    if (!startNode) {
      throw new BadRequestException('Start node not found in workflow definition');
    }

    const sourceContext = source.context ?? source.ctx ?? {};
    const formData = sourceContext.data?.formData || {};
    const instanceId = randomUUID();
    const ctx = {
      runtime: {
        cursor: startNode.id,
        nodes: definition.nodes || [],
        edges: definition.edges || [],
        template_id: definition.id,
        template_name: definition.name,
        retry: {
          mode: 'full_instance',
          source_instance_id: id,
          requested_at: new Date().toISOString(),
        },
      },
      data: {
        formData,
        outputs: {},
      },
    };

    const access = accessFromInstance(source);
    await this.instanceRepo.createInstance(instanceId, definition.id, 'CREATED', withAccess(ctx, access), access);
    await this.instanceRepo.createJob({
      instanceId,
      type: 'START',
      runAt: new Date(),
      payload: {
        node_id: startNode.id,
        reason: 'instance_retry',
        source_instance_id: id,
        retry_mode: 'full_instance',
      },
    });
    await this.instanceRepo.createToken({
      id: randomUUID(),
      instanceId,
      nodeId: startNode.id,
      status: 'ACTIVE',
    });

    return {
      instance_id: instanceId,
      source_instance_id: id,
      template_id: definition.id,
      template_name: definition.name,
      status: 'CREATED',
      retry_mode: 'full_instance',
      trace_url: `/api/instances/${instanceId}/trace`,
      stream_url: `/api/instances/${instanceId}/stream`,
      result_url: `/api/instances/${instanceId}/result`,
    };
  }

  private async retryFailedNode(id: string, actor?: WorkflowHistoryActor) {
    const analysis = await this.analyzeRetryTarget(id, 'failed_node', actor);
    if (!analysis.canRetry) {
      throw new BadRequestException(analysis.reason || 'Failed-node retry is not available');
    }

    const instance = analysis.instance;
    const definition = analysis.definition;
    const failedNodeId = analysis.targetNode!.id;
    const failedNodeType = analysis.targetNodeType!;

    const tokenId = randomUUID();
    const context = analysis.context;
    const retryRecord = {
      mode: 'failed_node',
      node_id: failedNodeId,
      node_type: failedNodeType,
      requested_at: new Date().toISOString(),
    };
    const nextContext = {
      ...context,
      runtime: {
        ...(context.runtime || {}),
        retry: retryRecord,
        retry_history: [...(Array.isArray(context.runtime?.retry_history) ? context.runtime.retry_history : []), retryRecord],
      },
    };

    await this.instanceRepo.updateInstanceCtx(id, nextContext);
    await this.instanceRepo.updateInstanceStatus(id, 'RUNNING');
    await this.instanceRepo.createToken({
      id: tokenId,
      instanceId: id,
      nodeId: failedNodeId,
      status: 'ACTIVE',
    });
    await this.instanceRepo.createJob({
      instanceId: id,
      tokenId,
      type: 'RETRY',
      runAt: new Date(),
      payload: {
        node_id: failedNodeId,
        reason: 'failed_node_retry',
        retry_mode: 'failed_node',
      },
    });
    await this.outboxRepo.appendEvent(id, 'FAILED_NODE_RETRY_REQUESTED', {
      node_id: failedNodeId,
      node_type: failedNodeType,
      retry_mode: 'failed_node',
    });

    return {
      instance_id: id,
      template_id: definition.id,
      template_name: definition.name,
      status: 'RUNNING',
      retry_mode: 'failed_node',
      node_id: failedNodeId,
      node_type: failedNodeType,
      trace_url: `/api/instances/${id}/trace`,
      stream_url: `/api/instances/${id}/stream`,
      result_url: `/api/instances/${id}/result`,
    };
  }

  private async analyzeRetryTarget(
    id: string,
    mode: 'full_instance' | 'failed_node',
    actor?: WorkflowHistoryActor,
  ) {
    const instance = await this.getReadableInstance(id, actor);

    const status = String(instance.state ?? instance.status ?? '').toUpperCase();
    const definitionId = instance.template_id ?? instance.definition_id ?? instance.process_definition_id;
    if (!definitionId) {
      throw new BadRequestException('Instance has no workflow definition');
    }

    const definition = await this.workflowRepo.getDefinition(definitionId);
    if (!definition) {
      throw new NotFoundException('Workflow definition not found');
    }

    const context = instance.context ?? instance.ctx ?? {};
    const trace = await this.outboxRepo.fetchTrace(id, 500);
    const failedEvent = [...trace]
      .reverse()
      .find((event: any) => ['INSTANCE_FAILED', 'NODE_FAILED'].includes(event.type || event.event_type) && event.node_id);

    if (status !== 'FAILED') {
      return {
        instance,
        definition,
        context,
        status,
        failedEvent,
        canRetry: false,
        reason: 'Only FAILED instances can be retried',
        targetNode: null,
        targetNodeType: null,
      };
    }

    if (mode === 'full_instance') {
      const startNode = (definition.nodes || []).find((node: any) => node?.data?.nodeType === 'start');
      return {
        instance,
        definition,
        context,
        status,
        failedEvent,
        canRetry: Boolean(startNode),
        reason: startNode ? null : 'Start node not found in workflow definition',
        targetNode: startNode || null,
        targetNodeType: startNode ? 'start' : null,
      };
    }

    const failedNodeId = failedEvent?.node_id;
    if (!failedNodeId) {
      return {
        instance,
        definition,
        context,
        status,
        failedEvent,
        canRetry: false,
        reason: 'Failed node is not clear for this instance',
        targetNode: null,
        targetNodeType: null,
      };
    }

    const failedNode = (definition.nodes || []).find((node: any) => node.id === failedNodeId);
    const failedNodeType = failedNode?.data?.nodeType || failedNode?.node_type || failedNode?.type || null;
    const supported = ['service', 'script', 'command', 'workflow_call'].includes(failedNodeType);
    return {
      instance,
      definition,
      context,
      status,
      failedEvent,
      canRetry: Boolean(failedNode && supported),
      reason: failedNode
        ? supported
          ? null
          : 'Failed-node retry supports service/script/command/workflow_call nodes only'
        : 'Failed node is not found in workflow definition',
      targetNode: failedNode || null,
      targetNodeType: failedNodeType,
    };
  }

  async ensureReadableInstance(id: string, actor?: WorkflowHistoryActor): Promise<void> {
    await this.getReadableInstance(id, actor);
  }

  private async getReadableInstance(id: string, actor?: WorkflowHistoryActor): Promise<any> {
    const instance = await this.getReadableInstanceOrNull(id, actor);
    if (!instance) {
      throw new NotFoundException('Instance not found');
    }
    return instance;
  }

  private async getReadableInstanceOrNull(id: string, actor?: WorkflowHistoryActor): Promise<any | null> {
    const instance = await this.instanceRepo.getInstance(id);
    if (!instance || !canReadInstance(instance, actor)) {
      return null;
    }
    return instance;
  }
}

function withAccess(ctx: any, access?: WorkflowInstanceAccess): any {
  if (!access) {
    return ctx;
  }
  return {
    ...ctx,
    runtime: {
      ...(ctx?.runtime || {}),
      access,
    },
  };
}

function accessFromInstance(instance: any): WorkflowInstanceAccess {
  const access = instance.context?.runtime?.access || instance.ctx?.runtime?.access || {};
  return {
    workspace_id: instance.workspace_id || access.workspace_id,
    requester_id: instance.requester_id || access.requester_id || null,
    client_id: instance.client_id || access.client_id || null,
    approver_ids: instance.approver_ids || access.approver_ids || [],
  };
}

function canReadInstance(instance: any, actor?: WorkflowHistoryActor): boolean {
  if (!actor) {
    return true;
  }

  const roles = new Set(actor.roles || []);
  if (roles.has('admin')) {
    return true;
  }

  const access = accessFromInstance(instance);
  const workspaceId = access.workspace_id || 'default';
  const definitionId = String(instance.process_definition_id || instance.definition_id || instance.template_id || '');
  const instanceId = String(instance.id || instance._id || '');
  const actorId = actor.actor_id;

  if (roles.has('operator') && actor.workspace_ids.includes(workspaceId)) {
    return true;
  }
  if (roles.has('workflow_owner') && actor.owned_workflow_ids.includes(definitionId)) {
    return true;
  }
  if (actorId && roles.has('requester') && access.requester_id === actorId) {
    return true;
  }
  if (actorId && roles.has('approver') && (access.approver_ids || []).includes(actorId)) {
    return true;
  }
  if (roles.has('api_client')) {
    return Boolean(
      (actorId && access.client_id === actorId) ||
        actor.allowed_instance_ids.includes(instanceId) ||
        actor.allowed_workflow_ids.includes(definitionId),
    );
  }

  return false;
}

function buildSideEffectWarnings(nodes: any[]) {
  return nodes
    .map((node) => detectSideEffect(node))
    .filter((warning): warning is NonNullable<ReturnType<typeof detectSideEffect>> => Boolean(warning));
}

function detectSideEffect(node: any): {
  node_id: string;
  node_label: string;
  node_type: string;
  severity: 'low' | 'high';
  message: string;
} | null {
  const data = node?.data || node?.config || {};
  const nodeType = data.nodeType || node?.node_type || node?.type || '';
  const label = data.label || node?.label || node?.id || 'Unknown node';

  if (nodeType === 'script') {
    return {
      node_id: node.id,
      node_label: label,
      node_type: nodeType,
      severity: 'low',
      message: 'Script 노드는 외부 호출/쓰기 로직을 포함할 수 있습니다.',
    };
  }

  if (nodeType === 'workflow_call') {
    return {
      node_id: node.id,
      node_label: label,
      node_type: nodeType,
      severity: 'low',
      message: 'Workflow Call 노드는 자식 워크플로우 실행을 다시 생성할 수 있습니다.',
    };
  }

  if (nodeType === 'command') {
    return {
      node_id: node.id,
      node_label: label,
      node_type: nodeType,
      severity: 'high',
      message: 'Command 노드는 allowlist 명령을 다시 실행할 수 있습니다.',
    };
  }

  if (nodeType !== 'service') {
    return null;
  }

  const pluginId = data.plugin_id || data.pluginId || '';
  if (pluginId === 'builtin.http_request') {
    const method = String(data.method || 'GET').toUpperCase();
    const highRiskMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    return {
      node_id: node.id,
      node_label: label,
      node_type: nodeType,
      severity: highRiskMethods.includes(method) ? 'high' : 'low',
      message: highRiskMethods.includes(method)
        ? `HTTP ${method} 요청은 외부 시스템에 변경을 다시 보낼 수 있습니다.`
        : `HTTP ${method} 요청은 외부 시스템을 다시 호출합니다.`,
    };
  }

  if (pluginId.includes('mongodb') || pluginId.includes('db')) {
    const operation = String(data.operation || data.action || '').toLowerCase();
    const highRiskOperations = ['insert', 'update', 'delete', 'replace', 'write', 'aggregate_write'];
    return {
      node_id: node.id,
      node_label: label,
      node_type: nodeType,
      severity: highRiskOperations.includes(operation) ? 'high' : 'low',
      message: highRiskOperations.includes(operation)
        ? `DB ${operation} 작업은 데이터를 다시 변경할 수 있습니다.`
        : 'DB 노드는 외부 저장소를 다시 조회하거나 사용할 수 있습니다.',
    };
  }

  if (pluginId.includes('command') || pluginId.includes('executable')) {
    return {
      node_id: node.id,
      node_label: label,
      node_type: nodeType,
      severity: 'high',
      message: 'Command/Executable 노드는 외부 명령을 다시 실행할 수 있습니다.',
    };
  }

  return {
    node_id: node.id,
    node_label: label,
    node_type: nodeType,
    severity: 'low',
    message: 'Service 노드는 외부 시스템 호출을 다시 수행할 수 있습니다.',
  };
}
