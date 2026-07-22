import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  ArrowRight,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Copy,
  Database,
  ExternalLink,
  FileClock,
  KeyRound,
  ListChecks,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  XCircle,
} from 'lucide-react';
import { ApiError, PxmApi } from './api.ts';
import type { RequestLog } from './api.ts';

type Tab = 'workflows' | 'instances' | 'approvals' | 'console';
type WorkflowItem = { id: string; name: string; description?: string; version?: number; group?: string; group_id?: string; tags?: string[]; nodes?: Array<{ data?: { nodeType?: string; formSchema?: { fields?: Array<{ id: string; label?: string; type?: string }> } } }> };
type InstanceItem = { id?: string; _id?: string; state?: string; status?: string; process_definition_id?: string; definition_id?: string; created_at?: string; updated_at?: string; context?: Record<string, unknown> };
type ApprovalItem = { task_id: string; instance_id: string; workflow_id: string | null; workflow_name: string | null; node_label: string | null; status: string; approver_channel: string; assignee: string; action: string | null; authentication_method: string | null; created_at: string; completed_at: string | null; comment?: string | null; result?: Record<string, unknown> | null };
type ApprovalPage = { items: ApprovalItem[]; next_cursor: string | null };
type TraceItem = { id: number; event_type?: string; type?: string; node_label?: string; created_at?: string; payload?: unknown };

const storedBase = sessionStorage.getItem('pxm-playground-base') || '/api';
const storedKey = sessionStorage.getItem('pxm-playground-key') || '';

