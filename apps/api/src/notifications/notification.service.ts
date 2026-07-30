import { ConflictException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Db } from 'mongodb';
import { ManagementAuditService } from '../audit/management-audit.service';
import { assertAdmin } from '../authz/management-auth';
import { MONGO_DB } from '../db/mongo.provider';
import { WorkflowTaskRepositoryPort, type WorkflowHistoryActor } from '../db/ports/db.ports';
import type { NotificationQueryDto } from './dto/notification.dto';

export type NotificationDelivery = {
  _id: string;
  task_id: string;
  instance_id: string;
  recipient_id: string;
  channel: 'email';
  status: 'PENDING' | 'RUNNING' | 'SENT' | 'FAILED' | 'DEAD_LETTER' | 'CANCELED';
  title: string;
  requester: string | null;
  step_order: number | null;
  step_label: string | null;
  source_url: string | null;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  locked_by: string | null;
  locked_until: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly startedAt = new Date().toISOString();
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly tasks: WorkflowTaskRepositoryPort,
    private readonly audit: ManagementAuditService,
  ) {}

  async onModuleInit() {
    await Promise.all([
      this.deliveries.createIndex({ status: 1, next_attempt_at: 1, locked_until: 1 }),
      this.deliveries.createIndex({ task_id: 1, channel: 1 }, { unique: true }),
      this.attempts.createIndex({ delivery_id: 1, started_at: -1 }),
    ]);
    await this.cursors.updateOne(
      { _id: 'approval-task-email' },
      { $setOnInsert: { last_created_at: this.startedAt, last_task_id: '', created_at: this.startedAt } },
      { upsert: true },
    );
  }

  async discover(limit = 200) {
    const cursor = await this.cursors.findOne({ _id: 'approval-task-email' });
    const tasks = await this.tasks.fetchApprovalNotificationTasks({
      created_at: cursor?.last_created_at || this.startedAt,
      id: cursor?.last_task_id || '',
    }, limit);
    for (const task of tasks) {
      const now = new Date().toISOString();
      try {
        await this.deliveries.insertOne({
          _id: `${task.id}:email`,
          task_id: task.id,
          instance_id: task.instance_id,
          recipient_id: task.assignee,
          channel: 'email',
          status: 'PENDING',
          title: task.title,
          requester: task.requester,
          step_order: task.step_order,
          step_label: task.step_label,
          source_url: task.source_url,
          attempt_count: 0,
          max_attempts: positiveInt(process.env.APPROVAL_NOTIFICATION_MAX_ATTEMPTS, 5),
          next_attempt_at: now,
          last_error: null,
          locked_by: null,
          locked_until: null,
          sent_at: null,
          created_at: now,
          updated_at: now,
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    const last = tasks.at(-1);
    if (last) {
      await this.cursors.updateOne({ _id: 'approval-task-email' }, {
        $set: { last_created_at: last.created_at, last_task_id: last.id, updated_at: new Date().toISOString() },
      });
    }
    return tasks.length;
  }

  async claim(owner: string, limit = 20): Promise<NotificationDelivery[]> {
    const claims: NotificationDelivery[] = [];
    for (let i = 0; i < limit; i += 1) {
      const now = new Date();
      const claimed = await this.deliveries.findOneAndUpdate({
        $or: [
          { status: { $in: ['PENDING', 'FAILED'] }, next_attempt_at: { $lte: now.toISOString() } },
          { status: 'RUNNING', locked_until: { $lte: now.toISOString() } },
        ],
        $expr: { $lt: ['$attempt_count', '$max_attempts'] },
      }, {
        $set: {
          status: 'RUNNING', locked_by: owner,
          locked_until: new Date(now.getTime() + 60_000).toISOString(), updated_at: now.toISOString(),
        },
        $inc: { attempt_count: 1 },
      }, { sort: { next_attempt_at: 1 }, returnDocument: 'after' });
      if (!claimed) break;
      claims.push(claimed as NotificationDelivery);
    }
    return claims;
  }

  async currentTask(delivery: NotificationDelivery) {
    return this.tasks.getTask(delivery.task_id);
  }

  async recipientEmail(delivery: NotificationDelivery, task: any): Promise<string | null> {
    const user = await this.db.collection<any>('pxm_users').findOne({ _id: delivery.recipient_id });
    const email = user?.active === false ? null : user?.email || task?.payload?.display_snapshot?.email;
    return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null;
  }

  async markCanceled(delivery: NotificationDelivery, reason: string) {
    await this.finish(delivery, 'CANCELED', { error: reason });
  }

  async markSent(delivery: NotificationDelivery, recipientEmail: string, durationMs: number) {
    await this.attempt(delivery, 'SENT', null, durationMs);
    await this.finish(delivery, 'SENT', { sent_at: new Date().toISOString(), error: null });
    await this.deliveries.updateOne({ _id: delivery._id }, { $set: { recipient_hint: maskEmail(recipientEmail) } });
  }

  async markFailed(delivery: NotificationDelivery, error: string, durationMs: number) {
    await this.attempt(delivery, 'FAILED', error, durationMs);
    const exhausted = delivery.attempt_count >= delivery.max_attempts;
    const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(6, delivery.attempt_count - 1));
    await this.finish(delivery, exhausted ? 'DEAD_LETTER' : 'FAILED', {
      error: error.slice(0, 500),
      next_attempt_at: new Date(Date.now() + delay).toISOString(),
    });
  }

  async list(query: NotificationQueryDto, actor: WorkflowHistoryActor) {
    assertAdmin(actor);
    const filter = query.status ? { status: query.status } : {};
    return (await this.deliveries.find(filter).sort({ created_at: -1 }).limit(query.limit || 100).toArray()).map(safeDelivery);
  }

  async detail(id: string, actor: WorkflowHistoryActor) {
    assertAdmin(actor);
    const delivery = await this.deliveries.findOne({ _id: id });
    if (!delivery) throw new NotFoundException('Notification delivery not found');
    const attempts = await this.attempts.find({ delivery_id: id }).sort({ started_at: -1 }).limit(100).toArray();
    return { ...safeDelivery(delivery), attempts: attempts.map(({ _id, ...item }) => ({ id: _id, ...item })) };
  }

  async retry(id: string, reason: string, actor: WorkflowHistoryActor) {
    assertAdmin(actor);
    const delivery = await this.deliveries.findOne({ _id: id });
    if (!delivery) throw new NotFoundException('Notification delivery not found');
    const task = await this.tasks.getTask(delivery.task_id);
    if (!task || task.status !== 'OPEN') throw new ConflictException('Approval task is no longer OPEN');
    const now = new Date().toISOString();
    const result = await this.deliveries.updateOne({
      _id: id, status: { $in: ['FAILED', 'DEAD_LETTER', 'CANCELED'] },
    }, {
      $set: { status: 'PENDING', attempt_count: 0, next_attempt_at: now, last_error: null, locked_by: null, locked_until: null, updated_at: now },
    });
    if (!result.modifiedCount) throw new ConflictException('Notification is not retryable');
    await this.audit.append({
      action: 'approval_notification.retried',
      resource_type: 'approval_notification',
      resource_id: id,
      actor_id: actor.actor_id,
      details: { reason, task_id: delivery.task_id, recipient_id: delivery.recipient_id },
    });
    return safeDelivery((await this.deliveries.findOne({ _id: id }))!);
  }

  private async attempt(delivery: NotificationDelivery, status: 'SENT' | 'FAILED', error: string | null, durationMs: number) {
    await this.attempts.insertOne({
      _id: randomUUID(), delivery_id: delivery._id, attempt_number: delivery.attempt_count,
      status, error, duration_ms: durationMs, started_at: new Date(Date.now() - durationMs).toISOString(),
      completed_at: new Date().toISOString(),
    });
  }

  private async finish(delivery: NotificationDelivery, status: NotificationDelivery['status'], input: {
    error?: string | null; sent_at?: string | null; next_attempt_at?: string;
  }) {
    await this.deliveries.updateOne({ _id: delivery._id, status: 'RUNNING', locked_by: delivery.locked_by }, {
      $set: {
        status, last_error: input.error ?? null, sent_at: input.sent_at || null,
        next_attempt_at: input.next_attempt_at || delivery.next_attempt_at,
        locked_by: null, locked_until: null, updated_at: new Date().toISOString(),
      },
    });
  }

  private get deliveries() { return this.db.collection<any>('approval_notification_deliveries'); }
  private get attempts() { return this.db.collection<any>('approval_notification_attempts'); }
  private get cursors() { return this.db.collection<any>('approval_notification_cursors'); }
}

function safeDelivery(delivery: any) {
  const { _id, locked_by: _lockedBy, locked_until: _lockedUntil, source_url: sourceUrl, ...item } = delivery;
  return { id: _id, ...item, has_source_url: Boolean(sourceUrl) };
}
function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}***@${domain}`;
}
function positiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function isDuplicateKey(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 11000);
}
