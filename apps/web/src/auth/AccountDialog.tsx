import { useState, type FormEvent } from 'react';
import { KeyRound, UserRound, X } from 'lucide-react';
import { sessionApi, type SessionUser } from '../api/session';

export function AccountDialog({ user, onChange, onClose }: { user: SessionUser; onChange: (user: SessionUser) => void; onClose: () => void }) {
  const [name, setName] = useState(user.display_name); const [email, setEmail] = useState(user.email || '');
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  const saveProfile = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); setMessage(''); try { const next = await sessionApi.updateProfile({ display_name: name, email: email || null }); onChange(next); setMessage('개인정보를 저장했습니다.'); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const savePassword = async (event: FormEvent) => { event.preventDefault(); setError(''); setMessage(''); if (newPassword !== confirm) { setError('새 비밀번호 확인이 일치하지 않습니다.'); return; } setBusy(true); try { const result = await sessionApi.changePassword(currentPassword, newPassword); setCurrentPassword(''); setNewPassword(''); setConfirm(''); setMessage(`비밀번호를 변경했습니다. 다른 세션 ${result.revoked_sessions}개를 종료했습니다.`); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };

  return <div className="account-backdrop" role="presentation" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <section className="account-dialog" role="dialog" aria-modal="true" aria-label="내 계정">
      <header><div><strong>내 계정</strong><span>{user.id} · {roleLabel(user.role)}</span></div><button onClick={onClose} aria-label="닫기"><X size={18} /></button></header>
      {message && <div className="account-message">{message}</div>}{error && <div className="login-error">{error}</div>}
      <form onSubmit={saveProfile}><h3><UserRound size={17} /> 개인정보</h3><label>이름<input value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label><label>이메일<input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label><button disabled={busy || !name.trim()}>개인정보 저장</button></form>
      <form onSubmit={savePassword}><h3><KeyRound size={17} /> 비밀번호 변경</h3><label>현재 비밀번호<input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></label><label>새 비밀번호<input type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /><small>12자 이상, 현재 비밀번호와 다르게 입력하세요.</small></label><label>새 비밀번호 확인<input type="password" minLength={12} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label><button disabled={busy || !currentPassword || newPassword.length < 12 || !confirm}>비밀번호 변경</button></form>
    </section>
  </div>;
}

function roleLabel(role: SessionUser['role']) { return role === 'admin' ? '최고관리자' : role === 'group_manager' ? '그룹 관리자' : '사용자'; }
function errorText(error: unknown) { return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'; }
