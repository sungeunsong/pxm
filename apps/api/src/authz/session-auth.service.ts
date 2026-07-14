import { HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { AuthzRepositoryPort, type PxmSession, type PxmUser, type WorkflowHistoryActor } from '../db/ports/db.ports';
import { hashPassword, verifyPassword } from './password';

const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const failures = new Map<string, { count: number; blockedUntil: number }>();

@Injectable()
export class SessionAuthService {
  constructor(private readonly repo: AuthzRepositoryPort) {}

  async login(userId: string, password: string, req: Request) {
    const id = userId?.trim(); const limiterKey = `${req.ip || 'unknown'}:${id || 'unknown'}`;
    this.assertNotRateLimited(limiterKey);
    if (!id || !password) return this.rejectLogin(limiterKey);
    let user = await this.repo.getUser(id); let passwordHash = user ? await this.repo.getUserPasswordHash(id) : null;
    const bootstrapId = process.env.PXM_BOOTSTRAP_ADMIN_ID || 'admin';
    const bootstrapPassword = process.env.PXM_BOOTSTRAP_ADMIN_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'admin1234');
    if (id === bootstrapId && bootstrapPassword && password === bootstrapPassword && (!user || !passwordHash)) {
      user = await this.repo.upsertUser({ id, display_name: process.env.PXM_BOOTSTRAP_ADMIN_NAME || '최고관리자', role: 'admin', group_ids: [], status: 'active', actor: id, password_hash: await hashPassword(password) });
      passwordHash = await this.repo.getUserPasswordHash(id);
    }
    if (!user || user.status !== 'active' || !passwordHash || !(await verifyPassword(password, passwordHash))) return this.rejectLogin(limiterKey);
    failures.delete(limiterKey);
    const rawToken = randomBytes(32).toString('base64url'); const csrfToken = randomBytes(32).toString('base64url'); const now = Date.now();
    const session = await this.repo.createSession({ id: randomUUID(), token_hash: digest(rawToken), csrf_hash: digest(csrfToken), user_id: user.id, ip: req.ip || null, user_agent: req.header('user-agent') || null, idle_expires_at: new Date(now + IDLE_MS).toISOString(), absolute_expires_at: new Date(now + ABSOLUTE_MS).toISOString() });
    return { user, session, rawToken, csrfToken };
  }

  async authenticate(rawToken: string): Promise<{ user: PxmUser; actor: WorkflowHistoryActor; session: PxmSession } | null> {
    const session = await this.repo.findSessionByTokenHash(digest(rawToken)); const now = Date.now();
    if (!session || session.revoked_at || Date.parse(session.idle_expires_at) <= now || Date.parse(session.absolute_expires_at) <= now) {
      if (session && !session.revoked_at) await this.repo.revokeSession(session.id, 'expired'); return null;
    }
    const user = await this.repo.getUser(session.user_id);
    if (!user || user.status !== 'active') { await this.repo.revokeSession(session.id, 'user_inactive'); return null; }
    if (now - Date.parse(session.last_seen_at) >= 60_000) await this.repo.touchSession(session.id, new Date(now).toISOString(), new Date(Math.min(now + IDLE_MS, Date.parse(session.absolute_expires_at))).toISOString());
    return { user, actor: userActor(user), session };
  }

  verifyCsrf(session: PxmSession, token?: string): boolean {
    if (!token) return false; const actual = Buffer.from(digest(token)); const expected = Buffer.from(session.csrf_hash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  setCookies(res: Response, rawToken: string, csrfToken: string): void {
    res.cookie(sessionCookieName(), rawToken, cookieOptions(true, ABSOLUTE_MS));
    res.cookie(csrfCookieName(), csrfToken, cookieOptions(false, ABSOLUTE_MS));
  }
  clearCookies(res: Response): void { res.clearCookie(sessionCookieName(), cookieOptions(true)); res.clearCookie(csrfCookieName(), cookieOptions(false)); }
  readSessionCookie(req: Request): string | null { return readCookie(req.header('cookie'), sessionCookieName()); }
  async revoke(rawToken: string | null, reason: string) { if (!rawToken) return false; const session = await this.repo.findSessionByTokenHash(digest(rawToken)); return session ? this.repo.revokeSession(session.id, reason) : false; }
  listUserSessions(userId: string) { return this.repo.listUserSessions(userId); }
  revokeSession(id: string, reason = 'user_revoked') { return this.repo.revokeSession(id, reason); }
  revokeOtherSessions(userId: string, currentId: string) { return this.repo.revokeUserSessions(userId, 'user_revoked_all', currentId); }

  async changePassword(userId: string, currentPassword: string, newPassword: string, currentSessionId: string) {
    if (newPassword.length < 12) throw new UnauthorizedException('새 비밀번호는 12자 이상이어야 합니다.');
    if (currentPassword === newPassword) throw new UnauthorizedException('새 비밀번호는 현재 비밀번호와 달라야 합니다.');
    const currentHash = await this.repo.getUserPasswordHash(userId);
    if (!currentHash || !(await verifyPassword(currentPassword, currentHash))) throw new UnauthorizedException('현재 비밀번호가 올바르지 않습니다.');
    await this.repo.updateUserPasswordHash(userId, await hashPassword(newPassword), userId);
    const revoked = await this.repo.revokeUserSessions(userId, 'password_changed', currentSessionId);
    return { success: true, revoked_sessions: revoked };
  }

  async updateProfile(userId: string, displayName: string, email?: string | null) {
    const name = displayName?.trim();
    if (!name || name.length > 100) throw new UnauthorizedException('이름은 1자 이상 100자 이하여야 합니다.');
    const normalizedEmail = email?.trim() || null;
    if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new UnauthorizedException('이메일 형식이 올바르지 않습니다.');
    const user = await this.repo.updateUserProfile(userId, name, normalizedEmail);
    if (!user) throw new UnauthorizedException('사용자를 찾을 수 없습니다.');
    return user;
  }

  private assertNotRateLimited(key: string) { const state = failures.get(key); if (state && state.blockedUntil > Date.now()) throw new HttpException('로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.', HttpStatus.TOO_MANY_REQUESTS); }
  private rejectLogin(key: string): never { const state = failures.get(key) || { count: 0, blockedUntil: 0 }; state.count++; if (state.count >= 5) state.blockedUntil = Date.now() + 15 * 60_000; failures.set(key, state); throw new UnauthorizedException('아이디 또는 비밀번호가 올바르지 않습니다.'); }
}

export function userActor(user: PxmUser): WorkflowHistoryActor {
  const memberships = user.memberships || (user.group_ids || []).map((group_id) => ({
    group_id,
    role: user.role === 'group_manager' ? 'group_manager' as const : 'user' as const,
  }));
  return {
    actor_type: 'user',
    actor_id: user.id,
    roles: [user.role],
    scopes: [],
    workspace_ids: [],
    group_ids: user.group_ids,
    group_roles: Object.fromEntries(memberships.map((membership) => [membership.group_id, membership.role])),
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    api_key_id: null,
  };
}
function digest(value: string) { return createHash('sha256').update(value).digest('base64url'); }
function readCookie(header: string | undefined, name: string) { for (const part of (header || '').split(';')) { const [key, ...value] = part.trim().split('='); if (key === name) return decodeURIComponent(value.join('=')); } return null; }
function cookieOptions(httpOnly: boolean, maxAge?: number) { return { httpOnly, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', ...(maxAge ? { maxAge } : {}) }; }
function sessionCookieName() { return process.env.NODE_ENV === 'production' ? '__Host-pxm_session' : 'pxm_session'; }
function csrfCookieName() { return process.env.NODE_ENV === 'production' ? '__Host-pxm_csrf' : 'pxm_csrf'; }
