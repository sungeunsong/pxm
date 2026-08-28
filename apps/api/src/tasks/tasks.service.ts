import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  WorkflowHistoryActor,
  WorkflowInstanceRepositoryPort,
  WorkflowTaskRepositoryPort,
} from '../db/ports/db.ports';
import { ManagementAuditService } from '../audit/management-audit.service';
import { CompleteTaskDto, HoldTaskDto } from './dto/task.dto';
import { TaskHistoryQueryDto } from './dto/task-history.dto';
import {
  assertCanManageGroup,
  isAdmin,
  managerGroupIds,
} from '../authz/management-auth';
import {
  allowsApprovalChannel,
  approvalChannels,
} from '../db/approval-channels';

@Injectable()
export class TasksService {
  constructor(
    private readonly tasks: WorkflowTaskRepositoryPort,
    private readonly instances: WorkflowInstanceRepositoryPort,
    private readonly audit: ManagementAuditService,
  ) {}

  async listOpenTasks(actor: WorkflowHistoryActor) {
    this.assertAuthenticatedActor(actor);
    this.assertApiKeyApprovalScope(actor);
    const tasks = await this.tasks.listTasks(actor.actor_id!);
    const visible = await Promise.all(
      tasks.map(async (task) => {
        const instance = await this.instances.getInstance(task.instance_id);
        return instance && this.canAccessTask(actor, task, instance)
          ? task
          : null;
      }),
    );
    return visible.filter(Boolean);
  }

  async listHistory(
    dto: TaskHistoryQueryDto,
    actor: WorkflowHistoryActor,
    instanceId?: string,
  ) {
    this.assertHistoryAuthenticated(actor);
    this.assertHistoryReadScope(actor);
    const statuses = parseStatuses(dto.status);
    const limit = dto.limit || 50;
    const query = {
      statuses,
      workflow_id: dto.workflow_id,
      instance_id: instanceId || dto.instance_id,
      assignee: dto.assignee,
      approver_channel: dto.approver_channel,
      from: dto.from,
      to: dto.to,
      cursor: decodeTaskCursor(dto.cursor),
      limit,
    };

    if (actor.api_key_id) {
      Object.assign(query, {
        group_ids: actor.group_ids || [],
        allowed_workflow_ids: actor.allowed_workflow_ids || [],
      });
    } else if (isAdmin(actor)) {
      // Admin may use every supported filter.
    } else if (managerGroupIds(actor).length) {
      Object.assign(query, { group_ids: managerGroupIds(actor) });
    } else if (
      instanceId &&
      (await this.isRequesterOwnedInstance(instanceId, actor))
    ) {
      // The requester can follow the complete approval line for their own request.
    } else {
      if (dto.assignee && dto.assignee !== actor.actor_id) {
        throw new ForbiddenException(
          'Users can read only their own task history',
        );
      }
      query.assignee = actor.actor_id!;
    }

    const page = await this.tasks.listTaskHistory(query);
    const last = page.items.at(-1);
    return {
      items: page.items,
      next_cursor:
        page.has_more && last
          ? encodeTaskCursor(last.created_at, last.task_id)
          : null,
    };
  }

  async getHistoryItem(id: string, actor: WorkflowHistoryActor) {
    this.assertHistoryAuthenticated(actor);
    this.assertHistoryReadScope(actor);
    const item = await this.tasks.getTaskHistoryItem(id);
    if (!item || !this.canReadHistoryItem(actor, item))
      throw new NotFoundException('Task not found');
    return item;
  }

