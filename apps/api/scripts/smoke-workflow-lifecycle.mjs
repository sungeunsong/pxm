import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

const apiBaseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3011/api';
const mongoUri =
  process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';
const userId = process.env.PXM_DEMO_USER || 'admin';
const password = process.env.PXM_DEMO_PASSWORD || 'admin1234';

const client = new MongoClient(mongoUri);
let templateId;
const instanceIds = [];

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const session = await login();

  const draft = await requestJson('/templates', session, {
    method: 'POST',
    body: workflowPayload('Version 1'),
  });
  templateId = draft.id;
  assert.equal(draft.lifecycle_status, 'DRAFT');
  assert.equal(draft.active_published_version, null);

  await expectStatus(`/templates/${templateId}/start`, session, 400, {
    method: 'POST',
    body: { input: { source: 'draft' } },
  });

  const preview = await start(`/templates/${templateId}/execute`, session);
  assert.equal(await snapshotVersion(db, preview.instance_id), 1);

  const deployedV1 = await requestJson(
    `/templates/${templateId}/deploy`,
    session,
    {
      method: 'POST',
      body: {},
    },
  );
  assert.equal(deployedV1.template.active_published_version, 1);

  const draftV2 = await requestJson(`/templates/${templateId}`, session, {
    method: 'PUT',
    body: workflowPayload('Version 2'),
  });
  assert.equal(draftV2.version, 2);
  assert.equal(draftV2.active_published_version, 1);
  assert.equal(draftV2.has_unpublished_changes, true);

  const publishedV1Run = await start(`/templates/${templateId}/start`, session);
  assert.equal(await snapshotVersion(db, publishedV1Run.instance_id), 1);
  assert.equal(await startLabel(db, publishedV1Run.instance_id), 'Version 1');

  const deployedV2 = await requestJson(
    `/templates/${templateId}/deploy`,
    session,
    {
      method: 'POST',
      body: {},
    },
  );
  assert.equal(deployedV2.template.active_published_version, 2);

  const publishedV2Run = await start(`/templates/${templateId}/start`, session);
  assert.equal(await snapshotVersion(db, publishedV2Run.instance_id), 2);
  assert.equal(await startLabel(db, publishedV2Run.instance_id), 'Version 2');

  const disabled = await requestJson(
    `/templates/${templateId}/disable`,
    session,
    {
      method: 'POST',
      body: {},
    },
  );
  assert.equal(disabled.template.lifecycle_status, 'DISABLED');
  assert.equal(disabled.template.active_published_version, 2);
  await expectStatus(`/templates/${templateId}/start`, session, 400, {
    method: 'POST',
    body: {},
  });

  const reactivated = await requestJson(
    `/templates/${templateId}/reactivate`,
    session,
    { method: 'POST', body: {} },
  );
  assert.equal(reactivated.template.active_published_version, 2);

  const rollback = await requestJson(
    `/templates/${templateId}/versions/1/rollback`,
    session,
    { method: 'POST', body: {} },
  );
  assert.equal(rollback.version, 3);
  assert.equal(rollback.active_published_version, 2);
  assert.equal(rollback.has_unpublished_changes, true);

  const beforeRollbackDeploy = await start(
    `/templates/${templateId}/start`,
    session,
  );
  assert.equal(await snapshotVersion(db, beforeRollbackDeploy.instance_id), 2);
  assert.equal(
    await startLabel(db, beforeRollbackDeploy.instance_id),
    'Version 2',
  );

  const deployedRollback = await requestJson(
    `/templates/${templateId}/deploy`,
    session,
    { method: 'POST', body: {} },
  );
  assert.equal(deployedRollback.template.active_published_version, 3);

  const rollbackRun = await start(`/templates/${templateId}/start`, session);
  assert.equal(await snapshotVersion(db, rollbackRun.instance_id), 3);
  assert.equal(await startLabel(db, rollbackRun.instance_id), 'Version 1');

  console.log(
    `[workflow:lifecycle] passed template=${templateId} instances=${instanceIds.length}`,
  );
}

async function login() {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId, password }),
  });
  if (!response.ok) {
    throw new Error(
      `login failed: ${response.status} ${await response.text()}`,
    );
  }
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  const csrf = decodeURIComponent(
    cookies
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith('pxm_csrf='))
      ?.split('=')[1] || '',
  );
  return { cookie, csrf };
}

async function start(path, session) {
  const execution = await requestJson(path, session, {
    method: 'POST',
    body: { input: { lifecycle_test: true } },
  });
  assert.ok(execution.instance_id);
  instanceIds.push(execution.instance_id);
  return execution;
}

async function snapshotVersion(db, instanceId) {
  const instance = await db
    .collection('v2_process_instances')
    .findOne({ _id: instanceId });
  assert.ok(instance, `instance ${instanceId} must exist`);
  return instance.context?.runtime?.snapshot?.workflow?.version;
}

async function startLabel(db, instanceId) {
  const instance = await db
    .collection('v2_process_instances')
    .findOne({ _id: instanceId });
  return instance?.context?.runtime?.nodes?.find((node) => node.id === 'start')
    ?.data?.label;
}

async function requestJson(path, session, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function expectStatus(path, session, expectedStatus, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  assert.equal(response.status, expectedStatus, await response.text());
}

function workflowPayload(startLabelValue) {
  return {
    name: `TEST · workflow lifecycle ${Date.now()}`,
    description: 'Draft/Published/Disabled lifecycle smoke fixture',
    version_note: startLabelValue,
    nodes: [
      {
        id: 'start',
        type: 'custom',
        position: { x: 0, y: 0 },
        data: { nodeType: 'start', label: startLabelValue },
      },
      {
        id: 'end',
        type: 'custom',
        position: { x: 240, y: 0 },
        data: { nodeType: 'end', label: 'End' },
      },
    ],
    edges: [{ id: 'start-end', source: 'start', target: 'end' }],
  };
}

main()
  .catch((error) => {
    console.error('[workflow:lifecycle] failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const db = client.db(dbName);
      if (templateId) {
        await Promise.all([
          db
            .collection('v2_process_definitions')
            .deleteMany({ _id: templateId }),
          db
            .collection('v2_process_definition_versions')
            .deleteMany({ definition_id: templateId }),
        ]);
      }
      if (instanceIds.length > 0) {
        await Promise.all([
          db
            .collection('v2_process_instances')
            .deleteMany({ _id: { $in: instanceIds } }),
          db
            .collection('v2_engine_jobs')
            .deleteMany({ instance_id: { $in: instanceIds } }),
          db
            .collection('v2_tokens')
            .deleteMany({ instance_id: { $in: instanceIds } }),
        ]);
      }
    } finally {
      await client.close();
    }
  });
