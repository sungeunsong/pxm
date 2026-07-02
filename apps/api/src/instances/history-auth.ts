import type { Request } from 'express';
import type {
  WorkflowHistoryActor,
  WorkflowInstanceAccess,
} from '../db/ports/db.ports';

const DEFAULT_WORKSPACE_ID = 'default';

export function actorFromRequest(req?: Request): WorkflowHistoryActor {
  const actorId = headerValue(req, 'x-actor-id');
  const actorType = headerValue(req, 'x-actor-type') === 'api_client' ? 'api_client' : 'user';
  const roles = splitHeader(req, 'x-actor-roles');

  if (!actorId && roles.length === 0) {
    return {
      actor_type: 'user',
      actor_id: null,
      roles: ['operator'],
      workspace_ids: [DEFAULT_WORKSPACE_ID],
      owned_workflow_ids: [],
      allowed_workflow_ids: [],
      allowed_instance_ids: [],
    };
  }

  return {
    actor_type: actorType,
    actor_id: actorId,
    roles: normalizeRoles(roles, actorType),
    workspace_ids: splitHeader(req, 'x-workspace-ids', [DEFAULT_WORKSPACE_ID]),
    owned_workflow_ids: splitHeader(req, 'x-owned-workflow-ids'),
    allowed_workflow_ids: splitHeader(req, 'x-allowed-workflow-ids'),
    allowed_instance_ids: splitHeader(req, 'x-allowed-instance-ids'),
  };
}

export function instanceAccessFromRequest(
  req: Request | undefined,
  input?: Record<string, any>,
): WorkflowInstanceAccess {
  const actor = actorFromRequest(req);
  const requesterId =
    headerValue(req, 'x-requester-id') ||
    actor.actor_id ||
    stringValue(input?.requester_id) ||
    stringValue(input?.requester);

  return {
    workspace_id: splitHeader(req, 'x-workspace-ids', [DEFAULT_WORKSPACE_ID])[0],
    requester_id: requesterId,
    client_id: actor.actor_type === 'api_client' ? actor.actor_id : headerValue(req, 'x-client-id'),
    approver_ids: splitHeader(req, 'x-approver-ids'),
  };
}

function normalizeRoles(roles: string[], actorType: 'user' | 'api_client'): string[] {
  const normalized = roles.map((role) => role.trim()).filter(Boolean);
  if (actorType === 'api_client' && !normalized.includes('api_client')) {
    normalized.push('api_client');
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
