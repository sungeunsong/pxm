import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Clock3, History, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import { sessionApi, type SessionSecurityPolicy } from '../api/session';
import './SecurityPolicyPage.css';

type ExistingSessions = 'keep' | 'revoke_others' | 'revoke_all';

export function SecurityPolicyPage({ onCurrentSessionRevoked }: { onCurrentSessionRevoked: () => void }) {
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
    if (!window.confirm(`세션 정책을 ${idleMinutes}분 / ${absoluteHours}시간으로 변경할까요?\n\n${sessionAction}`)) return;
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
    <section className="security-policy-summary">
      <div><ShieldCheck size={22} /><span>현재 세션 정책</span><strong>{policy.idle_timeout_minutes}분 / {policy.absolute_timeout_hours}시간</strong></div>
      <div><Clock3 size={22} /><span>정책 출처</span><strong>{policy.source === 'database' ? '관리자 설정' : '초기 기본값'}</strong></div>
      <div><History size={22} /><span>정책 버전</span><strong>v{policy.version}</strong></div>
    </section>

    <form className="security-policy-form" onSubmit={save}>
      <section className="security-policy-panel">
        <header><div><h2>세션 만료 정책</h2><p>관리 콘솔 사용자의 로그인 세션에 적용되는 전역 정책입니다.</p></div><LockKeyhole size={22} /></header>
        <div className="security-timeout-grid">
          <label><span>비활동 타임아웃</span><div><input type="number" min={policy.limits.idle_min_minutes} max={policy.limits.idle_max_minutes} value={idleMinutes} onChange={(event) => setIdleMinutes(Number(event.target.value))} /><b>분</b></div><small>인증된 API 요청이 없으면 세션이 종료됩니다. 허용 범위: {policy.limits.idle_min_minutes}~{policy.limits.idle_max_minutes}분</small></label>
          <label><span>절대 타임아웃</span><div><input type="number" min={policy.limits.absolute_min_hours} max={policy.limits.absolute_max_hours} value={absoluteHours} onChange={(event) => setAbsoluteHours(Number(event.target.value))} /><b>시간</b></div><small>계속 사용 중이어도 로그인 후 지정 시간이 지나면 종료됩니다. 허용 범위: {policy.limits.absolute_min_hours}~{policy.limits.absolute_max_hours}시간</small></label>
        </div>
        {validationError && <div className="security-policy-warning"><TriangleAlert size={16} />{validationError}</div>}
      </section>

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
    </form>
  </div>;
}

function SessionOption({ value, selected, onChange, title, description, danger = false }: { value: ExistingSessions; selected: ExistingSessions; onChange: (value: ExistingSessions) => void; title: string; description: string; danger?: boolean }) {
  return <label className={`security-session-option${selected === value ? ' selected' : ''}${danger ? ' danger' : ''}`}>
    <input type="radio" name="existing-sessions" value={value} checked={selected === value} onChange={() => onChange(value)} />
    <span><strong>{title}</strong><small>{description}</small></span>
  </label>;
}

function errorText(error: unknown) { return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'; }
