import type { WorkflowHistoryActor, WorkflowInputPreset } from '../db/ports/db.ports';
import {
  canManageInputPreset,
  canUseInputPreset,
  normalizeWorkflowInputValues,
  validateInputPresetValues,
  validateWorkflowInputValues,
} from './templates.controller';

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

describe('workflow input contract', () => {
  const nodes = [{ data: { nodeType: 'start', formSchema: { fields: [
    { id: 'request_type', type: 'select', required: true, options: ['일반', '긴급'], defaultValue: '일반' },
    { id: 'reason', type: 'textarea', required: true, minLength: 3 },
    { id: 'notify', type: 'checkbox', defaultValue: false },
    { id: 'emergency_contact', type: 'text', required: true, condition: { field: 'request_type', operator: 'eq', value: '긴급' } },
    { id: 'api_token', type: 'text' },
  ] } } }];

  it('applies defaults and removes fields hidden by their condition', () => {
    expect(normalizeWorkflowInputValues(nodes, {
      reason: '정기 신청',
      emergency_contact: '010-0000-0000',
    })).toEqual({
      values: { request_type: '일반', reason: '정기 신청', notify: false },
      errors: [],
    });
  });

  it('validates required fields, types, options and unknown keys', () => {
    expect(validateWorkflowInputValues(nodes, {
      request_type: '임의 값',
      notify: 'yes',
      unknown: true,
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('reason'),
      expect.stringContaining('boolean'),
      expect.stringContaining('허용된 옵션'),
      expect.stringContaining('없는 키'),
    ]));
  });

  it('requires conditional fields only while they are visible', () => {
    expect(validateWorkflowInputValues(nodes, { request_type: '긴급', reason: '긴급 신청' }))
      .toContain('필수 입력값이 비어 있습니다: emergency_contact');
    expect(validateWorkflowInputValues(nodes, { request_type: '일반', reason: '일반 신청' }))
      .not.toContain('필수 입력값이 비어 있습니다: emergency_contact');
  });

  it('allows declared sensitive-looking runtime fields but not stored presets', () => {
    const value = { reason: '토큰 전달', api_token: 'runtime-only' };
    expect(validateWorkflowInputValues(nodes, value)).toEqual([]);
    expect(validateInputPresetValues(nodes, value)).toEqual(expect.arrayContaining([
      expect.stringContaining('민감정보 키'),
    ]));
  });

  describe('dynamic approval line', () => {
    const approvalLine = { approval_line: { steps: [{ approvers: [{ principal: { provider: 'hr', subject: 'u-1' } }] }] } };
    const dynamicApproval = { data: { nodeType: 'approval', approvalLineSource: 'dynamic' } };

    it('passes the approval request through alongside form fields', () => {
      expect(normalizeWorkflowInputValues([...nodes, dynamicApproval], {
        reason: '권한 신청',
        approval_request: approvalLine,
      })).toEqual({
        values: { request_type: '일반', reason: '권한 신청', notify: false, approval_request: approvalLine },
        errors: [],
      });
    });

    it('uses the configured top-level key of a nested approval request path', () => {
      const custom = { data: { nodeType: 'approval', approvalType: 'dynamic', approvalRequestPath: 'meta.line' } };
      const result = normalizeWorkflowInputValues([...nodes, custom], { reason: '권한 신청', meta: { line: approvalLine } });
      expect(result.errors).toEqual([]);
      expect(result.values.meta).toEqual({ line: approvalLine });
    });

    it('still rejects the key when the workflow has no dynamic approval node', () => {
      expect(validateWorkflowInputValues(nodes, { reason: '권한 신청', approval_request: approvalLine }))
        .toContain('Start 입력 스키마에 없는 키입니다: approval_request');
    });
  });

  it('keeps schema-less workflow input compatible', () => {
    expect(normalizeWorkflowInputValues([{ data: { nodeType: 'start' } }], { legacy: { nested: true } }))
      .toEqual({ values: { legacy: { nested: true } }, errors: [] });
  });
});
