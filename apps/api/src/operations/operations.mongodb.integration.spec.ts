import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Operations MongoDB recovery integration', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    db = client.db(`pxm_operations_test_${process.pid}_${Date.now()}`);
    adapter = new MongodbAdapter(db);
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
  });

  it('detects backlog and permits each conditional recovery only once', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await db.collection('v2_process_instances').insertOne({
      _id: 'instance-1', state: 'WAITING', updated_at: old,
      lock_owner: 'dead-worker', lock_until: old, heartbeat_at: old,
    });
    await db.collection('v2_engine_jobs').insertOne({
      _id: 41, instance_id: 'instance-1', token_id: null, job_type: 'ADVANCE_TOKEN',
      status: 'FAILED', attempt: 2, run_at: old, updated_at: old,
    });
    await db.collection('v2_tasks').insertOne({
      _id: 'task-1', instance_id: 'instance-1', status: 'OPEN', assignee: 'approver-1',
    });

    const snapshot = await adapter.getOperationsSnapshot(60);
    expect(snapshot.jobs).toEqual([expect.objectContaining({ id: '41', status: 'FAILED' })]);
    expect(snapshot.waiting_instances).toEqual([
      expect.objectContaining({
        id: 'instance-1',
        classification: 'EXPECTED',
        waiting_reason: 'OPEN_TASK',
        open_task_count: 1,
      }),
    ]);
    expect(snapshot.expired_locks).toHaveLength(1);

    await expect(adapter.retryFailedJob('41')).resolves.toBe(true);
    await expect(adapter.retryFailedJob('41')).resolves.toBe(false);
    await expect(adapter.reclaimExpiredInstanceLock('instance-1')).resolves.toBe(true);
    await expect(adapter.reclaimExpiredInstanceLock('instance-1')).resolves.toBe(false);

    expect(await db.collection('v2_engine_jobs').findOne({ _id: 41 }))
      .toEqual(expect.objectContaining({ status: 'QUEUED', attempt: 3, lock_owner: null }));
  });
});
