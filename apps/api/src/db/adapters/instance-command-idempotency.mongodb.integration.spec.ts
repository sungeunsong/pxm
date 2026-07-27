import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { IdempotentInstanceCommand } from '../ports/db.ports';
import { MongodbAdapter } from './mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo instance command idempotency', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  const definitionId = randomUUID();
  const createdInstanceIds: string[] = [];
  const commandKeys: string[] = [];

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);
  });

  afterAll(async () => {
    await Promise.all([
      db.collection('v2_instance_command_idempotency').deleteMany({ _id: { $in: commandKeys } }),
      db.collection('v2_process_instances').deleteMany({ _id: { $in: createdInstanceIds } }),
      db.collection('v2_engine_jobs').deleteMany({ instance_id: { $in: createdInstanceIds } }),
      db.collection('v2_tokens').deleteMany({ instance_id: { $in: createdInstanceIds } }),
      db.collection('v2_event_outbox').deleteMany({ instance_id: { $in: createdInstanceIds } }),
    ]);
    await client.close();
  });

  it('creates one retry execution for concurrent requests and detects a changed request', async () => {
    const keyHash = `retry-${randomUUID()}`;
    commandKeys.push(keyHash);
    const buildCommand = (requestHash: string): IdempotentInstanceCommand => {
      const instanceId = randomUUID();
      const tokenId = randomUUID();
      createdInstanceIds.push(instanceId);
      return {
        key_hash: keyHash,
        request_hash: requestHash,
        expires_at: new Date(Date.now() + 60_000),
        result: { instance_id: instanceId, retry_mode: 'full_instance' },
        create_instances: [{ id: instanceId, definition_id: definitionId, status: 'CREATED', context: {} }],
        tokens: [{ id: tokenId, instance_id: instanceId, node_id: 'start', status: 'ACTIVE' }],
        jobs: [{ instance_id: instanceId, type: 'START', run_at: new Date(), payload: { reason: 'instance_retry' } }],
      };
    };

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => adapter.executeIdempotentCommand(buildCommand('same-retry'))));
    expect(outcomes.filter((item) => item.outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((item) => item.outcome === 'replayed')).toHaveLength(7);
    const instanceId = outcomes[0].result.instance_id;
    expect(new Set(outcomes.map((item) => item.result.instance_id)).size).toBe(1);
    expect(await db.collection('v2_process_instances').countDocuments({ _id: { $in: createdInstanceIds } })).toBe(1);
    expect(await db.collection('v2_engine_jobs').countDocuments({ instance_id: instanceId, job_type: 'START' })).toBe(1);
    expect(await db.collection('v2_tokens').countDocuments({ instance_id: instanceId })).toBe(1);
    await expect(adapter.executeIdempotentCommand(buildCommand('changed-retry'))).resolves.toEqual({
      outcome: 'conflict',
      result: expect.objectContaining({ instance_id: instanceId }),
    });
  });

  it('terminates an instance and emits its event once for concurrent requests', async () => {
    const keyHash = `terminate-${randomUUID()}`;
    commandKeys.push(keyHash);
    const instanceId = randomUUID();
    createdInstanceIds.push(instanceId);
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
    await db.collection('v2_engine_jobs').insertOne({
      _id: Date.now(),
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
    const command: IdempotentInstanceCommand = {
      key_hash: keyHash,
      request_hash: 'same-terminate',
      expires_at: new Date(Date.now() + 60_000),
      result: { success: true, instance_id: instanceId, terminated_instances: [instanceId] },
      update_instances: [{ id: instanceId, status: 'TERMINATED', complete_jobs: true }],
      events: [{ instance_id: instanceId, event_type: 'INSTANCE_TERMINATED', payload: { reason: 'operator_terminated' } }],
    };

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => adapter.executeIdempotentCommand(command)));
    expect(outcomes.filter((item) => item.outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((item) => item.outcome === 'replayed')).toHaveLength(7);
    expect(await db.collection('v2_process_instances').findOne({ _id: instanceId })).toEqual(expect.objectContaining({ state: 'TERMINATED' }));
    expect(await db.collection('v2_engine_jobs').countDocuments({ instance_id: instanceId, status: 'COMPLETED' })).toBe(1);
    expect(await db.collection('v2_event_outbox').countDocuments({ instance_id: instanceId, event_type: 'INSTANCE_TERMINATED' })).toBe(1);
  });

  it('stores pause control separately from the runtime state', async () => {
    const keyHash = `pause-${randomUUID()}`;
    commandKeys.push(keyHash);
    const instanceId = randomUUID();
    createdInstanceIds.push(instanceId);
    const now = new Date().toISOString();
    await db.collection('v2_process_instances').insertOne({
      _id: instanceId,
      process_definition_id: definitionId,
      state: 'RUNNING',
      status: 'RUNNING',
      is_paused: false,
      context: {},
      created_at: now,
      updated_at: now,
    });

    const command: IdempotentInstanceCommand = {
      key_hash: keyHash,
      request_hash: 'same-pause',
      expires_at: new Date(Date.now() + 60_000),
      result: { success: true, instance_id: instanceId, paused: true, runtime_state: 'RUNNING', changed: true },
      update_instances: [{ id: instanceId, paused: true, paused_by: 'operator-1', pause_origin_instance_id: instanceId }],
      events: [{ instance_id: instanceId, event_type: 'INSTANCE_PAUSED', payload: { reason: 'operator_paused' } }],
    };

    const outcomes = await Promise.all(Array.from({ length: 4 }, () => adapter.executeIdempotentCommand(command)));
    expect(outcomes.filter((item) => item.outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((item) => item.outcome === 'replayed')).toHaveLength(3);
    expect(await db.collection('v2_process_instances').findOne({ _id: instanceId })).toEqual(
      expect.objectContaining({ state: 'RUNNING', is_paused: true, paused_by: 'operator-1', pause_origin_instance_id: instanceId }),
    );
    expect(await db.collection('v2_event_outbox').countDocuments({ instance_id: instanceId, event_type: 'INSTANCE_PAUSED' })).toBe(1);
  });
});
