import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';
import { NotificationDispatcher } from './notification.dispatcher';
import { NotificationService } from './notification.service';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Approval notification MongoDB integration', () => {
  let client: MongoClient;
  let db: Db;
  let service: NotificationService;
  let dispatcher: NotificationDispatcher;
  let adapter: MongodbAdapter;
  const sent: Array<{ to: string; title: string }> = [];
  let failNext = false;
  const channel = {
    kind: 'email' as const,
    isConfigured: () => true,
    send: jest.fn(async (message: { to: string; title: string }) => {
      if (failNext) { failNext = false; throw new Error('smtp 503'); }
      sent.push(message);
    }),
  };
  const outbox = { appendEvent: jest.fn(async () => undefined) };

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    db = client.db(`pxm_notification_test_${process.pid}_${Date.now()}`);
    adapter = new MongodbAdapter(db);
    service = new NotificationService(
      db, adapter, adapter, adapter, outbox as any,
      { append: jest.fn(async () => undefined) } as any,
    );
    await service.onModuleInit();
    dispatcher = new NotificationDispatcher(service, channel);
    await db.collection('pxm_users').insertMany([
      { _id: 'approver-a', display_name: 'A', email: 'a@example.test', status: 'active', role: 'user', group_ids: ['group-1'], memberships: [{ group_id: 'group-1', role: 'user' }] },
      { _id: 'approver-b', display_name: 'B', email: 'b@example.test', status: 'active', role: 'user', group_ids: ['group-1'], memberships: [{ group_id: 'group-1', role: 'user' }] },
      { _id: 'manager-a', display_name: 'Manager', email: 'manager@example.test', status: 'active', role: 'group_manager', group_ids: ['group-1'], memberships: [{ group_id: 'group-1', role: 'group_manager' }] },
    ]);
    await db.collection('v2_process_instances').insertOne({
      _id: 'instance-1', process_definition_id: 'definition-1', state: 'WAITING', group_id: 'group-1', context: {},
    });
  });
  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
  });

  async function task(id: string, assignee: string, createdAt: string, status = 'OPEN') {
    await db.collection('v2_tasks').insertOne({
      _id: id, instance_id: 'instance-1', node_id: 'approval', assignee, status,
      payload: {
        approver_channel: 'pxm_user', step_order: 1, step_label: '1차 승인',
        content: { title: `결재 ${id}`, requester: 'requester', source_url: 'https://source.example/item' },
      },
      created_at: createdAt, updated_at: createdAt,
    });
  }

  it('sends each OPEN task once, suppresses ANY cancellation, and discovers a later sequential step', async () => {
    const firstAt = new Date(Date.now() + 10).toISOString();
    await task('task-a', 'approver-a', firstAt);
    await task('task-canceled', 'approver-b', new Date(Date.now() + 11).toISOString());
    await service.discover();
    await db.collection('v2_tasks').updateOne({ _id: 'task-canceled' }, { $set: { status: 'CANCELED' } });
    await dispatcher.tick();
    await dispatcher.tick();

    expect(sent.map(({ to, title }) => ({ to, title }))).toEqual([
      { to: 'a@example.test', title: '결재 task-a' },
    ]);
    expect(await db.collection('approval_notification_deliveries').findOne({ task_id: 'task-canceled' }))
      .toEqual(expect.objectContaining({ status: 'CANCELED' }));

    await task('task-next-step', 'approver-b', new Date(Date.now() + 30).toISOString());
    await dispatcher.tick();
    expect(sent.map(({ to, title }) => ({ to, title }))).toEqual([
      { to: 'a@example.test', title: '결재 task-a' },
      { to: 'b@example.test', title: '결재 task-next-step' },
    ]);
    expect(await db.collection('approval_notification_deliveries').countDocuments({ task_id: 'task-a' })).toBe(1);
  });

  it('records a temporary failure and succeeds on retry without a duplicate delivery row', async () => {
    await task('task-retry', 'approver-a', new Date(Date.now() + 50).toISOString());
    failNext = true;
    await dispatcher.tick();
    const failed = await db.collection('approval_notification_deliveries').findOne({ task_id: 'task-retry' });
    expect(failed).toEqual(expect.objectContaining({ status: 'FAILED', attempt_count: 1, last_error: 'smtp 503' }));
    await db.collection('approval_notification_deliveries').updateOne(
      { _id: failed!._id }, { $set: { next_attempt_at: new Date().toISOString() } },
    );
    await dispatcher.tick();
    expect(await db.collection('approval_notification_deliveries').findOne({ task_id: 'task-retry' }))
      .toEqual(expect.objectContaining({ status: 'SENT', attempt_count: 2 }));
    expect(await db.collection('approval_notification_attempts').countDocuments({ delivery_id: failed!._id })).toBe(2);
  });

  it('does not enqueue the separate PXM notification email for a hybrid task', async () => {
    const createdAt = new Date(Date.now() + 70).toISOString();
    await db.collection('v2_tasks').insertOne({
      _id: 'task-hybrid',
      instance_id: 'instance-1',
      node_id: 'approval',
      assignee: 'approver-a',
      status: 'OPEN',
      payload: {
        approver_channel: 'pxm_user',
        approval_channels: ['pxm_user', 'external_email'],
        external_email: 'a@example.test',
        content: { title: '하이브리드 결재' },
      },
      created_at: createdAt,
      updated_at: createdAt,
    });

    await dispatcher.tick();
    expect(
      await db
        .collection('approval_notification_deliveries')
        .countDocuments({ task_id: 'task-hybrid' }),
    ).toBe(0);
  });

  it('records and sends one reminder and one manager escalation after the configured deadlines', async () => {
    const createdAt = new Date(Date.now() - 10_000).toISOString();
    await db.collection('v2_tasks').insertOne({
      _id: 'task-deadline', instance_id: 'instance-1', node_id: 'approval-deadline',
      assignee: 'approver-a', status: 'OPEN',
      payload: {
        approver_channel: 'pxm_user', approval_channels: ['pxm_user'],
        approval_deadline: { deadline_seconds: 1, escalation_grace_seconds: 1 },
        content: { title: '기한 결재', requester: 'requester' },
      },
      created_at: createdAt, updated_at: createdAt,
    });

    await dispatcher.tick();
    await dispatcher.tick();

    const deliveries = await db.collection('approval_notification_deliveries')
      .find({ task_id: 'task-deadline' }).sort({ kind: 1 }).toArray();
    expect(deliveries.map(({ kind, recipient_id, status }) => ({ kind, recipient_id, status }))).toEqual([
      { kind: 'escalation', recipient_id: 'manager-a', status: 'SENT' },
      { kind: 'reminder', recipient_id: 'approver-a', status: 'SENT' },
    ]);
    expect(outbox.appendEvent).toHaveBeenCalledWith(
      'instance-1', 'APPROVAL_DEADLINE_REMINDER',
      expect.objectContaining({ task_id: 'task-deadline', node_id: 'approval-deadline' }),
    );
    expect(outbox.appendEvent).toHaveBeenCalledWith(
      'instance-1', 'APPROVAL_DEADLINE_ESCALATED',
      expect.objectContaining({ notified_manager_ids: ['manager-a'] }),
    );
  });

  it('defers an already queued deadline notification while the instance is paused', async () => {
    const createdAt = new Date(Date.now() - 10_000).toISOString();
    await db.collection('v2_tasks').insertOne({
      _id: 'task-paused', instance_id: 'instance-1', node_id: 'approval-paused',
      assignee: 'approver-a', status: 'OPEN',
      payload: {
        approval_deadline: { deadline_seconds: 1, escalation_grace_seconds: 60 },
        content: { title: '일시정지 결재' },
      },
      created_at: createdAt, updated_at: createdAt,
    });
    await service.discoverDeadlines();
    await db.collection('v2_process_instances').updateOne({ _id: 'instance-1' }, { $set: { is_paused: true } });
    await dispatcher.tick();
    expect(await db.collection('approval_notification_deliveries').findOne({ task_id: 'task-paused', kind: 'reminder' }))
      .toEqual(expect.objectContaining({ status: 'PENDING', attempt_count: 0, last_error: 'workflow instance is paused' }));

    await db.collection('v2_process_instances').updateOne({ _id: 'instance-1' }, { $set: { is_paused: false } });
    await db.collection('approval_notification_deliveries').updateOne(
      { task_id: 'task-paused', kind: 'reminder' }, { $set: { next_attempt_at: new Date().toISOString() } },
    );
    await dispatcher.tick();
    expect(await db.collection('approval_notification_deliveries').findOne({ task_id: 'task-paused', kind: 'reminder' }))
      .toEqual(expect.objectContaining({ status: 'SENT' }));
  });
});
