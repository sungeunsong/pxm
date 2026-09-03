import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateInstanceDto } from './dto/create-instance.dto';
import { createHash, randomUUID } from 'crypto';
import { OutboxRepositoryPort, WorkflowHistoryActor, WorkflowInstanceAccess, WorkflowInstanceRepositoryPort, WorkflowRepositoryPort } from '../db/ports/db.ports';
import {
  externalApprovalIdempotencyTtlMs,
  externalApprovalKeyHash,
  externalApprovalRequestHash,
  dynamicApprovalRequestPath,
  normalizeExternalApprovalRequest,
} from './external-approval-start';
import { AuthzService } from '../authz/authz.service';

@Injectable()
export class InstancesService {
  constructor(
    private readonly instanceRepo: WorkflowInstanceRepositoryPort,
    private readonly workflowRepo: WorkflowRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly authzService: AuthzService,
  ) {}

  async createInstance(dto: CreateInstanceDto, access?: WorkflowInstanceAccess) {
    const instanceId = randomUUID();
    const definitionId = dto.template_id;
    if (!definitionId) throw new BadRequestException('template_id is required');
    const definition = await this.workflowRepo.getPublishedDefinition(definitionId);
    if (!definition) throw new BadRequestException('Workflow is not published or is disabled');
    const startNode = (definition.nodes || []).find((node: any) => node?.data?.nodeType === 'start');
    if (!startNode) throw new BadRequestException('Start node not found');
    const versionAccess = {
      ...(access || {}),
      group_id: definition.group_id || access?.group_id || null,
      workflow_version_id: `${definition.id}:${definition.version || 1}`,
    };
    const input = dto.ctx ?? {};
    const formData = input.data?.formData || input.formData;
    const approvalRequestPath = dynamicApprovalRequestPath(definition.nodes || []);
    const externalApproval =
      formData && typeof formData === 'object' && !Array.isArray(formData)
        ? normalizeExternalApprovalRequest(formData, approvalRequestPath)
        : null;
    const externalApprovalRequestDigest = externalApproval
      ? externalApprovalRequestHash(definitionId, formData, approvalRequestPath)
      : null;
    if (externalApproval) {
      await this.authzService.resolveExternalApprovalPrincipals(
        formData,
        approvalRequestPath,
        versionAccess.group_id,
        definition.nodes || [],
      );
    }
    const ctx = withAccess(
      {
        ...input,
        runtime: {
          ...(input.runtime || {}),
          cursor: startNode.id,
          nodes: definition.nodes || [],
          edges: definition.edges || [],
          template_id: definition.id,
          template_name: definition.name,
          snapshot: {
            ...(input.runtime?.snapshot || {}),
            workflow: {
              id: definition.id,
              name: definition.name,
              version: definition.version || 1,
            },
          },
        },
      },
      versionAccess,
    );

    const tokenId = randomUUID();
    if (externalApproval) {
      const keyHash = externalApprovalKeyHash(externalApproval);
      const requestHash = externalApprovalRequestDigest!;
      const result = await this.instanceRepo.createIdempotentStart({
        key_hash: keyHash,
        request_hash: requestHash,
        expires_at: new Date(Date.now() + externalApprovalIdempotencyTtlMs()),
        instance: { id: instanceId, definition_id: definitionId, status: 'CREATED', context: ctx, access: versionAccess },
        token: { id: tokenId, node_id: startNode.id, status: 'ACTIVE' },
        job: { type: 'START', run_at: new Date(), payload: { node_id: startNode.id, reason: 'api_create' } },
      });
      if (result.outcome === 'conflict') {
        throw new ConflictException(
          'External approval request key was already used with different workflow input; increment revision to resubmit',
        );
      }
      return {
        instance_id: result.instance_id,
        idempotent_replay: result.outcome === 'replayed',
        external_approval_key: {
          provider: externalApproval.provider,
          request_id: externalApproval.requestId,
          revision: externalApproval.revision,
        },
      };
    }

    await this.instanceRepo.executeInstanceMutation({
      create_instances: [{ id: instanceId, definition_id: definitionId, status: 'CREATED', context: ctx, access: versionAccess }],
      tokens: [{ id: tokenId, instance_id: instanceId, node_id: startNode.id, status: 'ACTIVE' }],
      jobs: [{ instance_id: instanceId, type: 'START', run_at: new Date(), payload: { node_id: startNode.id, reason: 'api_create' } }],
    });

    return { instance_id: instanceId };
  }

