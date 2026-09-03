import type {
  WorkflowHistoryActor,
  WorkflowInstanceState,
  WorkflowInstanceStats,
} from './ports/db.ports';

const INSTANCE_STATES: WorkflowInstanceState[] = [
  'CREATED',
  'RUNNING',
  'WAITING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'TERMINATED',
  'UNKNOWN',
];

export function buildWorkflowInstanceStats(
  rows: Array<{ state?: unknown; count?: unknown }>,
  actor?: WorkflowHistoryActor,
): WorkflowInstanceStats {
  const byState = Object.fromEntries(
    INSTANCE_STATES.map((state) => [state, 0]),
  ) as Record<WorkflowInstanceState, number>;

  for (const row of rows) {
    const rawState =
      typeof row.state === 'string' ? row.state.toUpperCase() : '';
    const state = INSTANCE_STATES.includes(rawState as WorkflowInstanceState)
      ? (rawState as WorkflowInstanceState)
      : 'UNKNOWN';
    const count = Number(row.count || 0);
    byState[state] += Number.isFinite(count) ? count : 0;
  }

  return {
    total: Object.values(byState).reduce((sum, count) => sum + count, 0),
    by_state: byState,
    scope: !actor || actor.roles.includes('admin') ? 'all' : 'authorized',
  };
}
