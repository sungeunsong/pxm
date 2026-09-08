import { EventEmitter } from 'events';
import { ApiKeyAuthMiddleware } from './api-key-auth.middleware';

describe('ApiKeyAuthMiddleware usage completion', () => {
  function setup() {
    const authzService = {
      authenticateApiKey: jest.fn().mockResolvedValue({
        id: 'key-1', owner_type: 'SERVICE_ACCOUNT', owner_id: 'service-1', group_id: 'group-a',
        scopes: ['workflow:execute'], workflow_access: 'allowlist', allowed_workflow_ids: ['workflow-1'],
      }),
      assertApiKeyRequestAllowed: jest.fn().mockResolvedValue(undefined),
      resolveAllowedWorkflowIds: jest.fn().mockResolvedValue(['workflow-1']),
      appendApiKeyUsageLog: jest.fn().mockResolvedValue({ id: 'usage-1' }),
      completeApiKeyUsageLog: jest.fn().mockResolvedValue(undefined),
    };
    const req = {
      ip: '127.0.0.1',
      method: 'POST',
      originalUrl: '/api/v1/templates/workflow-1/start',
      header: jest.fn((name: string) => ({
        authorization: 'Bearer pxm_test',
        'user-agent': 'test-agent',
      }[name.toLowerCase()] || undefined)),
    } as any;
    const res = Object.assign(new EventEmitter(), {
      statusCode: 201,
      writableFinished: false,
    }) as any;
    const next = jest.fn();
    return { middleware: new ApiKeyAuthMiddleware(authzService as any), authzService, req, res, next };
  }

  it('records the HTTP status and duration when the response finishes', async () => {
    const { middleware, authzService, req, res, next } = setup();

    await middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(authzService.appendApiKeyUsageLog).toHaveBeenCalledWith(expect.objectContaining({
      api_key_id: 'key-1',
      completion_state: 'pending',
    }));

    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');
    await new Promise(resolve => setImmediate(resolve));

    expect(authzService.completeApiKeyUsageLog).toHaveBeenCalledTimes(1);
    expect(authzService.completeApiKeyUsageLog).toHaveBeenCalledWith('usage-1', expect.objectContaining({
      status_code: 201,
      completion_state: 'completed',
      duration_ms: expect.any(Number),
      completed_at: expect.any(String),
    }));
  });

  it('marks a connection closed before response completion as aborted', async () => {
    const { middleware, authzService, req, res, next } = setup();

    await middleware.use(req, res, next);
    res.emit('close');
    await new Promise(resolve => setImmediate(resolve));

    expect(authzService.completeApiKeyUsageLog).toHaveBeenCalledWith('usage-1', expect.objectContaining({
      status_code: null,
      completion_state: 'aborted',
    }));
  });
});
