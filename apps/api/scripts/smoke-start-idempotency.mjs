import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const apiBaseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3011/api';
const mongoUri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
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
  const workflow = await requestJson('/templates', session, {
    method: 'POST',
    body: workflowPayload(),
  });
  templateId = workflow.id;
  await requestJson(`/templates/${templateId}/deploy`, session, { method: 'POST', body: {} });

  const key = `start-smoke-${randomUUID()}`;
  const calls = await Promise.all(
    Array.from({ length: 10 }, () =>
      rawRequest(`/templates/${templateId}/start`, session, {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: { input: { order_id: 'ORDER-100' } },
      }),
    ),
  );
  assert.ok(calls.every(({ response }) => response.status === 202));
  const bodies = await Promise.all(calls.map(({ response }) => response.json()));
  instanceIds.push(...new Set(bodies.map((body) => body.instance_id).filter(Boolean)));
  assert.equal(new Set(bodies.map((body) => body.instance_id)).size, 1);
  assert.equal(bodies.filter((body) => body.idempotent_replay === false).length, 1);
  assert.equal(bodies.filter((body) => body.idempotent_replay === true).length, 9);
  assert.equal(calls.filter(({ response }) => response.headers.get('idempotency-replayed') === 'true').length, 9);

  assert.equal(await db.collection('v2_process_instances').countDocuments({ process_definition_id: templateId }), 1);
  assert.equal(await db.collection('v2_engine_jobs').countDocuments({ instance_id: bodies[0].instance_id, job_type: 'START' }), 1);
  assert.equal(await db.collection('v2_tokens').countDocuments({ instance_id: bodies[0].instance_id }), 1);

  const conflict = await rawRequest(`/templates/${templateId}/start`, session, {
    method: 'POST',
    headers: { 'idempotency-key': key },
    body: { input: { order_id: 'ORDER-CHANGED' } },
  });
  assert.equal(conflict.response.status, 409, await conflict.response.text());

  const next = await requestJson(`/templates/${templateId}/start`, session, {
    method: 'POST',
    headers: { 'idempotency-key': `${key}-next` },
    body: { input: { order_id: 'ORDER-100' } },
  });
  assert.notEqual(next.instance_id, bodies[0].instance_id);
  instanceIds.push(next.instance_id);
  assert.equal(await db.collection('v2_process_instances').countDocuments({ process_definition_id: templateId }), 2);

  console.log(`[workflow:start-idempotency] passed template=${templateId} unique_instances=${instanceIds.length}`);
}

async function login() {
  const response = await fetch(`${apiBaseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId, password }),
  });
  if (!response.ok) throw new Error(`login failed: ${response.status} ${await response.text()}`);
  const cookies = response.headers.getSetCookie();
  return {
    cookie: cookies.map((value) => value.split(';')[0]).join('; '),
    csrf: decodeURIComponent(cookies.map((value) => value.split(';')[0]).find((value) => value.startsWith('pxm_csrf='))?.split('=')[1] || ''),
  };
}

async function rawRequest(path, session, options = {}) {
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
  return { response };
}

async function requestJson(path, session, options = {}) {
  const { response } = await rawRequest(path, session, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json();
}

function workflowPayload() {
  return {
    name: `TEST · start idempotency ${Date.now()}`,
    description: 'Workflow Start API idempotency smoke fixture',
    nodes: [
      { id: 'start', type: 'custom', position: { x: 0, y: 0 }, data: { nodeType: 'start', label: 'Start' } },
      { id: 'end', type: 'custom', position: { x: 240, y: 0 }, data: { nodeType: 'end', label: 'End' } },
    ],
    edges: [{ id: 'start-end', source: 'start', target: 'end' }],
  };
}

main()
  .catch((error) => {
    console.error('[workflow:start-idempotency] failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const db = client.db(dbName);
      if (templateId) {
        await Promise.all([
          db.collection('v2_process_definitions').deleteMany({ _id: templateId }),
          db.collection('v2_process_definition_versions').deleteMany({ definition_id: templateId }),
          db.collection('v2_start_idempotency').deleteMany({ definition_id: templateId }),
          db.collection('v2_process_instances').deleteMany({ process_definition_id: templateId }),
          db.collection('v2_engine_jobs').deleteMany({ instance_id: { $in: instanceIds } }),
          db.collection('v2_tokens').deleteMany({ instance_id: { $in: instanceIds } }),
        ]);
      }
    } finally {
      await client.close();
    }
  });
