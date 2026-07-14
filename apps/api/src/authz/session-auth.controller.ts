import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ChangePasswordDto, LoginDto, UpdateProfileDto, UpdateSessionSecurityPolicyDto } from './dto/session-auth.dto';
import { Public } from './public-route';
import { SessionAuthService } from './session-auth.service';
import { actorFromRequest } from '../instances/history-auth';
import { assertAdmin } from './management-auth';
import { ManagementAuditService } from '../audit/management-audit.service';

@Controller('auth')
export class SessionAuthController {
  constructor(private readonly sessions: SessionAuthService, private readonly audit: ManagementAuditService) {}

  @Public() @Post('login') @HttpCode(200)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const login = await this.sessions.login(body.user_id, body.password, req);
    this.sessions.setCookies(res, login.rawToken, login.csrfToken, login.session.absolute_expires_at);
    return publicUser(login.user, login.session);
  }

  @Public() @Post('logout') @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(this.sessions.readSessionCookie(req), 'logout'); this.sessions.clearCookies(res); return { success: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const token = this.sessions.readSessionCookie(req); const authenticated = token ? await this.sessions.authenticate(token) : null;
    if (!authenticated) throw new UnauthorizedException('로그인이 필요합니다.'); return publicUser(authenticated.user, authenticated.session);
  }

  @Get('sessions')
  async listSessions(@Req() req: Request) {
    const current = currentSession(req);
    return (await this.sessions.listUserSessions(current.user_id)).map(({ token_hash: _token, csrf_hash: _csrf, ...session }) => ({ ...session, current: session.id === current.id }));
  }

  @Delete('sessions/:id')
  async revokeSession(@Param('id') id: string, @Req() req: Request) {
    const current = currentSession(req); const own = (await this.sessions.listUserSessions(current.user_id)).some(session => session.id === id);
    if (!own) throw new UnauthorizedException('세션을 찾을 수 없습니다.'); return { success: await this.sessions.revokeSession(id) };
  }

  @Post('sessions/revoke-others')
  async revokeOthers(@Req() req: Request) { const current = currentSession(req); return { revoked: await this.sessions.revokeOtherSessions(current.user_id, current.id) }; }

  @Post('change-password') @HttpCode(200)
  async changePassword(@Body() body: ChangePasswordDto, @Req() req: Request) {
    const current = currentSession(req);
    return this.sessions.changePassword(current.user_id, body.current_password || '', body.new_password || '', current.id);
  }


  @Post('profile') @HttpCode(200)
  async updateProfile(@Body() body: UpdateProfileDto, @Req() req: Request) {
    const current = currentSession(req);
    return publicUser(await this.sessions.updateProfile(current.user_id, body.display_name || '', body.email), current);
  }

  @Post('activity') @HttpCode(200)
  async activity(@Req() req: Request) {
    return this.sessions.recordUserActivity(currentSession(req));
  }

  @Get('security-policy')
  async getSecurityPolicy(@Req() req: Request) {
    assertAdmin(actorFromRequest(req));
    return this.sessions.getSecurityPolicy();
  }

  @Post('security-policy') @HttpCode(200)
  async updateSecurityPolicy(
    @Body() body: UpdateSessionSecurityPolicyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const actor = actorFromRequest(req); assertAdmin(actor);
    const current = currentSession(req);
    const result = await this.sessions.updateSecurityPolicy(current.user_id, current.id, body);
    await this.audit.append({
      action: 'security_policy.session_timeout_changed',
      resource_type: 'security_policy',
      resource_id: 'session',
      actor_id: actor.actor_id,
      details: {
        before: { idle_timeout_minutes: result.before.idle_timeout_minutes, absolute_timeout_hours: result.before.absolute_timeout_hours, version: result.before.version },
        after: { idle_timeout_minutes: result.policy.idle_timeout_minutes, absolute_timeout_hours: result.policy.absolute_timeout_hours, version: result.policy.version },
        existing_sessions: body.existing_sessions,
        revoked_sessions: result.revoked_sessions,
        reason: body.reason,
      },
    });
    if (result.current_session_revoked) this.sessions.clearCookies(res);
    return result;
  }
}

function currentSession(req: Request) { const session = (req as any).pxmSession; if (!session) throw new UnauthorizedException('로그인이 필요합니다.'); return session; }
function publicUser(user: any, session?: any) {
  return {
    id: user.id,
    display_name: user.display_name,
    email: user.email || null,
    role: user.role,
    group_ids: user.group_ids || [],
    memberships: user.memberships || [],
    ...(session ? { session: { idle_expires_at: session.idle_expires_at, absolute_expires_at: session.absolute_expires_at, last_seen_at: session.last_seen_at } } : {}),
  };
}
