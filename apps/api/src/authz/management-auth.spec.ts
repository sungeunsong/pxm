import { ForbiddenException } from '@nestjs/common';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import {
  assertCanManageGroup,
  groupRole,
  manageableGroupId,
  managerGroupIds,
} from './management-auth';

describe('group-scoped management authorization', () => {
  const actor: WorkflowHistoryActor = {
    actor_type: 'user',
    actor_id: 'manager-1',
    roles: ['group_manager'],
    scopes: [],
    workspace_ids: [],
    group_ids: ['group-a', 'group-b'],
    group_roles: {
      'group-a': 'group_manager',
      'group-b': 'user',
    },
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    api_key_id: null,
  };

  it('allows management only in groups where the membership role is group_manager', () => {
    expect(() => assertCanManageGroup(actor, 'group-a')).not.toThrow();
    expect(() => assertCanManageGroup(actor, 'group-b')).toThrow(ForbiddenException);
    expect(groupRole(actor, 'group-b')).toBe('user');
    expect(managerGroupIds(actor)).toEqual(['group-a']);
  });

  it('validates an explicitly selected group instead of silently using another group', () => {
    expect(manageableGroupId(actor, 'group-a')).toBe('group-a');
    expect(() => manageableGroupId(actor, 'group-b')).toThrow(ForbiddenException);
  });

  it('keeps legacy role and group_ids actors compatible', () => {
    const legacyActor = { ...actor, group_roles: undefined, group_ids: ['group-a', 'group-b'] };
    expect(managerGroupIds(legacyActor)).toEqual(['group-a', 'group-b']);
    expect(() => assertCanManageGroup(legacyActor, 'group-b')).not.toThrow();
  });
});