  async findAll(actor?: WorkflowHistoryActor) {
    return this.instanceRepo.listInstances(actor);
  }

  async getStats(actor?: WorkflowHistoryActor) {
    return this.instanceRepo.getInstanceStats(actor);
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

  async getTerminalOutputs(
    id: string,
    options: {
      nodeId?: string;
      after?: number;
      actor?: WorkflowHistoryActor;
    } = {},
  ) {
    const instance = await this.getReadableInstance(id, options.actor);
    const context = instance.context ?? instance.ctx ?? {};
    const trace = await this.outboxRepo.fetchTrace(id, 500);
    const commandNodes = collectCommandNodes(context, trace);
    const outputs = [...commandNodes.values()]
      .map((node) => buildTerminalOutputSnapshot(context, trace, node))
      .filter((item) => item)
      .filter((item) => !options.nodeId || item!.node_id === options.nodeId)
      .filter((item) => !options.after || (item!.last_event_id ?? 0) > options.after)
      .map((item) => item!);
    const latestEventId = trace.reduce((max, event) => Math.max(max, Number(event.id || 0)), 0);

    return {
      instance_id: id,
      status: instance.state ?? instance.status,
      poll_after: latestEventId,
      outputs,
    };
  }

  async scrubTerminalOutputs(options: { instanceId?: string; olderThanDays?: number; dryRun?: boolean; limit?: number; actor?: WorkflowHistoryActor }) {
    const olderThanDays = clampRetentionDays(options.olderThanDays, Number(process.env.TERMINAL_OUTPUT_RETENTION_DAYS ?? 7));
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const dryRun = options.dryRun === true;
    const limit = Math.min(Math.max(Number(options.limit || 50), 1), 500);
    const candidates = options.instanceId ? [await this.getReadableInstance(options.instanceId, options.actor)] : (await this.findAll(options.actor)).slice(0, limit);

    const results: Array<{
      instance_id: string;
      status: string;
      updated_at?: string;
      scrubbed_outputs: number;
      scrubbed_bytes: number;
      skipped_reason?: string;
    }> = [];

    for (const instance of candidates) {
      const instanceId = String(instance.id || instance._id || instance.instance_id);
      const updatedAt = parseDate(instance.updated_at || instance.completed_at || instance.created_at);
      const status = String(instance.state || instance.status || '').toUpperCase();
      if (!options.instanceId && updatedAt && updatedAt > cutoff) {
        results.push({
          instance_id: instanceId,
          status,
          updated_at: instance.updated_at,
          scrubbed_outputs: 0,
          scrubbed_bytes: 0,
          skipped_reason: 'newer_than_cutoff',
        });
        continue;
      }

      const context = instance.context ?? instance.ctx ?? {};
      const scrubbed = scrubContextTerminalOutputs(context, {
        scrubbedAt: new Date().toISOString(),
        retentionDays: olderThanDays,
      });
      if (scrubbed.scrubbedOutputs > 0 && !dryRun) {
        await this.instanceRepo.updateInstanceCtx(instanceId, context);
      }
      results.push({
        instance_id: instanceId,
        status,
        updated_at: instance.updated_at,
        scrubbed_outputs: scrubbed.scrubbedOutputs,
        scrubbed_bytes: scrubbed.scrubbedBytes,
        skipped_reason: scrubbed.scrubbedOutputs > 0 ? undefined : 'no_terminal_output',
      });
    }

    return {
      retention: {
        terminal_output_days: olderThanDays,
        audit_log_days: process.env.AUDIT_LOG_RETENTION_DAYS || 'unbounded',
        cutoff_at: cutoff.toISOString(),
        dry_run: dryRun,
      },
      scanned: candidates.length,
      scrubbed_instances: results.filter((item) => item.scrubbed_outputs > 0).length,
      scrubbed_outputs: results.reduce((sum, item) => sum + item.scrubbed_outputs, 0),
      scrubbed_bytes: results.reduce((sum, item) => sum + item.scrubbed_bytes, 0),
      results,
    };
  }

  async terminateInstance(id: string, actor?: WorkflowHistoryActor, idempotencyKey?: string) {
    await this.ensureReadableInstance(id, actor);
    const key = normalizeIdempotencyKey(idempotencyKey);
    if (key) {
      const hashes = instanceCommandHashes(actor, id, 'terminate', key, { command: 'terminate' });
      const existing = await this.instanceRepo.getIdempotentCommand(hashes.key_hash, hashes.request_hash);
      if (existing.outcome === 'replayed') return { ...existing.result, idempotent_replay: true };
      if (existing.outcome === 'conflict') throw new ConflictException('Idempotency-Key was already used with a different terminate request');
      const targets = await this.collectTerminationTargets(id, new Set<string>());
      const terminated = targets.filter((target) => target.shouldTerminate).map((target) => target.id);
      const response = { success: true, instance_id: id, terminated_instances: terminated };
      const command = await this.instanceRepo.executeIdempotentCommand({
        ...hashes,
        expires_at: new Date(Date.now() + instanceCommandIdempotencyTtlMs()),
        result: response,
        update_instances: targets.map((target) => ({
          id: target.id,
          status: target.shouldTerminate ? 'TERMINATED' : undefined,
          complete_jobs: true,
          cancel_approvals: target.shouldTerminate,
        })),
        events: terminated.map((instanceId) => ({
          instance_id: instanceId,
          event_type: 'INSTANCE_TERMINATED',
          payload: { reason: 'operator_terminated' },
        })),
      });
      if (command.outcome === 'conflict') throw new ConflictException('Idempotency-Key was already used with a different terminate request');
      return { ...command.result, idempotent_replay: command.outcome === 'replayed' };
    }
    const targets = await this.collectTerminationTargets(id, new Set<string>());
    const terminated = targets.filter((target) => target.shouldTerminate).map((target) => target.id);
    await this.instanceRepo.executeInstanceMutation({
      update_instances: targets.map((target) => ({
        id: target.id,
        status: target.shouldTerminate ? 'TERMINATED' : undefined,
        complete_jobs: true,
        cancel_approvals: target.shouldTerminate,
      })),
      events: terminated.map((instanceId) => ({
        instance_id: instanceId,
        event_type: 'INSTANCE_TERMINATED',
        payload: { reason: 'operator_terminated' },
      })),
    });
    return { success: true, instance_id: id, terminated_instances: terminated, idempotent_replay: false };
  }

  async setInstancePaused(id: string, paused: boolean, actor?: WorkflowHistoryActor, idempotencyKey?: string) {
    const instance = await this.getReadableInstance(id, actor);
    const runtimeState = String(instance.state ?? instance.status ?? '').toUpperCase();
    if (['COMPLETED', 'FAILED', 'TERMINATED'].includes(runtimeState)) {
      throw new ConflictException(`Cannot ${paused ? 'pause' : 'resume'} a terminal instance`);
    }

    const currentPaused = instance.is_paused === true;
    const pauseTargets = await this.collectPauseTargets(id, id, paused, new Set<string>());
    const changedTargets = pauseTargets.filter((target) => target.changed);
    const response = {
      success: true,
      instance_id: id,
      paused,
      runtime_state: runtimeState,
      changed: currentPaused !== paused || changedTargets.length > 0,
      affected_instance_ids: changedTargets.map((target) => target.id),
    };
    const key = normalizeIdempotencyKey(idempotencyKey);
    const command = paused ? 'pause' : 'resume';
    const hashes = key ? instanceCommandHashes(actor, id, command, key, { command }) : null;

    if (hashes) {
      const existing = await this.instanceRepo.getIdempotentCommand(hashes.key_hash, hashes.request_hash);
      if (existing.outcome === 'replayed') return { ...existing.result, idempotent_replay: true };
      if (existing.outcome === 'conflict') {
        throw new ConflictException(`Idempotency-Key was already used with a different ${command} request`);
      }
    }

    const actorId = actor?.api_key_id || actor?.actor_id || null;
    const mutation = {
      update_instances: changedTargets.map((target) => ({
        id: target.id,
        paused,
        paused_by: paused ? actorId : null,
        pause_origin_instance_id: paused ? id : null,
      })),
      events: changedTargets.map((target) => ({
        instance_id: target.id,
        event_type: paused ? 'INSTANCE_PAUSED' : 'INSTANCE_RESUMED',
        payload: {
          reason: paused ? 'operator_paused' : 'operator_resumed',
          runtime_state: target.runtimeState,
          actor_id: actorId,
          pause_origin_instance_id: id,
          in_flight_policy: 'finish_current_transaction',
        },
      })),
    };

    if (hashes) {
      const result = await this.instanceRepo.executeIdempotentCommand({
        ...hashes,
        expires_at: new Date(Date.now() + instanceCommandIdempotencyTtlMs()),
        result: response,
        ...mutation,
      });
      if (result.outcome === 'conflict') {
        throw new ConflictException(`Idempotency-Key was already used with a different ${command} request`);
      }
      return { ...result.result, idempotent_replay: result.outcome === 'replayed' };
    }

    if (!response.changed) {
      return { ...response, idempotent_replay: false };
    }
    await this.instanceRepo.executeInstanceMutation(mutation);
    return { ...response, idempotent_replay: false };
  }

  private async collectPauseTargets(
    id: string,
    rootId: string,
    paused: boolean,
    visited: Set<string>,
  ): Promise<Array<{ id: string; runtimeState: string; changed: boolean }>> {
    if (visited.has(id)) return [];
    visited.add(id);
    const instance = await this.instanceRepo.getInstance(id);
    if (!instance) return [];
    const runtimeState = String(instance.state ?? instance.status ?? '').toUpperCase();
    const terminal = ['COMPLETED', 'FAILED', 'TERMINATED'].includes(runtimeState);
    const changed = paused
      ? !terminal && instance.is_paused !== true
      : instance.is_paused === true && (id === rootId || instance.pause_origin_instance_id === rootId);
    const targets = [{ id, runtimeState, changed }];
    for (const child of await this.instanceRepo.listChildInstances(id)) {
      targets.push(...(await this.collectPauseTargets(String(child.id || child._id), rootId, paused, visited)));
    }
    return targets;
  }

  private async collectTerminationTargets(id: string, visited: Set<string>): Promise<Array<{ id: string; shouldTerminate: boolean }>> {
    if (visited.has(id)) return [];
    visited.add(id);
    const instance = await this.instanceRepo.getInstance(id);
    if (!instance) throw new NotFoundException('Instance not found');
    const status = String(instance.state ?? instance.status ?? '').toUpperCase();
    const targets = [{ id, shouldTerminate: !['COMPLETED', 'FAILED', 'TERMINATED'].includes(status) }];
    for (const child of await this.instanceRepo.listChildInstances(id)) {
      targets.push(...(await this.collectTerminationTargets(child.id, visited)));
    }
    return targets;
  }

  async previewRetry(id: string, mode: 'full_instance' | 'failed_node' = 'full_instance', actor?: WorkflowHistoryActor) {
    const analysis = await this.analyzeRetryTarget(id, mode, actor);
    const sideEffectWarnings = mode === 'failed_node' ? (analysis.targetNode ? buildSideEffectWarnings([analysis.targetNode]) : []) : buildSideEffectWarnings(analysis.definition.nodes || []);
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
        retry_history_count: Array.isArray(analysis.context.runtime?.retry_history) ? analysis.context.runtime.retry_history.length : 0,
      },
      side_effect_warnings: sideEffectWarnings,
      requires_confirmation: sideEffectWarnings.some((warning) => warning.severity === 'high'),
    };
  }

  async retryInstance(id: string, mode: 'full_instance' | 'failed_node' = 'full_instance', actor?: WorkflowHistoryActor, idempotencyKey?: string) {
    const key = normalizeIdempotencyKey(idempotencyKey);
    const hashes = key ? instanceCommandHashes(actor, id, 'retry', key, { command: 'retry', mode }) : null;
    if (hashes) {
      await this.ensureReadableInstance(id, actor);
      const existing = await this.instanceRepo.getIdempotentCommand(hashes.key_hash, hashes.request_hash);
      if (existing.outcome === 'replayed') return { ...existing.result, idempotent_replay: true };
      if (existing.outcome === 'conflict') throw new ConflictException('Idempotency-Key was already used with a different retry request');
    }
    if (mode === 'failed_node') {
      return this.retryFailedNode(id, actor, key, hashes);
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

    const sourceContext = source.context ?? source.ctx ?? {};
    const sourceVersion = workflowVersionFromContext(sourceContext);
    const definition = sourceVersion ? await this.workflowRepo.getDefinitionVersion(definitionId, sourceVersion) : await this.workflowRepo.getDefinition(definitionId);
    if (!definition) {
      throw new NotFoundException('Workflow definition not found');
    }

    const startNode = (definition.nodes || []).find((node: any) => node?.data?.nodeType === 'start');
    if (!startNode) {
      throw new BadRequestException('Start node not found in workflow definition');
    }

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
    const tokenId = randomUUID();
    const response = {
      instance_id: instanceId,
      source_instance_id: id,
      template_id: definition.id,
      template_name: definition.name,
      status: 'CREATED',
      retry_mode: 'full_instance',
      trace_url: `/api/v1/instances/${instanceId}/trace`,
      stream_url: `/api/v1/instances/${instanceId}/stream`,
      result_url: `/api/v1/instances/${instanceId}/result`,
    };
    if (key) {
      const command = await this.instanceRepo.executeIdempotentCommand({
        ...hashes!,
        expires_at: new Date(Date.now() + instanceCommandIdempotencyTtlMs()),
        result: response,
        create_instances: [{ id: instanceId, definition_id: definition.id, status: 'CREATED', context: withAccess(ctx, access), access }],
        tokens: [{ id: tokenId, instance_id: instanceId, node_id: startNode.id, status: 'ACTIVE' }],
        jobs: [{
          instance_id: instanceId,
          type: 'START',
          run_at: new Date(),
          payload: { node_id: startNode.id, reason: 'instance_retry', source_instance_id: id, retry_mode: 'full_instance' },
        }],
      });
      if (command.outcome === 'conflict') throw new ConflictException('Idempotency-Key was already used with a different retry request');
      return { ...command.result, idempotent_replay: command.outcome === 'replayed' };
    }
    await this.instanceRepo.executeInstanceMutation({
      create_instances: [{ id: instanceId, definition_id: definition.id, status: 'CREATED', context: withAccess(ctx, access), access }],
      tokens: [{ id: tokenId, instance_id: instanceId, node_id: startNode.id, status: 'ACTIVE' }],
      jobs: [{
        instance_id: instanceId,
        type: 'START',
        run_at: new Date(),
        payload: { node_id: startNode.id, reason: 'instance_retry', source_instance_id: id, retry_mode: 'full_instance' },
      }],
    });

    return { ...response, idempotent_replay: false };
  }

  private async retryFailedNode(
    id: string,
    actor?: WorkflowHistoryActor,
    idempotencyKey?: string | null,
    hashes?: ReturnType<typeof instanceCommandHashes> | null,
  ) {
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

    const response = {
      instance_id: id,
      template_id: definition.id,
      template_name: definition.name,
      status: 'RUNNING',
      retry_mode: 'failed_node',
      node_id: failedNodeId,
      node_type: failedNodeType,
      trace_url: `/api/v1/instances/${id}/trace`,
      stream_url: `/api/v1/instances/${id}/stream`,
      result_url: `/api/v1/instances/${id}/result`,
    };
    if (idempotencyKey) {
      const command = await this.instanceRepo.executeIdempotentCommand({
        ...(hashes || instanceCommandHashes(actor, id, 'retry', idempotencyKey, { command: 'retry', mode: 'failed_node' })),
        expires_at: new Date(Date.now() + instanceCommandIdempotencyTtlMs()),
        result: response,
        update_instances: [{ id, status: 'RUNNING', context: nextContext }],
        tokens: [{ id: tokenId, instance_id: id, node_id: failedNodeId, status: 'ACTIVE' }],
        jobs: [{
          instance_id: id,
          token_id: tokenId,
          type: 'RETRY',
          run_at: new Date(),
          payload: { node_id: failedNodeId, reason: 'failed_node_retry', retry_mode: 'failed_node' },
        }],
        events: [{
          instance_id: id,
          event_type: 'FAILED_NODE_RETRY_REQUESTED',
          payload: { node_id: failedNodeId, node_type: failedNodeType, retry_mode: 'failed_node' },
        }],
      });
      if (command.outcome === 'conflict') throw new ConflictException('Idempotency-Key was already used with a different retry request');
      return { ...command.result, idempotent_replay: command.outcome === 'replayed' };
    }

    await this.instanceRepo.executeInstanceMutation({
      update_instances: [{ id, status: 'RUNNING', context: nextContext }],
      tokens: [{ id: tokenId, instance_id: id, node_id: failedNodeId, status: 'ACTIVE' }],
      jobs: [{
        instance_id: id,
        token_id: tokenId,
        type: 'RETRY',
        run_at: new Date(),
        payload: { node_id: failedNodeId, reason: 'failed_node_retry', retry_mode: 'failed_node' },
      }],
      events: [{
        instance_id: id,
        event_type: 'FAILED_NODE_RETRY_REQUESTED',
        payload: { node_id: failedNodeId, node_type: failedNodeType, retry_mode: 'failed_node' },
      }],
    });

    return { ...response, idempotent_replay: false };
  }

  private async analyzeRetryTarget(id: string, mode: 'full_instance' | 'failed_node', actor?: WorkflowHistoryActor) {
    const instance = await this.getReadableInstance(id, actor);

    const status = String(instance.state ?? instance.status ?? '').toUpperCase();
    const definitionId = instance.template_id ?? instance.definition_id ?? instance.process_definition_id;
    if (!definitionId) {
      throw new BadRequestException('Instance has no workflow definition');
    }

    const context = instance.context ?? instance.ctx ?? {};
    const sourceVersion = workflowVersionFromContext(context);
    const definition = sourceVersion ? await this.workflowRepo.getDefinitionVersion(definitionId, sourceVersion) : await this.workflowRepo.getDefinition(definitionId);
    if (!definition) {
      throw new NotFoundException('Workflow definition not found');
    }

    const trace = await this.outboxRepo.fetchTrace(id, 500);
    const failedEvent = [...trace].reverse().find((event: any) => ['INSTANCE_FAILED', 'NODE_FAILED'].includes(event.type || event.event_type) && event.node_id);

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
      reason: failedNode ? (supported ? null : 'Failed-node retry supports service/script/command/workflow_call nodes only') : 'Failed node is not found in workflow definition',
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
    group_id: instance.group_id || access.group_id || null,
    requester_id: instance.requester_id || access.requester_id || null,
    client_id: instance.client_id || access.client_id || null,
    approver_ids: instance.approver_ids || access.approver_ids || [],
    caller: instance.caller || access.caller || null,
    business_actor: instance.business_actor || access.business_actor || null,
    workflow_version_id: instance.workflow_version_id || access.workflow_version_id || null,
  };
}

