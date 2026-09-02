import { BadRequestException } from '@nestjs/common';
import { TemplatesService } from './templates.service';

describe('Workflow deployment lifecycle', () => {
  const workflowRepo = {
    createDefinition: jest.fn(),
    listDefinitions: jest.fn(),
    getDefinition: jest.fn(),
    getPublishedDefinition: jest.fn(),
    setDefinitionLifecycle: jest.fn(),
    getDefinitionVersion: jest.fn(),
    restoreDefinitionVersion: jest.fn(),
  };
  const schedules = { syncDefinitionSchedules: jest.fn() };
  const dbWatch = { syncDefinitionWatchJobs: jest.fn() };
  const credentials = { getForRuntime: jest.fn() };
  const authz = { getUser: jest.fn() };
  const service = new TemplatesService(workflowRepo as any, schedules as any, dbWatch as any, credentials as any, authz as any);

  beforeEach(() => jest.clearAllMocks());

  it('creates a draft without activating schedule or DB watch triggers', async () => {
    workflowRepo.listDefinitions.mockResolvedValue([]);
    workflowRepo.getDefinition.mockResolvedValue({
      id: 'workflow-1',
      name: 'Draft workflow',
      version: 1,
      lifecycle_status: 'DRAFT',
      active_published_version: null,
      nodes: [],
      edges: [],
    });

    const created = await service.create({
      name: 'Draft workflow',
      group_id: 'group-1',
      nodes: [],
      edges: [],
    });

    expect(workflowRepo.createDefinition).toHaveBeenCalledWith(
      expect.any(String),
      'Draft workflow',
      [],
      [],
      expect.objectContaining({
        lifecycle_status: 'DRAFT',
        active_published_version: null,
      }),
    );
    expect(created.lifecycle_status).toBe('DRAFT');
    expect(schedules.syncDefinitionSchedules).not.toHaveBeenCalled();
    expect(dbWatch.syncDefinitionWatchJobs).not.toHaveBeenCalled();
  });

  it('rejects an SSH node without a credential', async () => {
    await expect(service.create({
      name: 'SSH workflow',
      group_id: 'group-1',
      nodes: [{ id: 'ssh', data: { nodeType: 'service', plugin_id: 'builtin.ssh', command: 'hostname' } }],
      edges: [],
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-SSH credential on an SSH node', async () => {
    credentials.getForRuntime.mockResolvedValue({ type: 'api_key' });
    await expect(service.create({
      name: 'SSH workflow',
      group_id: 'group-1',
      nodes: [{
        id: 'ssh',
        data: {
          nodeType: 'service',
          plugin_id: 'builtin.ssh',
          command: 'hostname',
          credential_id: 'credential-1',
        },
      }],
      edges: [],
    })).rejects.toThrow('SSH node requires a credential with type ssh');
  });

  it('publishes the current immutable version and activates its triggers', async () => {
    workflowRepo.getDefinition.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 3,
      lifecycle_status: 'DRAFT',
      active_published_version: null,
      nodes: [],
      edges: [],
    });
    workflowRepo.setDefinitionLifecycle.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 3,
      lifecycle_status: 'PUBLISHED',
      active_published_version: 3,
      nodes: [],
      edges: [],
    });
    workflowRepo.getPublishedDefinition.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 3,
      lifecycle_status: 'PUBLISHED',
      active_published_version: 3,
      nodes: [{ id: 'start', data: { nodeType: 'start' } }],
      edges: [],
    });

    const published = await service.publish('workflow-1', 'admin');

    expect(workflowRepo.setDefinitionLifecycle).toHaveBeenCalledWith(
      'workflow-1',
      expect.objectContaining({
        status: 'PUBLISHED',
        active_published_version: 3,
        actor_id: 'admin',
      }),
    );
    expect(schedules.syncDefinitionSchedules).toHaveBeenCalledWith('workflow-1', 'Purchase approval', expect.any(Array));
    expect(published?.has_unpublished_changes).toBe(false);
  });

  it('disables new trigger creation while retaining the published pointer', async () => {
    workflowRepo.getDefinition.mockResolvedValue({
      id: 'workflow-1',
      version: 4,
      lifecycle_status: 'PUBLISHED',
      active_published_version: 3,
    });
    workflowRepo.setDefinitionLifecycle.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 4,
      lifecycle_status: 'DISABLED',
      active_published_version: 3,
      nodes: [],
      edges: [],
    });

    const disabled = await service.disable('workflow-1', 'admin');

    expect(schedules.syncDefinitionSchedules).toHaveBeenCalledWith('workflow-1', 'Purchase approval', []);
    expect(dbWatch.syncDefinitionWatchJobs).toHaveBeenCalledWith('workflow-1', 'Purchase approval', []);
    expect(disabled).toEqual(
      expect.objectContaining({
        lifecycle_status: 'DISABLED',
        active_published_version: 3,
        has_unpublished_changes: true,
      }),
    );
  });

  it('reactivates the retained published version and its triggers', async () => {
    workflowRepo.getDefinition.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 4,
      lifecycle_status: 'DISABLED',
      active_published_version: 3,
    });
    workflowRepo.setDefinitionLifecycle.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 4,
      lifecycle_status: 'PUBLISHED',
      active_published_version: 3,
      nodes: [],
      edges: [],
    });
    workflowRepo.getPublishedDefinition.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 3,
      nodes: [{ id: 'start', data: { nodeType: 'start' } }],
      edges: [],
    });

    const reactivated = await service.reactivate('workflow-1', 'admin');

    expect(workflowRepo.setDefinitionLifecycle).toHaveBeenCalledWith('workflow-1', {
      status: 'PUBLISHED',
      active_published_version: 3,
      actor_id: 'admin',
    });
    expect(schedules.syncDefinitionSchedules).toHaveBeenCalledWith('workflow-1', 'Purchase approval', expect.any(Array));
    expect(dbWatch.syncDefinitionWatchJobs).toHaveBeenCalledWith('workflow-1', 'Purchase approval', expect.any(Array));
    expect(reactivated).toEqual(expect.objectContaining({ active_published_version: 3 }));
  });

  it('restores a version as a draft change without moving the published pointer', async () => {
    workflowRepo.getDefinition.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 2,
      lifecycle_status: 'PUBLISHED',
      active_published_version: 2,
      nodes: [],
      edges: [],
    });
    workflowRepo.getDefinitionVersion.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 1,
      lifecycle_status: 'DRAFT',
      active_published_version: null,
      nodes: [],
      edges: [],
    });
    workflowRepo.restoreDefinitionVersion.mockResolvedValue({
      id: 'workflow-1',
      name: 'Purchase approval',
      version: 3,
      lifecycle_status: 'PUBLISHED',
      active_published_version: 2,
      nodes: [],
      edges: [],
    });

    const restored = await service.rollback('workflow-1', 1, 'admin');

    expect(workflowRepo.restoreDefinitionVersion).toHaveBeenCalledWith(
      'workflow-1',
      1,
      expect.objectContaining({
        lifecycle_status: 'PUBLISHED',
        active_published_version: 2,
        updated_by: 'admin',
      }),
    );
    expect(restored).toEqual(
      expect.objectContaining({
        version: 3,
        active_published_version: 2,
        has_unpublished_changes: true,
      }),
    );
    expect(schedules.syncDefinitionSchedules).not.toHaveBeenCalled();
    expect(dbWatch.syncDefinitionWatchJobs).not.toHaveBeenCalled();
  });
});
