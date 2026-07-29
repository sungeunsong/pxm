import { ConflictException } from '@nestjs/common';
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
    const service = new InstancesService(instanceRepo as any, workflowRepo as any, {} as any);

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
    const service = new InstancesService(instanceRepo as any, workflowRepo as any, {} as any);

    await expect(service.createInstance(structuredClone(dto))).rejects.toBeInstanceOf(ConflictException);
    expect(instanceRepo.executeInstanceMutation).not.toHaveBeenCalled();
  });
});
