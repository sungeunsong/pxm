export type SessionUser = {
  id: string;
  display_name: string;
  email?: string | null;
  role: 'admin' | 'group_manager' | 'user';
  group_ids: string[];
  memberships: Array<{ group_id: string; role: 'group_manager' | 'user' }>;
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
};

async function read(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || '인증 요청에 실패했습니다.');
  return body;
}
