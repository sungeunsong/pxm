import { PluginsService } from './plugins.service';

describe('PluginsService', () => {
  let service: PluginsService;
  const credentialsService = {};
  const emptyCursor = { toArray: jest.fn().mockResolvedValue([]) };
  const db = {
    collection: jest.fn(() => ({
      find: jest.fn(() => emptyCursor),
    })),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service = new PluginsService(credentialsService as any, db as any);
    await service.onModuleInit();
  });

  it('loads the seeded MVP plugin manifests', () => {
    const plugins = service.findAll();

    expect(plugins.map((plugin) => plugin.plugin_id)).toEqual(
      expect.arrayContaining([
        'builtin.http_request',
        'builtin.ssh',
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
