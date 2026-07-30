import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../db/adapters/postgres.adapter';

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

describePostgres('Approval notification PostgreSQL task discovery', () => {
  let pool: Pool;
  let adapter: PostgresAdapter;
  let definitionId: string;
  let instanceId: string;
  const taskIds: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    adapter = new PostgresAdapter(pool);
  });
  beforeEach(async () => {
    definitionId = randomUUID(); instanceId = randomUUID();
    await pool.query(
      `INSERT INTO v2_process_definitions (id, definition_key, version, name, status)
       VALUES ($1::uuid, $2, 1, 'Notification workflow', 'ACTIVE')`,
      [definitionId, `notification-${definitionId}`],
    );
    await pool.query(
      `INSERT INTO v2_process_instances (id, process_definition_id, state, context)
       VALUES ($1::uuid, $2::uuid, 'WAITING', '{}'::jsonb)`,
      [instanceId, definitionId],
    );
  });
  afterEach(async () => {
    await pool.query(`DELETE FROM v2_tasks WHERE instance_id = $1::uuid`, [instanceId]);
    await pool.query(`DELETE FROM v2_process_instances WHERE id = $1::uuid`, [instanceId]);
    await pool.query(`DELETE FROM v2_process_definitions WHERE id = $1::uuid`, [definitionId]);
    taskIds.length = 0;
  });
  afterAll(async () => pool.end());

  it('returns only newly OPEN PXM-user tasks in stable cursor order', async () => {
    const cursor = new Date(Date.now() - 1_000).toISOString();
    for (const input of [
      { status: 'OPEN', channel: 'pxm_user', assignee: 'approver-a' },
      { status: 'CANCELED', channel: 'pxm_user', assignee: 'approver-b' },
      { status: 'OPEN', channel: 'external_email', assignee: 'external@example.test' },
    ]) {
      const id = randomUUID(); taskIds.push(id);
      await pool.query(
        `INSERT INTO v2_tasks (id, instance_id, node_id, assignee, status, payload)
         VALUES ($1::uuid, $2::uuid, 'approval', $3, $4,
           jsonb_build_object('approver_channel',$5::text,'step_order',1,'content',
             jsonb_build_object('title','Postgres approval','requester','requester')))`,
        [id, instanceId, input.assignee, input.status, input.channel],
      );
    }
    const candidates = await adapter.fetchApprovalNotificationTasks({ created_at: cursor, id: '' }, 20);
    expect(candidates).toEqual([
      expect.objectContaining({
        id: taskIds[0], assignee: 'approver-a', status: 'OPEN',
        workflow_name: 'Notification workflow', title: 'Postgres approval',
      }),
    ]);
    await expect(adapter.fetchApprovalNotificationTasks({
      created_at: candidates[0].created_at, id: candidates[0].id,
    }, 20)).resolves.toEqual([]);
  });
});
