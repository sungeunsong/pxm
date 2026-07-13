import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionAuthService } from './session-auth.service';

@Controller('auth')
export class SessionAuthController {
  constructor(private readonly sessions: SessionAuthService) {}

  @Post('login') @HttpCode(200)
  async login(@Body() body: { user_id?: string; password?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const login = await this.sessions.login(body?.user_id || '', body?.password || '', req);
    this.sessions.setCookies(res, login.rawToken, login.csrfToken);
    return publicUser(login.user);
  }

  @Post('logout') @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(this.sessions.readSessionCookie(req), 'logout'); this.sessions.clearCookies(res); return { success: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const token = this.sessions.readSessionCookie(req); const authenticated = token ? await this.sessions.authenticate(token) : null;
    if (!authenticated) throw new UnauthorizedException('로그인이 필요합니다.'); return publicUser(authenticated.user);
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
  async changePassword(@Body() body: { current_password?: string; new_password?: string }, @Req() req: Request) {
    const current = currentSession(req);
    return this.sessions.changePassword(current.user_id, body.current_password || '', body.new_password || '', current.id);
  }


  @Post('profile') @HttpCode(200)
  async updateProfile(@Body() body: { display_name?: string; email?: string | null }, @Req() req: Request) {
    const current = currentSession(req);
    return publicUser(await this.sessions.updateProfile(current.user_id, body.display_name || '', body.email));
  }
}

function currentSession(req: Request) { const session = (req as any).pxmSession; if (!session) throw new UnauthorizedException('로그인이 필요합니다.'); return session; }
function publicUser(user: any) { return { id: user.id, display_name: user.display_name, email: user.email || null, role: user.role, group_ids: user.group_ids || [] }; }
