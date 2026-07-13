import type { Request } from 'express';
import type {
  WorkflowHistoryActor,
  WorkflowInstanceAccess,
} from '../db/ports/db.ports';

const DEFAULT_WORKSPACE_ID = 'default';

export function actorFromRequest(req?: Request): WorkflowHistoryActor {
  const authenticatedActor = (req as any)?.workflowActor as WorkflowHistoryActor | undefined;
  if (authenticatedActor) {
    return authenticatedActor;
  }

  const allowActorHeaders = process.env.AUTHZ_ALLOW_ACTOR_HEADERS === 'true';
  const actorId = allowActorHeaders ? headerValue(req, 'x-actor-id') : null;
  const actorType = normalizeActorType(headerValue(req, 'x-actor-type'));
  const roles = allowActorHeaders ? splitHeader(req, 'x-actor-roles') : [];

  if (!actorId && roles.length === 0) {
    return {
      actor_type: 'user',
      actor_id: null,
      roles: ['operator'],
      scopes: [],
      workspace_ids: [DEFAULT_WORKSPACE_ID],
      group_ids: [],
      owned_workflow_ids: [],
      allowed_workflow_ids: [],
      allowed_instance_ids: [],
      api_key_id: null,
      business_actor: null,
    };
  }

  return {
    actor_type: actorType,
    actor_id: actorId,
    roles: normalizeRoles(roles, actorType),
    scopes: splitHeader(req, 'x-api-key-scopes'),
    workspace_ids: splitHeader(req, 'x-workspace-ids', [DEFAULT_WORKSPACE_ID]),
    group_ids: splitHeader(req, 'x-group-ids'),
    owned_workflow_ids: splitHeader(req, 'x-owned-workflow-ids'),
    allowed_workflow_ids: splitHeader(req, 'x-allowed-workflow-ids'),
    allowed_instance_ids: splitHeader(req, 'x-allowed-instance-ids'),
    api_key_id: headerValue(req, 'x-api-key-id'),
    business_actor: parseJsonHeader(req, 'x-business-actor'),
  };
}

export function instanceAccessFromRequest(
  req: Request | undefined,
  input?: Record<string, any>,
): WorkflowInstanceAccess {
  const actor = actorFromRequest(req);
  const groupIds = actor.group_ids || [];
  const requesterId =
    headerValue(req, 'x-requester-id') ||
    actor.actor_id ||
    stringValue(input?.requester_id) ||
    stringValue(input?.requester);

  return {
    workspace_id: splitHeader(req, 'x-workspace-ids', [DEFAULT_WORKSPACE_ID])[0],
    group_id: groupIds[0] || null,
    requester_id: requesterId,
    client_id: actor.actor_type === 'api_client' || actor.actor_type === 'service_account'
      ? actor.actor_id
      : headerValue(req, 'x-client-id'),
    approver_ids: splitHeader(req, 'x-approver-ids'),
    caller: {
      type: actor.actor_type,
      id: actor.actor_id,
      api_key_id: actor.api_key_id || null,
    },
    business_actor: actor.business_actor || null,
  };
}

function normalizeActorType(value: string | null): WorkflowHistoryActor['actor_type'] {
  if (value === 'api_client' || value === 'service_account') {
    return value;
  }
  return 'user';
}

function normalizeRoles(roles: string[], actorType: WorkflowHistoryActor['actor_type']): string[] {
  const normalized = roles.map((role) => role.trim()).filter(Boolean);
  if (actorType === 'api_client' && !normalized.includes('api_client')) {
    normalized.push('api_client');
  }
  if (actorType === 'service_account') {
    return normalized;
  }
  if (normalized.length === 0) {
    normalized.push('requester');
  }
  return normalized;
}

function splitHeader(req: Request | undefined, name: string, fallback: string[] = []): string[] {
  const value = headerValue(req, name);
  if (!value) {
    return fallback;
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function headerValue(req: Request | undefined, name: string): string | null {
  const value = req?.header(name);
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  return value || null;
}

function parseJsonHeader(req: Request | undefined, name: string): Record<string, any> | null {
  const value = headerValue(req, name);
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
