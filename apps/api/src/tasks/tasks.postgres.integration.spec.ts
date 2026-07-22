import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../db/adapters/postgres.adapter';

const describePostgres =
  process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

describePostgres('Postgres approval task transaction', () => {
  let pool: Pool;
  let adapter: PostgresAdapter;
  let definitionId: string;
  let instanceId: string;
  let taskId: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    adapter = new PostgresAdapter(pool);
  });

  beforeEach(async () => {
    definitionId = randomUUID();
    instanceId = randomUUID();
    taskId = randomUUID();
    await pool.query(
      `INSERT INTO v2_process_definitions (id, definition_key, version, name, status)
       VALUES ($1::uuid, $2, 1, 'Task integration test', 'ACTIVE')`,
      [definitionId, `task-integration-${definitionId}`],
    );
    await pool.query(
      `INSERT INTO v2_process_instances (id, process_definition_id, state, context)
       VALUES ($1::uuid, $2::uuid, 'WAITING', '{}'::jsonb)`,
      [instanceId, definitionId],
    );
    await pool.query(
      `INSERT INTO v2_tasks (id, instance_id, node_id, assignee, status, payload)
       VALUES ($1::uuid, $2::uuid, 'approval', 'alice', 'OPEN', '{}'::jsonb)`,
      [taskId, instanceId],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM v2_process_instances WHERE id = $1::uuid`, [
      instanceId,
    ]);
    await pool.query(`DELETE FROM v2_process_definitions WHERE id = $1::uuid`, [
      definitionId,
    ]);
  });

  afterAll(async () => pool.end());

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
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM v2_engine_jobs WHERE instance_id = $1::uuid AND type = 'RESUME'`,
          [instanceId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM v2_event_outbox WHERE instance_id = $1::uuid AND event_type = 'TASK_APPROVED'`,
          [instanceId],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT status, payload FROM v2_tasks WHERE id = $1::uuid`,
          [taskId],
        )
      ).rows[0],
    ).toEqual(
      expect.objectContaining({
        status: 'APPROVED',
        payload: expect.objectContaining({
          completion: expect.objectContaining({
            actor_id: 'alice',
            idempotency_key: 'approval-request-1',
          }),
        }),
      }),
    );
    expect(
      (
        await pool.query(
          `SELECT state FROM v2_process_instances WHERE id = $1::uuid`,
          [instanceId],
        )
      ).rows[0].state,
    ).toBe('RUNNING');
  });
});
