import { WorkflowCompatibilityService } from './workflow-compatibility.service';

describe('WorkflowCompatibilityService', () => {
  const node = (id: string, nodeType: string, data: Record<string, unknown> = {}) => ({ id, data: { nodeType, ...data } });

  const build = (overrides: Partial<Record<'libraries' | 'credential' | 'user' | 'plugin' | 'command' | 'target', any>> = {}) => {
    const service = new WorkflowCompatibilityService(
      { getDefinition: jest.fn().mockResolvedValue(overrides.target ?? null) } as any,
      {
        getGroup: jest.fn().mockResolvedValue({ id: 'group-b', name: '인프라팀' }),
        getUser: jest.fn().mockImplementation(async () => {
          if (overrides.user === undefined) throw new Error('not found');
          return overrides.user;
        }),
      } as any,
      { availabilityForGroup: jest.fn().mockResolvedValue(overrides.credential ?? { status: 'ok', name: 'hr-db', owner_group_id: 'group-a' }) } as any,
      { evaluateForGroup: jest.fn().mockResolvedValue(overrides.libraries ?? []) } as any,
      { findOne: jest.fn().mockReturnValue(overrides.plugin === undefined ? { display_name: 'HTTP Request' } : overrides.plugin) } as any,
      { get: jest.fn().mockImplementation(async () => {
        if (overrides.command === undefined) throw new Error('not found');
        return overrides.command;
      }) } as any,
    );
    return service;
  };

  it('명시적 조치가 필요한 항목을 모두 한 번에 보여주고 해결 주체를 붙인다', async () => {
    const service = build({
      libraries: [{ package_name: 'lodash', version: '4.17.21', node_ids: ['js-1'], status: 'not_allowed_for_group' }],
      credential: { status: 'not_shared', name: 'hr-db', owner_group_id: 'group-a' },
      user: { id: 'kim', display_name: '김철수', status: 'active', group_ids: ['group-a'] },
    });
    const report = await service.evaluate('wf-1', [
      node('js-1', 'script', { scriptLibraries: [{ package_name: 'lodash', version: '4.17.21' }] }),
      node('svc-1', 'service', { plugin_id: 'builtin.http_request', credential_id: 'cred-1' }),
      node('appr-1', 'approval', { approvalChannels: ['pxm_user'], assignee: 'kim' }),
    ], 'group-b');

    const byKind = Object.fromEntries(report.items.map((item) => [item.kind, item]));
    expect(byKind.script_library).toMatchObject({ status: 'action_required', remediation: { actor: 'admin', group_id: 'group-b' } });
    expect(byKind.credential).toMatchObject({
      status: 'action_required',
      label: 'hr-db',
      node_ids: ['svc-1'],
      remediation: { actor: 'group_manager', group_id: 'group-a' },
    });
    expect(byKind.approver).toMatchObject({ status: 'blocked', remediation: { actor: 'self' } });
    // 승인·공유로 풀리는 항목은 제품 안에서 바로 요청할 수 있다. 승인자 교체는 요청 대상이 아니다.
    expect(byKind.script_library.requestable).toEqual({ resource_type: 'script_library', resource_ref: { package_name: 'lodash', version: '4.17.21' } });
    expect(byKind.credential.requestable).toEqual({ resource_type: 'credential', resource_ref: { credential_id: 'cred-1' } });
    expect(byKind.approver.requestable).toBeUndefined();
    expect(byKind.plugin).toMatchObject({ status: 'ok' });
    expect(report.summary).toMatchObject({ action_required: 2, blocked: 1, ready: false });
    expect(report.target_group_name).toBe('인프라팀');
  });

  it('모든 자원을 쓸 수 있으면 준비 완료다', async () => {
    const service = build({
      libraries: [{ package_name: 'lodash', version: '4.17.21', node_ids: ['js-1'], status: 'ok' }],
      user: { id: 'kim', status: 'active', group_ids: ['group-b'] },
    });
    const report = await service.evaluate('wf-1', [
      node('svc-1', 'service', { plugin_id: 'builtin.http_request', credential_id: 'cred-1' }),
      node('appr-1', 'approval', { approvalChannels: ['pxm_user'], assignee: 'kim' }),
    ], 'group-b');
    expect(report.summary).toMatchObject({ ready: true, blocked: 0, action_required: 0 });
  });

  it('동적 결재선과 이메일 전용 결재자는 그룹 구성원 검사를 하지 않는다', async () => {
    const report = await build().evaluate('wf-1', [
      node('a1', 'approval', { approvalLineSource: 'dynamic' }),
      node('a2', 'approval', { approvalChannels: ['external_email'], assignee: 'x@corp.example' }),
    ], 'group-b');
    expect(report.items.filter((item) => item.kind === 'approver')).toEqual([]);
  });

  it('그룹 제한이 없는 Command는 경고로, 사용 중지된 플러그인은 차단으로 알린다', async () => {
    const report = await build({ command: { display_name: '권한 부여', enabled: true }, plugin: null }).evaluate('wf-1', [
      node('cmd-1', 'command', { commandId: 'grant' }),
      node('svc-1', 'service', { plugin_id: 'hosted.retired' }),
    ], 'group-b');
    const byKind = Object.fromEntries(report.items.map((item) => [item.kind, item]));
    expect(byKind.command).toMatchObject({ status: 'warning', label: '권한 부여' });
    expect(byKind.plugin).toMatchObject({ status: 'blocked', remediation: { actor: 'admin' } });
    expect(report.summary.ready).toBe(false);
  });

  it('다른 그룹의 하위 워크플로우 호출은 경고, 없는 대상은 차단이다', async () => {
    const other = await build({ target: { id: 'wf-child', name: '계정 조회', group_id: 'group-a' } })
      .evaluate('wf-1', [node('call-1', 'workflow_call', { targetWorkflowId: 'wf-child' })], 'group-b');
    expect(other.items[0]).toMatchObject({ kind: 'workflow_call', status: 'warning', label: '계정 조회', node_ids: ['call-1'] });

    const missing = await build().evaluate('wf-1', [node('call-1', 'workflow_call', { targetWorkflowId: 'gone' })], 'group-b');
    expect(missing.items[0]).toMatchObject({ status: 'blocked' });
  });

  it('관리 그룹이 없으면 그 자체를 차단 항목으로 보여준다', async () => {
    const report = await build().evaluate('wf-1', [], null);
    expect(report.items[0]).toMatchObject({ kind: 'group', status: 'blocked' });
  });
});
