import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from './mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo workflow instance mutation transaction', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  const definitionId = randomUUID();
  const instanceIds: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);
  });

  afterAll(async () => {
    await Promise.all([
      db.collection('v2_process_instances').deleteMany({ _id: { $in: instanceIds } }),
      db.collection('v2_engine_jobs').deleteMany({ instance_id: { $in: instanceIds } }),
      db.collection('v2_tokens').deleteMany({ instance_id: { $in: instanceIds } }),
      db.collection('v2_event_outbox').deleteMany({ instance_id: { $in: instanceIds } }),
    ]);
    await client.close();
  });

  it('creates an instance, token, and engine job together', async () => {
    const instanceId = randomUUID();
    const tokenId = randomUUID();
    instanceIds.push(instanceId);

    await adapter.executeInstanceMutation({
      create_instances: [{ id: instanceId, definition_id: definitionId, status: 'CREATED', context: {} }],
      tokens: [{ id: tokenId, instance_id: instanceId, node_id: 'start', status: 'ACTIVE' }],
      jobs: [{ instance_id: instanceId, type: 'START', run_at: new Date(), payload: { node_id: 'start' } }],
    });

    expect(await db.collection('v2_process_instances').countDocuments({ _id: instanceId })).toBe(1);
    expect(await db.collection('v2_tokens').countDocuments({ _id: tokenId, instance_id: instanceId })).toBe(1);
    expect(await db.collection('v2_engine_jobs').countDocuments({ instance_id: instanceId, job_type: 'START' })).toBe(1);
  });

  it('rolls back the instance when a later token insert fails', async () => {
    const existingInstanceId = randomUUID();
    const attemptedInstanceId = randomUUID();
    const duplicateTokenId = randomUUID();
    instanceIds.push(existingInstanceId, attemptedInstanceId);
    const now = new Date().toISOString();
    await db.collection('v2_process_instances').insertOne({
      _id: existingInstanceId,
      process_definition_id: definitionId,
      state: 'RUNNING',
      status: 'RUNNING',
      context: {},
      created_at: now,
      updated_at: now,
    });
    await db.collection('v2_tokens').insertOne({
      _id: duplicateTokenId,
      instance_id: existingInstanceId,
      node_id: 'existing',
      status: 'ACTIVE',
      parent_token_id: null,
      scope_key: null,
      created_at: now,
      updated_at: now,
    });

    await expect(adapter.executeInstanceMutation({
      create_instances: [{ id: attemptedInstanceId, definition_id: definitionId, status: 'CREATED', context: {} }],
      tokens: [{ id: duplicateTokenId, instance_id: attemptedInstanceId, node_id: 'start', status: 'ACTIVE' }],
      jobs: [{ instance_id: attemptedInstanceId, type: 'START', run_at: new Date(), payload: {} }],
    })).rejects.toThrow();

    expect(await db.collection('v2_process_instances').countDocuments({ _id: attemptedInstanceId })).toBe(0);
    expect(await db.collection('v2_engine_jobs').countDocuments({ instance_id: attemptedInstanceId })).toBe(0);
    expect(await db.collection('v2_tokens').countDocuments({ instance_id: attemptedInstanceId })).toBe(0);
    expect(await db.collection('v2_tokens').countDocuments({ _id: duplicateTokenId, instance_id: existingInstanceId })).toBe(1);
  });

  it('updates status, jobs, and event together', async () => {
    const instanceId = randomUUID();
    instanceIds.push(instanceId);
    const now = new Date().toISOString();
    await db.collection('v2_process_instances').insertOne({
      _id: instanceId,
      process_definition_id: definitionId,
      state: 'RUNNING',
      status: 'RUNNING',
      context: {},
      created_at: now,
      updated_at: now,
    });
    const counter = await db.collection<any>('v2_counters').findOneAndUpdate(
      { _id: 'v2_engine_jobs' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    await db.collection('v2_engine_jobs').insertOne({
      _id: Number(counter?.seq || Date.now()),
      instance_id: instanceId,
      token_id: null,
      job_type: 'START',
      run_at: now,
      attempt: 0,
      status: 'RUNNING',
      payload: {},
      created_at: now,
      updated_at: now,
    });

    await adapter.executeInstanceMutation({
      update_instances: [{ id: instanceId, status: 'TERMINATED', complete_jobs: true }],
      events: [{ instance_id: instanceId, event_type: 'INSTANCE_TERMINATED', payload: { reason: 'test' } }],
    });

    expect(await db.collection('v2_process_instances').findOne({ _id: instanceId })).toEqual(expect.objectContaining({ state: 'TERMINATED' }));
    expect(await db.collection('v2_engine_jobs').countDocuments({ instance_id: instanceId, status: 'COMPLETED' })).toBe(1);
    expect(await db.collection('v2_event_outbox').countDocuments({ instance_id: instanceId, event_type: 'INSTANCE_TERMINATED' })).toBe(1);
  });
});
