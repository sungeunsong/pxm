import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo approval task transaction', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  let instanceId: string;
  let taskId: string;

  beforeAll(async () => {
    client = new MongoClient(
      process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017',
    );
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);
  });

  beforeEach(async () => {
    instanceId = randomUUID();
    taskId = randomUUID();
    const now = new Date().toISOString();
    await db.collection('v2_process_instances').insertOne({
      _id: instanceId,
      process_definition_id: randomUUID(),
      state: 'WAITING',
      status: 'WAITING',
      context: {},
      created_at: now,
      updated_at: now,
    });
    await db.collection('v2_tasks').insertOne({
      _id: taskId,
      instance_id: instanceId,
      token_id: null,
      node_id: 'approval',
      assignee: 'alice',
      status: 'OPEN',
      payload: {},
      created_at: now,
      updated_at: now,
    });
  });

  afterEach(async () => {
    await Promise.all([
      db.collection('v2_tasks').deleteMany({ _id: taskId }),
      db.collection('v2_engine_jobs').deleteMany({ instance_id: instanceId }),
      db.collection('v2_event_outbox').deleteMany({ instance_id: instanceId }),
      db.collection('v2_process_instances').deleteMany({ _id: instanceId }),
    ]);
  });

  afterAll(async () => client.close());

  it('creates one RESUME job when the same approval request is submitted concurrently', async () => {
    const command = {
      task_id: taskId,
      action: 'approve' as const,
      status: 'APPROVED' as const,
      actor_id: 'alice',
      idempotency_key: 'approval-request-1',
    };

    expect(await adapter.listTasks('alice')).toEqual([
      expect.objectContaining({
        id: taskId,
        instance_id: instanceId,
        instance_status: 'WAITING',
      }),
    ]);

    const outcomes = await Promise.all([
      adapter.completeTask(command),
      adapter.completeTask(command),
    ]);

    expect(outcomes.map((item) => item.outcome).sort()).toEqual([
      'completed',
      'idempotent',
    ]);
    expect(
      await db
        .collection('v2_engine_jobs')
        .countDocuments({ instance_id: instanceId, job_type: 'RESUME' }),
    ).toBe(1);
    expect(
      await db
        .collection('v2_event_outbox')
        .countDocuments({
          instance_id: instanceId,
          event_type: 'TASK_APPROVED',
        }),
    ).toBe(1);
    expect(await db.collection('v2_tasks').findOne({ _id: taskId })).toEqual(
      expect.objectContaining({
        status: 'APPROVED',
        completion: expect.objectContaining({
          actor_id: 'alice',
          idempotency_key: 'approval-request-1',
        }),
      }),
    );
    expect(
      await db.collection('v2_process_instances').findOne({ _id: instanceId }),
    ).toEqual(expect.objectContaining({ state: 'RUNNING' }));
  });
});