  async completeTask(
    id: string,
    dto: CompleteTaskDto,
    actor: WorkflowHistoryActor,
    idempotencyKey?: string | null,
  ) {
    this.assertAuthenticatedActor(actor);
    this.assertApiKeyApprovalScope(actor);
    const task = await this.tasks.getTask(id);
    if (!task) throw new NotFoundException('Task not found');
    const instance = await this.instances.getInstance(task.instance_id);
    if (!instance) throw new NotFoundException('Task instance not found');
    const instanceStatus = String(instance.state || instance.status || '').toUpperCase();
    if (['COMPLETED', 'FAILED', 'TERMINATED'].includes(instanceStatus)) {
      throw new ConflictException(`Approval is not allowed for a ${instanceStatus.toLowerCase()} instance`);
    }
    if (!this.canAccessTask(actor, task, instance)) {
      throw new ForbiddenException(
        'Task approval is not allowed for this actor',
      );
    }

    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const result = await this.tasks.completeTask({
      task_id: id,
      action: dto.action,
      status: dto.action === 'approve' ? 'APPROVED' : 'REJECTED',
      actor_id: actor.actor_id!,
      api_key_id: actor.api_key_id || null,
      business_actor: actor.business_actor || null,
      comment: dto.comment?.trim() || null,
      result: dto.result || null,
      idempotency_key: normalizedKey,
      authentication_method: actor.api_key_id ? 'api_key' : 'pxm_session',
    });

    if (result.outcome === 'not_found')
      throw new NotFoundException('Task not found');
    if (result.outcome === 'already_completed') {
      throw new ConflictException('Task has already been completed');
    }
    if (result.outcome === 'completed' || result.outcome === 'idempotent') {
      await this.audit.append({
        event_id: `task:${id}:completion`,
        action: dto.action === 'approve' ? 'task.approved' : 'task.rejected',
        resource_type: 'task',
        resource_id: id,
        group_id: instance.group_id || null,
        actor_id: actor.actor_id,
        api_key_id: actor.api_key_id || null,
        details: {
          instance_id: task.instance_id,
          workflow_id:
            instance.definition_id || instance.process_definition_id || null,
          business_actor: actor.business_actor || null,
          comment: dto.comment?.trim() || null,
          result: dto.result || null,
          idempotency_key: normalizedKey,
        },
      });
    }

    return {
      success: true,
      task_id: id,
      instance_id: task.instance_id,
      action: dto.action,
      status: dto.action === 'approve' ? 'APPROVED' : 'REJECTED',
      already_processed: result.outcome === 'idempotent',
    };
  }

  async holdTask(
    id: string,
    dto: HoldTaskDto,
    actor: WorkflowHistoryActor,
  ) {
    this.assertAuthenticatedActor(actor);
    this.assertApiKeyApprovalScope(actor);
    const task = await this.tasks.getTask(id);
    if (!task) throw new NotFoundException('Task not found');
    const instance = await this.instances.getInstance(task.instance_id);
    if (!instance) throw new NotFoundException('Task instance not found');
    if (!this.canAccessTask(actor, task, instance)) {
      throw new ForbiddenException('Task hold is not allowed for this actor');
    }
    if (task.status !== 'OPEN') {
      throw new ConflictException('Only open tasks can be put on hold');
    }

    const hold = await this.tasks.holdTask(id, {
      actor_id: actor.actor_id!,
      comment: dto.comment?.trim() || null,
      held_at: new Date().toISOString(),
    });
    if (!hold) throw new ConflictException('Task is no longer open');

    await this.audit.append({
      action: 'task.held',
      resource_type: 'task',
      resource_id: id,
      group_id:
        instance.group_id ||
        instance.context?.runtime?.access?.group_id ||
        null,
      actor_id: actor.actor_id,
      api_key_id: actor.api_key_id || null,
      details: {
        instance_id: task.instance_id,
        comment: dto.comment?.trim() || null,
      },
    });
    return {
      success: true,
      task_id: id,
      instance_id: task.instance_id,
      status: 'OPEN',
      hold,
    };
  }

  async retryExternalApproval(id: string, actor: WorkflowHistoryActor) {
    this.assertHistoryAuthenticated(actor);
    if (actor.api_key_id)
      throw new ForbiddenException(
        'API key cannot reissue external approval links',
      );
    const item = await this.tasks.getTaskHistoryItem(id);
    if (!item) throw new NotFoundException('Task not found');
    assertCanManageGroup(actor, item.group_id);
    if (
      !approvalChannels({
        approval_channels: item.approval_channels,
        approver_channel: item.approver_channel,
      }).includes('external_email')
    )
      throw new BadRequestException('Task is not an external email approval');
    if (item.status !== 'OPEN')
      throw new ConflictException('Only open approval tasks can be reissued');

    const requeued = await this.tasks.requeueExternalApproval(id);
    if (!requeued)
      throw new ConflictException('Approval task could not be reissued');

    await this.audit.append({
      action: 'task.external_approval.requeued',
      resource_type: 'task',
      resource_id: id,
      group_id: item.group_id,
      actor_id: actor.actor_id,
      details: {
        instance_id: item.instance_id,
        workflow_id: item.workflow_id,
        recipient: item.assignee,
      },
    });
    return {
      success: true,
      task_id: id,
      delivery_status: 'PENDING',
    };
  }

