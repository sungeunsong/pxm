import type { WorkflowHistoryActor } from './ports/db.ports';
import { buildWorkflowInstanceStats } from './instance-stats';

describe('instance stats', () => {
  it('returns every supported state and folds unexpected states into UNKNOWN', () => {
    expect(
      buildWorkflowInstanceStats([
        { state: 'RUNNING', count: 52 },
        { state: 'FAILED', count: '3' },
        { state: 'CUSTOM', count: 2 },
      ]),
    ).toEqual({
      total: 57,
      by_state: {
        CREATED: 0,
        RUNNING: 52,
        WAITING: 0,
        PAUSED: 0,
        COMPLETED: 0,
        FAILED: 3,
        TERMINATED: 0,
        UNKNOWN: 2,
      },
      scope: 'all',
    });
  });

  it('marks a non-admin result as authorization scoped', () => {
    expect(
      buildWorkflowInstanceStats([], actor({ roles: ['group_manager'] })).scope,
    ).toBe('authorized');
  });
});

function actor(overrides: Partial<WorkflowHistoryActor>): WorkflowHistoryActor {
  return {
    actor_type: 'user',
    actor_id: 'manager-1',
    roles: [],
    scopes: [],
    workspace_ids: [],
    group_ids: [],
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    api_key_id: null,
    business_actor: null,
    ...overrides,
  };
}
