import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { AuthzRepositoryPort } from '../db/ports/db.ports';
import { hashPassword } from './password';
import { SessionAuthService } from './session-auth.service';

describe('SessionAuthService security policy', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('uses the current 30 minute / 8 hour defaults when no DB policy exists', async () => {
    process.env = { ...originalEnv, PXM_SESSION_IDLE_MINUTES: '', PXM_SESSION_ABSOLUTE_HOURS: '' };
    const repo = { getSessionSecurityPolicy: jest.fn().mockResolvedValue(null) } as unknown as AuthzRepositoryPort;
    const service = new SessionAuthService(repo);

    await expect(service.getSecurityPolicy()).resolves.toMatchObject({
      idle_timeout_minutes: 30,
      absolute_timeout_hours: 8,
      version: 0,
      source: 'default',
    });
  });

  it('rejects an absolute timeout that is not longer than the idle timeout', async () => {
    const service = new SessionAuthService({} as AuthzRepositoryPort);
    await expect(service.updateSecurityPolicy('admin', 'session-1', {
      idle_timeout_minutes: 120,
      absolute_timeout_hours: 2,
      existing_sessions: 'keep',
      current_password: 'password',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires the current password and can revoke every session except the current one', async () => {
    const passwordHash = await hashPassword('correct-password');
    const repo = {
      getUserPasswordHash: jest.fn().mockResolvedValue(passwordHash),
      getSessionSecurityPolicy: jest.fn().mockResolvedValue(null),
      upsertSessionSecurityPolicy: jest.fn().mockResolvedValue({
        idle_timeout_minutes: 15,
        absolute_timeout_hours: 4,
        version: 1,
        updated_by: 'admin',
        updated_at: '2026-07-14T00:00:00.000Z',
      }),
      revokeAllSessions: jest.fn().mockResolvedValue(3),
    } as unknown as jest.Mocked<AuthzRepositoryPort>;
    const service = new SessionAuthService(repo);

    await expect(service.updateSecurityPolicy('admin', 'session-1', {
      idle_timeout_minutes: 15,
      absolute_timeout_hours: 4,
      existing_sessions: 'revoke_others',
      current_password: 'wrong-password',
    })).rejects.toBeInstanceOf(UnauthorizedException);

    const result = await service.updateSecurityPolicy('admin', 'session-1', {
      idle_timeout_minutes: 15,
      absolute_timeout_hours: 4,
      existing_sessions: 'revoke_others',
      current_password: 'correct-password',
    });

    expect(repo.upsertSessionSecurityPolicy).toHaveBeenCalledWith({ idle_timeout_minutes: 15, absolute_timeout_hours: 4, updated_by: 'admin' });
    expect(repo.revokeAllSessions).toHaveBeenCalledWith('security_policy_changed', 'session-1');
    expect(result).toMatchObject({ revoked_sessions: 3, current_session_revoked: false });
  });

  it('extends idle expiry only through an explicit user activity heartbeat', async () => {
    const now = Date.now();
    const session = {
      id: 'session-1', token_hash: 'hash', csrf_hash: 'csrf', user_id: 'admin',
      created_at: new Date(now - 300_000).toISOString(),
      last_seen_at: new Date(now - 120_000).toISOString(),
      idle_expires_at: new Date(now + 60_000).toISOString(),
      absolute_expires_at: new Date(now + 3_600_000).toISOString(),
      idle_timeout_minutes: 30,
    };
    const repo = { touchSession: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuthzRepositoryPort>;
    const service = new SessionAuthService(repo);

    const result = await service.recordUserActivity(session);

    expect(repo.touchSession).toHaveBeenCalledTimes(1);
    expect(Date.parse(result.idle_expires_at)).toBeGreaterThan(now + 29 * 60_000);
  });
});