export function App() {
  const [baseUrl, setBaseUrl] = useState(storedBase);
  const [apiKey, setApiKey] = useState(storedKey);
  const [businessActorText, setBusinessActorText] = useState('{"employee_id":"DEMO-001"}');
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<Tab>('workflows');
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([]);
  const [instances, setInstances] = useState<InstanceItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowItem | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<InstanceItem | null>(null);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalItem | null>(null);
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [inputJson, setInputJson] = useState('{\n  "requestTitle": "API Consumer Demo",\n  "amount": 125000,\n  "requester": "external-client"\n}');
  const [approvalStatus, setApprovalStatus] = useState('OPEN,APPROVED,REJECTED');
  const [approvalChannel, setApprovalChannel] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const businessActor = useMemo(() => parseObject(businessActorText), [businessActorText]);
  const api = useMemo(() => new PxmApi(
    { baseUrl, apiKey, businessActor },
    (entry) => setLogs((current) => [entry, ...current].slice(0, 100)),
  ), [baseUrl, apiKey, businessActor]);

  const connect = async () => {
    setBusy('connect'); setError(''); setNotice('');
    try {
      const items = await api.get<WorkflowItem[]>('/templates?activeOnly=true');
      setWorkflows(items);
      setConnected(true);
      sessionStorage.setItem('pxm-playground-base', baseUrl);
      sessionStorage.setItem('pxm-playground-key', apiKey);
      setNotice(`${items.length}개 워크플로우를 조회했습니다.`);
    } catch (cause) { setError(apiError(cause)); setConnected(false); }
    finally { setBusy(''); }
  };

  const loadWorkflows = () => run('workflows', async () => setWorkflows(await api.get<WorkflowItem[]>('/templates?activeOnly=true')));
  const loadInstances = () => run('instances', async () => setInstances(await api.get<InstanceItem[]>('/instances')));
  const loadApprovals = () => run('approvals', async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (approvalStatus.trim()) params.set('status', approvalStatus.trim());
    if (approvalChannel) params.set('approver_channel', approvalChannel);
    const page = await api.get<ApprovalPage>(`/tasks/history?${params}`);
    setApprovals(page.items);
  });

  const execute = () => run('execute', async () => {
    if (!selectedWorkflow) return;
    const formData = JSON.parse(inputJson) as Record<string, unknown>;
    const result = await api.post<{ instance_id: string }>(`/templates/${encodeURIComponent(selectedWorkflow.id)}/execute`, { formData });
    setNotice(`Instance ${result.instance_id}를 시작했습니다.`);
    setSelectedWorkflow(null);
    setTab('instances');
    await loadInstancesDirect();
  });

  const loadInstancesDirect = async () => setInstances(await api.get<InstanceItem[]>('/instances'));
  const inspectInstance = (item: InstanceItem) => run('trace', async () => {
    const id = instanceId(item);
    const [detail, events] = await Promise.all([
      api.get<InstanceItem>(`/instances/${encodeURIComponent(id)}`),
      api.get<TraceItem[]>(`/instances/${encodeURIComponent(id)}/trace`),
    ]);
    setSelectedInstance(detail); setTrace(events);
  });
  const inspectApproval = (item: ApprovalItem) => run('approval-detail', async () => {
    setSelectedApproval(await api.get<ApprovalItem>(`/tasks/${encodeURIComponent(item.task_id)}`));
  });
  const completeApproval = (action: 'approve' | 'reject', comment: string) => run('approval-complete', async () => {
    if (!selectedApproval) return;
    await api.post(
      `/tasks/${encodeURIComponent(selectedApproval.task_id)}/complete`,
      { action, comment },
      { 'Idempotency-Key': `api-playground:${selectedApproval.task_id}:${action}:${crypto.randomUUID()}` },
    );
    setNotice(action === 'approve' ? '결재를 승인했습니다.' : '결재를 반려했습니다.');
    setSelectedApproval(null);
    await loadApprovalsDirect();
  });
  const loadApprovalsDirect = async () => {
    const page = await api.get<ApprovalPage>('/tasks/history?status=OPEN,APPROVED,REJECTED&limit=100');
    setApprovals(page.items);
  };

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setError(''); setNotice('');
    try { await action(); }
    catch (cause) { setError(apiError(cause)); }
    finally { setBusy(''); }
  }

  const switchTab = (next: Tab) => {
    setTab(next); setError(''); setNotice('');
    if (next === 'workflows') void loadWorkflows();
    if (next === 'instances') void loadInstances();
    if (next === 'approvals') void loadApprovals();
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Braces /></div><div><strong>PXM</strong><span>API Consumer Demo</span></div></div>
      <div className={`connection-state ${connected ? 'connected' : ''}`}><CircleDot /><div><strong>{connected ? 'API Connected' : 'Not connected'}</strong><span>{baseUrl || '/api'}</span></div></div>
      <nav>
        <NavButton icon={<Workflow />} label="Workflows" active={tab === 'workflows'} disabled={!connected} onClick={() => switchTab('workflows')} />
        <NavButton icon={<Activity />} label="Instances" active={tab === 'instances'} disabled={!connected} onClick={() => switchTab('instances')} />
        <NavButton icon={<ListChecks />} label="Approval History" active={tab === 'approvals'} disabled={!connected} onClick={() => switchTab('approvals')} />
        <NavButton icon={<TerminalSquare />} label="API Console" active={tab === 'console'} disabled={!connected} badge={logs.length} onClick={() => switchTab('console')} />
      </nav>
      <div className="sidebar-note"><ShieldCheck /><p>관리자 세션 없이 API Key scope와 resource boundary를 그대로 검증합니다.</p></div>
    </aside>

    <main>
      <header className="topbar"><div><span className="eyebrow">REFERENCE CLIENT</span><h1>{tabTitle(tab)}</h1></div><div className="top-actions"><button className="ghost" onClick={() => setConnected(false)}><KeyRound /> 연결 설정</button><a className="ghost" href="http://localhost:5174" target="_blank" rel="noreferrer">PXM Console <ExternalLink /></a></div></header>
      {!connected ? <ConnectionPanel baseUrl={baseUrl} apiKey={apiKey} businessActor={businessActorText} busy={busy === 'connect'} error={error} onBaseUrl={setBaseUrl} onApiKey={setApiKey} onBusinessActor={setBusinessActorText} onConnect={() => void connect()} /> : <>
        {(error || notice) && <div className={`banner ${error ? 'error' : 'notice'}`}>{error ? <XCircle /> : <CheckCircle2 />}<span>{error || notice}</span></div>}
        {tab === 'workflows' && <WorkflowsView items={workflows} busy={busy} onRefresh={() => void loadWorkflows()} onSelect={(item) => { setSelectedWorkflow(item); setInputJson(defaultInput(item)); }} />}
        {tab === 'instances' && <InstancesView items={instances} busy={busy} onRefresh={() => void loadInstances()} onInspect={(item) => void inspectInstance(item)} />}
        {tab === 'approvals' && <ApprovalsView items={approvals} busy={busy} status={approvalStatus} channel={approvalChannel} onStatus={setApprovalStatus} onChannel={setApprovalChannel} onSearch={() => void loadApprovals()} onInspect={(item) => void inspectApproval(item)} />}
        {tab === 'console' && <ConsoleView logs={logs} onClear={() => setLogs([])} />}
      </>}
    </main>
    {selectedWorkflow && <ExecuteDrawer workflow={selectedWorkflow} input={inputJson} busy={busy === 'execute'} onInput={setInputJson} onClose={() => setSelectedWorkflow(null)} onExecute={() => void execute()} />}
    {selectedInstance && <DetailDrawer title="Instance Trace" subtitle={instanceId(selectedInstance)} onClose={() => setSelectedInstance(null)}><InstanceDetail item={selectedInstance} trace={trace} /></DetailDrawer>}
    {selectedApproval && <DetailDrawer title="Approval Detail" subtitle={selectedApproval.task_id} onClose={() => setSelectedApproval(null)}><ApprovalDetail item={selectedApproval} busy={busy === 'approval-complete'} onComplete={(action, comment) => void completeApproval(action, comment)} /></DetailDrawer>}
  </div>;
}

