import { ForbiddenException } from '@nestjs/common';
import { AuthzController } from './authz.controller';

describe('AuthzController group deletion policy', () => {
  const adminRequest = {
    workflowActor: {
      actor_type: 'user', actor_id: 'admin-1', roles: ['admin'], scopes: [], workspace_ids: ['default'],
      group_ids: [], group_roles: {}, owned_workflow_ids: [], allowed_workflow_ids: [],
      allowed_instance_ids: [], api_key_id: null,
    },
  } as any;

  it('records the actual deletion mode and preserves credential sharing configuration', async () => {
    const result = { success: true, already_deleted: false, deletion_mode: 'recoverable', impact: { workflows: [] } };
    const authzService = { deleteGroup: jest.fn().mockResolvedValue(result) };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const credentials = { revokeGroupShares: jest.fn() };
    const controller = new AuthzController(authzService as any, audit as any, credentials as any);

    await expect(controller.deleteGroup('group-a', undefined, adminRequest)).resolves.toBe(result);
    expect(credentials.revokeGroupShares).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'group.deleted' }));
  });

  it('records permanent deletion separately', async () => {
    const result = { success: true, already_deleted: false, deletion_mode: 'permanent', impact: { workflows: [] } };
    const authzService = { deleteGroup: jest.fn().mockResolvedValue(result) };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthzController(authzService as any, audit as any, {} as any);

    await controller.deleteGroup('group-a', undefined, adminRequest);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'group.permanently_deleted' }));
  });
});

describe('AuthzController group membership management', () => {
  const managerRequest = {
    workflowActor: {
      actor_type: 'user', actor_id: 'manager-1', roles: ['group_manager'], scopes: [], workspace_ids: ['default'],
      group_ids: ['group-a'], group_roles: { 'group-a': 'group_manager' }, owned_workflow_ids: [],
      allowed_workflow_ids: [], allowed_instance_ids: [], api_key_id: null,
    },
  } as any;

  it('lets a group manager add an ordinary user to their group', async () => {
    const existing = { id: 'user-1', role: 'user', memberships: [], group_ids: [] };
    const saved = { ...existing, memberships: [{ group_id: 'group-a', role: 'user' }], group_ids: ['group-a'] };
    const authzService = {
      getUser: jest.fn().mockResolvedValue(existing),
      setUserMembership: jest.fn().mockResolvedValue(saved),
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthzController(authzService as any, audit as any, {} as any);

    await expect(controller.setGroupMembership('group-a', 'user-1', { role: 'user' }, managerRequest)).resolves.toBe(saved);
    expect(authzService.setUserMembership).toHaveBeenCalledWith('user-1', 'group-a', 'user', 'manager-1');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.membership_added', group_id: 'group-a' }));
  });

  it('prevents a group manager from changing another group manager membership', async () => {
    const authzService = {
      getUser: jest.fn().mockResolvedValue({
        id: 'manager-2', role: 'group_manager', group_ids: ['group-a'],
        memberships: [{ group_id: 'group-a', role: 'group_manager' }],
      }),
      setUserMembership: jest.fn(),
    };
    const controller = new AuthzController(authzService as any, {} as any, {} as any);

    await expect(controller.setGroupMembership('group-a', 'manager-2', { role: 'user' }, managerRequest))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(authzService.setUserMembership).not.toHaveBeenCalled();
  });

  it('prevents a group manager from changing a global admin membership', async () => {
    const authzService = {
      getUser: jest.fn().mockResolvedValue({
        id: 'admin-1', role: 'admin', group_ids: ['group-a'],
        memberships: [{ group_id: 'group-a', role: 'user' }],
      }),
      setUserMembership: jest.fn(),
    };
    const controller = new AuthzController(authzService as any, {} as any, {} as any);

    await expect(controller.setGroupMembership('group-a', 'admin-1', { role: 'user' }, managerRequest))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(authzService.setUserMembership).not.toHaveBeenCalled();
  });

  it('preserves account fields and status when a group manager submits an existing user', async () => {
    const existing = {
      id: 'user-1', display_name: 'Original User', email: 'original@example.com', role: 'user', status: 'active',
      group_ids: ['group-a'], memberships: [{ group_id: 'group-a', role: 'user' }],
    };
    const authzService = {
      getUser: jest.fn().mockResolvedValue(existing),
      upsertUser: jest.fn().mockImplementation(async (dto) => ({ ...existing, ...dto })),
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthzController(authzService as any, audit as any, {} as any);

    await controller.upsertUser({
      id: 'user-1', display_name: 'Changed', email: 'changed@example.com', role: 'user', status: 'disabled',
      memberships: [{ group_id: 'group-a', role: 'user' }], password: 'long-enough-password',
    }, managerRequest);

    expect(authzService.upsertUser).toHaveBeenCalledWith(expect.objectContaining({
      display_name: 'Original User', email: 'original@example.com', status: 'active', password: undefined,
    }));
  });
});

describe('AuthzController external principal mapping management', () => {
  const mapping = {
    id: 'mapping-1',
    provider: 'acrapoint',
    subject: 'EMP-100',
    group_id: 'group-a',
    pxm_user_id: 'user-1',
    display_name: 'Approver',
    email: 'approver@example.com',
    department: 'Finance',
    status: 'active' as const,
    version: 1,
    pxm_user: null,
    available_channels: ['pxm_user', 'external_email'] as const,
    issues: [],
    created_at: '2026-08-03T00:00:00.000Z',
    updated_at: '2026-08-03T00:00:00.000Z',
  };
  const managerRequest = {
    workflowActor: {
      actor_type: 'user',
      actor_id: 'manager-1',
      roles: ['group_manager'],
      scopes: [],
      workspace_ids: ['default'],
      group_ids: ['group-a', 'group-b'],
      group_roles: { 'group-a': 'group_manager', 'group-b': 'user' },
      owned_workflow_ids: [],
      allowed_workflow_ids: [],
      allowed_instance_ids: [],
      api_key_id: null,
    },
  } as any;

  it('allows a group manager to create a mapping in their group and audits the resulting snapshot', async () => {
    const authzService = {
      createExternalPrincipalMapping: jest.fn().mockResolvedValue(mapping),
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthzController(authzService as any, audit as any, {} as any);

    await expect(controller.createExternalPrincipalMapping({
      provider: 'acrapoint',
      subject: 'EMP-100',
      group_id: 'group-a',
      pxm_user_id: 'user-1',
    }, managerRequest)).resolves.toBe(mapping);

    expect(authzService.createExternalPrincipalMapping).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: 'group-a' }),
      'manager-1',
    );
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'external_principal_mapping.created',
      resource_type: 'external_principal_mapping',
      resource_id: 'mapping-1',
      group_id: 'group-a',
      details: { after: expect.objectContaining({ pxm_user_id: 'user-1', status: 'active' }) },
    }));
  });

  it('rejects a group manager attempting to manage a mapping in another group', async () => {
    const authzService = { createExternalPrincipalMapping: jest.fn() };
    const controller = new AuthzController(authzService as any, {} as any, {} as any);

    await expect(controller.createExternalPrincipalMapping({
      provider: 'acrapoint',
      subject: 'EMP-200',
      group_id: 'group-b',
      pxm_user_id: 'user-2',
    }, managerRequest)).rejects.toBeInstanceOf(ForbiddenException);
    expect(authzService.createExternalPrincipalMapping).not.toHaveBeenCalled();
  });

  it('records before and after snapshots for status changes', async () => {
    const disabled = { ...mapping, status: 'disabled' as const };
    const authzService = {
      getExternalPrincipalMapping: jest.fn().mockResolvedValue(mapping),
      setExternalPrincipalMappingStatus: jest.fn().mockResolvedValue(disabled),
    };
    const audit = { append: jest.fn().mockResolvedValue(undefined) };
    const controller = new AuthzController(authzService as any, audit as any, {} as any);

    await controller.setExternalPrincipalMappingStatus(
      mapping.id,
      { status: 'disabled' },
      managerRequest,
    );

    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'external_principal_mapping.disabled',
      details: {
        before: expect.objectContaining({ status: 'active' }),
        after: expect.objectContaining({ status: 'disabled' }),
      },
    }));
  });
});

