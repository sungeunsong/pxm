import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { SessionAuthService } from './session-auth.service';

@Injectable()
export class SessionAuthMiddleware implements NestMiddleware {
  constructor(private readonly sessions: SessionAuthService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const token = this.sessions.readSessionCookie(req);
    if (token) {
      const authenticated = await this.sessions.authenticate(token);
      if (authenticated) {
        if (isUnsafe(req.method) && !isCsrfExempt(req) && !this.sessions.verifyCsrf(authenticated.session, req.header('x-csrf-token'))) return next(new ForbiddenException('CSRF token is invalid'));
        (req as any).workflowActor = authenticated.actor; (req as any).pxmSession = authenticated.session;
      }
    }
    next();
  }
}

function isUnsafe(method: string) { return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()); }
function isCsrfExempt(req: Request) { return (req.originalUrl || req.url).replace(/\?.*$/, '').endsWith('/api/auth/login'); }