function ConnectionPanel(props: { baseUrl: string; apiKey: string; businessActor: string; busy: boolean; error: string; onBaseUrl: (v: string) => void; onApiKey: (v: string) => void; onBusinessActor: (v: string) => void; onConnect: () => void }) {
  return <section className="connection-panel"><div className="connection-copy"><span className="eyebrow">API-FIRST VALIDATION</span><h2>외부 시스템의 시선으로<br />PXM을 호출해 보세요.</h2><p>실제 API Key의 scope, 허용 워크플로우, 그룹 경계를 사용합니다. 입력한 키는 현재 브라우저 탭의 sessionStorage에만 보관됩니다.</p><div className="capabilities"><span><Workflow /> Workflow execute</span><span><Activity /> Instance trace</span><span><FileClock /> Approval history</span></div></div><form onSubmit={(event) => { event.preventDefault(); props.onConnect(); }}><label>API Base URL<input value={props.baseUrl} onChange={(e) => props.onBaseUrl(e.target.value)} placeholder="/api" /><small>로컬 프록시는 `/api`, 원격 서버는 `https://host/api`</small></label><label>API Key<input type="password" value={props.apiKey} onChange={(e) => props.onApiKey(e.target.value)} placeholder="pxm_..." autoComplete="off" /></label><label>Business Actor JSON<textarea value={props.businessActor} onChange={(e) => props.onBusinessActor(e.target.value)} spellCheck={false} /></label>{props.error && <div className="form-error">{props.error}</div>}<button className="primary" disabled={props.busy || !props.apiKey.trim()}>{props.busy ? <RefreshCw className="spin" /> : <ArrowRight />} 연결 및 권한 확인</button></form></section>;
}

function WorkflowsView({ items, busy, onRefresh, onSelect }: { items: WorkflowItem[]; busy: string; onRefresh: () => void; onSelect: (item: WorkflowItem) => void }) {
  return <section><SectionHeader title="Executable workflows" description="API Key에 허용된 워크플로우만 표시됩니다." busy={busy === 'workflows'} onRefresh={onRefresh} /><div className="card-grid">{items.map((item) => <article className="workflow-card" key={item.id}><div className="card-icon"><Workflow /></div><div className="card-meta"><span>v{item.version || 1}</span><span>{item.group || item.group_id || 'No group'}</span></div><h3>{item.name}</h3><p>{item.description || '설명 없음'}</p><div className="tag-row">{(item.tags || []).slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}</div><footer><code>{shortId(item.id)}</code><button onClick={() => onSelect(item)}><Play /> 실행</button></footer></article>)}</div>{!items.length && <Empty icon={<Workflow />} title="조회 가능한 워크플로우가 없습니다" text="API Key의 workflow:read scope와 allowed_workflow_ids를 확인하세요." />}</section>;
}

function InstancesView({ items, busy, onRefresh, onInspect }: { items: InstanceItem[]; busy: string; onRefresh: () => void; onInspect: (item: InstanceItem) => void }) {
  return <section><SectionHeader title="Runtime instances" description="호출 주체가 조회할 수 있는 실행 인스턴스입니다." busy={busy === 'instances'} onRefresh={onRefresh} /><div className="data-table"><div className="table-head"><span>Instance</span><span>Workflow</span><span>Status</span><span>Updated</span><span /></div>{items.map((item) => <button className="table-row" key={instanceId(item)} onClick={() => onInspect(item)}><code>{shortId(instanceId(item))}</code><code>{shortId(item.process_definition_id || item.definition_id || '-')}</code><Status value={item.state || item.status || 'UNKNOWN'} /><span>{formatDate(item.updated_at || item.created_at)}</span><ChevronRight /></button>)}</div>{!items.length && <Empty icon={<Database />} title="실행 인스턴스가 없습니다" text="workflow:execute scope로 워크플로우를 실행해 보세요." />}</section>;
}

