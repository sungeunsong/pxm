import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import type {
  WorkflowHistoryActor,
  WorkflowInstanceState,
} from '../ports/db.ports';
import { MongodbAdapter } from './mongodb.adapter';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo instance stats', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  const prefix = `pxm34-${randomUUID()}`;

  beforeAll(async () => {
    client = new MongoClient(
      process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017',
    );
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);

    const now = new Date().toISOString();
    const states: WorkflowInstanceState[] = [
      ...Array.from({ length: 30 }, () => 'COMPLETED' as const),
      ...Array.from({ length: 20 }, () => 'RUNNING' as const),
      ...Array.from({ length: 5 }, () => 'WAITING' as const),
      ...Array.from({ length: 4 }, () => 'FAILED' as const),
      'RUNNING',
      'TERMINATED',
    ];
    await db.collection('v2_process_instances').insertMany([
      ...states.map((state, index) => ({
        _id: `${prefix}-${index}`,
        process_definition_id: `${prefix}-definition`,
        state,
        is_paused: index === 59,
        context: { runtime: { access: { requester_id: 'requester-a' } } },
        created_at: now,
        updated_at: now,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        _id: `${prefix}-other-${index}`,
        process_definition_id: `${prefix}-definition`,
        state: 'COMPLETED',
        context: { runtime: { access: { requester_id: 'requester-b' } } },
        created_at: now,
        updated_at: now,
      })),
    ]);
  });

  afterAll(async () => {
    await db
      .collection('v2_process_instances')
      .deleteMany({ _id: { $regex: `^${prefix}` } });
    await client.close();
  });

  it('aggregates all authorized rows even though the recent list is limited to 50', async () => {
    const requester = actor({ actor_id: 'requester-a', roles: ['user'] });
    expect(await adapter.listInstances(requester)).toHaveLength(50);
    expect(await adapter.getInstanceStats(requester)).toEqual({
      total: 61,
      by_state: {
        CREATED: 0,
        RUNNING: 20,
        WAITING: 5,
        PAUSED: 1,
        COMPLETED: 30,
        FAILED: 4,
        TERMINATED: 1,
        UNKNOWN: 0,
      },
      scope: 'authorized',
    });
  });

  it('uses the same requester authorization scope as instance history', async () => {
    const stats = await adapter.getInstanceStats(
      actor({ actor_id: 'requester-b', roles: ['user'] }),
    );
    expect(stats.total).toBe(3);
    expect(stats.scope).toBe('authorized');
  });
});

function actor(overrides: Partial<WorkflowHistoryActor>): WorkflowHistoryActor {
  return {
    actor_type: 'user',
    actor_id: null,
    roles: [],
    scopes: [],
    workspace_ids: [],
    group_ids: [],
    owned_workflow_ids: [],
    allowed_workflow_ids: [],
    allowed_instance_ids: [],
    api_key_id: null,
    business_actor: null,
    ...overrides,
  };
}
