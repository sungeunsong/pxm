export const marker = 'pxm-guided-demo-v1';
export const groupId = 'pxm-guided-demo';
export const users = [
  { id: 'demo-secadmin', display_name: '데모 · 보안 관리자', email: 'demo-secadmin@pxm.local', role: 'group_manager' },
  { id: 'demo-approver1', display_name: '데모 · 내부 승인자', email: 'demo-approver1@pxm.local', role: 'user' },
  { id: 'demo-approver2', display_name: '데모 · 공동 승인자', email: 'demo-approver2@pxm.local', role: 'user' },
  { id: 'demo-delegate1', display_name: '데모 · 대리 결재자', email: 'demo-delegate1@pxm.local', role: 'user' },
  { id: 'demo-requester1', display_name: '데모 · 신청자', email: 'demo-requester1@pxm.local', role: 'user' },
];
export const employees = [
  { emp_id: 'E-1001', name: '김사원', employment_type: 'employee', security_training_done: true },
  { emp_id: 'E-2001', name: '이협력', employment_type: 'partner', security_training_done: true },
  { emp_id: 'E-2002', name: '박협력', employment_type: 'partner', security_training_done: false },
];
export const demoLibrary = { package_name: 'lodash', version: '4.17.21' };
export const externalPrincipalMapping = {
  provider: 'pxm-demo-hr',
  subject: 'partner-manager-01',
  group_id: groupId,
  pxm_user_id: 'demo-approver1',
  display_name: '협력사 승인 책임자',
  email: 'partner-approver@pxm.local',
  department: '외부 협력사',
};
const node = (id, x, y, nodeType, label, data = {}) => ({ id, type: 'custom', position: { x, y }, data: { nodeType, label, ...data } });
const edge = (source, target, extra = {}) => ({ id: `${source}-${target}`, source, target, type: 'smoothstep', ...extra });
const approval = (id, x, y, external = false) => node(id, x, y, 'approval', external ? '협력사 이메일 승인' : '내부 담당자 승인', {
  approvalType: 'single', approvalLineSource: 'fixed',
  approverChannel: external ? 'external_email' : 'pxm_user',
  assignee: external ? 'partner-approver@pxm.local' : 'demo-approver1',
  externalApprovalRequireOtp: true,
});
const fields = [
  { id: 'emp_id', type: 'text', label: '사번', required: true },
  { id: 'privilege_level', type: 'text', label: '권한 (read / admin)', required: true },
  { id: 'target_system', type: 'text', label: '대상 시스템', required: true },
];
export function fixtures(credentials, dbName, serviceUrl) {
  const start = () => node('start', 0, 160, 'start', '접근 권한 신청', { triggerType: 'manual', formSchema: { fields } });
  const end = (id, x, y, label) => node(id, x, y, 'end', label);
  const common = { group_id: groupId, group: '데모 · 보안운영팀', tags: [marker], version_note: '반복 실습 기준 데이터 v1' };
  const libraryFields = [
    { id: 'numbers', type: 'text', label: '처리할 숫자 (쉼표로 구분)', required: true },
  ];
  return [
    { key: 'basic', payload: { ...common, name: '실습 1 · 기본 접근 권한 결재', description: '신청 → 내부 승인/반려 → 결과 확인',
      nodes: [start(), approval('approval', 260, 160), end('approved', 520, 60, '승인 완료'), end('rejected', 520, 300, '반려 완료')],
      edges: [edge('start', 'approval'), edge('approval', 'approved', { sourceHandle: 'approved' }), edge('approval', 'rejected', { sourceHandle: 'rejected' })],
    } },
    { key: 'delegation', payload: { ...common, name: '실습 3 · 대리 결재와 기한 알림', description: '원래 승인자의 결재가 대리 결재자에게 전달되고 1분 뒤 기한 알림이 발생하는 실습',
      nodes: [start(), approval('delegated-approval', 280, 160, false), end('approved', 560, 60, '승인 완료'), end('rejected', 560, 300, '반려 완료')]
        .map(item => item.id === 'delegated-approval' ? { ...item, data: { ...item.data,
          label: '대리 결재 대상 승인', approvalDeadlineEnabled: true, approvalDeadlineValue: 1,
          approvalDeadlineUnit: 'minutes', approvalEscalationGraceValue: 1,
          approvalEscalationGraceUnit: 'minutes', approvalDelegationAllowed: true,
        } } : item),
      edges: [edge('start', 'delegated-approval'), edge('delegated-approval', 'approved', { sourceHandle: 'approved' }), edge('delegated-approval', 'rejected', { sourceHandle: 'rejected' })],
    } },
    { key: 'integrated', payload: { ...common, name: '실습 2 · 협력사 접근 권한 신청', description: '직원 조회 → 위험도 분기 → 내부/외부 승인 → 모의 접근제어 시스템 반영',
      nodes: [start(),
        node('lookup', 230, 160, 'service', '직원 정보 조회', { plugin_id: 'connector.db.mongodb.query', plugin_version: '1.0.0', credential_id: credentials.hr, database: dbName, collection: 'pxm_demo_employees', operation: 'find', filter: { emp_id: '{{formData.emp_id}}' }, outputPath: 'hr' }),
        node('risk', 460, 160, 'script', '위험도 계산', { scriptType: 'javascript', outputPath: 'risk', code: `const person = context.data.outputs.hr.rows[0];
if (!person) throw new Error('직원 정보를 찾을 수 없습니다.');
const req = context.data.formData;
const score = (req.privilege_level === 'admin' ? 50 : 0) + (person.employment_type === 'partner' ? 30 : 0) + (!person.security_training_done ? 20 : 0);
console.log('위험 점수:', score);
return { level: score < 50 ? 'AUTO' : 'REVIEW', score };` }),
        node('decision', 690, 160, 'gateway', '자동 처리 / 승인 필요', { gatewayType: 'exclusive' }),
        approval('internal', 920, 280), approval('external', 1150, 280, true),
        node('provision', 1380, 80, 'service', '모의 권한 반영', { plugin_id: 'builtin.http_request', plugin_version: '1.0.0', credential_id: credentials.access, method: 'POST', url: `${serviceUrl}/invoke`, body: { emp_id: '{{formData.emp_id}}', privilege_level: '{{formData.privilege_level}}', target_system: '{{formData.target_system}}' }, outputPath: 'provisioning' }),
        end('approved', 1610, 80, '권한 반영 완료'), end('rejected', 1380, 400, '반려 종료'),
      ],
      edges: [edge('start', 'lookup'), edge('lookup', 'risk'), edge('risk', 'decision'),
        edge('decision', 'provision', { label: '저위험', data: { condition: 'data.outputs.risk.level == AUTO' } }),
        edge('decision', 'internal', { label: '검토 필요', data: { isDefault: true } }),
        edge('internal', 'external', { sourceHandle: 'approved' }), edge('internal', 'rejected', { sourceHandle: 'rejected' }),
        edge('external', 'provision', { sourceHandle: 'approved' }), edge('external', 'rejected', { sourceHandle: 'rejected' }), edge('provision', 'approved')],
    } },
    { key: 'designerLab', payload: { ...common,
      name: '실습 5 · 디자이너와 배포 수명주기',
      description: '빠른 노드 추가, 자동 정렬, 실행 설정 요약과 배포 버전 관리를 안전하게 연습하는 전용 워크플로우',
      nodes: [
        node('start', 40, 80, 'start', '변경 요청 접수', { triggerType: 'manual', formSchema: { fields } }),
        node('lookup', 470, 390, 'service', '대상 사용자 조회', {
          plugin_id: 'connector.db.mongodb.query', plugin_version: '1.0.0', credential_id: credentials.hr,
          database: dbName, collection: 'pxm_demo_employees', operation: 'find',
          filter: { emp_id: '{{formData.emp_id}}' }, outputPath: 'employee',
        }),
        node('decision', 250, 560, 'gateway', '관리자 권한 여부', { gatewayType: 'exclusive' }),
        approval('approval', 790, 440),
        node('provision', 1040, 180, 'service', '모의 변경 반영', {
          plugin_id: 'builtin.http_request', plugin_version: '1.0.0', credential_id: credentials.access,
          method: 'POST', url: `${serviceUrl}/invoke`,
          body: { emp_id: '{{formData.emp_id}}', privilege_level: '{{formData.privilege_level}}', target_system: '{{formData.target_system}}' },
          outputPath: 'provisioning',
        }),
        end('completed', 1320, 80, '변경 완료'),
        end('rejected', 1260, 480, '반려 종료'),
      ],
      edges: [
        edge('start', 'lookup'), edge('lookup', 'decision'),
        edge('decision', 'provision', { label: '일반 권한', data: { condition: 'privilege_level != admin' } }),
        edge('decision', 'approval', { label: '관리자 권한', data: { isDefault: true } }),
        edge('approval', 'provision', { sourceHandle: 'approved' }),
        edge('approval', 'rejected', { sourceHandle: 'rejected' }), edge('provision', 'completed'),
      ],
    } },
    { key: 'multiStage', presets: [multiStagePreset], payload: { ...common,
      name: '실습 6 · 다단계 공동 결재',
      description: '1단계 전원 승인(ALL) → 2단계 선착순 승인(ANY) → 완료 결과 Webhook을 확인하는 실습',
      nodes: [
        node('start', 0, 140, 'start', '변경 요청', { triggerType: 'manual', formSchema: { fields: [
          { id: 'request_id', type: 'text', label: '외부 요청 번호', required: true },
          { id: 'request_title', type: 'text', label: '요청 제목', required: true },
        ] } }),
        node('build-request', 300, 140, 'script', '결재선 구성', {
          scriptType: 'javascript', outputPath: 'formData.approval_request',
          code: `const req = context.data.formData;
return {
  source: { provider: 'pxm-demo-hr' },
  request_id: req.request_id,
  revision: 1,
  content: { title: req.request_title, summary: '데모용 계정 권한 변경', requester: 'demo-requester1' },
  approval_line: { steps: [
    { order: 1, label: '보안 담당 공동 검토', mode: 'ALL', approvers: [
      { assignee: 'demo-approver1', approver_channel: 'pxm_user' },
      { assignee: 'demo-approver2', approver_channel: 'pxm_user' },
    ] },
    { order: 2, label: '최종 승인', mode: 'ANY', approvers: [
      { assignee: 'demo-secadmin', approval_channels: ['pxm_user', 'external_email'], email: 'demo-secadmin@pxm.local' },
      { assignee: 'partner-approver@pxm.local', approver_channel: 'external_email' },
    ] },
  ] },
};`,
        }),
        node('approval', 620, 140, 'approval', '동적 다단계 결재', {
          approvalType: 'dynamic', approvalLineSource: 'dynamic', approvalRequestPath: 'approval_request',
          approvalDelegationAllowed: false,
        }),
        end('approved', 940, 40, '변경 승인 완료'),
        end('rejected', 940, 280, '변경 반려 종료'),
      ],
      edges: [
        edge('start', 'build-request'), edge('build-request', 'approval'),
        edge('approval', 'approved', { sourceHandle: 'approved' }),
        edge('approval', 'rejected', { sourceHandle: 'rejected' }),
      ],
    } },
    { key: 'commandTerminal', presets: [commandPreset], payload: { ...common,
      name: '실습 7 · 명령 실행 터미널',
      description: '허용 목록에 등록된 명령만 실행하고 stdout/stderr/종료 코드를 터미널 화면으로 확인하는 실습',
      nodes: [
        node('start', 0, 120, 'start', '운영 점검 시작', {
          triggerType: 'manual',
          formSchema: { fields: [
            { id: 'message', type: 'text', label: '출력 메시지', required: true, defaultValue: 'PXM demo command completed' },
          ] },
        }),
        node('command', 300, 120, 'command', '허용된 점검 명령 실행', {
          commandId: 'builtin.echo',
          commandArgumentsJson: JSON.stringify({ message: '{{formData.message}}' }, null, 2),
          commandTimeoutMs: 1000,
          outputPath: 'commandResult',
        }),
        end('completed', 620, 120, '점검 완료'),
      ],
      edges: [edge('start', 'command'), edge('command', 'completed')],
    } },
    { key: 'nodeVersionGate', presets: [], payload: { ...common,
      name: '실습 8 · Node.js 버전 점검 분기',
      description: '허용 명령의 stdout을 후속 JS 노드에서 구조화하고 기준 버전에 따라 분기하는 실습',
      nodes: [
        node('start', 0, 140, 'start', '런타임 점검 시작', { triggerType: 'manual', formSchema: { fields: [] } }),
        node('node-version', 280, 140, 'command', 'Node.js 버전 확인', {
          commandId: 'builtin.node_version',
          commandArgumentsJson: '{}',
          commandTimeoutMs: 1000,
          outputPath: 'nodeVersion',
        }),
        node('parse-version', 560, 140, 'script', '메이저 버전 판독', {
          scriptType: 'javascript',
          outputPath: 'nodeVersionCheck',
          code: `const raw = String(context.data.outputs.nodeVersion.stdout || '').trim();
const matched = /^v(\\d+)\\.(\\d+)\\.(\\d+)/.exec(raw);
if (!matched) throw new Error('Node.js 버전 형식을 해석할 수 없습니다: ' + raw);
const major = Number(matched[1]);
console.log('감지한 Node.js 버전:', raw, '메이저:', major);
return { raw, major, minimum: 20, supported: major >= 20 };`,
        }),
        node('version-gate', 840, 140, 'gateway', 'Node.js 20 이상 여부', { gatewayType: 'exclusive' }),
        end('supported', 1120, 40, '지원 버전 확인'),
        end('upgrade', 1120, 260, '업그레이드 필요'),
      ],
      edges: [
        edge('start', 'node-version'),
        edge('node-version', 'parse-version'),
        edge('parse-version', 'version-gate'),
        edge('version-gate', 'supported', { label: '20 이상', data: { condition: 'data.outputs.nodeVersionCheck.major >= 20' } }),
        edge('version-gate', 'upgrade', { label: '20 미만', data: { isDefault: true } }),
      ],
    } },
    { key: 'jsLibrary', presets: [libraryPreset], payload: { ...common,
      name: '실습 4 · 승인된 JS 라이브러리 사용',
      description: '관리자가 승인한 lodash 고정 버전을 JS 노드에서 사용해 입력 숫자를 집계',
      nodes: [
        node('start', 0, 120, 'start', '집계 요청', { triggerType: 'manual', formSchema: { fields: libraryFields } }),
        node('aggregate', 300, 120, 'script', 'lodash로 숫자 집계', {
          scriptType: 'javascript', outputPath: 'libraryResult',
          scriptLibraries: [demoLibrary],
          code: `const values = String(context.data.formData.numbers || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
  .map(Number)
  .filter(Number.isFinite);
if (!values.length) throw new Error('숫자를 하나 이상 입력해 주세요.');
const lodash = libs['lodash'];
return {
  count: values.length,
  unique: lodash.uniq(values),
  sortedUnique: lodash.sortBy(lodash.uniq(values)),
  total: lodash.sum(values),
};`,
        }),
        end('completed', 620, 120, '집계 완료'),
      ],
      edges: [edge('start', 'aggregate'), edge('aggregate', 'completed')],
    } },
    ...(credentials.ssh ? [{ key: 'sshRemote', presets: [sshPreset], payload: { ...common,
      name: '실습 9 · SSH 원격 명령 실행',
      description: '등록된 SSH 자격증명으로 원격 명령을 실행하고 stdout을 후속 노드로 넘기는 실습',
      nodes: [
        node('start', 0, 140, 'start', '원격 점검 시작', {
          triggerType: 'manual',
          formSchema: { fields: [
            { id: 'target_path', type: 'text', label: '확인할 원격 경로', required: true, defaultValue: '/tmp' },
          ] },
        }),
        node('ssh', 300, 140, 'service', '원격 서버 상태 확인', {
          plugin_id: 'builtin.ssh',
          plugin_version: '1.0.0',
          credential_id: credentials.ssh,
          command: 'hostname && uname -sr && ls -1 {{formData.target_path}} | wc -l',
          timeout_ms: 15000,
          outputPath: 'remote',
        }),
        node('summarize', 600, 140, 'script', '원격 결과 정리', {
          scriptType: 'javascript',
          outputPath: 'remoteSummary',
          code: `const lines = String(context.data.outputs.remote.stdout || '')
  .split('\\n')
  .map(line => line.trim())
  .filter(Boolean);
if (lines.length < 3) throw new Error('원격 명령 출력이 예상과 다릅니다: ' + JSON.stringify(lines));
return {
  hostname: lines[0],
  kernel: lines[1],
  entryCount: Number(lines[2]),
  exitCode: context.data.outputs.remote.exit_code,
};`,
        }),
        end('completed', 900, 140, '원격 점검 완료'),
      ],
      edges: [edge('start', 'ssh'), edge('ssh', 'summarize'), edge('summarize', 'completed')],
    } }] : []),
  ];
}
export const sshPreset = {
  alias: 'demo-ssh',
  name: '원격 /tmp 점검',
  values: { target_path: '/tmp' },
};
export const presets = [
  { alias: 'demo-auto', name: '저위험 · 자동 처리', values: { emp_id: 'E-1001', privilege_level: 'read', target_system: '개발 포털' } },
  { alias: 'demo-review', name: '고위험 · 내부/외부 승인', values: { emp_id: 'E-2001', privilege_level: 'admin', target_system: '개발 포털' } },
];
export const libraryPreset = {
  alias: 'demo-library',
  name: 'lodash 숫자 집계',
  values: { numbers: '12, 7, 12, 30, 7' },
};
export const multiStagePreset = {
  alias: 'demo-multi-stage',
  name: '공동 결재 데모 요청',
  values: { request_id: 'DEMO-APPROVAL-001', request_title: '협력사 관리자 권한 변경' },
};
export const commandPreset = {
  alias: 'demo-command',
  name: '운영 점검 메시지 출력',
  values: { message: 'PXM demo command completed' },
};