function ApprovalsView(props: { items: ApprovalItem[]; busy: string; status: string; channel: string; onStatus: (v: string) => void; onChannel: (v: string) => void; onSearch: () => void; onInspect: (item: ApprovalItem) => void }) {
  return <section><SectionHeader title="Approval task history" description="결재 대기부터 승인·반려 완료 이력까지 API로 조회합니다." /><div className="filters"><label><span>Status</span><input value={props.status} onChange={(e) => props.onStatus(e.target.value)} /></label><label><span>Channel</span><select value={props.channel} onChange={(e) => props.onChannel(e.target.value)}><option value="">All channels</option><option value="pxm_user">PXM user</option><option value="external_email">External email</option></select></label><button onClick={props.onSearch} disabled={props.busy === 'approvals'}><Search /> 조회</button></div><div className="data-table approvals"><div className="table-head"><span>Workflow / Task</span><span>Assignee</span><span>Channel</span><span>Status</span><span>Completed</span><span /></div>{props.items.map((item) => <button className="table-row" key={item.task_id} onClick={() => props.onInspect(item)}><span><strong>{item.workflow_name || 'Unknown workflow'}</strong><code>{shortId(item.task_id)}</code></span><span className="truncate">{item.assignee}</span><span>{item.approver_channel === 'external_email' ? 'Email + OTP' : 'PXM user'}</span><Status value={item.status} /><span>{formatDate(item.completed_at || item.created_at)}</span><ChevronRight /></button>)}</div>{!props.items.length && <Empty icon={<ListChecks />} title="조건에 맞는 결재 이력이 없습니다" text="status 또는 channel 필터를 변경해 보세요." />}</section>;
}

function ConsoleView({ logs, onClear }: { logs: RequestLog[]; onClear: () => void }) {
  const [selected, setSelected] = useState<RequestLog | null>(logs[0] || null);
  return <section><SectionHeader title="API request console" description="Authorization 원문을 제외한 최근 요청·응답 100건입니다." action={<button className="ghost compact" onClick={onClear}>Clear</button>} /><div className="console-layout"><div className="request-list">{logs.map((log) => <button key={`${log.id}-${log.at}`} className={selected?.id === log.id ? 'active' : ''} onClick={() => setSelected(log)}><span className={`method ${log.method.toLowerCase()}`}>{log.method}</span><div><strong>{log.path}</strong><small>{log.status || 'ERR'} · {log.durationMs}ms</small></div></button>)}</div><div className="request-detail">{selected ? <><div className="request-summary"><span className={`method ${selected.method.toLowerCase()}`}>{selected.method}</span><code>{selected.path}</code><Status value={String(selected.status || 'ERROR')} /></div><h4>cURL</h4><CopyBlock text={curlFor(selected)} /><h4>Response</h4><JsonBlock value={selected.responseBody || { error: selected.error }} /></> : <Empty icon={<TerminalSquare />} title="아직 API 요청이 없습니다" text="다른 메뉴에서 API를 호출하면 여기에 기록됩니다." />}</div></div></section>;
}

function ExecuteDrawer({ workflow, input, busy, onInput, onClose, onExecute }: { workflow: WorkflowItem; input: string; busy: boolean; onInput: (v: string) => void; onClose: () => void; onExecute: () => void }) {
  return <DetailDrawer title="Execute Workflow" subtitle={workflow.name} onClose={onClose}><div className="execute-body"><div className="endpoint"><span>POST</span><code>/templates/{workflow.id}/execute</code></div><label>formData JSON<textarea className="code-input" value={input} onChange={(e) => onInput(e.target.value)} spellCheck={false} /></label><button className="primary" disabled={busy} onClick={onExecute}>{busy ? <RefreshCw className="spin" /> : <Play />} 실행 요청 보내기</button></div></DetailDrawer>;
}

