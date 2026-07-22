import { ExternalApprovalDispatcher } from './external-approval.dispatcher';

describe('ExternalApprovalDispatcher', () => {
  it('stores only a token hash and sends the raw token in the transient mail URL', async () => {
    const tasks = {
      claimExternalApprovalTasks: jest.fn().mockResolvedValue([
        {
          task_id: 'task-1',
          instance_id: 'instance-1',
          email: 'outside@example.com',
          require_otp: true,
          expires_in_hours: 24,
          attempt_count: 1,
        },
      ]),
      setExternalApprovalDeliveryToken: jest.fn().mockResolvedValue(true),
      markExternalApprovalDelivery: jest.fn(),
    };
    const mailer = {
      isConfigured: jest.fn(() => true),
      sendApprovalLink: jest.fn(),
    };
    const dispatcher = new ExternalApprovalDispatcher(
      tasks as any,
      mailer as any,
    );

    await dispatcher.tick();

    const stored = tasks.setExternalApprovalDeliveryToken.mock.calls[0][2];
    const url = mailer.sendApprovalLink.mock.calls[0][0].url as string;
    const rawToken = url.split('/').pop()!;
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(rawToken);
    expect(tasks.markExternalApprovalDelivery).toHaveBeenCalledWith(
      'task-1',
      expect.any(String),
      'SENT',
      expect.any(Object),
    );
  });
});
