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

  it('applies audit filters and redacts legacy details again when reading', async () => {
    const toArray = jest.fn().mockResolvedValue([{
      _id: 'audit-1',
      action: 'credential.updated',
      details: { password: 'legacy-secret', safe: 'visible' },
    }]);
    const limit = jest.fn().mockReturnValue({ toArray });
    const sort = jest.fn().mockReturnValue({ limit });
    const find = jest.fn().mockReturnValue({ sort });
    const service = new ManagementAuditService({ collection: () => ({ find }) } as any);

    await expect(service.list(
      { actor_id: 'admin', roles: ['admin'], group_ids: [], api_key_id: null } as any,
      { groupId: 'group-a', action: 'credential.updated', from: '2026-09-01', to: '2026-09-02', limit: 50 },
    )).resolves.toEqual([expect.objectContaining({
      details: { password: '[REDACTED]', safe: 'visible' },
    })]);
    expect(find).toHaveBeenCalledWith({
      group_id: 'group-a',
      action: 'credential.updated',
      created_at: {
        $gte: '2026-09-01T00:00:00.000Z',
        $lte: '2026-09-02T23:59:59.999Z',
      },
    });
    expect(limit).toHaveBeenCalledWith(50);
  });
});