function workflowVersionFromContext(context: any): number | null {
  const snapshotVersion = Number(context?.runtime?.snapshot?.workflow?.version);
  if (Number.isInteger(snapshotVersion) && snapshotVersion > 0) return snapshotVersion;
  const versionId = context?.runtime?.access?.workflow_version_id;
  const parsed = Number.parseInt(
    String(versionId || '')
      .split(':')
      .at(-1) || '',
    10,
  );
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
  if (access.group_id && (actor.group_roles?.[access.group_id] === 'group_manager' || (!actor.group_roles && roles.has('group_manager') && actor.group_ids?.includes(access.group_id)))) {
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
    return Boolean((actorId && access.client_id === actorId) || actor.allowed_instance_ids.includes(instanceId) || actor.allowed_workflow_ids.includes(definitionId));
  }
  if ((roles.has('user') || actor.actor_type === 'service_account') && (actor.scopes || []).includes('workflow:read') && actor.allowed_workflow_ids.includes(definitionId)) {
    return true;
  }

  return false;
}

function collectCommandNodes(context: any, trace: any[]): Map<string, any> {
  const nodes = new Map<string, any>();
  for (const node of context?.runtime?.nodes || []) {
    const data = node?.data || node?.config || {};
    const nodeType = data.nodeType || node?.node_type || node?.type;
    if (nodeType === 'command') {
      nodes.set(String(node.id || node.node_id), node);
    }
  }

  for (const event of trace || []) {
    const nodeId = event.node_id || event.payload?.node_id;
    const commandId = event.payload?.command_id;
    if (!nodeId || !commandId) {
      continue;
    }
    nodes.set(
      String(nodeId),
      nodes.get(String(nodeId)) || {
        id: String(nodeId),
        data: {
          nodeType: 'command',
          label: event.node_label || String(nodeId),
          commandId,
          outputPath: event.payload?.output_path,
        },
      },
    );
  }

  return nodes;
}

