import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useFeedback } from '../components/feedback/feedback-context';
import { Clock3, Laptop, LockKeyhole, LogOut, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { sessionApi, type ActiveSession, type SessionSecurityPolicy } from '../api/session';
import './SecurityPolicyPage.css';

type ExistingSessions = 'keep' | 'revoke_others' | 'revoke_all';

export function SecurityPolicyPage({ onCurrentSessionRevoked }: { onCurrentSessionRevoked: () => void }) {
  const { confirm: confirmDialog } = useFeedback();
  const [activeTab, setActiveTab] = useState<'policy' | 'sessions'>('policy');
  const [policy, setPolicy] = useState<SessionSecurityPolicy | null>(null);
  const [idleMinutes, setIdleMinutes] = useState(30);
  const [absoluteHours, setAbsoluteHours] = useState(8);
  const [existingSessions, setExistingSessions] = useState<ExistingSessions>('keep');
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    sessionApi.getSecurityPolicy()
      .then((value) => { setPolicy(value); setIdleMinutes(value.idle_timeout_minutes); setAbsoluteHours(value.absolute_timeout_hours); })
      .catch((value) => setError(errorText(value)))
      .finally(() => setLoading(false));
  }, []);

  const validationError = useMemo(() => {
    if (!policy) return '';
    if (!Number.isInteger(idleMinutes) || idleMinutes < policy.limits.idle_min_minutes || idleMinutes > policy.limits.idle_max_minutes) {
      return `비활동 타임아웃은 ${policy.limits.idle_min_minutes}~${policy.limits.idle_max_minutes}분이어야 합니다.`;
    }
    if (!Number.isInteger(absoluteHours) || absoluteHours < policy.limits.absolute_min_hours || absoluteHours > policy.limits.absolute_max_hours) {
      return `절대 타임아웃은 ${policy.limits.absolute_min_hours}~${policy.limits.absolute_max_hours}시간이어야 합니다.`;
    }
    if (absoluteHours * 60 <= idleMinutes) return '절대 타임아웃은 비활동 타임아웃보다 길어야 합니다.';
    return '';
  }, [absoluteHours, idleMinutes, policy]);

  const changed = Boolean(policy && (idleMinutes !== policy.idle_timeout_minutes || absoluteHours !== policy.absolute_timeout_hours));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(''); setMessage('');
    if (validationError) { setError(validationError); return; }
    if (!changed || reason.trim().length < 3 || !password) return;
    const sessionAction = existingSessions === 'keep'
      ? '기존 세션은 현재 만료 정책을 유지합니다.'
      : existingSessions === 'revoke_others'
        ? '현재 세션을 제외한 모든 사용자의 세션이 즉시 종료됩니다.'
        : '현재 세션을 포함한 모든 사용자의 세션이 즉시 종료됩니다.';
    const proceed = await confirmDialog({
      title: `세션 정책을 ${idleMinutes}분 / ${absoluteHours}시간으로 변경할까요?`,
      description: sessionAction,
      confirmLabel: '변경',
      tone: existingSessions === 'keep' ? 'default' : 'danger',
    });
    if (!proceed) return;
    setSaving(true);
    try {
      const result = await sessionApi.updateSecurityPolicy({
        idle_timeout_minutes: idleMinutes,
        absolute_timeout_hours: absoluteHours,
        existing_sessions: existingSessions,
        reason: reason.trim(),
        current_password: password,
      });
      setPolicy(result.policy); setPassword(''); setReason('');
      if (result.current_session_revoked) { onCurrentSessionRevoked(); return; }
      setMessage(`정책을 저장했습니다. 기존 세션 ${result.revoked_sessions}개를 종료했습니다.`);
    } catch (value) {
      setError(errorText(value));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="security-policy-state">보안 정책을 불러오는 중입니다.</div>;
  if (!policy) return <div className="security-policy-state error">{error || '보안 정책을 불러오지 못했습니다.'}</div>;

  return <div className="security-policy-page">
    <nav className="product-settings-tabs" aria-label="제품 설정 분류">
      <button className={activeTab === 'policy' ? 'active' : ''} onClick={() => setActiveTab('policy')}><LockKeyhole size={16} /><span>세션 만료 정책</span><small>만료 시간과 적용 범위</small></button>
      <button className={activeTab === 'sessions' ? 'active' : ''} onClick={() => setActiveTab('sessions')}><Laptop size={16} /><span>내 로그인 세션</span><small>접속 기기 확인 및 종료</small></button>
    </nav>

    {activeTab === 'sessions' ? <ActiveSessionsPanel /> : <>
      <section className="security-policy-summary">
        <div><ShieldCheck size={22} /><span>비활동 타임아웃</span><strong>{policy.idle_timeout_minutes}분</strong></div>
        <div><Clock3 size={22} /><span>절대 타임아웃</span><strong>{policy.absolute_timeout_hours}시간</strong></div>
      </section>

    <form className="security-policy-form" onSubmit={save}>
      <section className="security-policy-panel">
        <header><div><h2>세션 만료 정책</h2><p>관리 콘솔 사용자의 로그인 세션에 적용되는 전역 정책입니다.</p></div><LockKeyhole size={22} /></header>
        <div className="security-timeout-grid">
          <label><span>비활동 타임아웃</span><div><input type="number" min={policy.limits.idle_min_minutes} max={policy.limits.idle_max_minutes} value={idleMinutes} onChange={(event) => setIdleMinutes(Number(event.target.value))} /><b>분</b></div><small>키보드·클릭 등 사용자 활동이 없으면 세션이 종료됩니다. 허용 범위: {policy.limits.idle_min_minutes}~{policy.limits.idle_max_minutes}분</small></label>
          <label><span>절대 타임아웃</span><div><input type="number" min={policy.limits.absolute_min_hours} max={policy.limits.absolute_max_hours} value={absoluteHours} onChange={(event) => setAbsoluteHours(Number(event.target.value))} /><b>시간</b></div><small>계속 사용 중이어도 로그인 후 지정 시간이 지나면 종료됩니다. 허용 범위: {policy.limits.absolute_min_hours}~{policy.limits.absolute_max_hours}시간</small></label>
        </div>
        {validationError && <div className="security-policy-warning"><TriangleAlert size={16} />{validationError}</div>}
      </section>

      <div className="security-policy-side-column">
        <section className="security-policy-panel">
          <header><div><h2>기존 세션 처리</h2><p>새 정책 저장 시 이미 로그인된 세션을 어떻게 처리할지 선택합니다.</p></div></header>
          <div className="security-session-options">
            <SessionOption value="keep" selected={existingSessions} onChange={setExistingSessions} title="기존 세션 유지" description="기존 세션은 로그인 당시 정책을 유지하고 새 로그인부터 변경값을 적용합니다." />
            <SessionOption value="revoke_others" selected={existingSessions} onChange={setExistingSessions} title="현재 세션 제외 전체 종료" description="설정 중인 최고관리자는 유지하고 다른 모든 로그인 세션을 즉시 종료합니다." />
            <SessionOption value="revoke_all" selected={existingSessions} onChange={setExistingSessions} title="모든 세션 종료" description="현재 최고관리자까지 포함해 모든 세션을 종료하고 다시 로그인합니다." danger />
          </div>
        </section>

        <section className="security-policy-panel security-confirm-panel">
          <header><div><h2>변경 확인</h2><p>정책 변경은 감사 로그에 이전값·변경값·사유와 함께 기록됩니다.</p></div></header>
          <label><span>변경 사유</span><textarea minLength={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="정책을 변경하는 이유를 입력하세요." /></label>
          <label><span>현재 관리자 비밀번호</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="최고관리자 비밀번호 재확인" /></label>
          {message && <div className="security-policy-message">{message}</div>}
          {error && <div className="security-policy-error">{error}</div>}
          <div className="security-policy-actions"><button type="submit" disabled={saving || !changed || Boolean(validationError) || reason.trim().length < 3 || !password}>{saving ? '저장 중…' : '정책 변경'}</button></div>
        </section>
      </div>
    </form>
    </>}
  </div>;
}

function ActiveSessionsPanel() {
  const { confirm: confirmDialog } = useFeedback();
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try { setSessions(await sessionApi.listSessions()); }
    catch (value) { setError(errorText(value)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const activeSessions = sessions.filter((session) => !session.revoked_at && Date.parse(session.idle_expires_at) > Date.now() && Date.parse(session.absolute_expires_at) > Date.now());
  const revoke = async (session: ActiveSession) => {
    if (session.current) return;
    const proceed = await confirmDialog({
      title: '이 세션을 종료할까요?',
      description: `${deviceLabel(session.user_agent)} 기기의 로그인이 즉시 해제됩니다.`,
      confirmLabel: '종료',
      tone: 'danger',
    });
    if (!proceed) return;
    try { await sessionApi.revokeSession(session.id); setMessage('선택한 세션을 종료했습니다.'); await load(); }
    catch (value) { setError(errorText(value)); }
  };
  const revokeOthers = async () => {
    const proceed = await confirmDialog({
      title: '다른 세션을 모두 종료할까요?',
      description: '현재 브라우저를 제외한 모든 기기의 로그인이 즉시 해제됩니다.',
      confirmLabel: '모두 종료',
      tone: 'danger',
    });
    if (!proceed) return;
    try { const result = await sessionApi.revokeOtherSessions(); setMessage(`다른 세션 ${result.revoked}개를 종료했습니다.`); await load(); }
    catch (value) { setError(errorText(value)); }
  };

  return <section className="active-sessions-panel">
    <header><div><h2>내 로그인 세션</h2><p>현재 계정으로 로그인된 기기와 마지막 사용자 활동을 확인하고 원격으로 종료합니다.</p></div><div><span>{activeSessions.length}개 활성</span><button className="sessions-refresh" onClick={() => void load()} title="새로고침" aria-label="세션 목록 새로고침"><RefreshCw size={15} /></button><button className="revoke-others" onClick={() => void revokeOthers()} disabled={activeSessions.length <= 1}><LogOut size={15} /> 다른 세션 모두 종료</button></div></header>
    {message && <div className="security-policy-message">{message}</div>}
    {error && <div className="security-policy-error">{error}</div>}
    {loading ? <div className="active-sessions-empty">세션을 불러오는 중입니다.</div> : activeSessions.length === 0 ? <div className="active-sessions-empty">활성 세션이 없습니다.</div> : <div className="active-session-list">
      {activeSessions.map((session) => <article key={session.id} className={session.current ? 'current' : ''}>
        <div className="active-session-icon"><Laptop size={19} /></div>
        <div className="active-session-main"><strong>{deviceLabel(session.user_agent)} {session.current && <em>현재 세션</em>}</strong><span title={session.user_agent || ''}>{session.user_agent || '알 수 없는 브라우저'}</span></div>
        <dl><div><dt>IP</dt><dd>{session.ip || '-'}</dd></div><div><dt>마지막 활동</dt><dd>{formatDate(session.last_seen_at)}</dd></div><div><dt>절대 만료</dt><dd>{formatDate(session.absolute_expires_at)}</dd></div></dl>
        <button className="session-revoke-button" onClick={() => void revoke(session)} disabled={session.current}>{session.current ? '사용 중' : '세션 종료'}</button>
      </article>)}
    </div>}
  </section>;
}

function SessionOption({ value, selected, onChange, title, description, danger = false }: { value: ExistingSessions; selected: ExistingSessions; onChange: (value: ExistingSessions) => void; title: string; description: string; danger?: boolean }) {
  return <label className={`security-session-option${selected === value ? ' selected' : ''}${danger ? ' danger' : ''}`}>
    <input type="radio" name="existing-sessions" value={value} checked={selected === value} onChange={() => onChange(value)} />
    <span><strong>{title}</strong><small>{description}</small></span>
  </label>;
}

function errorText(error: unknown) { return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'; }
function formatDate(value: string) { return new Date(value).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
function deviceLabel(userAgent?: string | null) {
  if (!userAgent) return '알 수 없는 기기';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : '브라우저';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Linux/.test(userAgent) ? 'Linux' : '기기';
  return `${os} · ${browser}`;
}
