import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from './postgres.adapter';

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

describePostgres('PostgreSQL external principal mapping registry', () => {
  let pool: Pool;
  let adapter: PostgresAdapter;
  const suffix = randomUUID();
  const groupId = `mapping-group-${suffix}`;
  const userId = `mapping-user-${suffix}`;
  const mappingId = `mapping-${suffix}`;
  const provider = `provider-${suffix}`;
  const subject = `subject-${suffix}`;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL
        || 'postgres://postgres:postgres@127.0.0.1:5432/pxm',
    });
    adapter = new PostgresAdapter(pool);
    await adapter.upsertGroup({ id: groupId, name: `Mapping integration group ${suffix}` });
    await adapter.upsertUser({
      id: userId,
      display_name: 'Mapping integration user',
      email: 'mapping@example.com',
      group_ids: [groupId],
      memberships: [{ group_id: groupId, role: 'user' }],
      status: 'active',
    });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM v2_external_principal_mappings WHERE id=$1', [mappingId]);
    await pool.query('DELETE FROM pxm_users WHERE id=$1', [userId]);
    await pool.query('DELETE FROM pxm_groups WHERE id=$1', [groupId]);
    await pool.end();
  });

  it('creates, searches, updates, disables, and enforces provider/subject uniqueness', async () => {
    const created = await adapter.createExternalPrincipalMapping({
      id: mappingId,
      provider,
      subject,
      group_id: groupId,
      pxm_user_id: userId,
      email: 'external@example.com',
      actor: 'integration-test',
    });
    expect(created).toMatchObject({ id: mappingId, provider, subject, status: 'active' });
    await expect(adapter.createExternalPrincipalMapping({
      provider,
      subject,
      group_id: groupId,
      pxm_user_id: userId,
    })).rejects.toMatchObject({ code: '23505' });

    await expect(adapter.findExternalPrincipalMapping(provider, subject))
      .resolves.toMatchObject({ id: mappingId });
    await expect(adapter.listExternalPrincipalMappings({ group_id: groupId, subject: subject.slice(0, 12) }))
      .resolves.toEqual([expect.objectContaining({ id: mappingId })]);
    await expect(adapter.updateExternalPrincipalMapping(mappingId, {
      group_id: groupId,
      pxm_user_id: userId,
      display_name: 'Updated approver',
      email: 'updated@example.com',
      department: 'Finance',
      actor: 'integration-test',
    })).resolves.toMatchObject({ display_name: 'Updated approver', department: 'Finance' });
    await expect(adapter.setExternalPrincipalMappingStatus(mappingId, 'disabled', 'integration-test'))
      .resolves.toMatchObject({ status: 'disabled' });
  });
});
