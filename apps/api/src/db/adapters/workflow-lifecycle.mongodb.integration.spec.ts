import { randomUUID } from 'crypto';
import { Db, MongoClient } from 'mongodb';
import { MongodbAdapter } from './mongodb.adapter';

const describeMongo = process.env.RUN_MONGO_INTEGRATION === 'true' ? describe : describe.skip;

describeMongo('Mongo workflow deployment lifecycle', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: MongodbAdapter;
  const definitionId = randomUUID();

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017');
    await client.connect();
    db = client.db(process.env.MONGO_DB_NAME || 'pxm_db');
    adapter = new MongodbAdapter(db);
  });

  afterAll(async () => {
    await Promise.all([db.collection('v2_process_definitions').deleteMany({ _id: definitionId }), db.collection('v2_process_definition_versions').deleteMany({ definition_id: definitionId })]);
    await client.close();
  });

  it('keeps API execution on the published version until a new version is published', async () => {
    const nodesV1 = [{ id: 'start', data: { nodeType: 'start', label: 'Published start' } }];
    await adapter.createDefinition(definitionId, 'Lifecycle test', nodesV1, [], {
      lifecycle_status: 'DRAFT',
      active_published_version: null,
    });
    expect(await adapter.getPublishedDefinition(definitionId)).toBeNull();

    await adapter.setDefinitionLifecycle(definitionId, {
      status: 'PUBLISHED',
      active_published_version: 1,
      actor_id: 'admin',
    });
    const firstPublication = await adapter.getDefinition(definitionId);
    expect(firstPublication).toEqual(expect.objectContaining({
      active_published_version: 1,
      published_at: expect.any(String),
      published_by: 'admin',
    }));
    expect(await adapter.getPublishedDefinition(definitionId)).toEqual(expect.objectContaining({ version: 1, nodes: nodesV1 }));

    const nodesV2 = [{ id: 'start', data: { nodeType: 'start', label: 'Draft start' } }];
    await adapter.createDefinition(definitionId, 'Lifecycle test', nodesV2, [], {
      lifecycle_status: 'PUBLISHED',
      active_published_version: 1,
    });
    const current = await adapter.getDefinition(definitionId);
    const publishedBeforeDeploy = await adapter.getPublishedDefinition(definitionId);
    expect(current).toEqual(expect.objectContaining({ version: 2, nodes: nodesV2 }));
    expect(publishedBeforeDeploy).toEqual(expect.objectContaining({ version: 1, nodes: nodesV1 }));

    await adapter.setDefinitionLifecycle(definitionId, {
      status: 'PUBLISHED',
      active_published_version: 2,
      actor_id: 'admin',
    });
    const secondPublication = await adapter.getDefinition(definitionId);
    expect(secondPublication).toEqual(expect.objectContaining({
      active_published_version: 2,
      published_at: expect.any(String),
      published_by: 'admin',
    }));
    expect(await adapter.getPublishedDefinition(definitionId)).toEqual(expect.objectContaining({ version: 2, nodes: nodesV2 }));

    await adapter.setDefinitionLifecycle(definitionId, {
      status: 'DISABLED',
      actor_id: 'admin',
    });
    const disabled = await adapter.getDefinition(definitionId);
    expect(disabled).toEqual(expect.objectContaining({
      lifecycle_status: 'DISABLED',
      active_published_version: 2,
      published_at: secondPublication.published_at,
      published_by: secondPublication.published_by,
    }));
    expect(await adapter.getPublishedDefinition(definitionId)).toBeNull();

    await adapter.setDefinitionLifecycle(definitionId, {
      status: 'PUBLISHED',
      active_published_version: 2,
      actor_id: 'reactivating-admin',
    });
    expect(await adapter.getDefinition(definitionId)).toEqual(expect.objectContaining({
      lifecycle_status: 'PUBLISHED',
      active_published_version: 2,
      published_at: secondPublication.published_at,
      published_by: secondPublication.published_by,
    }));

    await expect(adapter.setDefinitionLifecycle(definitionId, {
      status: 'PUBLISHED',
      active_published_version: 99,
      actor_id: 'admin',
    })).rejects.toThrow('Workflow version v99 does not exist');
    expect(await adapter.getDefinition(definitionId)).toEqual(expect.objectContaining({
      lifecycle_status: 'PUBLISHED',
      active_published_version: 2,
      published_at: secondPublication.published_at,
    }));
  });
});
