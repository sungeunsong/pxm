import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronRight, FileClock, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { auditApi, type ManagementAuditEvent } from '../api/audit';
import { authzApi, type PxmGroup } from '../api/authz';
import type { SessionUser } from '../api/session';
import './AuditLogPage.css';

const ACTION_LABELS: Record<string, string> = {
  'workflow.created': '워크플로우 생성',
  'workflow.updated': '워크플로우 수정',
  'workflow.deleted': '워크플로우 삭제',
  'workflow.published': '워크플로우 배포',
  'task.approved': '결재 승인',
  'task.rejected': '결재 반려',
  'task.held': '결재 보류',
  'credential.created': '자격증명 생성',
  'credential.updated': '자격증명 수정',
  'credential.deleted': '자격증명 삭제',
  'security_policy.updated': '보안 정책 변경',
};

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

export function AuditLogPage({ currentUser }: { currentUser: SessionUser }) {
  const [events, setEvents] = useState<ManagementAuditEvent[]>([]);
  const [groups, setGroups] = useState<PxmGroup[]>([]);
  const [groupId, setGroupId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [selected, setSelected] = useState<ManagementAuditEvent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setEvents(await auditApi.list({ groupId, action, from, to }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '감사 로그를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [action, from, groupId, to]);

  useEffect(() => {
    authzApi.listGroups(false, currentUser.role !== 'admin').then(setGroups).catch(() => setGroups([]));
  }, [currentUser.role]);

  useEffect(() => { void load(); }, [load]);

  const actions = useMemo(() => Array.from(new Set(events.map((event) => event.action))).sort(), [events]);
  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);

  return <div className="audit-page">
    <section className="audit-intro">
      <div className="audit-intro-icon"><ShieldCheck size={22} /></div>
      <div><p>누가 언제 어떤 관리 작업을 수행했는지 확인합니다. 민감정보는 저장 및 조회 단계에서 마스킹됩니다.</p></div>
      <button className="audit-refresh" onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />새로고침</button>
    </section>

    <section className="audit-filters" aria-label="감사 로그 필터">
      <label><span>그룹</span><select value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">전체 그룹</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>
      <label><span>작업 유형</span><select value={action} onChange={(event) => setAction(event.target.value)}><option value="">전체 작업</option>{actions.map((item) => <option value={item} key={item}>{actionLabel(item)}</option>)}</select></label>
      <label><span>시작일</span><div className="audit-date"><CalendarDays size={14}/><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></div></label>
      <label><span>종료일</span><div className="audit-date"><CalendarDays size={14}/><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></div></label>
      <button className="audit-search" onClick={load} disabled={loading}><Search size={15}/>조회</button>
    </section>

    {error && <div className="audit-error">{error}</div>}
    <section className="audit-list">
      <header><div><FileClock size={17}/><h3>관리 작업 이력</h3></div><span>{events.length}건</span></header>
      <div className="audit-list-head"><span>시각</span><span>작업</span><span>대상</span><span>수행자</span><span>그룹</span><span /></div>
      {events.length ? events.map((event) => <button className="audit-row" key={event._id} onClick={() => setSelected(event)}>
        <time>{formatDate(event.created_at)}</time>
        <span><strong>{actionLabel(event.action)}</strong><small>{event.action}</small></span>
        <span><strong>{resourceLabel(event.resource_type)}</strong><code title={event.resource_id}>{shortId(event.resource_id)}</code></span>
        <span>{event.actor_id || 'system'}</span>
        <span>{event.group_id ? groupNames.get(event.group_id) || shortId(event.group_id) : '플랫폼 전체'}</span>
        <ChevronRight size={16}/>
      </button>) : <div className="audit-empty"><ShieldCheck size={28}/><strong>{loading ? '감사 로그를 불러오는 중입니다.' : '조건에 맞는 감사 로그가 없습니다.'}</strong><span>그룹이나 조회 기간을 변경해 보세요.</span></div>}
    </section>

    {selected && <div className="audit-drawer-backdrop" onMouseDown={() => setSelected(null)}>
      <aside className="audit-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="감사 로그 상세">
        <header><div><span>감사 이벤트 상세</span><h3>{actionLabel(selected.action)}</h3></div><button onClick={() => setSelected(null)} aria-label="닫기"><X size={18}/></button></header>
        <dl>
          <div><dt>발생 시각</dt><dd>{new Date(selected.created_at).toLocaleString('ko-KR')}</dd></div>
          <div><dt>수행자</dt><dd>{selected.actor_id || 'system'}</dd></div>
          <div><dt>작업 유형</dt><dd><code>{selected.action}</code></dd></div>
          <div><dt>대상</dt><dd>{resourceLabel(selected.resource_type)} · <code>{selected.resource_id}</code></dd></div>
          <div><dt>그룹</dt><dd>{selected.group_id ? groupNames.get(selected.group_id) || selected.group_id : '플랫폼 전체'}</dd></div>
          <div><dt>이벤트 ID</dt><dd><code>{selected._id}</code></dd></div>
        </dl>
        <section><div><h4>상세 데이터</h4><span><ShieldCheck size={13}/>민감정보 마스킹 적용</span></div><pre>{JSON.stringify(selected.details || {}, null, 2)}</pre></section>
      </aside>
    </div>}
  </div>;
}

function actionLabel(action: string) {
  return ACTION_LABELS[action] || action.split('.').map((part) => part.replaceAll('_', ' ')).join(' · ');
}

function resourceLabel(type: string) {
  return ({ workflow: '워크플로우', task: '결재', group: '그룹', user: '사용자', service_account: '서비스 계정', api_key: 'API Key', credential: '자격증명', security_policy: '보안 정책', runtime_integrity: '실행 무결성', webhook_endpoint: 'Webhook', webhook_delivery: 'Webhook 전송', runtime_operation: '운영 조치', approval_notification: '승인 알림', external_principal_mapping: '외부 사용자 매핑' } as Record<string, string>)[type] || type;
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatDate(value: string) {
  const date = new Date(value);
  return <><strong>{date.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}</strong><small>{date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></>;
}
