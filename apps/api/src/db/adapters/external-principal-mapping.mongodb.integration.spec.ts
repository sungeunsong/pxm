import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from './mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo external principal mapping registry', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  const suffix = randomUUID();
  const groupId = `mapping-group-${suffix}`;
  const userId = `mapping-user-${suffix}`;
  const mappingId = `mapping-${suffix}`;
  const provider = `provider-${suffix}`;
  const subject = `subject-${suffix}`;

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017', {
      serverSelectionTimeoutMS: 2_000,
    });
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);
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
    if (db) {
      await db.collection('v2_external_principal_mappings').deleteMany({ _id: mappingId });
      await db.collection('pxm_users').deleteMany({ _id: userId });
      await db.collection('pxm_groups').deleteMany({ _id: groupId });
    }
    if (client) await client.close();
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
    })).rejects.toMatchObject({ code: 11000 });

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
