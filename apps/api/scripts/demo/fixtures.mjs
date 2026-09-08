export const marker = 'pxm-guided-demo-v1';
export const groupId = 'pxm-guided-demo';
export const users = [
  { id: 'demo-secadmin', display_name: '데모 · 보안 관리자', role: 'group_manager' },
  { id: 'demo-approver1', display_name: '데모 · 내부 승인자', role: 'user' },
  { id: 'demo-requester1', display_name: '데모 · 신청자', role: 'user' },
];
export const employees = [
  { emp_id: 'E-1001', name: '김사원', employment_type: 'employee', security_training_done: true },
  { emp_id: 'E-2001', name: '이협력', employment_type: 'partner', security_training_done: true },
  { emp_id: 'E-2002', name: '박협력', employment_type: 'partner', security_training_done: false },
];
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
  return [
    { key: 'basic', payload: { ...common, name: '실습 1 · 기본 접근 권한 결재', description: '신청 → 내부 승인/반려 → 결과 확인',
      nodes: [start(), approval('approval', 260, 160), end('approved', 520, 60, '승인 완료'), end('rejected', 520, 300, '반려 완료')],
      edges: [edge('start', 'approval'), edge('approval', 'approved', { sourceHandle: 'approved' }), edge('approval', 'rejected', { sourceHandle: 'rejected' })],
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
  ];
}
export const presets = [
  { alias: 'demo-auto', name: '저위험 · 자동 처리', values: { emp_id: 'E-1001', privilege_level: 'read', target_system: '개발 포털' } },
  { alias: 'demo-review', name: '고위험 · 내부/외부 승인', values: { emp_id: 'E-2001', privilege_level: 'admin', target_system: '개발 포털' } },
];
