import { AuthzService } from './authz.service';

describe('AuthzService group memberships', () => {
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
});
