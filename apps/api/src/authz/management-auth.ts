import { ForbiddenException } from '@nestjs/common';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';

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
  if (actor.roles.includes('group_manager') && (actor.group_ids || []).includes(groupId)) {
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
  if (actor.roles.includes('group_manager')) {
    if (requestedGroupId) {
      assertCanManageGroup(actor, requestedGroupId);
      return requestedGroupId;
    }
    const [firstGroupId] = actor.group_ids || [];
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

function isDevelopmentBypass(actor: WorkflowHistoryActor): boolean {
  return (
    process.env.AUTHZ_ENFORCE_MANAGEMENT !== 'true' &&
    !actor.api_key_id &&
    !actor.actor_id &&
    actor.roles.includes('operator')
  );
}
