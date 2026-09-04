import { buildHttpTestOutput, PluginsService } from './plugins.service';

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

describe('buildHttpTestOutput', () => {
  const headers = { 'content-type': 'application/json' };

  // PXM-35: Engine의 build_http_response_output과 같은 구조여야 한다.
  it('parses a JSON body', () => {
    const output = buildHttpTestOutput(200, true, headers, 'application/json', '{"user":{"id":"u-1"}}');

    expect(output).toMatchObject({ status_code: 200, ok: true, headers });
    expect((output.body as any).user.id).toBe('u-1');
    expect((output as any).body_truncated).toBeUndefined();
  });

  it('keeps a non-JSON body as a string', () => {
    const output = buildHttpTestOutput(200, true, {}, 'text/plain', 'granted');

    expect(output.body).toBe('granted');
  });

  it('falls back to raw text when JSON parsing fails', () => {
    const output = buildHttpTestOutput(200, true, {}, 'application/json', '{not json');

    expect(output.body).toBe('{not json');
  });

  it('truncates a body over the limit', () => {
    const raw = 'a'.repeat(200);
    const output = buildHttpTestOutput(200, true, {}, 'application/json', raw, 64);

    expect((output as any).body_truncated).toBe(true);
    expect((output as any).body_bytes).toBe(200);
    expect((output.body as string).length).toBe(64);
  });

  it('does not split a multibyte character when truncating', () => {
    const raw = '가'.repeat(50);
    const output = buildHttpTestOutput(200, true, {}, 'text/plain', raw, 64);

    const body = output.body as string;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(64);
    expect([...body].every((char) => char === '가')).toBe(true);
  });
});
