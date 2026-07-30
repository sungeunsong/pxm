import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClientSession, Db } from 'mongodb';
import { isAdmin, managerGroupIds } from '../authz/management-auth';
import { MONGO_DB } from '../db/mongo.provider';
import type { WorkflowHistoryActor } from '../db/ports/db.ports';

export type ManagementAuditEvent = {
  event_id?: string;
  action: string;
  resource_type: 'workflow' | 'task' | 'group' | 'user' | 'service_account' | 'api_key' | 'credential' | 'security_policy' | 'runtime_integrity' | 'webhook_endpoint' | 'webhook_delivery';
  resource_id: string;
  group_id?: string | null;
  actor_id?: string | null;
  api_key_id?: string | null;
  details?: Record<string, unknown>;
};

@Injectable()
export class ManagementAuditService {
  constructor(@Inject(MONGO_DB) private readonly db: Db) {}

  async append(event: ManagementAuditEvent, session?: ClientSession): Promise<void> {
    const { event_id: eventId, ...payload } = event;
    const document = {
      _id: eventId || randomUUID(),
      ...payload,
      group_id: event.group_id || null,
      actor_id: event.actor_id || 'system',
      details: sanitizeAuditDetails(event.details || {}),
      created_at: new Date().toISOString(),
    };
    if (eventId) {
      await this.collection.updateOne(
        { _id: eventId },
        { $setOnInsert: document },
        session ? { upsert: true, session } : { upsert: true },
      );
      return;
    }
    if (session) {
      await this.collection.insertOne(document, { session });
      return;
    }
    await this.collection.insertOne(document);
  }

  async list(actor: WorkflowHistoryActor, groupId?: string, limit = 200) {
    if (actor.api_key_id) throw new ForbiddenException('API key cannot read management audit');
    let filter: Record<string, unknown> = {};
    if (isAdmin(actor)) {
      if (groupId) filter = { group_id: groupId };
    } else if (managerGroupIds(actor).length) {
      const manageableGroups = managerGroupIds(actor);
      if (groupId && !manageableGroups.includes(groupId)) {
        throw new ForbiddenException('group_manager can read own group audit only');
      }
      filter = { group_id: groupId || { $in: manageableGroups } };
    } else {
      throw new ForbiddenException('management role is required');
    }
    return this.collection.find(filter).sort({ created_at: -1 }).limit(Math.min(Math.max(limit, 1), 500)).toArray();
  }

  private get collection() {
    return this.db.collection<any>('management_audit_logs');
  }
}

const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|passphrase)/i;

export function sanitizeAuditDetails(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(value, 0);
}

function sanitizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= 12) return { truncated: '[MAX_DEPTH]' };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1),
  ]));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') return sanitizeObject(value as Record<string, unknown>, depth);
  return value;
}
