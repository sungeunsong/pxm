import { useState, type FormEvent } from 'react';
import { sessionApi, type SessionUser } from '../api/session';

export function LoginPage({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onLogin(await sessionApi.login(userId, password)); }
    catch (e) { setError(e instanceof Error ? e.message : '로그인에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  return <main className="login-page">
    <form className="login-card" onSubmit={submit}>
      <div className="login-brand"><img src="/brand/pxm-app-icon.png" alt="PXM" /><div className="login-brand-copy"><h1>PXM</h1><span>Penta eXecute Manager</span></div></div>
      <p className="login-description">워크플로우 실행과 운영을 관리하세요.</p>
      <label>사용자 ID<input autoFocus autoComplete="username" value={userId} onChange={e => setUserId(e.target.value)} /></label>
      <label>비밀번호<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <div className="login-error">{error}</div>}
      <button disabled={busy || !userId || !password}>{busy ? '로그인 중…' : '로그인'}</button>
    </form>
  </main>;
}
