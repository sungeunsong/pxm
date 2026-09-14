import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

@Injectable()
export class ExternalApprovalMailer {
  private transporter?: Transporter;

  isConfigured(): boolean {
    return Boolean(process.env.PXM_SMTP_URL || process.env.SMTP_HOST);
  }

  async sendApprovalLink(input: {
    to: string;
    url: string;
    expiresAt: string;
    requireOtp: boolean;
    title?: string | null;
    requester?: string | null;
    stepLabel?: string | null;
    sourceUrl?: string | null;
    inboxUrl?: string | null;
  }): Promise<void> {
    const detailLines = [
      input.title ? `결재 제목: ${input.title}` : '',
      input.requester ? `요청자: ${input.requester}` : '',
      input.stepLabel ? `결재 단계: ${input.stepLabel}` : '',
    ].filter(Boolean);
    await this.transport().sendMail({
      from: process.env.PXM_SMTP_FROM || 'PXM <no-reply@localhost>',
      to: input.to,
      subject: '[PXM] 승인이 필요한 요청이 도착했습니다',
      text: [
        'PXM에서 승인이 필요한 요청이 도착했습니다.',
        '',
        ...detailLines,
        `승인 링크: ${input.url}`,
        input.inboxUrl ? `PXM 결재함: ${input.inboxUrl}` : '',
        input.sourceUrl ? `원문: ${input.sourceUrl}` : '',
        `링크 만료: ${input.expiresAt}`,
        input.requireOtp
          ? '처리 시 이메일로 전송되는 6자리 OTP 확인이 필요합니다.'
          : '',
        '',
        '본인이 요청한 승인이 아니라면 이 메일을 무시하세요.',
      ]
        .filter(Boolean)
        .join('\n'),
      html: `<p>PXM에서 승인이 필요한 요청이 도착했습니다.</p>
        ${input.title ? `<p><strong>${escapeHtml(input.title)}</strong></p>` : ''}
        ${input.requester ? `<p>요청자: ${escapeHtml(input.requester)}</p>` : ''}
        ${input.stepLabel ? `<p>결재 단계: ${escapeHtml(input.stepLabel)}</p>` : ''}
        <p><a href="${escapeHtml(input.url)}">승인 요청 확인</a></p>
        ${input.inboxUrl ? `<p><a href="${escapeHtml(input.inboxUrl)}">PXM 결재함에서 확인</a></p>` : ''}
        ${input.sourceUrl ? `<p><a href="${escapeHtml(input.sourceUrl)}">원문 확인</a></p>` : ''}
        <p>링크 만료: ${escapeHtml(input.expiresAt)}</p>
        ${input.requireOtp ? '<p>처리 시 이메일로 전송되는 6자리 OTP 확인이 필요합니다.</p>' : ''}
        <p>본인이 요청한 승인이 아니라면 이 메일을 무시하세요.</p>`,
    });
  }

  async sendOtp(input: {
    to: string;
    otp: string;
    expiresInMinutes: number;
  }): Promise<void> {
    await this.transport().sendMail({
      from: process.env.PXM_SMTP_FROM || 'PXM <no-reply@localhost>',
      to: input.to,
      subject: '[PXM] 외부 승인 인증번호',
      text: `PXM 외부 승인 인증번호는 ${input.otp} 입니다. ${input.expiresInMinutes}분 안에 입력하세요.`,
      html: `<p>PXM 외부 승인 인증번호입니다.</p><p style="font-size:24px;font-weight:700;letter-spacing:6px">${input.otp}</p><p>${input.expiresInMinutes}분 안에 입력하세요.</p>`,
    });
  }

