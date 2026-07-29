import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { IdempotentWorkflowStart } from '../ports/db.ports';
import { PostgresAdapter } from './postgres.adapter';

const describePostgres =
  process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

describePostgres('PostgreSQL workflow start idempotency', () => {
  let pool: Pool;
  let adapter: PostgresAdapter;
  const definitionId = randomUUID();
  const keyHash = `external-approval-${randomUUID()}`;
  const instanceIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({
      connectionString:
        process.env.POSTGRES_URL ||
        process.env.DATABASE_URL ||
        'postgres://postgres:postgres@127.0.0.1:5432/pxm',
    });
    adapter = new PostgresAdapter(pool);
    await adapter.createDefinition(definitionId, 'PXM-11 start idempotency test', [], []);
  });

  afterAll(async () => {
    await pool.query('delete from v2_start_idempotency where key_hash = $1', [keyHash]);
    await pool.query('delete from v2_engine_jobs where instance_id = any($1::uuid[])', [instanceIds]);
    await pool.query('delete from v2_tokens where instance_id = any($1::uuid[])', [instanceIds]);
    await pool.query('delete from v2_process_instances where id = any($1::uuid[])', [instanceIds]);
    await pool.query('delete from v2_definition_edges where definition_id = $1::uuid', [definitionId]);
    await pool.query('delete from v2_definition_nodes where definition_id = $1::uuid', [definitionId]);
    await pool.query('delete from v2_process_definition_versions where definition_id = $1::uuid', [definitionId]);
    await pool.query('delete from v2_process_definitions where id = $1::uuid', [definitionId]);
    await pool.end();
  });

  it('creates one instance for concurrent retries and detects changed payload', async () => {
    const request = (requestHash: string): IdempotentWorkflowStart => {
      const instanceId = randomUUID();
      instanceIds.push(instanceId);
      return {
        key_hash: keyHash,
        request_hash: requestHash,
        expires_at: new Date(Date.now() + 60_000),
        instance: {
          id: instanceId,
          definition_id: definitionId,
          status: 'CREATED',
          context: { data: { formData: { approval_request: { request_id: 'AP-1' } } } },
        },
        token: { id: randomUUID(), node_id: 'start', status: 'ACTIVE' },
        job: { type: 'START', run_at: new Date(), payload: { node_id: 'start' } },
      };
    };

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => adapter.createIdempotentStart(request('same-payload'))),
    );
    expect(outcomes.filter((item) => item.outcome === 'created')).toHaveLength(1);
    expect(outcomes.filter((item) => item.outcome === 'replayed')).toHaveLength(7);
    expect(new Set(outcomes.map((item) => item.instance_id)).size).toBe(1);

    await expect(adapter.createIdempotentStart(request('changed-payload'))).resolves.toEqual({
      outcome: 'conflict',
      instance_id: outcomes[0].instance_id,
    });
  });
});