export const demoCommands = [
  {
    command_id: 'demo.request_summary',
    display_name: 'Request Summary',
    description: '여러 동적 인자를 지정된 순서로 조합해 요청 요약을 출력하는 시연용 command입니다.',
    executable: '/usr/bin/printf',
    fixed_args: ['요청번호=%s | 대상=%s | 작업=%s'],
    arg_order: ['request_id', 'target_system', 'action'],
    argument_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', title: 'Request ID', default: 'REQ-2026-001' },
        target_system: { type: 'string', title: 'Target System', default: '개발 포털' },
        action: { type: 'string', title: 'Action', default: '권한 부여' },
      },
      required: ['request_id', 'target_system', 'action'],
    },
    timeout_ms: 1000,
    max_stdout_bytes: 4096,
    max_stderr_bytes: 4096,
    working_dir: null,
    workspace_ids: [],
    enabled: true,
  },
  {
    command_id: 'demo.path_label',
    display_name: 'Path Label',
    description: '파일을 읽지 않고 입력 경로의 마지막 이름만 추출하는 시연용 command입니다.',
    executable: '/usr/bin/basename',
    fixed_args: ['--'],
    arg_order: ['path'],
    argument_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', title: 'Path', default: '/srv/releases/pxm-v9.tar.gz' },
      },
      required: ['path'],
    },
    timeout_ms: 1000,
    max_stdout_bytes: 4096,
    max_stderr_bytes: 4096,
    working_dir: null,
    workspace_ids: [],
    enabled: true,
  },
];
