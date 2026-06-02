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
});
