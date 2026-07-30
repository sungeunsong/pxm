import { WebhookDispatcher } from './webhook-dispatcher';

describe('WebhookDispatcher', () => {
  const originalFetch = global.fetch;
  const originalDelay = process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalDelay === undefined) {
      delete process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS;
    } else {
      process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS = originalDelay;
    }
  });

  it('keeps a timed-out request for retry with its event id', async () => {
    process.env.WEBHOOK_INITIAL_RETRY_DELAY_MS = '1';
    global.fetch = jest
      .fn()
      .mockRejectedValue(new DOMException('timed out', 'TimeoutError')) as any;
    const finishDelivery = jest.fn().mockResolvedValue(true);
    const service = {
      discoverEvents: jest.fn().mockResolvedValue(0),
      claimDeliveries: jest.fn().mockResolvedValue([
        {
          _id: 'delivery-1',
          event_key: 'mongodb:event-1',
          attempt_count: 1,
          max_attempts: 3,
        },
      ]),
      deliveryRuntime: jest.fn().mockResolvedValue({
        endpoint: {
          url: 'https://example.test/webhook',
          timeout_ms: 500,
        },
        secret: 'a'.repeat(32),
        body: { id: 'mongodb:event-1', type: 'APPROVAL_REQUEST_APPROVED' },
      }),
      sign: jest.fn().mockReturnValue('v1=signature'),
      finishDelivery,
    };

    await new WebhookDispatcher(service as any).tick();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.test/webhook',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-pxm-event-id': 'mongodb:event-1',
          'idempotency-key': 'mongodb:event-1',
        }),
      }),
    );
    expect(finishDelivery).toHaveBeenCalledWith(
      'delivery-1',
      expect.any(String),
      expect.objectContaining({
        status: 'FAILED',
        error: expect.stringContaining('timed out'),
      }),
      expect.objectContaining({ duration_ms: expect.any(Number) }),
    );
  });
});