function buildTerminalOutputSnapshot(context: any, trace: any[], node: any) {
  const nodeId = String(node.id || node.node_id);
  const data = node.data || node.config || {};
  const relatedEvents = [...(trace || [])].filter((event) => event.node_id === nodeId || event.payload?.node_id === nodeId);
  const latestCommandEvent = [...relatedEvents].reverse().find((event) => event.payload?.command_id || event.type === 'NODE_COMPLETED' || event.event_type === 'NODE_COMPLETED');
  const outputPath = latestCommandEvent?.payload?.output_path || data.outputPath || data.output_path || `commandResults.${nodeId}`;
  const output = getContextValueAtPath(context, outputPath) || getContextValueAtPath(context, `data.outputs.${outputPath}`);
  const status = String(latestCommandEvent?.type || latestCommandEvent?.event_type || '').includes('FAILED') ? 'FAILED' : output ? 'COMPLETED' : 'PENDING';

  return {
    node_id: nodeId,
    node_label: String(data.label || node.label || latestCommandEvent?.node_label || nodeId),
    status,
    command_id: sanitizeTerminalText(String(output?.command_id || latestCommandEvent?.payload?.command_id || data.commandId || data.command_id || 'command')),
    output_path: outputPath,
    exit_code: output?.exit_code ?? latestCommandEvent?.payload?.exit_code ?? null,
    timed_out: Boolean(output?.timed_out ?? latestCommandEvent?.payload?.timed_out ?? false),
    duration_ms: output?.duration_ms ?? latestCommandEvent?.payload?.duration_ms ?? null,
    stdout: typeof output?.stdout === 'string' ? sanitizeTerminalText(output.stdout) : '',
    stderr: typeof output?.stderr === 'string' ? sanitizeTerminalText(output.stderr) : '',
    has_output: Boolean(output && typeof output === 'object'),
    last_event_id: latestCommandEvent?.id ? Number(latestCommandEvent.id) : null,
    updated_at: latestCommandEvent?.created_at || null,
  };
}

