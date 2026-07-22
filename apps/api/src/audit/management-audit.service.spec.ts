import { ManagementAuditService, sanitizeAuditDetails } from './management-audit.service';

describe('management audit redaction', () => {
  it('redacts secrets recursively without removing useful metadata', () => {
    expect(sanitizeAuditDetails({
      action: 'credential.updated',
      nested: {
        authorization: 'Bearer secret',
        safe: 'visible',
        entries: [{ api_key: 'secret-key', name: 'integration' }],
      },
    })).toEqual({
      action: 'credential.updated',
      nested: {
        authorization: '[REDACTED]',
        safe: 'visible',
        entries: [{ api_key: '[REDACTED]', name: 'integration' }],
      },
    });
  });

  it('upserts a deterministic event id so an idempotent retry does not duplicate the audit event', async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    const service = new ManagementAuditService({ collection: () => ({ updateOne }) } as any);

    await service.append({
      event_id: 'task:task-1:completion',
      action: 'task.approved',
      resource_type: 'task',
      resource_id: 'task-1',
      actor_id: 'alice',
    });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'task:task-1:completion' },
      { $setOnInsert: expect.objectContaining({ _id: 'task:task-1:completion', action: 'task.approved' }) },
      { upsert: true },
    );
  });
});
