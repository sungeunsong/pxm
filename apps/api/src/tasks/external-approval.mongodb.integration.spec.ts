import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo external email approval transaction', () => {
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
      assignee: 'outside@example.com',
      status: 'OPEN',
      payload: {
        approver_channel: 'external_email',
        external_require_otp: true,
        external_expires_in_hours: 24,
      },
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

  it('claims delivery, stores a token hash, and consumes it with task completion', async () => {
    const owner = 'test-mailer';
    const claims = await adapter.claimExternalApprovalTasks(
      owner,
      new Date(),
      new Date(Date.now() + 60_000),
      10,
    );
    expect(claims).toEqual([
      expect.objectContaining({
        task_id: taskId,
        email: 'outside@example.com',
        require_otp: true,
      }),
    ]);
    expect(
      await adapter.setExternalApprovalDeliveryToken(taskId, owner, {
        email: 'outside@example.com',
        token_hash: 'a'.repeat(64),
        token_expires_at: new Date(Date.now() + 60_000).toISOString(),
        require_otp: true,
        attempt_count: 1,
      }),
    ).toBe(true);
    await adapter.markExternalApprovalDelivery(taskId, owner, 'SENT', {
      sent_at: new Date().toISOString(),
    });

    const openPage = await adapter.listTaskHistory({
      statuses: ['OPEN'],
      instance_id: instanceId,
      approver_channel: 'external_email',
      limit: 10,
    });
    expect(openPage.items).toEqual([
      expect.objectContaining({
        task_id: taskId,
        status: 'OPEN',
        approver_channel: 'external_email',
      }),
    ]);

    const result = await adapter.completeTask({
      task_id: taskId,
      action: 'approve',
      status: 'APPROVED',
      actor_id: 'external-email:test',
      idempotency_key: 'external-request',
      external_approval: {
        token_hash: 'a'.repeat(64),
        email: 'outside@example.com',
        auth_method: 'email_otp',
      },
    });
    expect(result.outcome).toBe('completed');
    expect(await adapter.getTaskHistoryItem(taskId)).toEqual(
      expect.objectContaining({
        task_id: taskId,
        status: 'APPROVED',
        action: 'approve',
        authentication_method: 'email_otp',
        completed_at: expect.any(String),
      }),
    );
    expect(await db.collection('v2_tasks').findOne({ _id: taskId })).toEqual(
      expect.objectContaining({
        status: 'APPROVED',
        payload: expect.objectContaining({
          external_approval: expect.objectContaining({
            consumed_at: expect.any(String),
            auth_method: 'email_otp',
          }),
        }),
      }),
    );
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
  });
});
