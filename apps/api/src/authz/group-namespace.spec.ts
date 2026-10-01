import { ConflictException } from '@nestjs/common';
import { AuthzService } from './authz.service';
import {
  isValidGroupNamespace,
  suggestGroupNamespace,
  uniqueGroupNamespace,
} from './group-namespace';

describe('group namespace helpers', () => {
  it('derives a valid namespace from an ASCII group name', () => {
    expect(suggestGroupNamespace('SecOps Team', 'g1')).toBe('secops-team');
    expect(suggestGroupNamespace('  123 Ops!! ', 'g1')).toBe('ops');
  });

  it('falls back to the group id when the name has no ASCII letters', () => {
    expect(suggestGroupNamespace('보안운영팀', 'security-ops')).toBe(
      'security-ops',
    );
    const value = suggestGroupNamespace(
      '보안운영팀',
      '0CE44000-b3e7-483c-8025-c60a089d74f0',
    );
    expect(value).toBe('group-0ce44000');
    expect(isValidGroupNamespace(value)).toBe(true);
  });

  it('keeps suggestions within the length limit', () => {
    const value = suggestGroupNamespace('a'.repeat(80), 'g1');
    expect(value).toHaveLength(32);
    expect(isValidGroupNamespace(value)).toBe(true);
  });

  it('adds a numeric suffix when the value is taken', () => {
    expect(uniqueGroupNamespace('secops', new Set())).toBe('secops');
    expect(
      uniqueGroupNamespace('secops', new Set(['secops', 'secops-2'])),
    ).toBe('secops-3');
    const long = 'a'.repeat(32);
    const next = uniqueGroupNamespace(long, new Set([long]));
    expect(next).toHaveLength(32);
    expect(next.endsWith('-2')).toBe(true);
  });

  it('rejects values outside the pattern', () => {
    expect(isValidGroupNamespace('Secops')).toBe(false);
    expect(isValidGroupNamespace('1ops')).toBe(false);
    expect(isValidGroupNamespace('a')).toBe(false);
    expect(isValidGroupNamespace('sec_ops-1')).toBe(true);
    // '__'는 한정 이름 구분자라 쓰면 다른 그룹 Tool 이름과 겹칠 수 있다
    expect(isValidGroupNamespace('foo__x')).toBe(false);
  });
});

describe('AuthzService group namespace', () => {
  function build(
    groups: Array<{ id: string; name: string; namespace?: string | null }>,
  ) {
    const store = new Map(
      groups.map((group) => [group.id, { status: 'active', ...group }]),
    );
    const repo = {
      listGroups: jest.fn(async () => [...store.values()]),
      getGroup: jest.fn(async (id: string) => store.get(id) ?? null),
      upsertGroup: jest.fn(async (input: { id?: string; name: string }) => {
        const id = input.id ?? 'new-group';
        const current = store.get(id);
        const next = {
          status: 'active',
          namespace: null,
          ...current,
          id,
          name: input.name,
        };
        store.set(id, next);
        return next;
      }),
      assignGroupNamespace: jest.fn(async (id: string, namespace: string) => {
        if (
          [...store.values()].some((group) => group.namespace === namespace)
        ) {
          throw Object.assign(new Error('duplicate'), { code: 11000 });
        }
        const current = store.get(id)!;
        if (current.namespace) return false;
        store.set(id, { ...current, namespace });
        return true;
      }),
    };
    return { repo, store, service: new AuthzService(repo as any, {} as any) };
  }

  it('assigns a namespace derived from the name when a group is created', async () => {
    const { service } = build([
      { id: 'g0', name: 'Other', namespace: 'secops' },
    ]);
    const saved = await service.upsertGroup({ name: 'SecOps' });
    expect(saved.namespace).toBe('secops-2');
  });

  it('uses the requested namespace on create', async () => {
    const { service } = build([]);
    const saved = await service.upsertGroup({
      name: '보안운영팀',
      namespace: 'sec',
    });
    expect(saved.namespace).toBe('sec');
  });

  it('rejects a requested namespace that another group uses', async () => {
    const { service, repo } = build([
      { id: 'g0', name: 'Other', namespace: 'sec' },
    ]);
    await expect(
      service.upsertGroup({ name: 'New', namespace: 'sec' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.upsertGroup).not.toHaveBeenCalled();
  });

  it('keeps the namespace when the group is renamed and rejects changing it', async () => {
    const { service } = build([
      { id: 'g1', name: 'SecOps', namespace: 'secops' },
    ]);
    const renamed = await service.upsertGroup({
      id: 'g1',
      name: 'Security Operations',
    });
    expect(renamed.namespace).toBe('secops');
    await expect(
      service.upsertGroup({ id: 'g1', name: 'SecOps', namespace: 'other' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws instead of returning a group without a namespace', async () => {
    const { service, repo } = build([
      { id: 'g1', name: 'Ops', namespace: null },
    ]);
    repo.assignGroupNamespace.mockImplementation(async () => {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    });
    await expect(
      service.ensureGroupNamespace({
        id: 'g1',
        name: 'Ops',
        status: 'active',
      } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses the value another server assigned at the same time', async () => {
    const { service, repo, store } = build([
      { id: 'g1', name: 'Ops', namespace: null },
    ]);
    repo.assignGroupNamespace.mockImplementation(async () => {
      store.set('g1', { ...store.get('g1')!, namespace: 'ops' });
      return false;
    });
    const saved = await service.ensureGroupNamespace({
      id: 'g1',
      name: 'Ops',
      status: 'active',
    } as any);
    expect(saved.namespace).toBe('ops');
  });

  it('backfills groups created before namespaces existed', async () => {
    const { service, store } = build([
      { id: 'g1', name: 'Ops', namespace: null },
      { id: 'g2', name: 'ops', namespace: null },
      { id: 'g3', name: 'Keep', namespace: 'keep' },
    ]);
    await service.onModuleInit();
    expect(store.get('g1')!.namespace).toBe('ops');
    expect(store.get('g2')!.namespace).toBe('ops-2');
    expect(store.get('g3')!.namespace).toBe('keep');
  });
});