function getContextValueAtPath(context: any, path: string) {
  if (!context || !path) {
    return undefined;
  }
  return path
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => {
      if (value === undefined || value === null) {
        return undefined;
      }
      return value[key];
    }, context);
}

const TERMINAL_SECRET_PATTERN = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?uri|authorization|credential|passphrase)/i;
const MONGODB_CREDENTIAL_PATTERN = new RegExp('(mongodb(?:\\\\+srv)?://[^:\\\\s/@]+:)[^@\\\\s]+(@)', 'gi');
const POSTGRES_CREDENTIAL_PATTERN = new RegExp('(postgres(?:ql)?://[^:\\\\s/@]+:)[^@\\\\s]+(@)', 'gi');

function sanitizeTerminalText(value: string) {
  return maskTerminalSecrets(stripAnsiControlSequences(String(value || '')));
}

function stripAnsiControlSequences(value: string) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[PX^_].*?\u001b\\/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function maskTerminalSecrets(value: string) {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/gi, '$1***')
    .replace(/(authorization\s*[:=]\s*basic\s+)[^\s"'`]+/gi, '$1***')
    .replace(/((?:password|passwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?uri|credential|passphrase)\s*[=:]\s*)[^\s"'`]+/gi, '$1***')
    .replace(/([?&](?:token|secret|api[_-]?key|access[_-]?key|password|passphrase)=)[^&\s"'`]+/gi, '$1***')
    .replace(MONGODB_CREDENTIAL_PATTERN, '$1***$2')
    .replace(POSTGRES_CREDENTIAL_PATTERN, '$1***$2');
}

function sanitizeTerminalObject(value: any): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeTerminalText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeTerminalObject(item));
  if (typeof value === 'object') {
    return Object.entries(value).reduce<Record<string, any>>((acc, [key, item]) => {
      acc[key] = TERMINAL_SECRET_PATTERN.test(key) ? '***' : sanitizeTerminalObject(item);
      return acc;
    }, {});
  }
  return String(value);
}

function scrubContextTerminalOutputs(context: any, options: { scrubbedAt: string; retentionDays: number }): { scrubbedOutputs: number; scrubbedBytes: number } {
  let scrubbedOutputs = 0;
  let scrubbedBytes = 0;

  const visit = (value: any) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const hasCommandShape = typeof value.command_id === 'string' && (typeof value.stdout === 'string' || typeof value.stderr === 'string');
    if (hasCommandShape) {
      scrubbedBytes += Buffer.byteLength(value.stdout || '', 'utf8');
      scrubbedBytes += Buffer.byteLength(value.stderr || '', 'utf8');
      value.stdout = '';
      value.stderr = '';
      value.terminal_output_scrubbed_at = options.scrubbedAt;
      value.terminal_output_retention_days = options.retentionDays;
      scrubbedOutputs += 1;
      return;
    }

    Object.values(value).forEach(visit);
  };

  visit(context);
  if (scrubbedOutputs > 0) {
    context.runtime = {
      ...(context.runtime || {}),
      terminal_output_retention: {
        terminal_output_days: options.retentionDays,
        last_scrubbed_at: options.scrubbedAt,
        scrubbed_outputs: scrubbedOutputs,
      },
    };
  }

  return { scrubbedOutputs, scrubbedBytes };
}

function clampRetentionDays(value: any, fallback: number) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) {
    return Math.min(Math.max(fallback || 7, 1), 3650);
  }
  return Math.min(Math.max(Math.floor(days), 1), 3650);
}