  private canAccessTask(
    actor: WorkflowHistoryActor,
    task: any,
    instance: any,
  ): boolean {
    if (!allowsApprovalChannel(task.payload, 'pxm_user')) return false;
    if (String(task.assignee || '') !== actor.actor_id) return false;
    const workflowId = String(
      instance.definition_id || instance.process_definition_id || '',
    );
    const groupId =
      instance.group_id || instance.context?.runtime?.access?.group_id || null;
    if (actor.api_key_id) {
      if (!workflowId || !actor.allowed_workflow_ids.includes(workflowId))
        return false;
      return Boolean(groupId && (actor.group_ids || []).includes(groupId));
    }
    if (actor.roles.includes('admin')) return true;
    return Boolean(groupId && (actor.group_ids || []).includes(groupId));
  }

  private canReadHistoryItem(
    actor: WorkflowHistoryActor,
    item: {
      assignee: string;
      group_id: string | null;
      workflow_id: string | null;
    },
  ): boolean {
    if (actor.api_key_id) {
      return Boolean(
        item.group_id &&
        actor.group_ids?.includes(item.group_id) &&
        item.workflow_id &&
        actor.allowed_workflow_ids.includes(item.workflow_id),
      );
    }
    if (isAdmin(actor)) return true;
    if (item.group_id && managerGroupIds(actor).includes(item.group_id))
      return true;
    return item.assignee === actor.actor_id;
  }

  private async isRequesterOwnedInstance(
    instanceId: string,
    actor: WorkflowHistoryActor,
  ): Promise<boolean> {
    if (!actor.actor_id || actor.api_key_id) return false;
    const instance = await this.instances.getInstance(instanceId);
    if (!instance) throw new NotFoundException('Instance not found');
    const access =
      instance.context?.runtime?.access ||
      instance.ctx?.runtime?.access ||
      {};
    return (instance.requester_id || access.requester_id || null) === actor.actor_id;
  }

  private assertAuthenticatedActor(actor: WorkflowHistoryActor) {
    if (!actor.actor_id)
      throw new UnauthorizedException('Authenticated user is required');
    if (actor.actor_type === 'service_account') {
      throw new ForbiddenException(
        'Service accounts cannot complete approval tasks',
      );
    }
  }

  private assertApiKeyApprovalScope(actor: WorkflowHistoryActor) {
    if (actor.api_key_id && !actor.scopes?.includes('task:approve')) {
      throw new ForbiddenException('task:approve scope is required');
    }
  }

  private assertHistoryReadScope(actor: WorkflowHistoryActor) {
    if (actor.api_key_id && !actor.scopes?.includes('workflow:read')) {
      throw new ForbiddenException('workflow:read scope is required');
    }
  }

  private assertHistoryAuthenticated(actor: WorkflowHistoryActor) {
    if (!actor.actor_id)
      throw new UnauthorizedException('Authenticated actor is required');
  }
}

const TASK_STATUSES = ['OPEN', 'APPROVED', 'REJECTED', 'CANCELED'] as const;

function parseStatuses(
  value?: string,
): Array<(typeof TASK_STATUSES)[number]> | undefined {
  if (!value) return undefined;
  const statuses = value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (!statuses.length || !statuses.every(isTaskStatus)) {
    throw new BadRequestException(
      'status must contain OPEN, APPROVED, REJECTED, or CANCELED',
    );
  }
  return statuses;
}

function isTaskStatus(value: string): value is (typeof TASK_STATUSES)[number] {
  return TASK_STATUSES.some((status) => status === value);
}

function encodeTaskCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ created_at: createdAt, id })).toString(
    'base64url',
  );
}

function decodeTaskCursor(
  value?: string,
): { created_at: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('created_at' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.created_at !== 'string' ||
      typeof parsed.id !== 'string' ||
      !Number.isFinite(Date.parse(parsed.created_at))
    )
      throw new Error('invalid');
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
}

function normalizeIdempotencyKey(value?: string | null): string | null {
  const key = value?.trim();
  if (!key) return null;
  if (key.length > 200)
    throw new BadRequestException(
      'Idempotency-Key must be at most 200 characters',
    );
  return key;
}
