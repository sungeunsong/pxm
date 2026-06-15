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
        'connector.db.mongodb.query',
      ]),
    );
  });

  it('returns plugin versions newest first', () => {
    const versions = service.findVersions('connector.db.mongodb.query');

    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe('1.0.0');
  });

  it('returns null for an unknown plugin', () => {
    expect(service.findOne('connector.missing')).toBeNull();
  });
});
