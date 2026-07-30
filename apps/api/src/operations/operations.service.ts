import { ConflictException, Injectable } from '@nestjs/common';
import { ManagementAuditService } from '../audit/management-audit.service';
import { assertAdmin } from '../authz/management-auth';
import { EngineQueueRepositoryPort, type WorkflowHistoryActor } from '../db/ports/db.ports';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service';

@Injectable()
export class OperationsService {
  constructor(
    private readonly queue: EngineQueueRepositoryPort,
    private readonly webhooks: WebhookDeliveryService,
    private readonly audit: ManagementAuditService,
  ) {}

  async overview(actor: WorkflowHistoryActor, waitingThresholdMinutes = 60, limit = 100) {
    assertAdmin(actor);
    const [queue, runtime, outbox] = await Promise.all([
      this.queue.getQueueStats(),
      this.queue.getOperationsSnapshot(waitingThresholdMinutes, limit),
      this.webhooks.getOperationalSnapshot(actor, limit),
    ]);
    const queuedAgeWarningMs = Number(process.env.OPERATIONS_QUEUE_WARNING_MS || 300_000);
    const outboxAgeWarningMs = Number(process.env.OPERATIONS_OUTBOX_WARNING_MS || 300_000);
    const oldestOutboxAgeMs = outbox.oldest_pending_at
      ? Math.max(0, Date.now() - Date.parse(outbox.oldest_pending_at))
      : null;
    const suspiciousWaitingCount = runtime.waiting_instances.filter(
      (instance) => instance.classification === 'SUSPICIOUS',
    ).length;
    const expectedWaitingCount = runtime.waiting_instances.length - suspiciousWaitingCount;
    const danger = queue.failed > 0 || runtime.expired_locks.length > 0 ||
      outbox.failed > 0 || outbox.dead_letter > 0;
    const warning = suspiciousWaitingCount > 0 ||
      (oldestOutboxAgeMs || 0) >= outboxAgeWarningMs ||
      (queue.oldest_queued_age_ms || 0) >= queuedAgeWarningMs;
    return {
      status: danger ? 'DANGER' : warning ? 'WARNING' : 'HEALTHY',
      generated_at: new Date().toISOString(),
      thresholds: {
        waiting_minutes: waitingThresholdMinutes,
        queued_warning_ms: queuedAgeWarningMs,
        outbox_warning_ms: outboxAgeWarningMs,
      },
      queue,
      runtime: {
        ...runtime,
        expected_waiting_count: expectedWaitingCount,
        suspicious_waiting_count: suspiciousWaitingCount,
      },
      outbox: { ...outbox, oldest_pending_age_ms: oldestOutboxAgeMs },
    };
  }

  async retryJob(jobId: string, reason: string, actor: WorkflowHistoryActor) {
    assertAdmin(actor);
    if (!await this.queue.retryFailedJob(jobId)) {
      throw new ConflictException('Job is no longer FAILED or does not exist');
    }
    await this.audit.append({
      action: 'runtime.job.retried',
      resource_type: 'runtime_operation',
      resource_id: jobId,
      actor_id: actor.actor_id,
      details: { reason, result: 'QUEUED' },
    });
    return { job_id: jobId, status: 'QUEUED' };
  }

  async reclaimLock(instanceId: string, reason: string, actor: WorkflowHistoryActor) {
    assertAdmin(actor);
    if (!await this.queue.reclaimExpiredInstanceLock(instanceId)) {
      throw new ConflictException('Instance lock is no longer expired or does not exist');
    }
    await this.audit.append({
      action: 'runtime.instance_lock.reclaimed',
      resource_type: 'runtime_operation',
      resource_id: instanceId,
      actor_id: actor.actor_id,
      details: { reason, result: 'RECLAIMED' },
    });
    return { instance_id: instanceId, status: 'RECLAIMED' };
  }

  async retryOutbox(deliveryId: string, reason: string, actor: WorkflowHistoryActor) {
    assertAdmin(actor);
    return this.webhooks.retryDelivery(deliveryId, actor, reason);
  }
}
