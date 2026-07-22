import { GoneException, HttpException } from '@nestjs/common';
import {
  ExternalApprovalService,
  hashToken,
} from './external-approval.service';

describe('ExternalApprovalService', () => {
  const rawToken = 'A'.repeat(43);
  let task: any;
  const tasks = {
    findExternalApprovalByTokenHash: jest.fn(),
    setExternalApprovalOtp: jest.fn(),
    incrementExternalApprovalOtpFailures: jest.fn(),
    completeTask: jest.fn(),
  };
  const instances = { getInstance: jest.fn() };
  const audit = { append: jest.fn() };
  const mailer = { isConfigured: jest.fn(() => true), sendOtp: jest.fn() };
  const service = new ExternalApprovalService(
    tasks as any,
    instances as any,
    audit as any,
    mailer as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    task = {
      id: 'task-1',
      instance_id: 'instance-1',
      node_id: 'approval',
      assignee: 'outside@example.com',
      status: 'OPEN',
      payload: {
        external_approval: {
          email: 'outside@example.com',
          token_hash: hashToken(rawToken),
          token_expires_at: new Date(Date.now() + 60_000).toISOString(),
          require_otp: false,
          consumed_at: null,
        },
      },
    };
    tasks.findExternalApprovalByTokenHash.mockImplementation(async () => task);
    instances.getInstance.mockResolvedValue({
      definition_id: 'workflow-1',
      group_id: 'group-1',
      context: {
        template_name: 'Purchase',
        data: { formData: { amount: 100, apiToken: 'hidden' } },
      },
    });
    tasks.completeTask.mockResolvedValue({ outcome: 'completed', task });
  });

  it('returns masked details and redacts sensitive form fields', async () => {
    const details = await service.getDetails(rawToken);
    expect(details).toEqual(
      expect.objectContaining({
        recipient: 'ou*****@example.com',
        workflow_name: 'Purchase',
        requires_otp: false,
      }),
    );
    expect(details.form_data).toEqual({ amount: 100, apiToken: '[REDACTED]' });
  });

  it('completes a link-only approval with a hashed token and external audit identity', async () => {
    const result = await service.complete(rawToken, {
      action: 'approve',
      comment: 'approved',
    });
    expect(tasks.completeTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        action: 'approve',
        external_approval: expect.objectContaining({
          token_hash: hashToken(rawToken),
          auth_method: 'email_link',
        }),
      }),
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'task.approved',
        details: expect.objectContaining({
          approval_channel: 'external_email',
          approver_email: 'outside@example.com',
        }),
      }),
    );
    expect(result.status).toBe('APPROVED');
  });

  it('issues an OTP without storing the plaintext value', async () => {
    task.payload.external_approval.require_otp = true;
    tasks.setExternalApprovalOtp.mockResolvedValue(true);
    await service.requestOtp(rawToken);
    const sentOtp = mailer.sendOtp.mock.calls[0][0].otp;
    const stored = tasks.setExternalApprovalOtp.mock.calls[0][2];
    expect(sentOtp).toMatch(/^\d{6}$/);
    expect(stored.otp_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(sentOtp);
  });

  it('counts invalid OTP attempts and rejects the completion', async () => {
    task.payload.external_approval.require_otp = true;
    task.payload.external_approval.otp_hash = '0'.repeat(64);
    task.payload.external_approval.otp_expires_at = new Date(
      Date.now() + 60_000,
    ).toISOString();
    task.payload.external_approval.otp_attempts = 0;
    tasks.incrementExternalApprovalOtpFailures.mockResolvedValue(1);
    await expect(
      service.complete(rawToken, { action: 'approve', otp: '123456' }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(tasks.completeTask).not.toHaveBeenCalled();
  });

  it('rejects an expired link', async () => {
    task.payload.external_approval.token_expires_at = new Date(
      Date.now() - 1,
    ).toISOString();
    await expect(service.getDetails(rawToken)).rejects.toBeInstanceOf(
      GoneException,
    );
  });
});
