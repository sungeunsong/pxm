import { AuthzService } from './authz.service';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';

describe('AuthzService group memberships', () => {
  function membershipService() {
    const existing = {
      id: 'user-1',
      display_name: 'User One',
      email: 'user@example.com',
      role: 'group_manager' as const,
      group_ids: ['group-a', 'group-b'],
      memberships: [
        { group_id: 'group-a', role: 'group_manager' as const },
        { group_id: 'group-b', role: 'user' as const },
      ],
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const repo = {
      getUser: jest.fn().mockResolvedValue(existing),
      getGroup: jest.fn().mockImplementation(async (id: string) => ({ id, status: 'active' })),
      upsertUser: jest.fn().mockImplementation(async (user) => ({ ...existing, ...user })),
    };
    return { existing, repo, service: new AuthzService(repo as any, {} as any) };
  }

  it('adds or changes one group membership without replacing memberships in other groups', async () => {
    const existing = {
      id: 'user-1',
      display_name: 'User One',
      email: 'user@example.com',
      role: 'group_manager' as const,
      group_ids: ['group-a'],
      memberships: [{ group_id: 'group-a', role: 'group_manager' as const }],
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const repo = {
      getUser: jest.fn().mockResolvedValue(existing),
      getGroup: jest.fn().mockImplementation(async (id: string) => ({ id, status: 'active' })),
      upsertUser: jest.fn().mockImplementation(async (user) => ({
        ...existing,
        ...user,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
      })),
    };
    const service = new AuthzService(repo as any, {} as any);

    const saved = await service.upsertUser({
      id: 'user-1',
      display_name: 'User One',
      role: 'user',
      memberships: [{ group_id: 'group-b', role: 'user' }],
    });

    expect(saved.memberships).toEqual([
      { group_id: 'group-a', role: 'group_manager' },
      { group_id: 'group-b', role: 'user' },
    ]);
    expect(saved.group_ids).toEqual(['group-a', 'group-b']);
    expect(saved.role).toBe('group_manager');
  });

  it('preserves a global admin role when adding a scoped membership', async () => {
    const existing = {
      id: 'admin-1',
      display_name: 'Admin',
      role: 'admin' as const,
      group_ids: [],
      memberships: [],
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const repo = {
      getUser: jest.fn().mockResolvedValue(existing),
      getGroup: jest.fn().mockResolvedValue({ id: 'group-a', status: 'active' }),
      upsertUser: jest.fn().mockImplementation(async (user) => ({ ...existing, ...user })),
    };
    const service = new AuthzService(repo as any, {} as any);

    const saved = await service.upsertUser({
      id: 'admin-1',
      display_name: 'Admin',
      role: 'user',
      memberships: [{ group_id: 'group-a', role: 'user' }],
    });

    expect(saved.role).toBe('admin');
  });

  it('rejects a duplicate ID when explicitly creating a user', async () => {
    const { service } = membershipService();

    await expect(service.createUser({ id: 'user-1', display_name: 'Duplicate' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('changes only the requested group membership role', async () => {
    const { service } = membershipService();

    const saved = await service.setUserMembership('user-1', 'group-b', 'group_manager', 'admin-1');

    expect(saved.memberships).toEqual([
      { group_id: 'group-a', role: 'group_manager' },
      { group_id: 'group-b', role: 'group_manager' },
    ]);
    expect(saved.group_ids).toEqual(['group-a', 'group-b']);
  });

  it('removes only the requested group membership without deleting the user', async () => {
    const { service, repo } = membershipService();

    const saved = await service.removeUserMembership('user-1', 'group-a', 'manager-1');

    expect(saved.memberships).toEqual([{ group_id: 'group-b', role: 'user' }]);
    expect(saved.group_ids).toEqual(['group-b']);
    expect(saved.role).toBe('user');
    expect(repo.upsertUser).toHaveBeenCalledWith(expect.objectContaining({
      id: 'user-1',
      display_name: 'User One',
      status: 'active',
    }));
  });
});

describe('AuthzService API key usage history', () => {
  it('keeps the authenticated owner separate from sanitized self-reported business actor data', async () => {
    const repo = {
      listApiKeyUsage: jest.fn().mockResolvedValue({
        total: 1,
        items: [{
          id: 'usage-1',
          api_key_id: 'key-1',
          owner_type: 'SERVICE_ACCOUNT',
          owner_id: 'portal-service',
          group_id: 'group-a',
          endpoint: 'POST /api/v1/templates/workflow-1/start?secret=value',
          workflow_id: 'workflow-1',
          request_id: 'request-1',
          ip: '127.0.0.1',
          user_agent: 'test',
          business_actor: {
            id: 'employee-7',
            name: 'Requester',
            department: 'must-not-be-returned',
            token: 'must-not-be-returned',
          },
          status_code: 201,
          duration_ms: 42,
          completed_at: '2026-09-07T01:00:00.042Z',
          completion_state: 'completed',
          created_at: '2026-09-07T01:00:00.000Z',
        }],
      }),
    };
    const service = new AuthzService(repo as any, {} as any);

    const result = await service.listApiKeyUsage({
      groupId: 'group-a', page: 1, pageSize: 20,
    });

    expect(repo.listApiKeyUsage).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'group-a' }));
    expect(result.items[0]).toMatchObject({
      owner_id: 'portal-service',
      endpoint: 'POST /api/v1/templates/workflow-1/start',
      business_actor: { id: 'employee-7', name: 'Requester' },
      status_code: 201,
      duration_ms: 42,
      completion_state: 'completed',
    });
    expect(result.items[0]).not.toHaveProperty('user_agent');
    expect(result.items[0].business_actor).not.toHaveProperty('department');
    expect(result.items[0].business_actor).not.toHaveProperty('token');
  });

  it('rejects a reversed date range before querying storage', async () => {
    const repo = { listApiKeyUsage: jest.fn() };
    const service = new AuthzService(repo as any, {} as any);

    await expect(service.listApiKeyUsage({
      groupId: 'group-a',
      from: '2026-09-08T00:00:00.000Z',
      to: '2026-09-07T00:00:00.000Z',
      page: 1,
      pageSize: 20,
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.listApiKeyUsage).not.toHaveBeenCalled();
  });
});

describe('AuthzService group deletion lifecycle', () => {
  const workflow = {
    id: 'workflow-1', name: 'Scheduled workflow', group_id: 'group-a', lifecycle_status: 'PUBLISHED',
    nodes: [
      { id: 'start', data: { nodeType: 'start', triggerType: 'schedule' } },
      { id: 'service', data: { nodeType: 'service', credential_id: 'credential-1' } },
    ],
  };

  function buildService(activeInstanceCount = 0) {
    const authzRepo = {
      getGroup: jest.fn().mockResolvedValue({ id: 'group-a', name: 'Group A', status: 'active' }),
      listApiKeys: jest.fn().mockResolvedValue([{ id: 'key-1', status: 'active' }]),
      listServiceAccounts: jest.fn().mockResolvedValue([{ id: 'service-1' }]),
      listExternalPrincipalMappings: jest.fn().mockResolvedValue([{ id: 'mapping-1' }]),
      listUsers: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
      listGroupWorkflowRecordIds: jest.fn().mockResolvedValue(['workflow-1']),
      hardDeleteGroup: jest.fn().mockResolvedValue(true),
      completeGroupRecoveryReview: jest.fn().mockResolvedValue(true),
      softDeleteGroup: jest.fn().mockResolvedValue(true),
    };
    const workflowRepo = {
      listDefinitions: jest.fn().mockResolvedValue([workflow]),
      getDefinition: jest.fn().mockResolvedValue(workflow),
    };
    const instanceRepo = {
      getGroupDeletionRuntimeImpact: jest.fn().mockResolvedValue({
        active_instance_count: activeInstanceCount,
        active_instance_ids: activeInstanceCount ? ['instance-1'] : [],
        open_approval_count: activeInstanceCount ? 1 : 0,
      }),
    };
    const schedules = { syncDefinitionSchedules: jest.fn().mockResolvedValue(undefined) };
    const dbWatch = { syncDefinitionWatchJobs: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new AuthzService(authzRepo as any, workflowRepo as any, instanceRepo as any, schedules as any, dbWatch as any),
      authzRepo, schedules, dbWatch,
    };
  }

  it('shows workflows, triggers, credentials, principals, and runtime blockers before deletion', async () => {
    const { service } = buildService(1);

    await expect(service.getGroupDeletionImpact('group-a')).resolves.toEqual(expect.objectContaining({
      workflows: [expect.objectContaining({ id: 'workflow-1' })],
      active_instance_count: 1,
      open_approval_count: 1,
      schedule_trigger_count: 1,
      db_watch_trigger_count: 0,
      referenced_credential_ids: ['credential-1'],
      active_api_key_count: 1,
      service_account_count: 1,
      external_mapping_count: 1,
      member_count: 1,
      deletion_mode: 'blocked',
      deletion_blocked: true,
    }));
  });

  it('blocks deletion without disabling triggers when an instance is active', async () => {
    const { service, authzRepo, schedules } = buildService(1);

    await expect(service.deleteGroup('group-a', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    expect(schedules.syncDefinitionSchedules).not.toHaveBeenCalled();
    expect(authzRepo.softDeleteGroup).not.toHaveBeenCalled();
  });

  it('disables automatic triggers before cascading the group deletion', async () => {
    const { service, authzRepo, schedules, dbWatch } = buildService();

    await expect(service.deleteGroup('group-a', 'admin-1')).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(schedules.syncDefinitionSchedules).toHaveBeenCalledWith('workflow-1', 'Scheduled workflow', []);
    expect(dbWatch.syncDefinitionWatchJobs).toHaveBeenCalledWith('workflow-1', 'Scheduled workflow', []);
    expect(authzRepo.softDeleteGroup).toHaveBeenCalledWith('group-a', 'admin-1');
  });

  it('permanently deletes only a group with no resources or usage history', async () => {
    const { service, authzRepo, schedules } = buildService();
    authzRepo.listApiKeys.mockResolvedValue([]);
    authzRepo.listServiceAccounts.mockResolvedValue([]);
    authzRepo.listExternalPrincipalMappings.mockResolvedValue([]);
    authzRepo.listUsers.mockResolvedValue([]);
    authzRepo.listGroupWorkflowRecordIds.mockResolvedValue([]);
    (service as any).workflowRepo.listDefinitions.mockResolvedValue([]);

    await expect(service.getGroupDeletionImpact('group-a')).resolves.toEqual(expect.objectContaining({
      deletion_mode: 'permanent',
      permanent_deletion_allowed: true,
      usage_history_reasons: [],
    }));
    await expect(service.deleteGroup('group-a', 'admin-1')).resolves.toEqual(expect.objectContaining({
      deletion_mode: 'permanent',
    }));
    expect(authzRepo.hardDeleteGroup).toHaveBeenCalledWith('group-a');
    expect(authzRepo.softDeleteGroup).not.toHaveBeenCalled();
    expect(schedules.syncDefinitionSchedules).not.toHaveBeenCalled();
  });

  it('keeps an otherwise empty group recoverable when an audit history exists', async () => {
    const { authzRepo, schedules, dbWatch } = buildService();
    authzRepo.listApiKeys.mockResolvedValue([]);
    authzRepo.listServiceAccounts.mockResolvedValue([]);
    authzRepo.listExternalPrincipalMappings.mockResolvedValue([]);
    authzRepo.listUsers.mockResolvedValue([]);
    authzRepo.listGroupWorkflowRecordIds.mockResolvedValue([]);
    const workflowRepo = { listDefinitions: jest.fn().mockResolvedValue([]), getDefinition: jest.fn() };
    const instanceRepo = { getGroupDeletionRuntimeImpact: jest.fn().mockResolvedValue({ active_instance_count: 0, active_instance_ids: [], open_approval_count: 0 }) };
    const audit = { summarizeGroupUsage: jest.fn().mockResolvedValue([{ action: 'user.membership_removed', count: 1 }]) };
    const service = new AuthzService(authzRepo as any, workflowRepo as any, instanceRepo as any, schedules as any, dbWatch as any, audit as any);

    await expect(service.getGroupDeletionImpact('group-a')).resolves.toEqual(expect.objectContaining({
      deletion_mode: 'recoverable',
      permanent_deletion_allowed: false,
      usage_history_reasons: [expect.objectContaining({ code: 'management_history', count: 1 })],
    }));
  });

  it('treats a repeated deletion as an idempotent success', async () => {
    const { service, authzRepo, schedules } = buildService();
    authzRepo.getGroup.mockResolvedValue({ id: 'group-a', name: 'Group A', status: 'deleted' });

    await expect(service.deleteGroup('group-a', 'admin-1')).resolves.toEqual({
      success: true, already_deleted: true, impact: null,
    });
    expect(schedules.syncDefinitionSchedules).not.toHaveBeenCalled();
    expect(authzRepo.softDeleteGroup).not.toHaveBeenCalled();
  });
});

describe('AuthzService external principal mappings', () => {
  const activeUser = {
    id: 'pxm-user-1',
    display_name: 'PXM Approver',
    email: 'pxm@example.com',
    role: 'user' as const,
    group_ids: ['group-a'],
    memberships: [{ group_id: 'group-a', role: 'user' as const }],
    status: 'active' as const,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  const mapping = {
    id: 'mapping-1',
    provider: 'acrapoint',
    subject: 'EMP-100',
    group_id: 'group-a',
    pxm_user_id: activeUser.id,
    display_name: 'External Approver',
    email: 'external@example.com',
    department: 'Finance',
    status: 'active' as const,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };

  function approvalForm(approver: Record<string, any>) {
    return {
      approval_request: {
        source: { provider: 'acrapoint' },
        request_id: 'REQ-1',
        approval_line: { steps: [{ order: 1, approvers: [approver] }] },
      },
    };
  }

  it('creates a unique mapping only for an active user in the target group', async () => {
    const repo = {
      getGroup: jest.fn().mockResolvedValue({ id: 'group-a', status: 'active' }),
      getUser: jest.fn().mockResolvedValue(activeUser),
      findExternalPrincipalMapping: jest.fn().mockResolvedValue(null),
      createExternalPrincipalMapping: jest.fn().mockResolvedValue(mapping),
    };
    const service = new AuthzService(repo as any, {} as any);

    await expect(service.createExternalPrincipalMapping({
      provider: 'acrapoint',
      subject: 'EMP-100',
      group_id: 'group-a',
      pxm_user_id: activeUser.id,
      email: 'External@Example.com',
    }, 'admin')).resolves.toMatchObject({
      provider: 'acrapoint',
      available_channels: ['pxm_user', 'external_email'],
      issues: [],
    });
    expect(repo.createExternalPrincipalMapping).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'acrapoint',
      email: 'external@example.com',
      actor: 'admin',
    }));
  });

  it('rejects a duplicate provider and subject mapping', async () => {
    const repo = {
      getGroup: jest.fn().mockResolvedValue({ id: 'group-a', status: 'active' }),
      getUser: jest.fn().mockResolvedValue(activeUser),
      findExternalPrincipalMapping: jest.fn().mockResolvedValue(mapping),
    };
    const service = new AuthzService(repo as any, {} as any);
    await expect(service.createExternalPrincipalMapping({
      provider: 'acrapoint', subject: 'EMP-100', group_id: 'group-a', pxm_user_id: activeUser.id,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolves a mapped hybrid approver and snapshots mapping, user, and email data', async () => {
    const repo = {
      findExternalPrincipalMapping: jest.fn().mockResolvedValue(mapping),
      getUser: jest.fn().mockResolvedValue(activeUser),
    };
    const service = new AuthzService(repo as any, {} as any);
    const formData = approvalForm({
      principal: { provider: 'acrapoint', subject: 'EMP-100' },
      approval_channels: ['pxm_user', 'external_email'],
    });

    await service.resolveExternalApprovalPrincipals(formData, 'approval_request', 'group-a');

    const approver = formData.approval_request.approval_line.steps[0].approvers[0];
    expect(approver).toMatchObject({
      pxm_user_id: 'pxm-user-1',
      delivery: { email: 'external@example.com' },
      display: { name: 'External Approver', email: 'external@example.com', department: 'Finance' },
      principal_mapping: {
        id: 'mapping-1',
        pxm_user_id: 'pxm-user-1',
        version: 1,
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    });
  });

  it('allows an unmapped external user to use email only', async () => {
    const repo = {
      findExternalPrincipalMapping: jest.fn().mockResolvedValue(null),
      getUser: jest.fn(),
    };
    const service = new AuthzService(repo as any, {} as any);
    const formData = approvalForm({
      principal: { provider: 'vendor', subject: 'person-9' },
      approval_channels: ['external_email'],
      delivery: { email: 'person@example.com' },
    });

    await expect(
      service.resolveExternalApprovalPrincipals(formData, 'approval_request', 'group-a'),
    ).resolves.toBeUndefined();
    expect(repo.getUser).not.toHaveBeenCalled();
  });

  it('keeps mapping health and email delivery availability independent', async () => {
    const disabledUser = { ...activeUser, status: 'disabled' as const };
    const repo = {
      listExternalPrincipalMappings: jest.fn().mockResolvedValue([mapping]),
      findExternalPrincipalMapping: jest.fn().mockResolvedValue(mapping),
      getUser: jest.fn().mockResolvedValue(disabledUser),
    };
    const service = new AuthzService(repo as any, {} as any);
    const formData = approvalForm({
      principal: { provider: 'acrapoint', subject: 'EMP-100' },
      approval_channels: ['external_email'],
    });

    await expect(
      service.resolveExternalApprovalPrincipals(formData, 'approval_request', 'group-a'),
    ).resolves.toBeUndefined();
    await expect(service.listExternalPrincipalMappings({ group_id: 'group-a' }))
      .resolves.toEqual([
        expect.objectContaining({
          issues: expect.arrayContaining(['user_disabled']),
          available_channels: ['external_email'],
        }),
      ]);
  });

  it.each([
    ['unmapped external user', null],
    ['disabled mapping', { ...mapping, status: 'disabled' }],
    ['mapping in another group', { ...mapping, group_id: 'group-b' }],
  ])('rejects pxm_user delivery for %s', async (_label, currentMapping) => {
    const repo = {
      findExternalPrincipalMapping: jest.fn().mockResolvedValue(currentMapping),
      getUser: jest.fn().mockResolvedValue(activeUser),
    };
    const service = new AuthzService(repo as any, {} as any);
    const formData = approvalForm({
      principal: { provider: 'acrapoint', subject: 'EMP-100' },
      approval_channels: ['pxm_user'],
    });

    await expect(
      service.resolveExternalApprovalPrincipals(formData, 'approval_request', 'group-a'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not let a later mapping change mutate a resolved execution snapshot', async () => {
    const repo = {
      findExternalPrincipalMapping: jest.fn().mockResolvedValue(mapping),
      getUser: jest.fn().mockResolvedValue(activeUser),
    };
    const service = new AuthzService(repo as any, {} as any);
    const formData = approvalForm({
      principal: { provider: 'acrapoint', subject: 'EMP-100' },
      approval_channels: ['pxm_user'],
    });
    await service.resolveExternalApprovalPrincipals(formData, 'approval_request', 'group-a');

    mapping.pxm_user_id = activeUser.id;
    repo.findExternalPrincipalMapping.mockResolvedValue({
      ...mapping,
      pxm_user_id: 'pxm-user-2',
      updated_at: '2026-01-03T00:00:00.000Z',
    });

    const snapshot = formData.approval_request.approval_line.steps[0].approvers[0];
    expect(snapshot.pxm_user_id).toBe('pxm-user-1');
    expect(snapshot.principal_mapping.updated_at).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('AuthzService API key workflow access', () => {
  const now = '2026-01-01T00:00:00.000Z';

  function apiKeyService(workflows: Array<{ id: string; group_id: string }> = []) {
    const repo = {
      getGroup: jest.fn().mockResolvedValue({ id: 'group-a', status: 'active' }),
      getServiceAccount: jest.fn().mockResolvedValue({ id: 'service-1', group_id: 'group-a', status: 'active' }),
      createApiKey: jest.fn().mockImplementation(async (key) => ({
        ...key,
        id: key.id || 'key-new',
        status: 'active',
        created_at: now,
        updated_at: now,
      })),
      getApiKey: jest.fn(),
      disableApiKey: jest.fn().mockResolvedValue(true),
    };
    const workflowRepo = {
      listDefinitions: jest.fn().mockImplementation(async () => workflows),
      getDefinition: jest.fn().mockImplementation(async (id: string) => workflows.find((item) => item.id === id) || null),
    };
    return { repo, workflowRepo, service: new AuthzService(repo as any, workflowRepo as any) };
  }

  it('dynamically includes workflows added after an all_in_group key was issued', async () => {
    const workflows = [{ id: 'workflow-1', group_id: 'group-a' }];
    const { service } = apiKeyService(workflows);
    const key = { workflow_access: 'all_in_group', group_id: 'group-a', allowed_workflow_ids: [] } as any;

    await expect(service.resolveAllowedWorkflowIds(key)).resolves.toEqual(['workflow-1']);
    workflows.push({ id: 'workflow-2', group_id: 'group-a' });
    workflows.push({ id: 'workflow-other-group', group_id: 'group-b' });
    await expect(service.resolveAllowedWorkflowIds(key)).resolves.toEqual(['workflow-1', 'workflow-2']);
  });

  it('keeps an empty allowlist empty even when the group has workflows', async () => {
    const { service, workflowRepo } = apiKeyService([{ id: 'workflow-1', group_id: 'group-a' }]);
    const key = { workflow_access: 'allowlist', group_id: 'group-a', allowed_workflow_ids: [] } as any;

    await expect(service.resolveAllowedWorkflowIds(key)).resolves.toEqual([]);
    expect(workflowRepo.listDefinitions).not.toHaveBeenCalled();
  });

  it('stores explicit policies and rejects workflow ids for all_in_group', async () => {
    const { service, repo } = apiKeyService([{ id: 'workflow-1', group_id: 'group-a' }]);
    const base = {
      name: 'Integration', owner_type: 'SERVICE_ACCOUNT' as const, owner_id: 'service-1',
      group_id: 'group-a', scopes: ['workflow:execute'] as const,
    };

    await expect(service.createApiKey({
      ...base, workflow_access: 'all_in_group', allowed_workflow_ids: ['workflow-1'],
    })).rejects.toBeInstanceOf(BadRequestException);

    await service.createApiKey({
      ...base, workflow_access: 'allowlist', allowed_workflow_ids: ['workflow-1'],
    });
    expect(repo.createApiKey).toHaveBeenLastCalledWith(expect.objectContaining({
      workflow_access: 'allowlist', allowed_workflow_ids: ['workflow-1'],
    }));
  });

  it('preserves workflow access policy when rotating a key', async () => {
    const { service, repo } = apiKeyService();
    repo.getApiKey.mockResolvedValue({
      id: 'key-old', name: 'Integration', owner_type: 'SERVICE_ACCOUNT', owner_id: 'service-1',
      group_id: 'group-a', key_prefix: 'pxm_live_old', key_hash: 'hash', scopes: ['workflow:execute'],
      workflow_access: 'all_in_group', allowed_workflow_ids: [], ip_allowlist: [], status: 'active',
      created_at: now, updated_at: now,
    });

    await service.rotateApiKey('key-old', 'admin');
    expect(repo.createApiKey).toHaveBeenCalledWith(expect.objectContaining({
      workflow_access: 'all_in_group', allowed_workflow_ids: [],
    }));
    expect(repo.disableApiKey).toHaveBeenCalledWith('key-old', 'admin');
  });
});

describe('AuthzService API key authentication', () => {
  const activeKey = {
    id: 'key-1',
    name: 'Integration key',
    owner_type: 'SERVICE_ACCOUNT' as const,
    owner_id: 'service-1',
    group_id: 'group-a',
    key_prefix: 'pxm_live_example',
    key_hash: 'hash',
    scopes: ['workflow:read'] as const,
    workflow_access: 'allowlist' as const,
    allowed_workflow_ids: ['workflow-1'],
    ip_allowlist: [],
    rate_limit_per_minute: null,
    status: 'active' as const,
    expires_at: null,
    created_by: 'admin',
    disabled_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  function authenticationService(key: Record<string, any> | null = activeKey, groupStatus = 'active') {
    const repo = {
      findApiKeyByHash: jest.fn().mockResolvedValue(key),
      getGroup: jest.fn().mockResolvedValue({ id: 'group-a', status: groupStatus }),
      touchApiKey: jest.fn().mockResolvedValue(undefined),
    };
    return { repo, service: new AuthzService(repo as any, {} as any) };
  }

  it('returns 401 for a malformed API key', async () => {
    const { service } = authenticationService();
    await expect(service.authenticateApiKey('not-a-pxm-key')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 for an unknown API key', async () => {
    const { service } = authenticationService(null);
    await expect(service.authenticateApiKey('pxm_live_unknown')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['disabled', { ...activeKey, status: 'disabled' }],
    ['expired', { ...activeKey, expires_at: '2000-01-01T00:00:00.000Z' }],
  ])('returns 401 for a %s API key', async (_label, key) => {
    const { service } = authenticationService(key);
    await expect(service.authenticateApiKey('pxm_live_existing')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 401 when the API key group is inactive', async () => {
    const { service } = authenticationService(activeKey, 'deleted');
    await expect(service.authenticateApiKey('pxm_live_existing')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('authenticates an active key and records its use time', async () => {
    const { repo, service } = authenticationService();
    await expect(service.authenticateApiKey('pxm_live_existing')).resolves.toBe(activeKey);
    expect(repo.touchApiKey).toHaveBeenCalledWith('key-1', expect.any(String));
  });
});
