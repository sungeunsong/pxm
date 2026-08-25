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
