import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { IdempotentWorkflowStart } from '../ports/db.ports';
import { MongodbAdapter } from './mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo workflow start idempotency', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  const definitionId = randomUUID();
  const keyHash = `test-${randomUUID()}`;
  const instanceIds: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);
  });

  afterAll(async () => {
    await Promise.all([
      db.collection('v2_start_idempotency').deleteMany({ _id: keyHash }),
      db.collection('v2_process_instances').deleteMany({ _id: { $in: instanceIds } }),
      db.collection('v2_engine_jobs').deleteMany({ instance_id: { $in: instanceIds } }),
      db.collection('v2_tokens').deleteMany({ instance_id: { $in: instanceIds } }),
    ]);
    await client.close();
  });

  it('creates exactly one execution for concurrent requests and rejects changed input', async () => {
    const request = (requestHash: string): IdempotentWorkflowStart => {
      const instanceId = randomUUID();
      instanceIds.push(instanceId);
      return {
        key_hash: keyHash,
        request_hash: requestHash,
        expires_at: new Date(Date.now() + 60_000),
        instance: {
          id: instanceId,
          definition_id: definitionId,
          status: 'CREATED',
          context: { runtime: { cursor: 'start' }, data: { formData: { order_id: 1 } } },
        },
        token: { id: randomUUID(), node_id: 'start', status: 'ACTIVE' },
        job: { type: 'START', run_at: new Date(), payload: { node_id: 'start' } },
      };
    };

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => adapter.createIdempotentStart(request('same-request'))));
    expect(outcomes.filter((item) => item.outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((item) => item.outcome === 'replayed')).toHaveLength(7);
    expect(new Set(outcomes.map((item) => item.instance_id)).size).toBe(1);

    const createdInstanceId = outcomes[0].instance_id;
    expect(await db.collection('v2_process_instances').countDocuments({ _id: { $in: instanceIds } })).toBe(1);
    expect(await db.collection('v2_engine_jobs').countDocuments({ instance_id: createdInstanceId, job_type: 'START' })).toBe(1);
    expect(await db.collection('v2_tokens').countDocuments({ instance_id: createdInstanceId })).toBe(1);

    await expect(adapter.createIdempotentStart(request('changed-request'))).resolves.toEqual({
      outcome: 'conflict',
      instance_id: createdInstanceId,
    });
  });
});
