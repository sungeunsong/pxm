import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3000/api';
const mongoUri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';

const client = new MongoClient(mongoUri);

async function main() {
  await client.connect();
  const db = client.db(dbName);

  const template = await postJson(`${apiBaseUrl}/templates`, {
    name: `Smoke Parallel Gateway ${new Date().toISOString()}`,
    nodes: [
      node('start', 'start', 'Start', 0),
      node('fork', 'gateway', 'Parallel Fork', 180, { gatewayType: 'parallel' }),
      node('http_one', 'service', 'HTTP Branch One', 380, {
        plugin_id: 'builtin.http_request',
        method: 'GET',
        url: `${apiBaseUrl}/debug/flaky?key=gateway-smoke-one&fail=0`,
      }),
      node('http_two', 'service', 'HTTP Branch Two', 380, {
        plugin_id: 'builtin.http_request',
        method: 'GET',
        url: `${apiBaseUrl}/debug/flaky?key=gateway-smoke-two&fail=0`,
      }),
      node('join', 'gateway', 'Parallel Join', 620, { gatewayType: 'parallel' }),
      node('end', 'end', 'End', 820),
    ],
    edges: [
      edge('e-start-fork', 'start', 'fork'),
      edge('e-fork-http-one', 'fork', 'http_one'),
      edge('e-fork-http-two', 'fork', 'http_two'),
      edge('e-http-one-join', 'http_one', 'join'),
      edge('e-http-two-join', 'http_two', 'join'),
      edge('e-join-end', 'join', 'end'),
    ],
  });

  const execution = await postJson(`${apiBaseUrl}/templates/${template.id}/execute`, {
    formData: { requester: 'smoke', purpose: 'parallel-gateway' },
  });
  const instanceId = execution.instance_id;
  assert.ok(instanceId, 'execute response must include instance_id');

  const completed = await waitFor(async () => {
    const instance = await db.collection('v2_process_instances').findOne({ _id: instanceId });
    return instance?.state === 'COMPLETED' ? instance : null;
  }, `COMPLETED parallel gateway instance ${instanceId}`);

  for (const nodeId of ['http_one', 'http_two', 'join', 'end']) {
    const log = await db.collection('v2_execution_logs').findOne({
      instance_id: instanceId,
      node_id: nodeId,
      event_type: 'NODE_COMPLETED',
    });
    assert.ok(log, `${nodeId} should complete`);
  }

  const consumedJoinTokens = await db.collection('v2_tokens').countDocuments({
    instance_id: instanceId,
    node_id: 'join',
    status: 'CONSUMED',
  });
  assert.equal(consumedJoinTokens, 2, 'parallel join should consume both arriving branch tokens');

  console.log(
    `[mongo:smoke:gateway] passed instance=${completed._id} template=${template.id}`,
  );
}

function node(id, nodeType, label, x, extraData = {}) {
  return {
    id,
    type: 'custom',
    position: { x, y: id === 'http_two' ? 140 : 0 },
    data: { label, nodeType, ...extraData },
  };
}

function edge(id, source, target) {
  return { id, source, target };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

async function waitFor(probe, label, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

main()
  .catch((err) => {
    console.error('[mongo:smoke:gateway] failed');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
