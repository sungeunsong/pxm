import { WorkflowLifecycleUpdate } from './ports/db.ports';

type WorkflowLifecycleState = {
  version?: number | null;
  active_published_version?: number | null;
  published_at?: string | null;
  published_by?: string | null;
  metadata?: {
    active_published_version?: number | null;
    published_at?: string | null;
    published_by?: string | null;
  };
};

export type ResolvedWorkflowLifecycle = {
  activePublishedVersion: number | null;
  publishedAt: string | null;
  publishedBy: string | null;
};

function currentValue<T>(
  state: WorkflowLifecycleState,
  key: 'active_published_version' | 'published_at' | 'published_by',
): T | null {
  return (state[key] ?? state.metadata?.[key] ?? null) as T | null;
}

function isValidTimestamp(value: string | null): value is string {
  return Boolean(value && !Number.isNaN(Date.parse(value)));
}

export function candidateActivePublishedVersion(
  current: WorkflowLifecycleState,
  lifecycle: WorkflowLifecycleUpdate,
): number | null {
  return (
    lifecycle.active_published_version ??
    currentValue<number>(current, 'active_published_version') ??
    (lifecycle.status === 'PUBLISHED' ? (current.version ?? null) : null)
  );
}

export function resolveWorkflowLifecycle(
  current: WorkflowLifecycleState,
  lifecycle: WorkflowLifecycleUpdate,
  snapshotExists: boolean,
  now: string,
): ResolvedWorkflowLifecycle {
  const activePublishedVersion = candidateActivePublishedVersion(
    current,
    lifecycle,
  );
  const hasValidVersion =
    Number.isInteger(activePublishedVersion) &&
    Number(activePublishedVersion) > 0;

  if (lifecycle.status === 'PUBLISHED' && !hasValidVersion) {
    throw new Error(
      'Published workflow requires a positive active_published_version',
    );
  }
  if (hasValidVersion && !snapshotExists) {
    throw new Error(
      `Workflow version v${activePublishedVersion} does not exist`,
    );
  }

  const currentActiveVersion = currentValue<number>(
    current,
    'active_published_version',
  );
  const currentPublishedAt = currentValue<string>(current, 'published_at');
  const currentPublishedBy = currentValue<string>(current, 'published_by');

  if (lifecycle.status === 'DISABLED') {
    return {
      activePublishedVersion: hasValidVersion ? activePublishedVersion : null,
      publishedAt: currentPublishedAt,
      publishedBy: currentPublishedBy,
    };
  }

  const isSamePublication = currentActiveVersion === activePublishedVersion;
  return {
    activePublishedVersion,
    publishedAt:
      isSamePublication && isValidTimestamp(currentPublishedAt)
        ? currentPublishedAt
        : now,
    publishedBy:
      isSamePublication && currentPublishedBy
        ? currentPublishedBy
        : (lifecycle.actor_id ?? null),
  };
}
