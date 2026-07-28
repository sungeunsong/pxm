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
  let tokenId: string;
  let requestId: string;
  let stepId: string;
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
    tokenId = randomUUID();
    requestId = randomUUID();
    stepId = randomUUID();
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
    await db.collection('v2_tokens').insertOne({
      _id: tokenId,
      instance_id: instanceId,
      node_id: 'approval',
      status: 'WAITING',
      parent_token_id: null,
      scope_key: null,
      created_at: now,
      updated_at: now,
    });
    await db.collection('v2_approval_requests').insertOne({
      _id: requestId,
      instance_id: instanceId,
      token_id: tokenId,
      node_id: 'approval',
      status: 'IN_PROGRESS',
      current_step_order: 1,
      version: 0,
      result: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    });
    await db.collection('v2_approval_steps').insertOne({
      _id: stepId,
      request_id: requestId,
      step_order: 1,
      mode: 'ALL',
      required_count: 1,
      status: 'OPEN',
      version: 0,
      completed_at: null,
      created_at: now,
      updated_at: now,
    });
    await db.collection('v2_tasks').insertOne({
      _id: taskId,
      instance_id: instanceId,
      token_id: tokenId,
      approval_request_id: requestId,
      approval_step_id: stepId,
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
      db.collection('v2_tasks').deleteMany({ approval_request_id: requestId }),
      db.collection('v2_approval_steps').deleteMany({ request_id: requestId }),
      db.collection('v2_approval_requests').deleteMany({ _id: requestId }),
      db.collection('v2_tokens').deleteMany({ _id: tokenId }),
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
      await db.collection('v2_event_outbox').countDocuments({
        instance_id: instanceId,
        event_type: 'APPROVAL_REQUEST_COMPLETED',
      }),
    ).toBe(1);
    expect(
      await db.collection('v2_event_outbox').countDocuments({
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
    expect(
      await db.collection('v2_approval_requests').findOne({ _id: requestId }),
    ).toEqual(
      expect.objectContaining({
        status: 'APPROVED',
        version: 1,
        result: expect.objectContaining({ task_id: taskId }),
      }),
    );
    expect(
      await db.collection('v2_approval_steps').findOne({ _id: stepId }),
    ).toEqual(expect.objectContaining({ status: 'APPROVED', version: 1 }));
  });

  it('rejects the aggregate and still resumes the Engine exactly once', async () => {
    const result = await adapter.completeTask({
      task_id: taskId,
      action: 'reject',
      status: 'REJECTED',
      actor_id: 'alice',
      comment: 'needs revision',
      idempotency_key: 'approval-rejection-1',
    });

    expect(result.outcome).toBe('completed');
    expect(
      await db.collection('v2_approval_requests').findOne({ _id: requestId }),
    ).toEqual(
      expect.objectContaining({
        status: 'REJECTED',
        version: 1,
        result: expect.objectContaining({
          action: 'reject',
          comment: 'needs revision',
        }),
      }),
    );
    expect(
      await db.collection('v2_approval_steps').findOne({ _id: stepId }),
    ).toEqual(expect.objectContaining({ status: 'REJECTED', version: 1 }));
    expect(
      await db
        .collection('v2_engine_jobs')
        .countDocuments({ instance_id: instanceId, job_type: 'RESUME' }),
    ).toBe(1);
  });

  it('opens sequential tasks one at a time and resumes only after the final approval', async () => {
    const now = new Date().toISOString();
    const step2Id = randomUUID();
    const step3Id = randomUUID();
    await db
      .collection('v2_approval_requests')
      .updateOne({ _id: requestId }, { $set: { total_steps: 3 } });
    await db.collection('v2_approval_steps').insertMany([
      {
        _id: step2Id,
        request_id: requestId,
        step_order: 2,
        mode: 'ALL',
        required_count: 1,
        assignee: 'bob',
        approver_channel: 'pxm_user',
        task_payload: { step_order: 2 },
        status: 'LOCKED',
        version: 0,
        completed_at: null,
        created_at: now,
        updated_at: now,
      },
      {
        _id: step3Id,
        request_id: requestId,
        step_order: 3,
        mode: 'ALL',
        required_count: 1,
        assignee: 'carol',
        approver_channel: 'pxm_user',
        task_payload: { step_order: 3 },
        status: 'LOCKED',
        version: 0,
        completed_at: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    await adapter.completeTask({
      task_id: taskId,
      action: 'approve',
      status: 'APPROVED',
      actor_id: 'alice',
      idempotency_key: 'sequential-step-1',
    });
    let request = await db
      .collection('v2_approval_requests')
      .findOne({ _id: requestId });
    let instance = await db
      .collection('v2_process_instances')
      .findOne({ _id: instanceId });
    let openTasks = await db
      .collection('v2_tasks')
      .find({ approval_request_id: requestId, status: 'OPEN' })
      .toArray();
    expect(request).toEqual(
      expect.objectContaining({ status: 'IN_PROGRESS', current_step_order: 2 }),
    );
    expect(instance).toEqual(expect.objectContaining({ state: 'WAITING' }));
    expect(openTasks).toHaveLength(1);
    expect(openTasks[0]).toEqual(
      expect.objectContaining({ approval_step_id: step2Id, assignee: 'bob' }),
    );
    expect(
      await db
        .collection('v2_engine_jobs')
        .countDocuments({ instance_id: instanceId, job_type: 'RESUME' }),
    ).toBe(0);

    await adapter.completeTask({
      task_id: openTasks[0]._id,
      action: 'approve',
      status: 'APPROVED',
      actor_id: 'bob',
      idempotency_key: 'sequential-step-2',
    });
    openTasks = await db
      .collection('v2_tasks')
      .find({ approval_request_id: requestId, status: 'OPEN' })
      .toArray();
    expect(openTasks).toHaveLength(1);
    expect(openTasks[0]).toEqual(
      expect.objectContaining({ approval_step_id: step3Id, assignee: 'carol' }),
    );
    expect(
      await db
        .collection('v2_engine_jobs')
        .countDocuments({ instance_id: instanceId, job_type: 'RESUME' }),
    ).toBe(0);

    await adapter.completeTask({
      task_id: openTasks[0]._id,
      action: 'approve',
      status: 'APPROVED',
      actor_id: 'carol',
      idempotency_key: 'sequential-step-3',
    });
    request = await db
      .collection('v2_approval_requests')
      .findOne({ _id: requestId });
    instance = await db
      .collection('v2_process_instances')
      .findOne({ _id: instanceId });
    expect(request).toEqual(
      expect.objectContaining({ status: 'APPROVED', current_step_order: 3 }),
    );
    expect(instance).toEqual(expect.objectContaining({ state: 'RUNNING' }));
    expect(
      await db
        .collection('v2_engine_jobs')
        .countDocuments({ instance_id: instanceId, job_type: 'RESUME' }),
    ).toBe(1);
  });

  it('rejects the whole request without opening any later step', async () => {
    const now = new Date().toISOString();
    const step2Id = randomUUID();
    const step3Id = randomUUID();
    await db
      .collection('v2_approval_requests')
      .updateOne({ _id: requestId }, { $set: { total_steps: 3 } });
    await db.collection('v2_approval_steps').insertMany([
      {
        _id: step2Id,
        request_id: requestId,
        step_order: 2,
        mode: 'ALL',
        required_count: 1,
        assignee: 'bob',
        approver_channel: 'pxm_user',
        task_payload: { step_order: 2 },
        status: 'LOCKED',
        version: 0,
        completed_at: null,
        created_at: now,
        updated_at: now,
      },
      {
        _id: step3Id,
        request_id: requestId,
        step_order: 3,
        mode: 'ALL',
        required_count: 1,
        assignee: 'carol',
        approver_channel: 'pxm_user',
        task_payload: { step_order: 3 },
        status: 'LOCKED',
        version: 0,
        completed_at: null,
        created_at: now,
        updated_at: now,
      },
    ]);
    await adapter.completeTask({
      task_id: taskId,
      action: 'approve',
      status: 'APPROVED',
      actor_id: 'alice',
      idempotency_key: 'reject-flow-step-1',
    });
    const step2Task = await db.collection('v2_tasks').findOne({
      approval_request_id: requestId,
      approval_step_id: step2Id,
    });
    await adapter.completeTask({
      task_id: step2Task!._id,
      action: 'reject',
      status: 'REJECTED',
      actor_id: 'bob',
      idempotency_key: 'reject-flow-step-2',
    });

    expect(
      await db.collection('v2_approval_requests').findOne({ _id: requestId }),
    ).toEqual(
      expect.objectContaining({ status: 'REJECTED', current_step_order: 2 }),
    );
    expect(
      await db.collection('v2_approval_steps').findOne({ _id: step3Id }),
    ).toEqual(expect.objectContaining({ status: 'LOCKED' }));
    expect(
      await db
        .collection('v2_tasks')
        .countDocuments({ approval_step_id: step3Id }),
    ).toBe(0);
    expect(
      await db.collection('v2_engine_jobs').countDocuments({
        instance_id: instanceId,
        job_type: 'RESUME',
      }),
    ).toBe(1);
  });
});
