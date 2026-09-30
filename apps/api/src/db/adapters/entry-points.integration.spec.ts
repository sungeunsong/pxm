import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import {
  EntryPoint,
  EntryPointConflictError,
  EntryPointRepositoryPort,
} from '../ports/entry-points.port';
import { MongoEntryPointRepository } from './entry-points.mongodb';
import { PostgresEntryPointRepository } from './entry-points.postgres';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;
const describePostgres =
  process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

function entry(
  overrides: Partial<EntryPoint> & Pick<EntryPoint, 'id' | 'group_id'>,
): EntryPoint {
  const now = new Date().toISOString();
  return {
    kind: 'tool',
    tenant_id: null,
    definition_id: 'wf-1',
    pinned_version: 3,
    input_schema: {
      type: 'object',
      properties: { user_id: { type: 'string' } },
      required: ['user_id'],
    },
    input_schema_source: 'derived',
    output_schema: null,
    output_contract: 'free_form',
    side_effect: 'read_only',
    status: 'active',
    description: 'test',
    tags: ['a'],
    resource_digest: null,
    history_policy: { body: 'none' },
    tool: { name: 'lookup_user', display_name: null },
    route: null,
    created_by: 'tester',
    updated_by: 'tester',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function contract(
  name: string,
  open: () => Promise<{
    repo: EntryPointRepositoryPort;
    close: () => Promise<void>;
  }>,
) {
  describe(name, () => {
    let repo: EntryPointRepositoryPort;
    let close: () => Promise<void>;
    const suffix = randomUUID();
    const groupA = `ep-group-a-${suffix}`;
    const groupB = `ep-group-b-${suffix}`;
    const created: string[] = [];

    beforeAll(async () => {
      ({ repo, close } = await open());
    });

    afterAll(async () => {
      for (const id of created) await repo.deleteEntryPoint(id);
      await close();
    });

    async function create(value: EntryPoint) {
      created.push(value.id);
      return repo.createEntryPoint(value);
    }

    it('stores and reads back a tool entry point', async () => {
      const saved = await create(
        entry({ id: `ep-1-${suffix}`, group_id: groupA }),
      );
      const loaded = await repo.getEntryPoint(saved.id);
      expect(loaded).toMatchObject({
        kind: 'tool',
        group_id: groupA,
        pinned_version: 3,
        input_schema: { required: ['user_id'] },
        tool: { name: 'lookup_user' },
        route: null,
        tenant_id: null,
      });
    });

    it('rejects the same tool name in the same group but allows it in another group', async () => {
      await expect(
        create(entry({ id: `ep-dup-${suffix}`, group_id: groupA })),
      ).rejects.toBeInstanceOf(EntryPointConflictError);
      await expect(
        create(entry({ id: `ep-2-${suffix}`, group_id: groupB })),
      ).resolves.toMatchObject({ group_id: groupB });
    });

    it('rejects the same route method and path', async () => {
      const route = {
        method: 'POST' as const,
        path: `/gw/${suffix}/access`,
        mode: 'passthrough' as const,
        response_mode: 'backend' as const,
        timeout_ms: 10_000,
        forward_headers: [],
      };
      await create(
        entry({
          id: `ep-r1-${suffix}`,
          group_id: groupA,
          kind: 'route',
          tool: null,
          route,
        }),
      );
      await expect(
        create(
          entry({
            id: `ep-r2-${suffix}`,
            group_id: groupB,
            kind: 'route',
            tool: null,
            route,
          }),
        ),
      ).rejects.toBeInstanceOf(EntryPointConflictError);
    });

    it('filters by kind, group, tool name and route', async () => {
      const tools = await repo.listEntryPoints({
        kind: 'tool',
        group_ids: [groupA, groupB],
      });
      expect(tools.map((item) => item.id).sort()).toEqual(
        [`ep-1-${suffix}`, `ep-2-${suffix}`].sort(),
      );
      const byName = await repo.listEntryPoints({
        group_ids: [groupB],
        tool_name: 'lookup_user',
      });
      expect(byName.map((item) => item.id)).toEqual([`ep-2-${suffix}`]);
      const byRoute = await repo.listEntryPoints({
        route: { method: 'POST', path: `/gw/${suffix}/access` },
      });
      expect(byRoute.map((item) => item.id)).toEqual([`ep-r1-${suffix}`]);
    });

    it('updates fields and keeps unique checks on update', async () => {
      const updated = await repo.updateEntryPoint(`ep-1-${suffix}`, {
        pinned_version: 4,
        status: 'disabled',
        tool: { name: 'lookup_user_v2', display_name: 'Lookup' },
        updated_by: 'tester-2',
      });
      expect(updated).toMatchObject({
        pinned_version: 4,
        status: 'disabled',
        tool: { name: 'lookup_user_v2' },
        updated_by: 'tester-2',
      });
      expect(
        await repo.listEntryPoints({
          group_ids: [groupA],
          tool_name: 'lookup_user_v2',
        }),
      ).toHaveLength(1);

      await create(
        entry({
          id: `ep-3-${suffix}`,
          group_id: groupA,
          tool: { name: 'other_tool' },
        }),
      );
      await expect(
        repo.updateEntryPoint(`ep-3-${suffix}`, {
          tool: { name: 'lookup_user_v2' },
          updated_by: null,
        }),
      ).rejects.toBeInstanceOf(EntryPointConflictError);
      expect(
        await repo.updateEntryPoint(`missing-${suffix}`, {
          status: 'active',
          updated_by: null,
        }),
      ).toBeNull();
    });

    it('deletes', async () => {
      expect(await repo.deleteEntryPoint(`ep-3-${suffix}`)).toBe(true);
      expect(await repo.getEntryPoint(`ep-3-${suffix}`)).toBeNull();
      expect(await repo.deleteEntryPoint(`ep-3-${suffix}`)).toBe(false);
    });
  });
}

describeMongo('entry point repository (MongoDB)', () => {
  contract('contract', async () => {
    const client = new MongoClient(
      process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017',
      { serverSelectionTimeoutMS: 2_000 },
    );
    await client.connect();
    const repo = new MongoEntryPointRepository(
      client.db(process.env.MONGO_DB_NAME || 'pxm_db'),
    );
    return { repo, close: () => client.close() };
  });
});

describePostgres('entry point repository (PostgreSQL)', () => {
  contract('contract', async () => {
    const pool = new Pool({
      connectionString:
        process.env.POSTGRES_URL ||
        process.env.DATABASE_URL ||
        'postgres://postgres:postgres@127.0.0.1:5432/pxm',
    });
    const repo = new PostgresEntryPointRepository(pool);
    return { repo, close: () => pool.end() };
  });
});
