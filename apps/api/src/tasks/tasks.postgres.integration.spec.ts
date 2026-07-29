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
  let tokenId: string;
  let requestId: string;
  let stepId: string;
  let taskId: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    adapter = new PostgresAdapter(pool);
  });

  beforeEach(async () => {
    definitionId = randomUUID();
    instanceId = randomUUID();
    tokenId = randomUUID();
    requestId = randomUUID();
    stepId = randomUUID();
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
      `INSERT INTO v2_tokens (id, instance_id, node_id, status)
       VALUES ($1::uuid, $2::uuid, 'approval', 'WAITING')`,
      [tokenId, instanceId],
    );
    await pool.query(
      `INSERT INTO v2_approval_requests
         (id, instance_id, token_id, node_id, status, current_step_order, version)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'approval', 'IN_PROGRESS', 1, 0)`,
      [requestId, instanceId, tokenId],
    );
    await pool.query(
      `INSERT INTO v2_approval_steps
         (id, request_id, step_order, mode, required_count, status, version)
       VALUES ($1::uuid, $2::uuid, 1, 'ALL', 1, 'OPEN', 0)`,
      [stepId, requestId],
    );
    await pool.query(
      `INSERT INTO v2_tasks
         (id, instance_id, token_id, approval_request_id, approval_step_id,
          node_id, assignee, status, payload)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               'approval', 'alice', 'OPEN', '{}'::jsonb)`,
      [taskId, instanceId, tokenId, requestId, stepId],
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
          `SELECT count(*)::int AS count FROM v2_event_outbox WHERE instance_id = $1::uuid AND event_type = 'APPROVAL_REQUEST_APPROVED'`,
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
    expect(
      (
        await pool.query(
          `SELECT status, version, result FROM v2_approval_requests WHERE id = $1::uuid`,
          [requestId],
        )
      ).rows[0],
    ).toEqual(
      expect.objectContaining({
        status: 'APPROVED',
        version: 1,
        result: expect.objectContaining({ task_id: taskId }),
      }),
    );
    expect(
      (
        await pool.query(
          `SELECT status, version FROM v2_approval_steps WHERE id = $1::uuid`,
          [stepId],
        )
      ).rows[0],
    ).toEqual(expect.objectContaining({ status: 'APPROVED', version: 1 }));
  });

  it('cancels request, step, and open task in the terminate transaction', async () => {
    await adapter.executeInstanceMutation({
      update_instances: [{
        id: instanceId,
        status: 'TERMINATED',
        complete_jobs: true,
        cancel_approvals: true,
      }],
    });

    expect((
      await pool.query(
        `SELECT status, version FROM v2_approval_requests WHERE id = $1::uuid`,
        [requestId],
      )
    ).rows[0]).toEqual(expect.objectContaining({ status: 'CANCELED', version: 1 }));
    expect((
      await pool.query(
        `SELECT status, version FROM v2_approval_steps WHERE id = $1::uuid`,
        [stepId],
      )
    ).rows[0]).toEqual(expect.objectContaining({ status: 'CANCELED', version: 1 }));
    expect((
      await pool.query(`SELECT status FROM v2_tasks WHERE id = $1::uuid`, [taskId])
    ).rows[0]).toEqual(expect.objectContaining({ status: 'CANCELED' }));
    expect((
      await pool.query(
        `SELECT count(*)::int AS count FROM v2_event_outbox
         WHERE instance_id = $1::uuid AND event_type = 'APPROVAL_REQUEST_CANCELED'`,
        [instanceId],
      )
    ).rows[0].count).toBe(1);
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
      (
        await pool.query(
          `SELECT status, version, result FROM v2_approval_requests WHERE id = $1::uuid`,
          [requestId],
        )
      ).rows[0],
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
      (
        await pool.query(
          `SELECT status, version FROM v2_approval_steps WHERE id = $1::uuid`,
          [stepId],
        )
      ).rows[0],
    ).toEqual(expect.objectContaining({ status: 'REJECTED', version: 1 }));
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM v2_engine_jobs WHERE instance_id = $1::uuid AND type = 'RESUME'`,
          [instanceId],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it('records final approval but leaves RESUME queued while the instance is paused', async () => {
    await pool.query(
      `UPDATE v2_process_instances SET is_paused = true, paused_at = NOW() WHERE id = $1::uuid`,
      [instanceId],
    );

    await adapter.completeTask({
      task_id: taskId,
      action: 'approve',
      status: 'APPROVED',
      actor_id: 'alice',
      idempotency_key: 'paused-final-approval',
    });

    expect((
      await pool.query(`SELECT status FROM v2_approval_requests WHERE id = $1::uuid`, [requestId])
    ).rows[0]).toEqual(expect.objectContaining({ status: 'APPROVED' }));
    expect((
      await pool.query(
        `SELECT status FROM v2_engine_jobs
         WHERE instance_id = $1::uuid AND type = 'RESUME'`,
        [instanceId],
      )
    ).rows[0]).toEqual(expect.objectContaining({ status: 'QUEUED' }));
    expect((
      await pool.query(
        `SELECT state, is_paused FROM v2_process_instances WHERE id = $1::uuid`,
        [instanceId],
      )
    ).rows[0]).toEqual(expect.objectContaining({ state: 'RUNNING', is_paused: true }));
  });

  it('completes an ALL step once after concurrent approvals', async () => {
    const bobTaskId = randomUUID();
    await pool.query(
      `UPDATE v2_approval_steps SET mode = 'ALL', required_count = 2 WHERE id = $1::uuid`,
      [stepId],
    );
    await pool.query(
      `INSERT INTO v2_tasks
         (id, instance_id, token_id, approval_request_id, approval_step_id,
          node_id, assignee, status, payload)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               'approval', 'bob', 'OPEN', '{}'::jsonb)`,
      [bobTaskId, instanceId, tokenId, requestId, stepId],
    );

    const outcomes = await Promise.all([
      adapter.completeTask({
        task_id: taskId, action: 'approve', status: 'APPROVED',
        actor_id: 'alice', idempotency_key: 'all-alice',
      }),
      adapter.completeTask({
        task_id: bobTaskId, action: 'approve', status: 'APPROVED',
        actor_id: 'bob', idempotency_key: 'all-bob',
      }),
    ]);
    expect(outcomes.map((item) => item.outcome)).toEqual([
      'completed',
      'completed',
    ]);
    expect((await pool.query(
      `SELECT status FROM v2_approval_requests WHERE id = $1::uuid`,
      [requestId],
    )).rows[0].status).toBe('APPROVED');
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM v2_engine_jobs
       WHERE instance_id = $1::uuid AND type = 'RESUME'`,
      [instanceId],
    )).rows[0].count).toBe(1);
  });

  it('completes ANY on the first approval and cancels siblings', async () => {
    const bobTaskId = randomUUID();
    await pool.query(
      `UPDATE v2_approval_steps SET mode = 'ANY', required_count = 1 WHERE id = $1::uuid`,
      [stepId],
    );
    await pool.query(
      `INSERT INTO v2_tasks
         (id, instance_id, token_id, approval_request_id, approval_step_id,
          node_id, assignee, status, payload)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               'approval', 'bob', 'OPEN', '{}'::jsonb)`,
      [bobTaskId, instanceId, tokenId, requestId, stepId],
    );

    await adapter.completeTask({
      task_id: taskId, action: 'approve', status: 'APPROVED',
      actor_id: 'alice', idempotency_key: 'any-alice',
    });
    expect((await pool.query(
      `SELECT status FROM v2_tasks WHERE id = $1::uuid`,
      [bobTaskId],
    )).rows[0].status).toBe('CANCELED');
    expect((await adapter.completeTask({
      task_id: bobTaskId, action: 'approve', status: 'APPROVED',
      actor_id: 'bob', idempotency_key: 'any-bob-late',
    })).outcome).toBe('already_completed');
  });

  it('keeps rejection final under concurrent approve and reject', async () => {
    const bobTaskId = randomUUID();
    await pool.query(
      `UPDATE v2_approval_steps SET mode = 'ALL', required_count = 2 WHERE id = $1::uuid`,
      [stepId],
    );
    await pool.query(
      `INSERT INTO v2_tasks
         (id, instance_id, token_id, approval_request_id, approval_step_id,
          node_id, assignee, status, payload)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               'approval', 'bob', 'OPEN', '{}'::jsonb)`,
      [bobTaskId, instanceId, tokenId, requestId, stepId],
    );

    await Promise.all([
      adapter.completeTask({
        task_id: taskId, action: 'approve', status: 'APPROVED',
        actor_id: 'alice', idempotency_key: 'race-approve',
      }),
      adapter.completeTask({
        task_id: bobTaskId, action: 'reject', status: 'REJECTED',
        actor_id: 'bob', idempotency_key: 'race-reject',
      }),
    ]);
    expect((await pool.query(
      `SELECT status FROM v2_approval_requests WHERE id = $1::uuid`,
      [requestId],
    )).rows[0].status).toBe('REJECTED');
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM v2_engine_jobs
       WHERE instance_id = $1::uuid AND type = 'RESUME'`,
      [instanceId],
    )).rows[0].count).toBe(1);
  });
});
