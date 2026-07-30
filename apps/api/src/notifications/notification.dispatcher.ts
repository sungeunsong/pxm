import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ApprovalNotificationChannel } from './notification-channel';
import { NotificationService, type NotificationDelivery } from './notification.service';

@Injectable()
export class NotificationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDispatcher.name);
  private readonly owner = `approval-notification-${process.pid}-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly notifications: NotificationService,
    private readonly channel: ApprovalNotificationChannel,
  ) {}

  onModuleInit() {
    if (!this.channel.isConfigured()) {
      this.logger.warn('Approval notification dispatcher is disabled because SMTP is not configured');
      return;
    }
    const pollMs = positiveInt(process.env.APPROVAL_NOTIFICATION_POLL_MS, 2000);
    this.timer = setInterval(() => void this.tick(), Math.max(1000, pollMs));
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.notifications.discover(positiveInt(process.env.APPROVAL_NOTIFICATION_DISCOVERY_BATCH_SIZE, 200));
      const claims = await this.notifications.claim(this.owner, positiveInt(process.env.APPROVAL_NOTIFICATION_BATCH_SIZE, 20));
      for (const claim of claims) await this.deliver(claim);
    } catch (error) {
      this.logger.error(`Approval notification dispatch failed: ${errorText(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async deliver(delivery: NotificationDelivery) {
    const started = Date.now();
    try {
      const task = await this.notifications.currentTask(delivery);
      if (!task || task.status !== 'OPEN' || task.payload?.approver_channel !== 'pxm_user') {
        await this.notifications.markCanceled(delivery, 'approval task is no longer OPEN');
        return;
      }
      const email = await this.notifications.recipientEmail(delivery, task);
      if (!email) throw new Error('recipient email is not configured');
      await withTimeout(this.channel.send({
        to: email,
        title: delivery.title,
        requester: delivery.requester,
        stepLabel: delivery.step_label || (delivery.step_order == null ? null : `${delivery.step_order}단계`),
        inboxUrl: `${publicWebUrl()}/#/inbox?task=${encodeURIComponent(delivery.task_id)}`,
        sourceUrl: delivery.source_url,
      }), positiveInt(process.env.APPROVAL_NOTIFICATION_TIMEOUT_MS, 10_000));
      await this.notifications.markSent(delivery, email, Date.now() - started);
    } catch (error) {
      await this.notifications.markFailed(delivery, errorText(error), Date.now() - started);
      this.logger.error(`Approval notification failed for task ${delivery.task_id}: ${errorText(error)}`);
    }
  }
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function publicWebUrl() {
  const configured = process.env.PXM_PUBLIC_WEB_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:5174';
  throw new Error('PXM_PUBLIC_WEB_URL is required for approval notifications');
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`notification timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
