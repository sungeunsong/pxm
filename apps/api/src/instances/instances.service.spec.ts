import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InstancesService } from './instances.service';

describe('InstancesService pause control', () => {
  const buildService = (instance: Record<string, any>) => {
    const instanceRepo = {
      getInstance: jest.fn().mockResolvedValue(instance),
      getIdempotentCommand: jest
        .fn()
        .mockResolvedValue({ outcome: 'missing', result: {} }),
      executeIdempotentCommand: jest.fn().mockImplementation(async (input) => ({
        outcome: 'created',
        result: input.result,
      })),
      executeInstanceMutation: jest.fn().mockResolvedValue(undefined),
      listChildInstances: jest.fn().mockResolvedValue([]),
    };
    const service = new InstancesService(
      instanceRepo as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { service, instanceRepo };
  };

  it('pauses a running instance without replacing its runtime state', async () => {
    const { service, instanceRepo } = buildService({
      id: 'instance-1',
      state: 'RUNNING',
      is_paused: false,
      context: {},
    });

    await expect(
      service.setInstancePaused('instance-1', true),
    ).resolves.toEqual({
      success: true,
      instance_id: 'instance-1',
      paused: true,
      runtime_state: 'RUNNING',
      changed: true,
      affected_instance_ids: ['instance-1'],
      idempotent_replay: false,
    });
    expect(instanceRepo.executeInstanceMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        update_instances: [{
          id: 'instance-1',
          paused: true,
          paused_by: null,
          pause_origin_instance_id: 'instance-1',
        }],
        events: [expect.objectContaining({ event_type: 'INSTANCE_PAUSED' })],
      }),
    );
  });

  it('returns a no-op when the requested pause state is already applied', async () => {
    const { service, instanceRepo } = buildService({
      id: 'instance-1',
      state: 'WAITING',
      is_paused: true,
      context: {},
    });

    await expect(
      service.setInstancePaused('instance-1', true),
    ).resolves.toEqual(
      expect.objectContaining({ paused: true, changed: false }),
    );
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
  });

  it('rejects pause and resume commands for terminal instances', async () => {
    const { service } = buildService({
      id: 'instance-1',
      state: 'COMPLETED',
      is_paused: false,
      context: {},
    });

    await expect(
      service.setInstancePaused('instance-1', true),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('replays an idempotent pause response without applying another mutation', async () => {
    const { service, instanceRepo } = buildService({
      id: 'instance-1',
      state: 'RUNNING',
      is_paused: false,
      context: {},
    });
    instanceRepo.getIdempotentCommand.mockResolvedValue({
      outcome: 'replayed',
      result: {
        success: true,
        instance_id: 'instance-1',
        paused: true,
        runtime_state: 'RUNNING',
        changed: true,
        affected_instance_ids: ['instance-1'],
      },
    });

    await expect(
      service.setInstancePaused('instance-1', true, undefined, 'same-key'),
    ).resolves.toEqual(
      expect.objectContaining({ paused: true, idempotent_replay: true }),
    );
    expect(instanceRepo.executeIdempotentCommand).not.toHaveBeenCalled();
  });

  it('pauses active workflow-call children without overriding an independently paused child', async () => {
    const { service, instanceRepo } = buildService({
      id: 'parent-1',
      state: 'WAITING',
      is_paused: false,
      context: {},
    });
    instanceRepo.listChildInstances.mockImplementation(async (id: string) => (
      id === 'parent-1' ? [{ id: 'child-1' }, { id: 'child-2' }] : []
    ));
    instanceRepo.getInstance.mockImplementation(async (id: string) => ({
      id,
      state: id === 'parent-1' ? 'WAITING' : 'RUNNING',
      is_paused: id === 'child-2',
      pause_origin_instance_id: id === 'child-2' ? 'other-parent' : null,
      context: {},
    }));

    const result = await service.setInstancePaused('parent-1', true);
    expect(result.affected_instance_ids).toEqual(['parent-1', 'child-1']);
    expect(instanceRepo.executeInstanceMutation).toHaveBeenCalledWith(expect.objectContaining({
      update_instances: [
        expect.objectContaining({ id: 'parent-1', pause_origin_instance_id: 'parent-1' }),
        expect.objectContaining({ id: 'child-1', pause_origin_instance_id: 'parent-1' }),
      ],
    }));
  });
});

describe('InstancesService public terminate authorization', () => {
  const apiKeyActor = (overrides: Record<string, any> = {}) => ({
    actor_type: 'user' as const,
    actor_id: 'owner-1',
    roles: ['user'],
    scopes: ['workflow:execute'],
    workspace_ids: ['default'],
    group_ids: ['group-a'],
    owned_workflow_ids: [],
    allowed_workflow_ids: ['workflow-1'],
    allowed_instance_ids: [],
    api_key_id: 'key-1',
    ...overrides,
  });

  const buildService = (instance: Record<string, any>) => {
    const instanceRepo = {
      getInstance: jest.fn().mockResolvedValue(instance),
      listChildInstances: jest.fn().mockResolvedValue([]),
      executeInstanceMutation: jest.fn().mockResolvedValue(undefined),
      getIdempotentCommand: jest.fn().mockResolvedValue({ outcome: 'missing', result: {} }),
      executeIdempotentCommand: jest.fn(),
    };
    return {
      service: new InstancesService(instanceRepo as any, {} as any, {} as any, {} as any),
      instanceRepo,
    };
  };

  const runningInstance = {
    id: 'instance-1',
    process_definition_id: 'workflow-1',
    state: 'RUNNING',
    context: {
      runtime: {
        access: {
          group_id: 'group-a',
          caller: { type: 'user', id: 'owner-1', api_key_id: 'original-key' },
        },
      },
    },
  };

  it('allows a rotated API key to terminate an instance started by the same owner', async () => {
    const { service, instanceRepo } = buildService(runningInstance);

    await expect(service.terminateInstance('instance-1', apiKeyActor({ api_key_id: 'rotated-key' }))).resolves.toEqual({
      success: true,
      instance_id: 'instance-1',
      terminated_instances: ['instance-1'],
      idempotent_replay: false,
    });
    expect(instanceRepo.executeInstanceMutation).toHaveBeenCalledWith(expect.objectContaining({
      update_instances: [expect.objectContaining({ id: 'instance-1', status: 'TERMINATED' })],
    }));
  });

  it('returns 403 when an API key lacks workflow:execute', async () => {
    const { service, instanceRepo } = buildService(runningInstance);

    await expect(service.terminateInstance('instance-1', apiKeyActor({ scopes: ['workflow:read'] })))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
  });

  it('hides an instance in another group', async () => {
    const { service, instanceRepo } = buildService({
      ...runningInstance,
      context: {
        runtime: {
          access: {
            group_id: 'group-b',
            caller: { type: 'user', id: 'owner-1', api_key_id: 'original-key' },
          },
        },
      },
    });

    await expect(service.terminateInstance('instance-1', apiKeyActor()))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
  });

  it('hides an instance started by a different owner in the same workflow scope', async () => {
    const { service, instanceRepo } = buildService(runningInstance);

    await expect(service.terminateInstance('instance-1', apiKeyActor({ actor_id: 'owner-2' })))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
  });

  it('hides a legacy instance without a recorded starter owner', async () => {
    const { service, instanceRepo } = buildService({
      ...runningInstance,
      context: { runtime: { access: { group_id: 'group-a' } } },
    });

    await expect(service.terminateInstance('instance-1', apiKeyActor()))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
  });

  it('matches service-account ownership separately from user ownership', async () => {
    const { service } = buildService({
      ...runningInstance,
      context: {
        runtime: {
          access: {
            group_id: 'group-a',
            caller: { type: 'service_account', id: 'owner-1', api_key_id: 'original-key' },
          },
        },
      },
    });

    await expect(service.terminateInstance('instance-1', apiKeyActor({
      actor_type: 'service_account',
      roles: [],
      api_key_id: 'rotated-service-key',
    }))).resolves.toEqual(expect.objectContaining({ terminated_instances: ['instance-1'] }));
  });

  it('treats a terminal instance as a successful no-op', async () => {
    const { service } = buildService({ ...runningInstance, state: 'COMPLETED' });

    await expect(service.terminateInstance('instance-1', apiKeyActor())).resolves.toEqual({
      success: true,
      instance_id: 'instance-1',
      terminated_instances: [],
      idempotent_replay: false,
    });
  });
});

describe('InstancesService external approval start', () => {
  const definition = {
    id: 'workflow-1',
    name: 'External approval',
    version: 1,
    nodes: [
      { id: 'start', data: { nodeType: 'start' } },
      {
        id: 'approval',
        data: {
          nodeType: 'approval',
          approvalLineSource: 'dynamic',
          approvalRequestPath: 'approval_request',
        },
      },
    ],
    edges: [],
  };
  const dto = {
    template_id: definition.id,
    ctx: {
      data: {
        formData: {
          approval_request: {
            source: { provider: 'acrapoint' },
            request_id: 'AP-100',
            revision: 1,
          },
        },
      },
    },
  };

  it('uses atomic start idempotency and returns the persisted instance on replay', async () => {
    const instanceRepo = {
      createIdempotentStart: jest
        .fn()
        .mockResolvedValueOnce({ outcome: 'created', instance_id: 'instance-original' })
        .mockResolvedValueOnce({ outcome: 'replayed', instance_id: 'instance-original' }),
      executeInstanceMutation: jest.fn(),
    };
    const workflowRepo = { getPublishedDefinition: jest.fn().mockResolvedValue(definition) };
    let mappingVersion = 0;
    const service = new InstancesService(instanceRepo as any, workflowRepo as any, {} as any, {
      resolveExternalApprovalPrincipals: jest.fn((formData) => {
        mappingVersion += 1;
        formData.approval_request.principal_mapping = { version: mappingVersion };
      }),
    } as any);

    await expect(service.createInstance(structuredClone(dto))).resolves.toMatchObject({
      instance_id: 'instance-original',
      idempotent_replay: false,
    });
    await expect(service.createInstance(structuredClone(dto))).resolves.toMatchObject({
      instance_id: 'instance-original',
      idempotent_replay: true,
    });
    expect(instanceRepo.createIdempotentStart).toHaveBeenCalledTimes(2);
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
    expect(instanceRepo.createIdempotentStart.mock.calls[0][0].key_hash).toBe(
      instanceRepo.createIdempotentStart.mock.calls[1][0].key_hash,
    );
    expect(instanceRepo.createIdempotentStart.mock.calls[0][0].request_hash).toBe(
      instanceRepo.createIdempotentStart.mock.calls[1][0].request_hash,
    );
    expect(instanceRepo.createIdempotentStart.mock.calls[0][0].instance.context)
      .toMatchObject({ data: { formData: { approval_request: { principal_mapping: { version: 1 } } } } });
  });

  it('returns a conflict when a claimed external request key has another payload', async () => {
    const instanceRepo = {
      createIdempotentStart: jest.fn().mockResolvedValue({
        outcome: 'conflict',
        instance_id: 'instance-original',
      }),
      executeInstanceMutation: jest.fn(),
    };
    const workflowRepo = { getPublishedDefinition: jest.fn().mockResolvedValue(definition) };
    const service = new InstancesService(instanceRepo as any, workflowRepo as any, {} as any, {
      resolveExternalApprovalPrincipals: jest.fn(),
    } as any);

    await expect(service.createInstance(structuredClone(dto))).rejects.toBeInstanceOf(ConflictException);
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
  });
});
