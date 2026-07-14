import { ForbiddenException } from '@nestjs/common';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';
import { developmentBypassEnabled } from './authenticated.guard';

export function assertAdmin(actor: WorkflowHistoryActor): void {
  if (isDevelopmentBypass(actor) || isAdmin(actor)) {
    return;
  }
  throw new ForbiddenException('admin role is required');
}

export function assertCanManageGroup(
  actor: WorkflowHistoryActor,
  groupId?: string | null,
): void {
  if (isDevelopmentBypass(actor) || isAdmin(actor)) {
    return;
  }
  if (!groupId) {
    throw new ForbiddenException('group_id is required for group_manager');
  }
  if (actor.api_key_id) {
    throw new ForbiddenException('API key cannot manage resources');
  }
  if (groupRole(actor, groupId) === 'group_manager') {
    return;
  }
  throw new ForbiddenException('group_manager can manage own group only');
}

export function assertCanIssueUser(
  actor: WorkflowHistoryActor,
  targetRole: string | undefined,
  groupIds: string[],
): void {
  if (isDevelopmentBypass(actor) || isAdmin(actor)) {
    return;
  }
  if (targetRole && targetRole !== 'user') {
    throw new ForbiddenException('group_manager can create user role only');
  }
  if (groupIds.length === 0) {
    throw new ForbiddenException('group_ids is required');
  }
  for (const groupId of groupIds) {
    assertCanManageGroup(actor, groupId);
  }
}

export function manageableGroupId(actor: WorkflowHistoryActor, requestedGroupId?: string): string | undefined {
  if (isDevelopmentBypass(actor) || isAdmin(actor)) {
    return requestedGroupId;
  }
  if (actor.api_key_id) {
    throw new ForbiddenException('API key cannot manage resources');
  }
  if (managerGroupIds(actor).length > 0) {
    if (requestedGroupId) {
      assertCanManageGroup(actor, requestedGroupId);
      return requestedGroupId;
    }
    const [firstGroupId] = managerGroupIds(actor);
    if (!firstGroupId) {
      throw new ForbiddenException('group_manager has no group');
    }
    return firstGroupId;
  }
  throw new ForbiddenException('management role is required');
}

export function isAdmin(actor: WorkflowHistoryActor): boolean {
  return !actor.api_key_id && actor.roles.includes('admin');
}

export function groupRole(
  actor: WorkflowHistoryActor,
  groupId: string,
): 'group_manager' | 'user' | undefined {
  if (actor.group_roles) {
    return actor.group_roles[groupId];
  }
  if ((actor.group_ids || []).includes(groupId)) {
    return actor.roles.includes('group_manager') ? 'group_manager' : 'user';
  }
  return undefined;
}

export function managerGroupIds(actor: WorkflowHistoryActor): string[] {
  if (actor.group_roles) {
    return Object.entries(actor.group_roles)
      .filter(([, role]) => role === 'group_manager')
      .map(([groupId]) => groupId);
  }
  return actor.roles.includes('group_manager') ? actor.group_ids || [] : [];
}

function isDevelopmentBypass(actor: WorkflowHistoryActor): boolean {
  return (
    developmentBypassEnabled() &&
    !actor.api_key_id &&
    !actor.actor_id &&
    actor.roles.includes('operator')
  );
}
