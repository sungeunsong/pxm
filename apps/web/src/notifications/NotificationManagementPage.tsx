import { useCallback, useEffect, useState } from 'react';
import { Mail, RefreshCw, RotateCcw, X } from 'lucide-react';
import { notificationsApi, type NotificationDelivery } from '../api/notifications';
import './NotificationManagementPage.css';

const statuses = ['', 'PENDING', 'RUNNING', 'SENT', 'FAILED', 'DEAD_LETTER', 'CANCELED'];

export function NotificationManagementPage() {
  const [items, setItems] = useState<NotificationDelivery[]>([]);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<(NotificationDelivery & { attempts: any[] }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setItems(await notificationsApi.list(status || undefined)); }
    catch (e) { setError(e instanceof Error ? e.message : '발송 이력 조회 실패'); }
    finally { setLoading(false); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const retry = async (item: NotificationDelivery) => {
    const reason = window.prompt('재발송 사유를 입력하세요. (3자 이상)');
    if (!reason || reason.trim().length < 3) return;
    if (!window.confirm('Task가 아직 OPEN인 경우에만 재발송됩니다. 계속할까요?')) return;
    try { await notificationsApi.retry(item.id, reason.trim()); setSelected(null); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '재발송 실패'); }
  };

  return <div className="notification-page">
    <section className="notification-intro">
      <div><span>APPROVAL NOTIFICATIONS</span><h2>승인자 알림 발송 이력</h2><p>새 결재 요청 이메일의 성공·실패와 재시도 결과를 확인합니다.</p></div>
      <button onClick={load} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>새로고침</button>
    </section>
    <section className="notification-summary">
      {['PENDING','SENT','FAILED','DEAD_LETTER'].map(key => <article key={key}><span>{key}</span><strong>{items.filter(i => i.status === key).length}</strong></article>)}
    </section>
    <div className="notification-toolbar">
      {statuses.map(value => <button key={value || 'ALL'} className={status === value ? 'active' : ''} onClick={() => setStatus(value)}>{value || 'ALL'}</button>)}
    </div>
    {error && <div className="notification-error">{error}</div>}
    <section className="notification-list">
      <header><span>결재 제목</span><span>승인자</span><span>채널</span><span>상태</span><span>시도</span><span>갱신 시각</span><span>조치</span></header>
      {items.map(item => <article key={item.id} onClick={() => notificationsApi.detail(item.id).then(setSelected).catch(e => setError(e.message))}>
        <strong>{item.title}</strong><span>{item.recipient_id}<small>{item.recipient_hint || ''}</small></span><span><Mail size={13}/> 이메일</span>
        <span className={`notification-status ${item.status.toLowerCase()}`}>{item.status}</span>
        <span>{item.attempt_count}/{item.max_attempts}</span><span>{new Date(item.updated_at).toLocaleString()}</span>
        <span>{['FAILED','DEAD_LETTER','CANCELED'].includes(item.status) && <button onClick={e => { e.stopPropagation(); void retry(item); }}><RotateCcw size={13}/>재발송</button>}</span>
      </article>)}
      {!items.length && <p>조건에 맞는 발송 이력이 없습니다.</p>}
    </section>
    {selected && <aside className="notification-drawer">
      <header><div><small>발송 상세</small><h3>{selected.title}</h3></div><button onClick={() => setSelected(null)}><X/></button></header>
      <dl><div><dt>Task</dt><dd>{selected.task_id}</dd></div><div><dt>승인자</dt><dd>{selected.recipient_id}</dd></div><div><dt>상태</dt><dd>{selected.status}</dd></div><div><dt>마지막 오류</dt><dd>{selected.last_error || '-'}</dd></div></dl>
      <h4>시도 이력</h4>{selected.attempts.map(a => <div className="notification-attempt" key={a.id}><strong>#{a.attempt_number} {a.status}</strong><span>{a.duration_ms}ms</span><small>{a.error || new Date(a.completed_at).toLocaleString()}</small></div>)}
    </aside>}
  </div>;
}
