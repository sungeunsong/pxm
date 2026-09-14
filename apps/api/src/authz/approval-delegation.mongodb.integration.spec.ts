import { MongoClient } from 'mongodb';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo approval delegation', () => {
  const client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
  const databaseName = `pxm_delegation_test_${process.pid}_${Date.now()}`;
  let adapter: MongodbAdapter;

  beforeAll(async () => { await client.connect(); adapter = new MongodbAdapter(client.db(databaseName)); });
  afterAll(async () => { await client.db(databaseName).dropDatabase(); await client.close(); });

  it('stores and revokes a scoped delegation', async () => {
    const created = await adapter.createApprovalDelegation({
      group_id: 'group-1', delegator_id: 'alice', delegate_id: 'bob', scope: 'selected', workflow_ids: ['workflow-1'],
      include_existing: true, starts_at: '2026-09-14T00:00:00.000Z', ends_at: '2026-09-21T00:00:00.000Z', reason: null, created_by: 'alice',
    });
    expect(await adapter.listApprovalDelegations({ delegate_id: 'bob' })).toEqual([expect.objectContaining({ id: created.id, status: 'active', workflow_ids: ['workflow-1'] })]);
    expect(await adapter.revokeApprovalDelegation(created.id, 'alice')).toEqual(expect.objectContaining({ status: 'revoked', revoked_by: 'alice' }));
  });

  it('atomically reassigns only an open task still owned by the expected user', async () => {
    const db = client.db(databaseName);
    await db.collection('v2_tasks').insertOne({ _id: 'task-1', status: 'OPEN', assignee: 'alice', payload: {} });
    expect(await adapter.reassignTask('task-1', 'alice', 'bob', { actor_id: 'manager', reason: 'absence' })).toEqual(expect.objectContaining({ assignee: 'bob' }));
    expect(await adapter.reassignTask('task-1', 'alice', 'charlie', { actor_id: 'manager', reason: 'race' })).toBeNull();
    expect((await db.collection('v2_tasks').findOne({ _id: 'task-1' }))?.payload.reassignment_history).toHaveLength(1);
  });
});
