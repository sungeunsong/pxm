import {
  candidateActivePublishedVersion,
  resolveWorkflowLifecycle,
} from './workflow-lifecycle';

describe('workflow lifecycle metadata', () => {
  const now = '2026-09-02T10:00:00.000Z';

  it('publishes the current immutable version for the first time', () => {
    const current = {
      version: 3,
      active_published_version: null,
      published_at: null,
      published_by: null,
    };
    const update = { status: 'PUBLISHED' as const, actor_id: 'admin' };

    expect(candidateActivePublishedVersion(current, update)).toBe(3);
    expect(resolveWorkflowLifecycle(current, update, true, now)).toEqual({
      activePublishedVersion: 3,
      publishedAt: now,
      publishedBy: 'admin',
    });
  });

  it('records a new publication when the active immutable version changes', () => {
    const current = {
      version: 4,
      active_published_version: 3,
      published_at: '2026-08-01T00:00:00.000Z',
      published_by: 'first-admin',
    };

    expect(
      resolveWorkflowLifecycle(
        current,
        {
          status: 'PUBLISHED',
          active_published_version: 4,
          actor_id: 'second-admin',
        },
        true,
        now,
      ),
    ).toEqual({
      activePublishedVersion: 4,
      publishedAt: now,
      publishedBy: 'second-admin',
    });
  });

  it('preserves publication metadata while disabling and reactivating the same version', () => {
    const current = {
      version: 4,
      active_published_version: 3,
      published_at: '2026-08-01T00:00:00.000Z',
      published_by: 'first-admin',
    };
    const disabled = resolveWorkflowLifecycle(
      current,
      { status: 'DISABLED', actor_id: 'operator' },
      true,
      now,
    );
    expect(disabled).toEqual({
      activePublishedVersion: 3,
      publishedAt: current.published_at,
      publishedBy: current.published_by,
    });

    expect(
      resolveWorkflowLifecycle(
        { ...current, lifecycle_status: 'DISABLED' },
        {
          status: 'PUBLISHED',
          active_published_version: 3,
          actor_id: 'operator',
        },
        true,
        now,
      ),
    ).toEqual(disabled);
  });

  it('rejects a published lifecycle without a positive immutable version', () => {
    expect(() =>
      resolveWorkflowLifecycle(
        { version: 0 },
        { status: 'PUBLISHED' },
        false,
        now,
      ),
    ).toThrow('positive active_published_version');
  });

  it('rejects a lifecycle pointer whose immutable snapshot does not exist', () => {
    expect(() =>
      resolveWorkflowLifecycle(
        { version: 2 },
        {
          status: 'PUBLISHED',
          active_published_version: 2,
        },
        false,
        now,
      ),
    ).toThrow('Workflow version v2 does not exist');
  });

  it('replaces an invalid legacy publication timestamp during reactivation', () => {
    expect(
      resolveWorkflowLifecycle(
        {
          version: 2,
          active_published_version: 2,
          published_at: 'not-a-date',
          published_by: 'first-admin',
        },
        {
          status: 'PUBLISHED',
          active_published_version: 2,
          actor_id: 'operator',
        },
        true,
        now,
      ),
    ).toEqual({
      activePublishedVersion: 2,
      publishedAt: now,
      publishedBy: 'first-admin',
    });
  });
});
