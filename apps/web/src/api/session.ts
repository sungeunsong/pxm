export type SessionUser = {
  id: string;
  display_name: string;
  email?: string | null;
  role: 'admin' | 'group_manager' | 'user';
  group_ids: string[];
  memberships: Array<{ group_id: string; role: 'group_manager' | 'user' }>;
  session?: SessionTiming;
};

export type SessionTiming = {
  idle_expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
};

export type ActiveSession = SessionTiming & {
  id: string;
  user_id: string;
  ip?: string | null;
  user_agent?: string | null;
  created_at: string;
  idle_timeout_minutes?: number;
  revoked_at?: string | null;
  revoke_reason?: string | null;
  current: boolean;
};

export type SessionSecurityPolicy = {
  idle_timeout_minutes: number;
  absolute_timeout_hours: number;
  updated_by?: string | null;
  updated_at: string;
  source: 'default' | 'database';
  limits: {
    idle_min_minutes: number;
    idle_max_minutes: number;
    absolute_min_hours: number;
    absolute_max_hours: number;
  };
};

export type SessionPolicyUpdateResult = {
  policy: SessionSecurityPolicy;
  revoked_sessions: number;
  current_session_revoked: boolean;
};

export const sessionApi = {
  async me(): Promise<SessionUser | null> {
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    if (response.status === 401) return null;
    return read(response);
  },
  async login(user_id: string, password: string): Promise<SessionUser> {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ user_id, password }),
    });
    return read(response);
  },
  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  },
  async updateProfile(payload: { display_name: string; email?: string | null }): Promise<SessionUser> {
    const response = await fetch('/api/auth/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) });
    return read(response);
  },
  async changePassword(current_password: string, new_password: string): Promise<{ success: true; revoked_sessions: number }> {
    const response = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ current_password, new_password }) });
    return read(response);
  },
  async getSecurityPolicy(): Promise<SessionSecurityPolicy> {
    return read(await fetch('/api/auth/security-policy', { credentials: 'include' }));
  },
  async updateSecurityPolicy(payload: {
    idle_timeout_minutes: number;
    absolute_timeout_hours: number;
    existing_sessions: 'keep' | 'revoke_others' | 'revoke_all';
    reason: string;
    current_password: string;
  }): Promise<SessionPolicyUpdateResult> {
    return read(await fetch('/api/auth/security-policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload),
    }));
  },
  async recordActivity(): Promise<SessionTiming> {
    return read(await fetch('/api/auth/activity', { method: 'POST', credentials: 'include' }));
  },
  async listSessions(): Promise<ActiveSession[]> {
    return read(await fetch('/api/auth/sessions', { credentials: 'include' }));
  },
  async revokeSession(id: string): Promise<{ success: boolean }> {
    return read(await fetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }));
  },
  async revokeOtherSessions(): Promise<{ revoked: number }> {
    return read(await fetch('/api/auth/sessions/revoke-others', { method: 'POST', credentials: 'include' }));
  },
};

async function read(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || '인증 요청에 실패했습니다.');
  return body;
}
