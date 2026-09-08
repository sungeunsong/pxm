import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PostgresAdapter } from '../db/adapters/postgres.adapter';

const describePostgres = process.env.RUN_POSTGRES_INTEGRATION === 'true' ? describe : describe.skip;

describePostgres('PostgreSQL group deletion lifecycle', () => {
  let pool: Pool;
  let adapter: PostgresAdapter;
  const groupId = `group-lifecycle-${randomUUID()}`;
  const pristineGroupId = `group-pristine-${randomUUID()}`;
  const workflowId = randomUUID();
  const manuallyDeletedWorkflowId = randomUUID();
  const instanceId = randomUUID();
  const apiKeyId = randomUUID();
  const usageId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
    });
    adapter = new PostgresAdapter(pool);
    await adapter.upsertGroup({ id: groupId, name: 'Lifecycle test', description: '', actor: 'test' });
    await adapter.upsertGroup({ id: pristineGroupId, name: 'Pristine test', description: '', actor: 'test' });
    await adapter.createDefinition(workflowId, 'Owned workflow', [], [], { group_id: groupId, lifecycle_status: 'PUBLISHED' });
    await adapter.createDefinition(manuallyDeletedWorkflowId, 'Already deleted', [], [], { group_id: groupId, lifecycle_status: 'DISABLED' });
    await adapter.deleteDefinition(manuallyDeletedWorkflowId);
    await adapter.createApiKey({
      id: apiKeyId, name: 'Lifecycle key', owner_type: 'SERVICE_ACCOUNT', owner_id: 'service-1', group_id: groupId,
      key_prefix: 'pxm_lifecycle', key_hash: randomUUID().replaceAll('-', ''), scopes: ['workflow:read'],
      workflow_access: 'allowlist', allowed_workflow_ids: [workflowId], actor: 'test',
    });
    await adapter.createInstance(instanceId, workflowId, 'WAITING', { runtime: { access: { group_id: groupId } } }, { group_id: groupId });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM pxm_api_key_usage_logs WHERE id = $1', [usageId]);
    await pool.query('DELETE FROM v2_process_instances WHERE id = $1::uuid', [instanceId]);
    await pool.query('DELETE FROM pxm_api_keys WHERE id = $1', [apiKeyId]);
    await pool.query('DELETE FROM pxm_groups WHERE id = $1', [groupId]);
    await pool.query('DELETE FROM pxm_groups WHERE id = $1', [pristineGroupId]);
    await pool.query('DELETE FROM v2_definition_edges WHERE definition_id = ANY($1::uuid[])', [[workflowId, manuallyDeletedWorkflowId]]);
    await pool.query('DELETE FROM v2_definition_nodes WHERE definition_id = ANY($1::uuid[])', [[workflowId, manuallyDeletedWorkflowId]]);
    await pool.query('DELETE FROM v2_process_definition_versions WHERE definition_id = ANY($1::uuid[])', [[workflowId, manuallyDeletedWorkflowId]]);
    await pool.query('DELETE FROM v2_process_definitions WHERE id = ANY($1::uuid[])', [[workflowId, manuallyDeletedWorkflowId]]);
    await pool.end();
  });

  it('reports active instances', async () => {
    await expect(adapter.getGroupDeletionRuntimeImpact([workflowId])).resolves.toEqual({
      active_instance_count: 1,
      active_instance_ids: [instanceId],
      open_approval_count: 0,
    });
  });

  it('completes an API key usage record with its HTTP result', async () => {
    await expect(adapter.appendApiKeyUsageLog({
      id: usageId, api_key_id: apiKeyId, owner_type: 'SERVICE_ACCOUNT', owner_id: 'service-1',
      group_id: groupId, endpoint: 'POST /api/v1/templates/workflow-1/start', completion_state: 'pending',
    })).resolves.toMatchObject({ id: usageId, completion_state: 'pending', status_code: null });

    await adapter.completeApiKeyUsageLog(usageId, {
      status_code: 201, duration_ms: 37, completed_at: '2026-09-08T00:00:00.000Z', completion_state: 'completed',
    });
    const result = await adapter.listApiKeyUsage({ keyId: apiKeyId, page: 1, pageSize: 20 });
    expect(result.items.find(item => item.id === usageId)).toMatchObject({
      status_code: 201, duration_ms: 37, completed_at: '2026-09-08T00:00:00.000Z', completion_state: 'completed',
    });
  });

  it('cascades logical deletion and restores only cascade-owned workflows as disabled', async () => {
    await adapter.updateInstanceStatus(instanceId, 'COMPLETED');

    await expect(adapter.softDeleteGroup(groupId, 'admin-1')).resolves.toBe(true);
    expect((await pool.query('SELECT status FROM pxm_groups WHERE id = $1', [groupId])).rows[0]).toMatchObject({ status: 'deleted' });
    expect((await pool.query('SELECT status, disabled_reason FROM pxm_api_keys WHERE id = $1', [apiKeyId])).rows[0]).toMatchObject({ status: 'disabled', disabled_reason: `group_deleted:${groupId}` });
    expect((await pool.query('SELECT status, metadata FROM v2_process_definitions WHERE id = $1::uuid', [workflowId])).rows[0]).toMatchObject({
      status: 'DELETED', metadata: { lifecycle_status: 'DISABLED', group_deletion: { group_id: groupId } },
    });

    await expect(adapter.restoreGroup(groupId, 'admin-1')).resolves.toBe(true);
    expect((await pool.query('SELECT recovery_review_required FROM pxm_groups WHERE id = $1', [groupId])).rows[0]).toMatchObject({ recovery_review_required: true });
    expect((await pool.query('SELECT status, metadata FROM v2_process_definitions WHERE id = $1::uuid', [workflowId])).rows[0]).toMatchObject({
      status: 'ACTIVE', metadata: { lifecycle_status: 'DISABLED' },
    });
    expect((await pool.query('SELECT status FROM v2_process_definitions WHERE id = $1::uuid', [manuallyDeletedWorkflowId])).rows[0]).toMatchObject({ status: 'DELETED' });
    expect((await pool.query('SELECT status FROM pxm_api_keys WHERE id = $1', [apiKeyId])).rows[0]).toMatchObject({ status: 'disabled' });
    await expect(adapter.completeGroupRecoveryReview(groupId, 'admin-1')).resolves.toBe(true);
    expect((await pool.query('SELECT recovery_review_required FROM pxm_groups WHERE id = $1', [groupId])).rows[0]).toMatchObject({ recovery_review_required: false });
  });

  it('permanently removes a pristine group record', async () => {
    await expect(adapter.listGroupWorkflowRecordIds(pristineGroupId)).resolves.toEqual([]);
    await expect(adapter.hardDeleteGroup(pristineGroupId)).resolves.toBe(true);
    await expect(adapter.getGroup(pristineGroupId)).resolves.toBeNull();
  });
});
