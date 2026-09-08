import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from '../db/adapters/mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo group deletion lifecycle', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  const groupId = `group-lifecycle-${randomUUID()}`;
  const pristineGroupId = `group-pristine-${randomUUID()}`;
  const workflowId = randomUUID();
  const manuallyDeletedWorkflowId = randomUUID();
  const instanceId = randomUUID();
  const approvalId = randomUUID();
  const apiKeyId = randomUUID();
  const usageId = randomUUID();

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);
    const now = new Date().toISOString();
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
    await adapter.createInstance(
      instanceId,
      workflowId,
      'WAITING',
      { runtime: { access: { group_id: groupId } } },
      { group_id: groupId },
    );
    await db.collection('v2_approval_requests').insertOne({
      _id: approvalId,
      instance_id: instanceId,
      token_id: randomUUID(),
      node_id: 'approval',
      status: 'IN_PROGRESS',
      current_step_order: 1,
      version: 1,
      created_at: now,
      updated_at: now,
    });
  });

  afterAll(async () => {
    await Promise.all([
      db.collection('pxm_groups').deleteMany({ _id: groupId }),
      db.collection('pxm_groups').deleteMany({ _id: pristineGroupId }),
      db.collection('v2_process_definitions').deleteMany({ _id: { $in: [workflowId, manuallyDeletedWorkflowId] } }),
      db.collection('v2_process_definition_versions').deleteMany({ definition_id: { $in: [workflowId, manuallyDeletedWorkflowId] } }),
      db.collection('v2_process_instances').deleteMany({ _id: instanceId }),
      db.collection('v2_approval_requests').deleteMany({ _id: approvalId }),
      db.collection('pxm_api_keys').deleteMany({ _id: apiKeyId }),
      db.collection('pxm_api_key_usage_logs').deleteMany({ _id: usageId }),
    ]);
    await client.close();
  });

  it('reports active instances and approvals exactly', async () => {
    await expect(adapter.getGroupDeletionRuntimeImpact([workflowId])).resolves.toEqual({
      active_instance_count: 1,
      active_instance_ids: [instanceId],
      open_approval_count: 1,
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
    await db.collection('v2_process_instances').updateOne({ _id: instanceId }, { $set: { state: 'COMPLETED' } });

    await expect(adapter.softDeleteGroup(groupId, 'admin-1')).resolves.toBe(true);
    expect(await db.collection('pxm_groups').findOne({ _id: groupId })).toMatchObject({ status: 'deleted' });
    expect(await db.collection('pxm_api_keys').findOne({ _id: apiKeyId })).toMatchObject({ status: 'disabled', disabled_reason: `group_deleted:${groupId}` });
    expect(await db.collection('v2_process_definitions').findOne({ _id: workflowId })).toMatchObject({
      status: 'DELETED', lifecycle_status: 'DISABLED', group_deletion: { group_id: groupId },
    });

    await expect(adapter.restoreGroup(groupId, 'admin-1')).resolves.toBe(true);
    expect(await db.collection('pxm_groups').findOne({ _id: groupId })).toMatchObject({ recovery_review_required: true });
    expect(await db.collection('v2_process_definitions').findOne({ _id: workflowId })).toMatchObject({ status: 'ACTIVE', lifecycle_status: 'DISABLED' });
    expect(await db.collection('v2_process_definitions').findOne({ _id: manuallyDeletedWorkflowId })).toMatchObject({ status: 'DELETED' });
    expect(await db.collection('pxm_api_keys').findOne({ _id: apiKeyId })).toMatchObject({ status: 'disabled' });
    await expect(adapter.completeGroupRecoveryReview(groupId, 'admin-1')).resolves.toBe(true);
    expect(await db.collection('pxm_groups').findOne({ _id: groupId })).toMatchObject({ recovery_review_required: false });
  });

  it('permanently removes a pristine group record', async () => {
    await expect(adapter.listGroupWorkflowRecordIds(pristineGroupId)).resolves.toEqual([]);
    await expect(adapter.hardDeleteGroup(pristineGroupId)).resolves.toBe(true);
    await expect(adapter.getGroup(pristineGroupId)).resolves.toBeNull();
  });
});
