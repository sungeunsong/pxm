const baseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3011/api';
const userId = process.env.PXM_DEMO_USER || 'admin';
const password = process.env.PXM_DEMO_PASSWORD || 'admin1234';

const login = await fetch(`${baseUrl}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: userId, password }),
});
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
const cookies = login.headers.getSetCookie();
const cookie = cookies.map(value => value.split(';')[0]).join('; ');
const csrf = decodeURIComponent(cookies.map(value => value.split(';')[0]).find(value => value.includes('pxm_csrf='))?.split('=')[1] || '');
const headers = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };

const groupsResponse = await fetch(`${baseUrl}/authz/groups`, { headers: { cookie } });
const groups = await groupsResponse.json();
let group = groups.find(item => item.name === 'Executive Demo');
if (!group) {
  const response = await fetch(`${baseUrl}/authz/groups`, { method: 'POST', headers, body: JSON.stringify({ name: 'Executive Demo', description: '프레젠테이션 및 제품 캡처용 데모 그룹' }) });
  if (!response.ok) throw new Error(`group create failed: ${response.status} ${await response.text()}`);
  group = await response.json();
}

const node = (id, x, y, nodeType, label, description, extra = {}) => ({
  id, type: 'custom', position: { x, y },
  data: { nodeType, label, description, ...extra },
});
const edge = (source, target, label, extra = {}) => ({
  id: `edge-${source}-${target}`, source, target, type: 'smoothstep', animated: true,
  label: label || undefined, data: { label: label || undefined, ...extra },
  style: { strokeWidth: 2 },
});

const nodes = [
  node('start', 30, 340, 'start', 'Premium Order Intake', 'VIP 주문과 파트너 요청을 실시간으로 접수합니다.', { triggerType: 'manual', formSchema: { fields: [{ id: 'customer', type: 'text', label: 'Customer', required: true }, { id: 'amount', type: 'number', label: 'Order Amount', required: true }] } }),
  node('normalize', 230, 340, 'script', 'Normalize Request', '채널별 입력을 표준 주문 모델로 정규화합니다.', { scriptType: 'javascript', outputPath: 'order.normalized' }),
  node('validate', 430, 340, 'service', 'Contract Validation', '필수 계약 정보와 데이터 품질을 검증합니다.', { plugin_id: 'builtin.http_request', plugin_version: '1.0.0', outputPath: 'validation' }),
  node('fanout', 630, 340, 'gateway', 'Parallel Intelligence', '위험·재고·컴플라이언스 분석을 동시에 시작합니다.', { gatewayType: 'parallel' }),
  node('risk', 830, 90, 'script', 'AI Risk Scoring', '거래 패턴과 고객 이력으로 위험 점수를 계산합니다.', { scriptType: 'javascript', outputPath: 'analysis.risk' }),
  node('inventory', 830, 340, 'service', 'Global Inventory Check', '다중 리전 재고와 공급 가능 일정을 조회합니다.', { plugin_id: 'connector.db.mongodb.query', plugin_version: '1.0.0', outputPath: 'analysis.inventory' }),
  node('compliance', 830, 590, 'command', 'Compliance Screening', '제재·수출통제·정책 룰셋을 일괄 검사합니다.', { commandId: 'builtin.echo', outputPath: 'analysis.compliance' }),
  node('join-analysis', 1040, 340, 'gateway', 'Analysis Sync', '세 가지 분석 결과가 모두 준비될 때까지 동기화합니다.', { gatewayType: 'parallel_join' }),
  node('decision', 1240, 340, 'gateway', 'Approval Strategy', '위험도와 주문 금액에 따라 승인 경로를 결정합니다.', { gatewayType: 'exclusive' }),
  node('executive-approval', 1450, 130, 'approval', 'Executive Approval', '고액 또는 고위험 주문을 책임자가 승인합니다.', { approvalType: 'single', assignee: 'executive-approver' }),
  node('auto-approve', 1450, 550, 'script', 'Smart Auto Approval', '정책 기준을 만족하는 주문을 자동 승인합니다.', { scriptType: 'javascript', outputPath: 'approval.auto' }),
  node('merge-decision', 1660, 340, 'gateway', 'Decision Merge', '수동·자동 승인 결과를 단일 실행 경로로 통합합니다.', { gatewayType: 'exclusive_merge' }),
  node('provision', 1660, 780, 'workflow_call', 'Fulfillment Orchestration', '결제·물류·라이선스 하위 워크플로우를 호출합니다.', { workflowCallMode: 'async', outputPath: 'fulfillment' }),
  node('wait', 1430, 780, 'timer', 'SLA Guard · 15 min', '외부 시스템 확정 상태를 기다리고 SLA를 감시합니다.', { timerType: 'duration', durationSeconds: 900 }),
  node('delivery-split', 1200, 780, 'gateway', 'Parallel Finalization', '고객 알림과 감사 보관을 동시에 수행합니다.', { gatewayType: 'parallel' }),
  node('notify', 940, 700, 'service', 'Omnichannel Notification', 'Email·Slack·Partner Portal로 처리 결과를 전송합니다.', { plugin_id: 'builtin.http_request', plugin_version: '1.0.0', outputPath: 'delivery.notification' }),
  node('audit', 940, 880, 'service', 'Immutable Audit Archive', '결정 근거와 실행 trace를 감사 저장소에 보관합니다.', { plugin_id: 'connector.db.mongodb.query', plugin_version: '1.0.0', outputPath: 'delivery.audit' }),
  node('complete', 680, 790, 'end', 'Order Activated', '전체 프로세스를 완료하고 통합 결과를 반환합니다.', { resultPath: 'fulfillment' }),
];

const edges = [
  edge('start', 'normalize'), edge('normalize', 'validate'), edge('validate', 'fanout'),
  edge('fanout', 'risk', 'Risk'), edge('fanout', 'inventory', 'Inventory'), edge('fanout', 'compliance', 'Compliance'),
  edge('risk', 'join-analysis'), edge('inventory', 'join-analysis'), edge('compliance', 'join-analysis'), edge('join-analysis', 'decision'),
  edge('decision', 'executive-approval', 'High Value · Review'), edge('decision', 'auto-approve', 'Low Risk · Auto'),
  edge('executive-approval', 'merge-decision'), edge('auto-approve', 'merge-decision'), edge('merge-decision', 'provision'), edge('provision', 'wait'), edge('wait', 'delivery-split'),
  edge('delivery-split', 'notify', 'Customer'), edge('delivery-split', 'audit', 'Audit'), edge('notify', 'complete'), edge('audit', 'complete'),
];

const existing = await (await fetch(`${baseUrl}/templates?activeOnly=false`, { headers: { cookie } })).json();
const previous = existing.find(item => item.name === 'DEMO · Intelligent Order Command Center');
let response;
const payload = { name: 'DEMO · Intelligent Order Command Center', description: 'AI 위험 분석, 병렬 검증, 임원 승인, 자동 실행과 감사 보관까지 연결한 프레젠테이션용 End-to-End workflow', group: 'Executive Demo', group_id: group.id, tags: ['showcase', 'ai', 'parallel', 'approval', 'orchestration'], version_note: 'Executive showcase capture flow', nodes, edges };
if (previous) response = await fetch(`${baseUrl}/templates/${previous.id}`, { method: 'PUT', headers, body: JSON.stringify(payload) });
else response = await fetch(`${baseUrl}/templates`, { method: 'POST', headers, body: JSON.stringify(payload) });
if (!response.ok) throw new Error(`template save failed: ${response.status} ${await response.text()}`);
const saved = await response.json();
console.log(JSON.stringify({ id: saved.id, name: saved.name, group_id: saved.group_id, nodes: saved.nodes.length, edges: saved.edges.length }, null, 2));
