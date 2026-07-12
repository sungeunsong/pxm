import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthzService } from './authz.service';

@Injectable()
export class ApiKeyAuthMiddleware implements NestMiddleware {
  constructor(private readonly authzService: AuthzService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    const rawKey = bearerToken(req);
    if (!rawKey) {
      next();
      return;
    }

    try {
      const key = await this.authzService.authenticateApiKey(rawKey);
      const businessActor = parseBusinessActor(req);
      (req as any).workflowActor = {
        actor_type: key.owner_type === 'SERVICE_ACCOUNT' ? 'service_account' : 'user',
        actor_id: key.owner_id,
        api_key_id: key.id,
        roles: key.owner_type === 'USER' ? ['user'] : [],
        scopes: key.scopes,
        workspace_ids: [],
        group_ids: [key.group_id],
        owned_workflow_ids: [],
        allowed_workflow_ids: key.allowed_workflow_ids,
        allowed_instance_ids: [],
        business_actor: businessActor,
      };

      await this.authzService.appendApiKeyUsageLog({
        api_key_id: key.id,
        owner_type: key.owner_type,
        owner_id: key.owner_id,
        group_id: key.group_id,
        endpoint: `${req.method} ${req.originalUrl || req.url}`,
        workflow_id: workflowIdFromRequest(req),
        request_id: requestIdFromRequest(req),
        ip: req.ip || null,
        user_agent: req.header('user-agent') || null,
        business_actor: businessActor,
      });
      next();
    } catch (error) {
      next(new UnauthorizedException(error instanceof Error ? error.message : 'Invalid API key'));
    }
  }
}

function bearerToken(req: Request): string | null {
  const authorization = req.header('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function requestIdFromRequest(req: Request): string | null {
  const value = req.header('x-request-id');
  return value?.trim() || null;
}

function workflowIdFromRequest(req: Request): string | null {
  const path = req.originalUrl || req.url || '';
  const match = path.match(/\/api\/templates\/([^/?]+)\/(?:start|execute|export|versions)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function parseBusinessActor(req: Request): Record<string, any> | null {
  const value = req.header('x-business-actor');
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
