import { PluginHostService } from './plugin-host.service';

describe('PluginHostService', () => {
  let service: PluginHostService;

  beforeEach(() => {
    service = new PluginHostService();
  });

  it('reports registered hosted executors', () => {
    expect(service.health().executors).toEqual(
      expect.arrayContaining([
        'connector.slack.send_message',
        'connector.acra.grant_permission',
        'connector.nit.create_issue',
        'connector.sample_echo',
      ]),
    );
  });

  it('invokes a hosted executor by plugin_id', async () => {
    const response = await service.invoke({
      plugin_id: 'connector.nit.create_issue',
      instance: { id: 'instance-1' },
      node: { id: 'node-1', token_id: '12345678-0000-0000-0000-000000000000' },
      config: {
        projectKey: 'OPS',
        titleTemplate: 'Request failed',
      },
      context: {},
      attempt: 0,
    });

    expect(response.success).toBe(true);
    expect(response.output?.ticket).toBe('NIT-12345678');
  });

  it('returns a contract error for an unknown plugin', async () => {
    const response = await service.invoke({
      plugin_id: 'connector.missing',
      instance: { id: 'instance-1' },
      node: { id: 'node-1' },
      config: {},
      context: {},
      attempt: 0,
    });

    expect(response.success).toBe(false);
    expect(response.retryable).toBe(false);
    expect(response.error?.code).toBe('PLUGIN_NOT_REGISTERED');
  });

  it('rejects payloads above the plugin resource limit', async () => {
    const response = await service.invoke({
      plugin_id: 'connector.sample_echo',
      instance: { id: 'instance-1' },
      node: { id: 'node-1' },
      config: {
        message: 'hello',
      },
      context: {},
      attempt: 1,
      resource_limits: {
        max_payload_bytes: 10,
      },
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('PLUGIN_PAYLOAD_TOO_LARGE');
  });

  it('rejects unsupported hosted isolation mode', async () => {
    const response = await service.invoke({
      plugin_id: 'connector.sample_echo',
      instance: { id: 'instance-1' },
      node: { id: 'node-1' },
      config: {},
      context: {},
      attempt: 1,
      isolation: {
        mode: 'external_process',
      },
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('PLUGIN_ISOLATION_UNSUPPORTED');
  });

  it('invokes the sample hosted executor module', async () => {
    const response = await service.invoke({
      plugin_id: 'connector.sample_echo',
      instance: { id: 'instance-1' },
      node: { id: 'node-1', token_id: 'token-1' },
      config: {
        message: 'hello',
      },
      context: {
        requester: 'user@example.com',
      },
      attempt: 1,
    });

    expect(response.success).toBe(true);
    expect(response.output).toMatchObject({
      connector: 'sample_echo',
      message: 'hello',
      instance_id: 'instance-1',
      node_id: 'node-1',
      token_id: 'token-1',
      attempt: 1,
      context_keys: ['requester'],
    });
  });
});
