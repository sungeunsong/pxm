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
  const workflow = await requestJson('/templates', session, { method: 'POST', body: workflowPayload() });
  templateId = workflow.id;
  await requestJson(`/templates/${templateId}/deploy`, session, { method: 'POST', body: {} });

  const retrySourceId = randomUUID();
  instanceIds.push(retrySourceId);
  await insertInstance(db, retrySourceId, 'FAILED', {
    runtime: {
      nodes: workflow.nodes,
      edges: workflow.edges,
      snapshot: { workflow: { id: templateId, name: workflow.name, version: 1 } },
    },
    data: { formData: { order_id: 'ORDER-RETRY' }, outputs: {} },
  });
  await db.collection('v2_execution_logs').insertOne({
    instance_id: retrySourceId,
    token_id: null,
    node_id: 'service',
    event_type: 'NODE_FAILED',
    payload: { reason: 'fixture failure' },
    created_at: new Date().toISOString(),
  });

  const retryKey = `retry-${randomUUID()}`;
  const retryCalls = await Promise.all(
    Array.from({ length: 10 }, () => rawRequest(`/instances/${retrySourceId}/retry`, session, {
      method: 'POST',
      headers: { 'idempotency-key': retryKey },
      body: { mode: 'full_instance' },
    })),
  );
  assert.ok(retryCalls.every(({ response }) => response.status === 201));
  const retryBodies = await Promise.all(retryCalls.map(({ response }) => response.json()));
  instanceIds.push(...new Set(retryBodies.map((body) => body.instance_id).filter(Boolean)));
  assert.equal(new Set(retryBodies.map((body) => body.instance_id)).size, 1);
  assert.equal(retryBodies.filter((body) => body.idempotent_replay === false).length, 1);
  assert.equal(retryBodies.filter((body) => body.idempotent_replay === true).length, 9);
  assert.equal(retryCalls.filter(({ response }) => response.headers.get('idempotency-replayed') === 'true').length, 9);
  assert.equal(await db.collection('v2_process_instances').countDocuments({ 'context.runtime.retry.source_instance_id': retrySourceId }), 1);

  const conflict = await rawRequest(`/instances/${retrySourceId}/retry`, session, {
    method: 'POST',
    headers: { 'idempotency-key': retryKey },
    body: { mode: 'failed_node' },
  });
  assert.equal(conflict.response.status, 409, await conflict.response.text());

  const failedNodeSourceId = randomUUID();
  instanceIds.push(failedNodeSourceId);
  await insertInstance(db, failedNodeSourceId, 'FAILED', {
    runtime: {
      nodes: workflow.nodes,
      edges: workflow.edges,
      snapshot: { workflow: { id: templateId, name: workflow.name, version: 1 } },
    },
    data: { formData: { order_id: 'ORDER-NODE-RETRY' }, outputs: {} },
  });
  await db.collection('v2_execution_logs').insertOne({
    instance_id: failedNodeSourceId,
    token_id: null,
    node_id: 'service',
    event_type: 'NODE_FAILED',
    payload: { reason: 'fixture node failure' },
    created_at: new Date().toISOString(),
  });
  const failedNodeKey = `failed-node-${randomUUID()}`;
  const failedNodeFirst = await requestJson(`/instances/${failedNodeSourceId}/retry`, session, {
    method: 'POST',
    headers: { 'idempotency-key': failedNodeKey },
    body: { mode: 'failed_node' },
  });
  const failedNodeReplay = await requestJson(`/instances/${failedNodeSourceId}/retry`, session, {
    method: 'POST',
    headers: { 'idempotency-key': failedNodeKey },
    body: { mode: 'failed_node' },
  });
  assert.equal(failedNodeFirst.idempotent_replay, false);
  assert.equal(failedNodeReplay.idempotent_replay, true);
  assert.equal(await db.collection('v2_engine_jobs').countDocuments({ instance_id: failedNodeSourceId, job_type: 'RETRY' }), 1);
  assert.equal(await db.collection('v2_tokens').countDocuments({ instance_id: failedNodeSourceId, node_id: 'service' }), 1);
  assert.equal(await db.collection('v2_event_outbox').countDocuments({ instance_id: failedNodeSourceId, event_type: 'FAILED_NODE_RETRY_REQUESTED' }), 1);

  const terminateParentId = randomUUID();
  const terminateChildId = randomUUID();
  instanceIds.push(terminateParentId, terminateChildId);
  await insertInstance(db, terminateParentId, 'RUNNING', { runtime: {}, data: {} });
  await insertInstance(db, terminateChildId, 'WAITING', { runtime: { parent_instance_id: terminateParentId }, data: {} });
  await insertJob(db, terminateParentId, 'RUNNING');
  await insertJob(db, terminateChildId, 'QUEUED');

  const terminateKey = `terminate-${randomUUID()}`;
  const terminateCalls = await Promise.all(
    Array.from({ length: 10 }, () => rawRequest(`/instances/${terminateParentId}/terminate`, session, {
      method: 'POST',
      headers: { 'idempotency-key': terminateKey },
      body: {},
    })),
  );
  assert.ok(terminateCalls.every(({ response }) => response.status === 201));
  const terminateBodies = await Promise.all(terminateCalls.map(({ response }) => response.json()));
  assert.equal(terminateBodies.filter((body) => body.idempotent_replay === false).length, 1);
  assert.equal(terminateBodies.filter((body) => body.idempotent_replay === true).length, 9);
  assert.deepEqual(new Set(terminateBodies[0].terminated_instances), new Set([terminateParentId, terminateChildId]));
  assert.equal(await db.collection('v2_process_instances').countDocuments({ _id: { $in: [terminateParentId, terminateChildId] }, state: 'TERMINATED' }), 2);
  assert.equal(await db.collection('v2_engine_jobs').countDocuments({ instance_id: { $in: [terminateParentId, terminateChildId] }, status: 'COMPLETED' }), 2);
  assert.equal(await db.collection('v2_event_outbox').countDocuments({ instance_id: { $in: [terminateParentId, terminateChildId] }, event_type: 'INSTANCE_TERMINATED' }), 2);

  console.log(`[instance:command-idempotency] passed template=${templateId} retry_requests=10 terminate_requests=10`);
}

