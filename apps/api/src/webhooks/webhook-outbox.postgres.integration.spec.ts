import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../db/adapters/postgres.adapter';

const describePostgres =
  process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

describePostgres('Postgres webhook outbox cursor', () => {
  let pool: Pool;
  let adapter: PostgresAdapter;
  let definitionId: string;
  let instanceId: string;
  let cursorBefore: string | null;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    adapter = new PostgresAdapter(pool);
  });

  beforeEach(async () => {
    cursorBefore = (
      await pool.query(`SELECT max(id)::text AS id FROM v2_event_outbox`)
    ).rows[0].id;
    definitionId = randomUUID();
    instanceId = randomUUID();
    await pool.query(
      `INSERT INTO v2_process_definitions
         (id, definition_key, version, name, status)
       VALUES ($1::uuid, $2, 1, 'Webhook outbox test', 'ACTIVE')`,
      [definitionId, `webhook-${definitionId}`],
    );
    await pool.query(
      `INSERT INTO v2_process_instances
         (id, process_definition_id, state, context)
       VALUES ($1::uuid, $2::uuid, 'COMPLETED', '{}'::jsonb)`,
      [instanceId, definitionId],
    );
    await pool.query(
      `INSERT INTO v2_event_outbox (instance_id, event_type, payload)
       VALUES
         ($1::uuid, 'TASK_APPROVED', '{}'::jsonb),
         ($1::uuid, 'APPROVAL_REQUEST_APPROVED', '{"source":{"provider":"acrapoint"}}'::jsonb),
         ($1::uuid, 'APPROVAL_REQUEST_REJECTED', '{"source":{"provider":"acrapoint"}}'::jsonb)`,
      [instanceId],
    );
  });

  afterEach(async () => {
    await pool.query(
      `DELETE FROM v2_process_instances WHERE id = $1::uuid`,
      [instanceId],
    );
    await pool.query(
      `DELETE FROM v2_process_definitions WHERE id = $1::uuid`,
      [definitionId],
    );
  });

  afterAll(async () => pool.end());

  it('reads final approval events in id order and resumes after the cursor', async () => {
    const first = await adapter.fetchWebhookEvents(cursorBefore, 1);
    expect(first[0]?.event_type).toBe('APPROVAL_REQUEST_APPROVED');
    expect(first[0]?.instance_id).toBe(instanceId);
    const next = await adapter.fetchWebhookEvents(first[0].id, 500);
    expect(
      next
        .filter((item) => item.instance_id === instanceId)
        .map((item) => item.event_type),
    ).toEqual(['APPROVAL_REQUEST_REJECTED']);
  });
});