function normalizeIdempotencyKey(value?: string): string | null {
  if (value === undefined) return null;
  const key = value.trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new BadRequestException('Idempotency-Key must contain 1 to 200 printable characters');
  }
  return key;
}

function instanceCommandHashes(
  actor: WorkflowHistoryActor | undefined,
  instanceId: string,
  command: 'retry' | 'terminate' | 'pause' | 'resume',
  key: string,
  request: Record<string, any>,
) {
  const principal = actor?.api_key_id ? `api_key:${actor.api_key_id}` : `${actor?.actor_type || 'unknown'}:${actor?.actor_id || 'anonymous'}`;
  return {
    key_hash: sha256(`instance-command:v1:${principal}:${instanceId}:${command}:${key}`),
    request_hash: sha256(stableStringify({ instance_id: instanceId, ...request })),
  };
}

function instanceCommandIdempotencyTtlMs(): number {
  const hours = Number(process.env.INSTANCE_COMMAND_IDEMPOTENCY_TTL_HOURS ?? 24);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function parseDate(value: any): Date | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildSideEffectWarnings(nodes: any[]) {
  return nodes.map((node) => detectSideEffect(node)).filter((warning): warning is NonNullable<ReturnType<typeof detectSideEffect>> => Boolean(warning));
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

  if (nodeType === 'approval') {
    return {
      node_id: node.id,
      node_label: label,
      node_type: nodeType,
      severity: 'high',
      message: 'Approval 노드는 전체 재시도 시 승인 task를 다시 생성할 수 있습니다.',
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
      message: highRiskMethods.includes(method) ? `HTTP ${method} 요청은 외부 시스템에 변경을 다시 보낼 수 있습니다.` : `HTTP ${method} 요청은 외부 시스템을 다시 호출합니다.`,
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
      message: highRiskOperations.includes(operation) ? `DB ${operation} 작업은 데이터를 다시 변경할 수 있습니다.` : 'DB 노드는 외부 저장소를 다시 조회하거나 사용할 수 있습니다.',
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