async function insertInstance(db, id, state, context) {
  const now = new Date().toISOString();
  await db.collection('v2_process_instances').insertOne({
    _id: id,
    process_definition_id: templateId,
    state,
    status: state,
    context,
    created_at: now,
    updated_at: now,
  });
}

async function insertJob(db, instanceId, status) {
  const now = new Date().toISOString();
  const counter = await db.collection('v2_counters').findOneAndUpdate(
    { _id: 'v2_engine_jobs' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  await db.collection('v2_engine_jobs').insertOne({
    _id: Number(counter?.seq || Date.now()),
    instance_id: instanceId,
    token_id: null,
    job_type: 'START',
    run_at: now,
    attempt: 0,
    status,
    payload: {},
    created_at: now,
    updated_at: now,
  });
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
    name: `TEST · instance command idempotency ${Date.now()}`,
    nodes: [
      { id: 'start', type: 'custom', position: { x: 0, y: 0 }, data: { nodeType: 'start', label: 'Start' } },
      { id: 'service', type: 'custom', position: { x: 200, y: 0 }, data: { nodeType: 'service', label: 'Service' } },
      { id: 'end', type: 'custom', position: { x: 400, y: 0 }, data: { nodeType: 'end', label: 'End' } },
    ],
    edges: [
      { id: 'start-service', source: 'start', target: 'service' },
      { id: 'service-end', source: 'service', target: 'end' },
    ],
  };
}

main()
  .catch((error) => {
    console.error('[instance:command-idempotency] failed');
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
          db.collection('v2_instance_command_idempotency').deleteMany({ 'result.instance_id': { $in: instanceIds } }),
          db.collection('v2_process_instances').deleteMany({ process_definition_id: templateId }),
          db.collection('v2_engine_jobs').deleteMany({ instance_id: { $in: instanceIds } }),
          db.collection('v2_tokens').deleteMany({ instance_id: { $in: instanceIds } }),
          db.collection('v2_execution_logs').deleteMany({ instance_id: { $in: instanceIds } }),
          db.collection('v2_event_outbox').deleteMany({ instance_id: { $in: instanceIds } }),
        ]);
      }
    } finally {
      await client.close();
    }
  });
