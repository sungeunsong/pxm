import { ConflictException } from '@nestjs/common';
import { OperationsService } from './operations.service';

describe('OperationsService', () => {
  const actor = { actor_id: 'admin-1', roles: ['admin'], api_key_id: null } as any;
  const queue = {
    getQueueStats: jest.fn(),
    getOperationsSnapshot: jest.fn(),
    retryFailedJob: jest.fn(),
    reclaimExpiredInstanceLock: jest.fn(),
  };
  const webhooks = {
    getOperationalSnapshot: jest.fn(),
    retryDelivery: jest.fn(),
  };
  const audit = { append: jest.fn() };
  const service = new OperationsService(queue as any, webhooks as any, audit as any);

  beforeEach(() => jest.clearAllMocks());

  it('marks the overview dangerous when a failed job exists', async () => {
    queue.getQueueStats.mockResolvedValue({
      queued: 0, running: 0, failed: 1, completed: 2, oldest_queued_age_ms: null,
    });
    queue.getOperationsSnapshot.mockResolvedValue({
      jobs: [{ id: '7', status: 'FAILED' }], waiting_instances: [], expired_locks: [],
    });
    webhooks.getOperationalSnapshot.mockResolvedValue({
      pending: 0, running: 0, failed: 0, dead_letter: 0, deliveries: [],
    });

    await expect(service.overview(actor)).resolves.toEqual(expect.objectContaining({ status: 'DANGER' }));
  });

  it('retries a failed job once and records the reason', async () => {
    queue.retryFailedJob.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(service.retryJob('7', 'worker restart recovery', actor))
      .resolves.toEqual({ job_id: '7', status: 'QUEUED' });
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'runtime.job.retried',
      details: { reason: 'worker restart recovery', result: 'QUEUED' },
    }));
    await expect(service.retryJob('7', 'duplicate click', actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not warn for a long wait that still has an open task', async () => {
    queue.getQueueStats.mockResolvedValue({
      queued: 0, running: 0, failed: 0, completed: 2, oldest_queued_age_ms: null,
    });
    queue.getOperationsSnapshot.mockResolvedValue({
      jobs: [],
      waiting_instances: [{ id: 'instance-1', classification: 'EXPECTED', waiting_reason: 'OPEN_TASK' }],
      expired_locks: [],
    });
    webhooks.getOperationalSnapshot.mockResolvedValue({
      pending: 0, running: 0, failed: 0, dead_letter: 0, deliveries: [], oldest_pending_at: null,
    });

    await expect(service.overview(actor)).resolves.toEqual(expect.objectContaining({
      status: 'HEALTHY',
      runtime: expect.objectContaining({
        expected_waiting_count: 1,
        suspicious_waiting_count: 0,
      }),
    }));
  });

  it('reclaims only an expired lock and delegates outbox retry with its reason', async () => {
    queue.reclaimExpiredInstanceLock.mockResolvedValue(true);
    webhooks.retryDelivery.mockResolvedValue({ id: 'delivery-1', status: 'PENDING' });

    await service.reclaimLock('instance-1', 'expired worker lease', actor);
    await service.retryOutbox('delivery-1', 'remote endpoint recovered', actor);

    expect(webhooks.retryDelivery).toHaveBeenCalledWith('delivery-1', actor, 'remote endpoint recovered');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'runtime.instance_lock.reclaimed',
      details: { reason: 'expired worker lease', result: 'RECLAIMED' },
    }));
  });
});
