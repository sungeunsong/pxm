import {
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto';
import { ManagementAuditService } from '../audit/management-audit.service';
import type { ExternalApprovalTask } from '../db/ports/db.ports';
import {
  WorkflowInstanceRepositoryPort,
  WorkflowTaskRepositoryPort,
} from '../db/ports/db.ports';
import { CompleteExternalApprovalDto } from './dto/external-approval.dto';
import { ExternalApprovalMailer } from './external-approval.mailer';

@Injectable()
export class ExternalApprovalService {
  constructor(
    private readonly tasks: WorkflowTaskRepositoryPort,
    private readonly instances: WorkflowInstanceRepositoryPort,
    private readonly audit: ManagementAuditService,
    private readonly mailer: ExternalApprovalMailer,
  ) {}

  async getDetails(rawToken: string) {
    const task = await this.validTask(rawToken);
    const external = task.payload.external_approval;
    const instance = (await this.instances.getInstance(
      task.instance_id,
    )) as unknown as ExternalApprovalInstance | null;
    if (!instance)
      throw new NotFoundException('Approval request was not found');
    return {
      task_id: task.id,
      status: task.status,
      workflow_name:
        instance.context?.template_name ||
        instance.context?.runtime?.snapshot?.workflow?.name ||
        null,
      node_id: task.node_id,
      recipient: maskEmail(external.email || task.assignee),
      requires_otp: external.require_otp !== false,
      expires_at: external.token_expires_at,
      form_data: redact(
        instance.context?.data?.formData || instance.context?.formData || {},
      ),
    };
  }

  async requestOtp(rawToken: string) {
    const task = await this.validTask(rawToken);
    const external = task.payload.external_approval;
    if (external.require_otp === false) return { required: false };
    if (!this.mailer.isConfigured())
      throw new ServiceUnavailableException(
        'External approval SMTP is not configured',
      );

    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    const nextSendAt = new Date(now.getTime() + 60_000);
    const tokenHash = hashToken(rawToken);
    const saved = await this.tasks.setExternalApprovalOtp(task.id, tokenHash, {
      otp_hash: this.hashOtp(rawToken, otp),
      otp_expires_at: expiresAt.toISOString(),
      otp_sent_at: now.toISOString(),
      otp_next_send_at: nextSendAt.toISOString(),
    });
    if (!saved)
      throw new HttpException(
        '인증번호는 60초 후 다시 요청할 수 있습니다.',
        HttpStatus.TOO_MANY_REQUESTS,
      );

    await this.mailer.sendOtp({
      to: external.email || task.assignee,
      otp,
      expiresInMinutes: 10,
    });
    return {
      required: true,
      sent: true,
      retry_after_seconds: 60,
      expires_at: expiresAt.toISOString(),
    };
  }

  async complete(rawToken: string, dto: CompleteExternalApprovalDto) {
    const task = await this.validTask(rawToken);
    const external = task.payload.external_approval;
    const requireOtp = external.require_otp !== false;
    if (requireOtp) await this.verifyOtp(task, rawToken, dto.otp);

    const instance = (await this.instances.getInstance(
      task.instance_id,
    )) as unknown as ExternalApprovalInstance | null;
    if (!instance)
      throw new NotFoundException('Approval request was not found');
    const email = String(external.email || task.assignee).toLowerCase();
    const authMethod = requireOtp ? 'email_otp' : 'email_link';
    const result = await this.tasks.completeTask({
      task_id: task.id,
      action: dto.action,
      status: dto.action === 'approve' ? 'APPROVED' : 'REJECTED',
      actor_id: `external-email:${hashToken(email).slice(0, 16)}`,
      comment: dto.comment?.trim() || null,
      idempotency_key: `external:${hashToken(rawToken)}`,
      external_approval: {
        token_hash: hashToken(rawToken),
        email,
        auth_method: authMethod,
      },
    });
    if (result.outcome === 'not_found')
      throw new NotFoundException('Approval request was not found');
    if (result.outcome === 'already_completed')
      throw new ConflictException(
        'Approval request has already been completed',
      );

    await this.audit.append({
      event_id: `task:${task.id}:completion`,
      action: dto.action === 'approve' ? 'task.approved' : 'task.rejected',
      resource_type: 'task',
      resource_id: task.id,
      group_id:
        instance.group_id ||
        instance.context?.runtime?.access?.group_id ||
        null,
      actor_id: `external-email:${hashToken(email).slice(0, 16)}`,
      details: {
        instance_id: task.instance_id,
        workflow_id:
          instance.definition_id || instance.process_definition_id || null,
        approval_channel: 'external_email',
        authentication_method: authMethod,
        approver_email: email,
        completed_at: new Date().toISOString(),
        comment: dto.comment?.trim() || null,
      },
    });
    return {
      success: true,
      action: dto.action,
      status: dto.action === 'approve' ? 'APPROVED' : 'REJECTED',
    };
  }

  private async validTask(rawToken: string): Promise<ExternalApprovalTask> {
    if (!/^[A-Za-z0-9_-]{40,200}$/.test(rawToken))
      throw new NotFoundException('Approval request was not found');
    const task = await this.tasks.findExternalApprovalByTokenHash(
      hashToken(rawToken),
    );
    if (!task) throw new NotFoundException('Approval request was not found');
    const external = task.payload.external_approval;
    if (task.status !== 'OPEN' || external?.consumed_at)
      throw new GoneException('Approval request is no longer available');
    if (
      !external?.token_expires_at ||
      Date.parse(external.token_expires_at) <= Date.now()
    ) {
      throw new GoneException('Approval link has expired');
    }
    return task;
  }

  private async verifyOtp(
    task: ExternalApprovalTask,
    rawToken: string,
    otp?: string,
  ) {
    const external = task.payload.external_approval;
    if (!otp || !/^\d{6}$/.test(otp))
      throw new HttpException(
        '6자리 인증번호를 입력하세요.',
        HttpStatus.UNAUTHORIZED,
      );
    if (Number(external.otp_attempts || 0) >= 5) {
      throw new HttpException(
        '인증번호 시도 횟수를 초과했습니다. 새 인증번호를 요청하세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const valid =
      external.otp_hash &&
      external.otp_expires_at &&
      Date.parse(external.otp_expires_at) > Date.now() &&
      timingSafeTextEqual(external.otp_hash, this.hashOtp(rawToken, otp));
    if (valid) return;
    const attempts = await this.tasks.incrementExternalApprovalOtpFailures(
      task.id,
      hashToken(rawToken),
    );
    if (attempts >= 5)
      throw new HttpException(
        '인증번호 시도 횟수를 초과했습니다. 새 인증번호를 요청하세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    throw new HttpException(
      '인증번호가 올바르지 않거나 만료되었습니다.',
      HttpStatus.UNAUTHORIZED,
    );
  }

  private hashOtp(rawToken: string, otp: string): string {
    return createHmac('sha256', externalApprovalSecret())
      .update(`${rawToken}:${otp}`)
      .digest('hex');
  }
}

export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function externalApprovalSecret(): string {
  const secret = process.env.PXM_EXTERNAL_APPROVAL_SECRET;
  if (secret && (process.env.NODE_ENV !== 'production' || secret.length >= 32))
    return secret;
  if (process.env.NODE_ENV !== 'production')
    return 'pxm-development-external-approval-secret';
  throw new ServiceUnavailableException(
    'PXM_EXTERNAL_APPROVAL_SECRET of at least 32 characters is required',
  );
}

function timingSafeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function maskEmail(email: string): string {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

function redact(value: unknown, key = ''): unknown {
  if (/password|secret|token|credential|api.?key/i.test(key))
    return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        redact(child, childKey),
      ]),
    );
  }
  return value;
}

type ExternalApprovalInstance = {
  definition_id?: string | null;
  process_definition_id?: string | null;
  group_id?: string | null;
  context?: {
    template_name?: string | null;
    formData?: unknown;
    data?: { formData?: unknown };
    runtime?: {
      snapshot?: { workflow?: { name?: string | null } };
      access?: { group_id?: string | null };
    };
  };
};
