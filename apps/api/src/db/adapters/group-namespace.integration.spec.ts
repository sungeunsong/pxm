import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import type { AuthzRepositoryPort } from '../ports/db.ports';
import { MongodbAdapter } from './mongodb.adapter';
import { PostgresAdapter } from './postgres.adapter';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;
const describePostgres =
  process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

function contract(
  open: () => Promise<{
    repo: AuthzRepositoryPort;
    cleanup: (ids: string[]) => Promise<void>;
  }>,
) {
  let repo: AuthzRepositoryPort;
  let cleanup: (ids: string[]) => Promise<void>;
  const suffix = randomUUID().slice(0, 8);
  const ids = [`ns-a-${suffix}`, `ns-b-${suffix}`];

  beforeAll(async () => {
    ({ repo, cleanup } = await open());
  });

  afterAll(async () => {
    await cleanup(ids);
  });

  it('stores the namespace on create and keeps it on rename', async () => {
    await repo.upsertGroup({
      id: ids[0],
      name: `ns a ${suffix}`,
      namespace: `ns-${suffix}`,
    });
    const renamed = await repo.upsertGroup({
      id: ids[0],
      name: `ns a renamed ${suffix}`,
      namespace: 'ignored',
    });
    expect(renamed.namespace).toBe(`ns-${suffix}`);
  });

  it('assigns only when empty and enforces uniqueness', async () => {
    await repo.upsertGroup({ id: ids[1], name: `ns b ${suffix}` });
    await expect(
      repo.assignGroupNamespace(ids[1], `ns-${suffix}`),
    ).rejects.toBeDefined();
    expect(await repo.assignGroupNamespace(ids[1], `nsb-${suffix}`)).toBe(true);
    expect(await repo.assignGroupNamespace(ids[1], `nsc-${suffix}`)).toBe(
      false,
    );
    expect((await repo.getGroup(ids[1]))?.namespace).toBe(`nsb-${suffix}`);
  });
}

describeMongo('group namespace (MongoDB)', () => {
  let client: MongoClient;
  contract(async () => {
    client = new MongoClient(
      process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017',
      { serverSelectionTimeoutMS: 2_000 },
    );
    await client.connect();
    const db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    return {
      repo: new MongodbAdapter(db),
      cleanup: async (ids) => {
        await db
          .collection<any>('pxm_groups')
          .deleteMany({ _id: { $in: ids } });
        await client.close();
      },
    };
  });
});

describePostgres('group namespace (PostgreSQL)', () => {
  contract(async () => {
    const pool = new Pool({
      connectionString:
        process.env.POSTGRES_URL ||
        process.env.DATABASE_URL ||
        'postgres://postgres:postgres@127.0.0.1:5432/pxm',
    });
    return {
      repo: new PostgresAdapter(pool),
      cleanup: async (ids) => {
        await pool.query('DELETE FROM pxm_groups WHERE id = ANY($1)', [ids]);
        await pool.end();
      },
    };
  });
});
