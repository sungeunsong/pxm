import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { TasksService } from './tasks.service';

describe('TasksService', () => {
  const taskRepo = {
    listTasks: jest.fn(),
    getTask: jest.fn(),
    holdTask: jest.fn(),
    completeTask: jest.fn(),
    listTaskHistory: jest.fn(),
    getTaskHistoryItem: jest.fn(),
    requeueExternalApproval: jest.fn(),
  };
  const instanceRepo = { getInstance: jest.fn() };
  const audit = { append: jest.fn() };
  const service = new TasksService(
    taskRepo as any,
    instanceRepo as any,
    audit as any,
  );

  beforeEach(() => jest.clearAllMocks());

  it('lists only tasks assigned to the authenticated actor and visible in the actor group', async () => {
    taskRepo.listTasks.mockResolvedValue([
      { id: 'task-1', instance_id: 'instance-1', assignee: 'alice' },
      { id: 'task-2', instance_id: 'instance-2', assignee: 'alice' },
    ]);
    instanceRepo.getInstance
      .mockResolvedValueOnce({
        definition_id: 'workflow-1',
        group_id: 'group-1',
      })
      .mockResolvedValueOnce({
        definition_id: 'workflow-2',
        group_id: 'group-2',
      });

    const result = await service.listOpenTasks(
      actor({ actor_id: 'alice', group_ids: ['group-1'] }),
    );

    expect(taskRepo.listTasks).toHaveBeenCalledWith('alice');
    expect(result).toEqual([
      { id: 'task-1', instance_id: 'instance-1', assignee: 'alice' },
    ]);
  });

  it('requires task:approve scope for an API key', async () => {
    await expect(
      service.listOpenTasks(
        actor({
          actor_id: 'alice',
          api_key_id: 'key-1',
          scopes: ['workflow:read'],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taskRepo.listTasks).not.toHaveBeenCalled();
  });

  it('rejects a task assigned to another user', async () => {
    taskRepo.getTask.mockResolvedValue({
      id: 'task-1',
      instance_id: 'instance-1',
      assignee: 'bob',
      status: 'OPEN',
    });
    instanceRepo.getInstance.mockResolvedValue({
      definition_id: 'workflow-1',
      group_id: 'group-1',
    });

    await expect(
      service.completeTask(
        'task-1',
        { action: 'approve' },
        actor({ actor_id: 'alice', group_ids: ['group-1'] }),
        'request-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taskRepo.completeTask).not.toHaveBeenCalled();
  });

  it('allows a hybrid task in the PXM inbox but rejects an email-only task', async () => {
    instanceRepo.getInstance.mockResolvedValue({
      definition_id: 'workflow-1',
      group_id: 'group-1',
    });
    taskRepo.completeTask.mockResolvedValue({
      outcome: 'completed',
      task: { id: 'task-1' },
    });
    taskRepo.getTask.mockResolvedValueOnce({
      id: 'task-1',
      instance_id: 'instance-1',
      node_id: 'approval',
      assignee: 'alice',
      status: 'OPEN',
      payload: {
        approval_channels: ['pxm_user', 'external_email'],
      },
    });

    await service.completeTask(
      'task-1',
      { action: 'approve' },
      actor({ actor_id: 'alice', group_ids: ['group-1'] }),
      'hybrid-web',
    );
    expect(taskRepo.completeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        authentication_method: 'pxm_session',
      }),
    );

    taskRepo.getTask.mockResolvedValueOnce({
      id: 'task-2',
      instance_id: 'instance-1',
      assignee: 'alice',
      status: 'OPEN',
      payload: { approval_channels: ['external_email'] },
    });
    await expect(
      service.completeTask(
        'task-2',
        { action: 'approve' },
        actor({ actor_id: 'alice', group_ids: ['group-1'] }),
        'email-only-web',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('applies API key workflow/group scope and records an idempotent audit event', async () => {
    taskRepo.getTask.mockResolvedValue({
      id: 'task-1',
      instance_id: 'instance-1',
      node_id: 'approval',
      assignee: 'alice',
      status: 'OPEN',
    });
    instanceRepo.getInstance.mockResolvedValue({
      definition_id: 'workflow-1',
      group_id: 'group-1',
    });
    taskRepo.completeTask.mockResolvedValue({
      outcome: 'completed',
      task: { id: 'task-1' },
    });
    const apiActor = actor({
      actor_id: 'alice',
      api_key_id: 'key-1',
      scopes: ['task:approve'],
      group_ids: ['group-1'],
      allowed_workflow_ids: ['workflow-1'],
      business_actor: { employee_id: 'E-100' },
    });

    const result = await service.completeTask(
      'task-1',
      { action: 'approve', comment: 'checked', result: { approved: true } },
      apiActor,
      'request-1',
    );

    expect(taskRepo.completeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        actor_id: 'alice',
        api_key_id: 'key-1',
        idempotency_key: 'request-1',
      }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'task:task-1:completion',
        action: 'task.approved',
        resource_type: 'task',
        group_id: 'group-1',
        api_key_id: 'key-1',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ success: true, already_processed: false }),
    );
  });

  it('returns the previous result for the same idempotency key without duplicating the audit event identity', async () => {
    taskRepo.getTask.mockResolvedValue({
      id: 'task-1',
      instance_id: 'instance-1',
      assignee: 'alice',
      status: 'APPROVED',
    });
    instanceRepo.getInstance.mockResolvedValue({
      definition_id: 'workflow-1',
      group_id: 'group-1',
    });
    taskRepo.completeTask.mockResolvedValue({
      outcome: 'idempotent',
      task: { id: 'task-1' },
    });

    const result = await service.completeTask(
      'task-1',
      { action: 'approve' },
      actor({ actor_id: 'alice', group_ids: ['group-1'] }),
      'request-1',
    );

    expect(result.already_processed).toBe(true);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: 'task:task-1:completion' }),
    );
  });

  it('returns conflict when a completed task does not match the idempotent request', async () => {
    taskRepo.getTask.mockResolvedValue({
      id: 'task-1',
      instance_id: 'instance-1',
      assignee: 'alice',
      status: 'APPROVED',
    });
    instanceRepo.getInstance.mockResolvedValue({
      definition_id: 'workflow-1',
      group_id: 'group-1',
    });
    taskRepo.completeTask.mockResolvedValue({
      outcome: 'already_completed',
      task: { id: 'task-1' },
    });

    await expect(
      service.completeTask(
        'task-1',
        { action: 'reject' },
        actor({ actor_id: 'alice', group_ids: ['group-1'] }),
        'request-2',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('limits a normal user task history to the authenticated assignee', async () => {
    taskRepo.listTaskHistory.mockResolvedValue({
      items: [{ task_id: 'task-1', created_at: '2026-07-21T00:00:00.000Z' }],
      has_more: false,
    });
    const result = await service.listHistory(
      { status: 'approved,rejected', limit: 20 },
      actor({ actor_id: 'alice' }),
    );
    expect(taskRepo.listTaskHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ['APPROVED', 'REJECTED'],
        assignee: 'alice',
        limit: 20,
      }),
    );
    expect(result).toEqual({ items: expect.any(Array), next_cursor: null });
  });

  it('lets a requester read the complete approval line for their own instance', async () => {
    instanceRepo.getInstance.mockResolvedValue({
      requester_id: 'alice',
      definition_id: 'workflow-1',
      group_id: 'group-1',
    });
    taskRepo.listTaskHistory.mockResolvedValue({
      items: [{ task_id: 'task-bob', assignee: 'bob', created_at: '2026-07-21T00:00:00.000Z' }],
      has_more: false,
    });

    await service.listHistory(
      { limit: 100 },
      actor({ actor_id: 'alice' }),
      'instance-1',
    );

    expect(taskRepo.listTaskHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        instance_id: 'instance-1',
        assignee: undefined,
      }),
    );
  });

  it('keeps a held task open and records the hold without completing it', async () => {
    taskRepo.getTask.mockResolvedValue({
      id: 'task-1',
      instance_id: 'instance-1',
      assignee: 'alice',
      status: 'OPEN',
      payload: { approval_channels: ['pxm_user'] },
    });
    instanceRepo.getInstance.mockResolvedValue({
      definition_id: 'workflow-1',
      group_id: 'group-1',
    });
    taskRepo.holdTask.mockResolvedValue({
      actor_id: 'alice',
      comment: '추가 확인 필요',
      held_at: '2026-08-28T00:00:00.000Z',
    });

    const result = await service.holdTask(
      'task-1',
      { comment: '추가 확인 필요' },
      actor({ actor_id: 'alice', group_ids: ['group-1'] }),
    );

    expect(taskRepo.holdTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        actor_id: 'alice',
        comment: '추가 확인 필요',
      }),
    );
    expect(taskRepo.completeTask).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ status: 'OPEN' }));
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.held' }),
    );
  });

  it('scopes API key history by group and allowed workflows', async () => {
    taskRepo.listTaskHistory.mockResolvedValue({ items: [], has_more: false });
    await service.listHistory(
      {},
      actor({
        actor_type: 'service_account',
        actor_id: 'erp',
        api_key_id: 'key-1',
        scopes: ['workflow:read'],
        group_ids: ['group-1'],
        allowed_workflow_ids: ['workflow-1'],
        roles: [],
      }),
    );
    expect(taskRepo.listTaskHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        group_ids: ['group-1'],
        allowed_workflow_ids: ['workflow-1'],
      }),
    );
  });

  it('hides a task detail outside the API key workflow scope', async () => {
    taskRepo.getTaskHistoryItem.mockResolvedValue({
      task_id: 'task-1',
      assignee: 'outside@example.com',
      group_id: 'group-1',
      workflow_id: 'workflow-2',
    });
    await expect(
      service.getHistoryItem(
        'task-1',
        actor({
          actor_type: 'service_account',
          actor_id: 'erp',
          api_key_id: 'key-1',
          scopes: ['workflow:read'],
          group_ids: ['group-1'],
          allowed_workflow_ids: ['workflow-1'],
          roles: [],
        }),
      ),
    ).rejects.toThrow('Task not found');
  });

  it('lets a group manager reissue an open external approval link', async () => {
    taskRepo.getTaskHistoryItem.mockResolvedValue({
      task_id: 'task-1',
      instance_id: 'instance-1',
      workflow_id: 'workflow-1',
      group_id: 'group-1',
      approver_channel: 'external_email',
      assignee: 'outside@example.com',
      status: 'OPEN',
    });
    taskRepo.requeueExternalApproval.mockResolvedValue(true);

    const result = await service.retryExternalApproval(
      'task-1',
      actor({
        actor_id: 'manager',
        roles: ['group_manager'],
        group_ids: ['group-1'],
      }),
    );

    expect(taskRepo.requeueExternalApproval).toHaveBeenCalledWith('task-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.external_approval.requeued',
        group_id: 'group-1',
      }),
    );
    expect(result.delivery_status).toBe('PENDING');
  });

  it('prevents a normal user from reissuing an external approval link', async () => {
    taskRepo.getTaskHistoryItem.mockResolvedValue({
      task_id: 'task-1',
      instance_id: 'instance-1',
      workflow_id: 'workflow-1',
      group_id: 'group-1',
      approver_channel: 'external_email',
      assignee: 'outside@example.com',
      status: 'OPEN',
    });

    await expect(
      service.retryExternalApproval(
        'task-1',
        actor({ actor_id: 'alice', group_ids: ['group-1'] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(taskRepo.requeueExternalApproval).not.toHaveBeenCalled();
  });
});

function actor(overrides: Partial<WorkflowHistoryActor>): WorkflowHistoryActor {
  return {
    actor_type: 'user',
    actor_id: 'alice',
    roles: ['user'],
    scopes: [],
    workspace_ids: ['default'],
    group_ids: [],
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    api_key_id: null,
    business_actor: null,
    ...overrides,
  };
}