function ApprovalDetail({ item, busy, onComplete }: { item: ApprovalItem; busy: boolean; onComplete: (action: 'approve' | 'reject', comment: string) => void }) {
  const [comment, setComment] = useState('API Consumer Demo에서 처리했습니다.');
  return <div className="approval-detail"><JsonBlock value={item} />{item.status === 'OPEN' && <div className="approval-action"><h3>Task action</h3><p>USER 소유 API Key와 <code>task:approve</code> scope가 필요합니다. 서비스 계정 키로는 결재할 수 없습니다.</p><label>Comment<textarea value={comment} onChange={(event) => setComment(event.target.value)} /></label><div><button className="reject" disabled={busy} onClick={() => onComplete('reject', comment)}>반려</button><button className="primary" disabled={busy} onClick={() => onComplete('approve', comment)}>{busy ? <RefreshCw className="spin" /> : <CheckCircle2 />} 승인</button></div></div>}</div>;
}

function DetailDrawer({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) { return <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><aside className="drawer"><header><div><span className="eyebrow">API RESPONSE</span><h2>{title}</h2><code>{subtitle}</code></div><button onClick={onClose} aria-label="닫기"><XCircle /></button></header>{children}</aside></div>; }
function InstanceDetail({ item, trace }: { item: InstanceItem; trace: TraceItem[] }) { return <div className="instance-detail"><div className="metric-row"><Metric label="State" value={item.state || item.status || '-'} /><Metric label="Events" value={String(trace.length)} /><Metric label="Updated" value={formatDate(item.updated_at)} /></div><h3>Event trace</h3><div className="timeline">{trace.map((event, index) => <div key={`${event.id}-${index}`}><span className="timeline-dot" /><div><strong>{event.event_type || event.type}</strong><span>{event.node_label || 'Runtime'} · {formatDate(event.created_at)}</span><pre>{JSON.stringify(event.payload || {}, null, 2)}</pre></div></div>)}</div></div>; }
function SectionHeader({ title, description, busy, onRefresh, action }: { title: string; description: string; busy?: boolean; onRefresh?: () => void; action?: ReactNode }) { return <div className="section-header"><div><h2>{title}</h2><p>{description}</p></div>{action || (onRefresh && <button className="ghost compact" onClick={onRefresh}><RefreshCw className={busy ? 'spin' : ''} /> Refresh</button>)}</div>; }
function NavButton({ icon, label, active, disabled, badge, onClick }: { icon: ReactNode; label: string; active: boolean; disabled: boolean; badge?: number; onClick: () => void }) { return <button className={active ? 'active' : ''} disabled={disabled} onClick={onClick}>{icon}<span>{label}</span>{badge ? <b>{badge}</b> : null}</button>; }
function Status({ value }: { value: string }) { const kind = /APPROVED|COMPLETED|200|201/.test(value) ? 'success' : /REJECTED|FAILED|ERROR|4\d\d|5\d\d/.test(value) ? 'danger' : /OPEN|WAITING|RUNNING/.test(value) ? 'waiting' : 'neutral'; return <span className={`status ${kind}`}>{value}</span>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div>; }
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="empty">{icon}<h3>{title}</h3><p>{text}</p></div>; }
function JsonBlock({ value }: { value: unknown }) { return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>; }
function CopyBlock({ text }: { text: string }) { const [copied, setCopied] = useState(false); return <div className="copy-block"><pre>{text}</pre><button onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}><Copy />{copied ? 'Copied' : 'Copy'}</button></div>; }

function tabTitle(tab: Tab) { return ({ workflows: 'Workflows', instances: 'Runtime Instances', approvals: 'Approval History', console: 'API Console' })[tab]; }
function instanceId(item: InstanceItem) { return String(item.id || item._id || ''); }
function shortId(value: string) { return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleString() : '-'; }
function parseObject(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
function apiError(cause: unknown) { if (cause instanceof ApiError) return `HTTP ${cause.status} · ${cause.message}`; return cause instanceof Error ? cause.message : String(cause); }
function defaultInput(workflow: WorkflowItem) { const fields = workflow.nodes?.find((node) => node.data?.nodeType === 'start')?.data?.formSchema?.fields || []; if (!fields.length) return '{\n  \n}'; return JSON.stringify(Object.fromEntries(fields.map((field) => [field.id, field.type === 'number' ? 0 : `${field.label || field.id} 입력`])), null, 2); }
function curlFor(log: RequestLog) { const body = log.requestBody === undefined ? '' : ` \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify(log.requestBody)}'`; return `curl -X ${log.method} '<API_BASE>${log.path}' \\\n  -H 'Authorization: Bearer <API_KEY>'${body}`; }