  async sendUserApprovalNotification(input: {
    to: string;
    title: string;
    requester: string | null;
    stepLabel: string | null;
    inboxUrl: string;
    sourceUrl: string | null;
    kind?: 'initial' | 'reminder' | 'escalation';
    dueAt?: string | null;
  }): Promise<void> {
    const kind = input.kind || 'initial';
    const intro = kind === 'reminder'
      ? '처리 기한이 지난 결재가 있습니다.'
      : kind === 'escalation'
        ? '그룹의 결재가 기한을 지나 아직 처리되지 않았습니다.'
        : '새 결재 요청이 도착했습니다.';
    const subjectPrefix = kind === 'reminder'
      ? '결재 처리 독촉'
      : kind === 'escalation'
        ? '결재 기한 초과 알림'
        : '결재 요청';
    const actionLabel = kind === 'escalation' ? 'PXM 실행 모니터링' : 'PXM 결재함';
    const lines = [
      `결재 제목: ${input.title}`,
      input.requester ? `요청자: ${input.requester}` : '',
      input.stepLabel ? `결재 단계: ${input.stepLabel}` : '',
      input.dueAt ? `처리 기한: ${input.dueAt}` : '',
      `${actionLabel}: ${input.inboxUrl}`,
      input.sourceUrl ? `원문: ${input.sourceUrl}` : '',
    ].filter(Boolean);
    await this.transport().sendMail({
      from: process.env.PXM_SMTP_FROM || 'PXM <no-reply@localhost>',
      to: input.to,
      subject: `[PXM] ${subjectPrefix}: ${input.title}`.slice(0, 180),
      text: [intro, '', ...lines].join('\n'),
      html: `<p>${escapeHtml(intro)}</p>
        <p><strong>${escapeHtml(input.title)}</strong></p>
        ${input.requester ? `<p>요청자: ${escapeHtml(input.requester)}</p>` : ''}
        ${input.stepLabel ? `<p>결재 단계: ${escapeHtml(input.stepLabel)}</p>` : ''}
        ${input.dueAt ? `<p>처리 기한: ${escapeHtml(input.dueAt)}</p>` : ''}
        <p><a href="${escapeHtml(input.inboxUrl)}">${actionLabel}에서 확인</a></p>
        ${input.sourceUrl ? `<p><a href="${escapeHtml(input.sourceUrl)}">원문 확인</a></p>` : ''}`,
    });
  }

  async sendDelegationNotification(input: {
    to: string;
    delegatorName: string;
    delegateName: string;
    startsAt: string;
    endsAt: string;
    revoked?: boolean;
  }): Promise<void> {
    const title = input.revoked ? '대리 결재 설정이 해제되었습니다.' : '대리 결재가 설정되었습니다.';
    const lines = [
      `원래 승인자: ${input.delegatorName}`,
      `대리 결재자: ${input.delegateName}`,
      `기간: ${input.startsAt} ~ ${input.endsAt}`,
      input.revoked ? '미처리 결재는 원래 승인자에게 돌아갑니다.' : '기간이 끝나면 미처리 결재는 원래 승인자에게 자동으로 돌아갑니다.',
    ];
    await this.transport().sendMail({
      from: process.env.PXM_SMTP_FROM || 'PXM <no-reply@localhost>',
      to: input.to,
      subject: `[PXM] ${title}`,
      text: [title, '', ...lines].join('\n'),
      html: `<p>${escapeHtml(title)}</p><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
    });
  }

  private transport(): Transporter {
    if (this.transporter) return this.transporter;
    const smtpUrl = process.env.PXM_SMTP_URL;
    if (smtpUrl) {
      this.transporter = nodemailer.createTransport(smtpUrl);
      return this.transporter;
    }
    const host = process.env.SMTP_HOST;
    if (!host)
      throw new ServiceUnavailableException(
        'External approval SMTP is not configured',
      );
    const port = positiveInt(process.env.SMTP_PORT, 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: user ? { user, pass: pass || '' } : undefined,
      requireTLS: process.env.SMTP_REQUIRE_TLS === 'true',
    });
    return this.transporter;
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(
    typeof value === 'string' || typeof value === 'number' ? String(value) : '',
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}
