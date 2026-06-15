import { PluginHostService } from './plugin-host.service';

describe('PluginHostService', () => {
  let service: PluginHostService;

  beforeEach(() => {
    service = new PluginHostService();
  });

  it('reports registered hosted executors', () => {
    expect(service.health().executors).toEqual([]);
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
      plugin_id: 'connector.missing',
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
    expect(response.error?.code).toBe('PLUGIN_NOT_REGISTERED');
  });

  it('rejects unsupported hosted isolation mode', async () => {
    const response = await service.invoke({
      plugin_id: 'connector.missing',
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
    expect(response.error?.code).toBe('PLUGIN_NOT_REGISTERED');
  });
});
