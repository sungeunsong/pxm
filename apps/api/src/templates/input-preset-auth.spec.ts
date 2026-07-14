import type { WorkflowHistoryActor, WorkflowInputPreset } from '../db/ports/db.ports';
import { canManageInputPreset, canUseInputPreset, validateInputPresetValues } from './templates.controller';

const presetBase: WorkflowInputPreset = {
  id: 'preset-1',
  workflow_id: 'workflow-1',
  alias: 'default',
  name: 'Default',
  values: { region: 'KR' },
  scope: 'private',
  group_id: null,
  shared_group_ids: [],
  enabled: true,
  created_by: 'user-a',
  updated_by: 'user-a',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function actor(id: string, groupId: string, groupRole: 'group_manager' | 'user'): WorkflowHistoryActor {
  return {
    actor_type: 'user', actor_id: id, roles: [groupRole], scopes: [], workspace_ids: [],
    group_ids: [groupId], group_roles: { [groupId]: groupRole }, owned_workflow_ids: [],
    allowed_workflow_ids: [], allowed_instance_ids: [], api_key_id: null,
  };
}

describe('input preset access policy', () => {
  it('keeps private presets visible and manageable only to the creator', () => {
    expect(canUseInputPreset(actor('user-a', 'group-a', 'user'), presetBase)).toBe(true);
    expect(canManageInputPreset(actor('user-a', 'group-a', 'user'), presetBase)).toBe(true);
    expect(canUseInputPreset(actor('user-b', 'group-a', 'group_manager'), presetBase)).toBe(false);
  });

  it('allows group members to use a group preset but only group managers to manage it', () => {
    const preset = { ...presetBase, scope: 'group' as const, group_id: 'group-a' };
    expect(canUseInputPreset(actor('user-b', 'group-a', 'user'), preset)).toBe(true);
    expect(canManageInputPreset(actor('user-b', 'group-a', 'user'), preset)).toBe(false);
    expect(canManageInputPreset(actor('manager-a', 'group-a', 'group_manager'), preset)).toBe(true);
  });

  it('allows a granted group to use a shared preset without management permission', () => {
    const preset = { ...presetBase, scope: 'shared' as const, group_id: 'group-a', shared_group_ids: ['group-b'] };
    expect(canUseInputPreset(actor('manager-b', 'group-b', 'group_manager'), preset)).toBe(true);
    expect(canManageInputPreset(actor('manager-b', 'group-b', 'group_manager'), preset)).toBe(false);
    expect(canUseInputPreset(actor('user-c', 'group-c', 'user'), preset)).toBe(false);
  });
});

describe('input preset value validation', () => {
  const nodes = [{ data: { nodeType: 'start', formSchema: { fields: [
    { id: 'customer', type: 'text', required: true },
    { id: 'amount', type: 'number', required: true, min: 0 },
    { id: 'dry_run', type: 'checkbox' },
  ] } } }];

  it('accepts values that match the Start input schema', () => {
    expect(validateInputPresetValues(nodes, { customer: 'C-100', amount: 10, dry_run: false })).toEqual([]);
  });

  it('rejects missing, unknown, mismatched and sensitive values', () => {
    expect(validateInputPresetValues(nodes, { amount: '10', unknown: true, nested: { api_key: 'secret' } })).toEqual(expect.arrayContaining([
      expect.stringContaining('민감정보 키'),
      expect.stringContaining('없는 키'),
      expect.stringContaining('customer'),
      expect.stringContaining('number'),
    ]));
  });
});
