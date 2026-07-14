import { sanitizeAuditDetails } from './management-audit.service';

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
});
