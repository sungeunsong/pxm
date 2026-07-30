import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../db/adapters/postgres.adapter';

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

describePostgres('Operations PostgreSQL recovery integration', () => {
  let pool: Pool;
  let adapter: PostgresAdapter;
  let definitionId: string;
  let instanceId: string;
  let jobId: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    adapter = new PostgresAdapter(pool);
  });

  beforeEach(async () => {
    definitionId = randomUUID();
    instanceId = randomUUID();
    await pool.query(
      `INSERT INTO v2_process_definitions (id, definition_key, version, name, status)
       VALUES ($1::uuid, $2, 1, 'Operations test', 'ACTIVE')`,
      [definitionId, `operations-${definitionId}`],
    );
    await pool.query(
      `INSERT INTO v2_process_instances
         (id, process_definition_id, state, context, lock_owner, lock_until, heartbeat_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 'WAITING', '{}'::jsonb, 'dead-worker',
               NOW() - interval '2 hours', NOW() - interval '2 hours', NOW() - interval '2 hours')`,
      [instanceId, definitionId],
    );
    jobId = (await pool.query(
      `INSERT INTO v2_engine_jobs
         (instance_id, token_id, type, run_at, attempt, status, payload, updated_at)
       VALUES ($1::uuid, NULL, 'ADVANCE_TOKEN', NOW() - interval '2 hours', 2, 'FAILED', '{}'::jsonb, NOW() - interval '2 hours')
       RETURNING id::text`,
      [instanceId],
    )).rows[0].id;
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM v2_engine_jobs WHERE instance_id = $1::uuid`, [instanceId]);
    await pool.query(`DELETE FROM v2_process_instances WHERE id = $1::uuid`, [instanceId]);
    await pool.query(`DELETE FROM v2_process_definitions WHERE id = $1::uuid`, [definitionId]);
  });
  afterAll(async () => pool.end());

  it('detects and conditionally recovers failures without duplicate execution', async () => {
    const snapshot = await adapter.getOperationsSnapshot(60, 500);
    expect(snapshot.jobs).toContainEqual(expect.objectContaining({ id: jobId, status: 'FAILED' }));
    expect(snapshot.waiting_instances).toContainEqual(expect.objectContaining({ id: instanceId }));
    expect(snapshot.waiting_instances).toContainEqual(expect.objectContaining({
      id: instanceId, classification: 'SUSPICIOUS', waiting_reason: 'NO_RESUME_SOURCE',
    }));
    expect(snapshot.expired_locks).toContainEqual(expect.objectContaining({ instance_id: instanceId }));

    await expect(adapter.retryFailedJob(jobId)).resolves.toBe(true);
    await expect(adapter.retryFailedJob(jobId)).resolves.toBe(false);
    await expect(adapter.reclaimExpiredInstanceLock(instanceId)).resolves.toBe(true);
    await expect(adapter.reclaimExpiredInstanceLock(instanceId)).resolves.toBe(false);
  });
});
