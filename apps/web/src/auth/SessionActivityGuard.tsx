import { useEffect, useRef, useState } from 'react';
import { Clock3 } from 'lucide-react';
import { sessionApi, type SessionTiming, type SessionUser } from '../api/session';
import './SessionActivityGuard.css';

const HEARTBEAT_MIN_INTERVAL_MS = 60_000;
const EXPIRY_CHECK_INTERVAL_MS = 1_000;
const WARNING_SECONDS = 120;
const ACTIVITY_STORAGE_KEY = 'pxm.session.user-activity';

export function SessionActivityGuard({ user, onUserChange, onExpired }: { user: SessionUser; onUserChange: (user: SessionUser) => void; onExpired: () => void }) {
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const userRef = useRef(user);
  const timingRef = useRef<SessionTiming | undefined>(user.session);
  const pendingActivityRef = useRef(false);
  const heartbeatRunningRef = useRef(false);
  const lastHeartbeatRef = useRef(Date.now());
  const expiredRef = useRef(false);
  const onUserChangeRef = useRef(onUserChange);
  const onExpiredRef = useRef(onExpired);
  const continueSessionRef = useRef<() => void>(() => undefined);

  userRef.current = user;
  onUserChangeRef.current = onUserChange;
  onExpiredRef.current = onExpired;
  if (user.session && user.session !== timingRef.current) timingRef.current = user.session;

  useEffect(() => {
    let lastActivityBroadcastAt = 0;
    const recordLocalActivity = () => {
      pendingActivityRef.current = true;
      const now = Date.now();
      if (now - lastActivityBroadcastAt < 1_000) return;
      lastActivityBroadcastAt = now;
      try { localStorage.setItem(ACTIVITY_STORAGE_KEY, String(now)); } catch { /* storage can be disabled */ }
    };
    const syncActivity = (event: StorageEvent) => { if (event.key === ACTIVITY_STORAGE_KEY) pendingActivityRef.current = true; };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((name) => window.addEventListener(name, recordLocalActivity, { passive: true }));
    window.addEventListener('storage', syncActivity);

    const sendHeartbeat = async (force = false) => {
      const timing = timingRef.current;
      if (!timing || heartbeatRunningRef.current || expiredRef.current) return;
      const now = Date.now();
      const idleRemaining = Date.parse(timing.idle_expires_at) - now;
      if (!force && (!pendingActivityRef.current || (now - lastHeartbeatRef.current < HEARTBEAT_MIN_INTERVAL_MS && idleRemaining > 90_000))) return;
      heartbeatRunningRef.current = true;
      lastHeartbeatRef.current = now;
      try {
        const nextTiming = await sessionApi.recordActivity();
        timingRef.current = nextTiming;
        pendingActivityRef.current = false;
        onUserChangeRef.current({ ...userRef.current, session: nextTiming });
      } catch {
        // The global fetch handler moves the app to login on 401.
      } finally {
        heartbeatRunningRef.current = false;
      }
    };

    const expire = () => {
      if (expiredRef.current) return;
      expiredRef.current = true;
      onExpiredRef.current();
    };

    const check = () => {
      const timing = timingRef.current;
      if (!timing) return;
      const remaining = Math.min(Date.parse(timing.idle_expires_at), Date.parse(timing.absolute_expires_at)) - Date.now();
      const seconds = Math.max(0, Math.ceil(remaining / 1000));
      setRemainingSeconds(seconds);
      if (remaining <= 0) { expire(); return; }
      void sendHeartbeat();
    };
    check();
    const interval = window.setInterval(check, EXPIRY_CHECK_INTERVAL_MS);
    const continueSession = () => { pendingActivityRef.current = true; void sendHeartbeat(true); };
    continueSessionRef.current = continueSession;
    return () => {
      window.clearInterval(interval);
      events.forEach((name) => window.removeEventListener(name, recordLocalActivity));
      window.removeEventListener('storage', syncActivity);
    };
  }, [user.id]);

  const showWarning = remainingSeconds !== null && remainingSeconds > 0 && remainingSeconds <= WARNING_SECONDS;
  if (!showWarning) return null;
  return <div className="session-expiry-backdrop" role="presentation">
    <section className="session-expiry-dialog" role="alertdialog" aria-modal="true" aria-label="세션 만료 예정">
      <Clock3 size={28} />
      <div><strong>세션이 곧 만료됩니다.</strong><p>실제 사용자 활동이 없어 자동 로그아웃될 예정입니다.</p></div>
      <span className="session-expiry-countdown">{formatRemaining(remainingSeconds)}</span>
      <button onClick={() => continueSessionRef.current()}>계속 사용</button>
    </section>
  </div>;
}

function formatRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
