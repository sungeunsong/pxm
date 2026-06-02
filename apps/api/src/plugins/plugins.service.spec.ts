import { PluginsService } from './plugins.service';

describe('PluginsService', () => {
  let service: PluginsService;

  beforeEach(() => {
    service = new PluginsService();
    service.onModuleInit();
  });

  it('loads the seeded MVP plugin manifests', () => {
    const plugins = service.findAll();

    expect(plugins.map((plugin) => plugin.plugin_id)).toEqual(
      expect.arrayContaining([
        'builtin.http_request',
        'connector.slack.send_message',
        'connector.acra.grant_permission',
        'connector.nit.create_issue',
        'connector.jira.create_issue',
        'connector.hr.lookup_user',
        'connector.ad.grant_group',
      ]),
    );
  });

  it('returns plugin versions newest first', () => {
    const versions = service.findVersions('connector.slack.send_message');

    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('1.0.0');
  });

  it('returns null for an unknown plugin', () => {
    expect(service.findOne('connector.missing')).toBeNull();
  });
});
