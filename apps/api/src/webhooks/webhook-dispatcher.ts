import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  WebhookDeliveryService,
  type WebhookDeliveryDocument,
} from './webhook-delivery.service';

@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private readonly owner = `webhook-dispatcher-${process.pid}-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly webhooks: WebhookDeliveryService) {}

  onModuleInit() {
    if (process.env.WEBHOOK_DISPATCH_ENABLED === 'false') {
      this.logger.warn('Webhook dispatcher is disabled');
      return;
    }
    const pollMs = positiveInt(process.env.WEBHOOK_DISPATCH_POLL_MS, 2_000);
    this.timer = setInterval(() => void this.tick(), Math.max(250, pollMs));
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.discoverAll();
      const now = new Date();
      const claims = await this.webhooks.claimDeliveries(
        this.owner,
        now,
        new Date(now.getTime() + 60_000),
        positiveInt(process.env.WEBHOOK_DISPATCH_BATCH_SIZE, 20),
      );
      for (const claim of claims) await this.deliver(claim);
    } catch (error) {
      this.logger.error(`Webhook dispatch failed: ${errorText(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async discoverAll() {
    const batchSize = positiveInt(
      process.env.WEBHOOK_DISCOVERY_BATCH_SIZE,
      200,
    );
    for (let batch = 0; batch < 10; batch += 1) {
      const count = await this.webhooks.discoverEvents(batchSize);
      if (count < batchSize) return;
    }
  }

  private async deliver(claim: WebhookDeliveryDocument) {
    const runtime = await this.webhooks.deliveryRuntime(claim._id, this.owner);
    if (!runtime) return;
    const body = JSON.stringify(runtime.body);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    try {
      const response = await fetch(runtime.endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'PXM-Webhook/1.0',
          'x-pxm-event-id': claim.event_key,
          'x-pxm-timestamp': timestamp,
          'x-pxm-signature': this.webhooks.sign(
            runtime.secret,
            timestamp,
            body,
          ),
          'idempotency-key': claim.event_key,
        },
        body,
        signal: AbortSignal.timeout(runtime.endpoint.timeout_ms),
      });
      const attempt = attemptTiming(startedAt, started);
      if (response.ok || response.status === 409) {
        await this.webhooks.finishDelivery(
          claim._id,
          this.owner,
          {
            status: 'SENT',
            response_status: response.status,
            duplicate: response.status === 409,
          },
          attempt,
        );
        return;
      }
      const message = `HTTP ${response.status}: ${(
        await response.text().catch(() => '')
      ).slice(0, 500)}`;
      if (isRetryableStatus(response.status)) {
        await this.failRetryable(claim, message, response.status, attempt);
      } else {
        await this.webhooks.finishDelivery(
          claim._id,
          this.owner,
          {
            status: 'DEAD_LETTER',
            response_status: response.status,
            error: message,
          },
          attempt,
        );
      }
    } catch (error) {
      await this.failRetryable(
        claim,
        errorText(error),
        undefined,
        attemptTiming(startedAt, started),
      );
    }
  }

  private async failRetryable(
    claim: WebhookDeliveryDocument,
    error: string,
    responseStatus: number | undefined,
    attempt: {
      started_at: string;
      completed_at: string;
      duration_ms: number;
    },
  ) {
    const exhausted = claim.attempt_count >= claim.max_attempts;
    const delayMs = Math.min(
      positiveInt(process.env.WEBHOOK_MAX_RETRY_DELAY_MS, 60 * 60_000),
      positiveInt(process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS, 5_000) *
        2 ** Math.max(0, claim.attempt_count - 1),
    );
    await this.webhooks.finishDelivery(
      claim._id,
      this.owner,
      exhausted
        ? {
            status: 'DEAD_LETTER',
            response_status: responseStatus,
            error,
          }
        : {
            status: 'FAILED',
            response_status: responseStatus,
            error,
            next_attempt_at: new Date(Date.now() + delayMs).toISOString(),
          },
      attempt,
    );
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function attemptTiming(startedAt: string, started: number) {
  return {
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