describe('AuthzController API key usage history', () => {
  const managerRequest = {
    workflowActor: {
      actor_type: 'user', actor_id: 'manager-1', roles: ['group_manager'], scopes: [], workspace_ids: ['default'],
      group_ids: ['group-a', 'group-b'], group_roles: { 'group-a': 'group_manager', 'group-b': 'user' },
      owned_workflow_ids: [], allowed_workflow_ids: [], allowed_instance_ids: [], api_key_id: null,
    },
  } as any;

  it('limits a group manager usage query to a group they manage', async () => {
    const result = { items: [], total: 0, page: 1, pageSize: 20 };
    const authzService = { listApiKeyUsage: jest.fn().mockResolvedValue(result) };
    const controller = new AuthzController(authzService as any, {} as any, {} as any);

    await expect(controller.apiKeyUsage({ groupId: 'group-a', page: 1, pageSize: 20 }, managerRequest))
      .resolves.toBe(result);
    expect(authzService.listApiKeyUsage).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'group-a' }));
  });

  it('rejects a usage query for a group the actor does not manage', async () => {
    const authzService = { listApiKeyUsage: jest.fn() };
    const controller = new AuthzController(authzService as any, {} as any, {} as any);

    await expect(controller.apiKeyUsage({ groupId: 'group-b', page: 1, pageSize: 20 }, managerRequest))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(authzService.listApiKeyUsage).not.toHaveBeenCalled();
  });

  it('rejects an ordinary user usage query', async () => {
    const userRequest = {
      workflowActor: {
        ...managerRequest.workflowActor,
        actor_id: 'user-1', roles: ['user'], group_roles: { 'group-a': 'user' },
      },
    } as any;
    const authzService = { listApiKeyUsage: jest.fn() };
    const controller = new AuthzController(authzService as any, {} as any, {} as any);

    await expect(controller.apiKeyUsage({ groupId: 'group-a', page: 1, pageSize: 20 }, userRequest))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(authzService.listApiKeyUsage).not.toHaveBeenCalled();
  });
});
