import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { WorkflowTaskRepositoryPort } from '../db/ports/db.ports';
import { ExternalApprovalMailer } from './external-approval.mailer';
import { hashToken } from './external-approval.service';

@Injectable()
export class ExternalApprovalDispatcher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ExternalApprovalDispatcher.name);
  private readonly owner = `external-approval-mailer-${process.pid}-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly tasks: WorkflowTaskRepositoryPort,
    private readonly mailer: ExternalApprovalMailer,
  ) {}

  onModuleInit() {
    if (!this.mailer.isConfigured()) {
      this.logger.warn(
        'External approval mail dispatcher is disabled because SMTP is not configured',
      );
      return;
    }
    const pollMs = positiveInt(process.env.EXTERNAL_APPROVAL_POLL_MS, 2000);
    this.timer = setInterval(() => void this.tick(), Math.max(1000, pollMs));
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
      const now = new Date();
      const claims = await this.tasks.claimExternalApprovalTasks(
        this.owner,
        now,
        new Date(now.getTime() + 60_000),
        positiveInt(process.env.EXTERNAL_APPROVAL_BATCH_SIZE, 20),
      );
      for (const claim of claims) await this.deliver(claim);
    } catch (error) {
      this.logger.error(
        `External approval dispatch failed: ${errorText(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async deliver(
    claim: Awaited<
      ReturnType<WorkflowTaskRepositoryPort['claimExternalApprovalTasks']>
    >[number],
  ) {
    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + claim.expires_in_hours * 60 * 60_000,
    );
    const stored = await this.tasks.setExternalApprovalDeliveryToken(
      claim.task_id,
      this.owner,
      {
        email: claim.email.toLowerCase(),
        token_hash: hashToken(rawToken),
        token_expires_at: expiresAt.toISOString(),
        require_otp: claim.require_otp,
        attempt_count: claim.attempt_count,
      },
    );
    if (!stored) return;

    try {
      const publicUrl = publicWebUrl();
      await this.mailer.sendApprovalLink({
        to: claim.email,
        url: `${publicUrl}/external-approval/${rawToken}`,
        expiresAt: expiresAt.toISOString(),
        requireOtp: claim.require_otp,
      });
      await this.tasks.markExternalApprovalDelivery(
        claim.task_id,
        this.owner,
        'SENT',
        {
          sent_at: new Date().toISOString(),
        },
      );
    } catch (error) {
      const retryDelay = Math.min(
        60 * 60_000,
        30_000 * 2 ** Math.min(6, claim.attempt_count - 1),
      );
      await this.tasks.markExternalApprovalDelivery(
        claim.task_id,
        this.owner,
        'FAILED',
        {
          retry_at: new Date(Date.now() + retryDelay).toISOString(),
          error: errorText(error).slice(0, 500),
        },
      );
      this.logger.error(
        `External approval email failed for task ${claim.task_id}: ${errorText(error)}`,
      );
    }
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(
    typeof value === 'string' || typeof value === 'number' ? String(value) : '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicWebUrl(): string {
  const configured = process.env.PXM_PUBLIC_WEB_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:5174';
  throw new Error('PXM_PUBLIC_WEB_URL is required for external approval email');
}
