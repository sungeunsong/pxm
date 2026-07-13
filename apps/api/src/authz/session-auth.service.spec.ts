import { SessionAuthService } from './session-auth.service';

describe('SessionAuthService', () => {
  const users = new Map<string, any>(); const sessions = new Map<string, any>();
  const repo: any = {
    getUser: jest.fn(async (id: string) => users.get(id)?.user || null), getUserPasswordHash: jest.fn(async (id: string) => users.get(id)?.password_hash || null),
    upsertUser: jest.fn(async (input: any) => { const user = { ...input, status: 'active', created_at: '', updated_at: '' }; users.set(input.id, { user, password_hash: input.password_hash }); return user; }),
    createSession: jest.fn(async (input: any) => { const value = { ...input, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), revoked_at: null }; sessions.set(input.token_hash, value); return value; }),
    findSessionByTokenHash: jest.fn(async (hash: string) => sessions.get(hash) || null), touchSession: jest.fn(), revokeSession: jest.fn(),
    updateUserPasswordHash: jest.fn(async (id: string, passwordHash: string) => { const value = users.get(id); if (!value) return false; value.password_hash = passwordHash; return true; }),
    revokeUserSessions: jest.fn(async () => 2),
  };
  const req: any = { ip: '127.0.0.1', header: () => 'jest' };
  beforeEach(() => { users.clear(); sessions.clear(); process.env.PXM_BOOTSTRAP_ADMIN_ID = 'admin'; process.env.PXM_BOOTSTRAP_ADMIN_PASSWORD = 'test-password'; });

  it('stores only an opaque token hash and authenticates it', async () => {
    const service = new SessionAuthService(repo); const login = await service.login('admin', 'test-password', req);
    expect(login.session.token_hash).not.toContain(login.rawToken); const authenticated = await service.authenticate(login.rawToken);
    expect(authenticated?.actor.roles).toEqual(['admin']); expect(service.verifyCsrf(login.session, login.csrfToken)).toBe(true);
  });
  it('rejects an invalid password', async () => { await expect(new SessionAuthService(repo).login('admin', 'wrong', req)).rejects.toThrow('아이디 또는 비밀번호'); });
  it('changes the password and revokes other sessions', async () => {
    const service = new SessionAuthService(repo); await service.login('admin', 'test-password', req);
    const result = await service.changePassword('admin', 'test-password', 'new-test-password', 'current');
    expect(result.revoked_sessions).toBe(2);
    await expect(service.login('admin', 'new-test-password', req)).resolves.toBeDefined();
  });
});
