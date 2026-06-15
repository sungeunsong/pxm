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
    name: `Smoke Approval ${new Date().toISOString()}`,
    nodes: [
      {
        id: 'start',
        type: 'custom',
        position: { x: 0, y: 0 },
        data: { label: 'Start', nodeType: 'start' },
      },
      {
        id: 'approval',
        type: 'custom',
        position: { x: 220, y: 0 },
        data: { label: 'Manager Approval', nodeType: 'approval', assignee: 'admin' },
      },
      {
        id: 'svc',
        type: 'custom',
        position: { x: 440, y: 0 },
        data: {
          label: 'HTTP Notice',
          nodeType: 'service',
          plugin_id: 'builtin.http_request',
          method: 'GET',
          url: `${apiBaseUrl}/debug/flaky?key=approval-smoke&fail=0`,
        },
      },
      {
        id: 'end',
        type: 'custom',
        position: { x: 660, y: 0 },
        data: { label: 'End', nodeType: 'end' },
      },
    ],
    edges: [
      { id: 'e-start-approval', source: 'start', target: 'approval' },
      { id: 'e-approval-svc', source: 'approval', target: 'svc' },
      { id: 'e-svc-end', source: 'svc', target: 'end' },
    ],
  });

  const execution = await postJson(`${apiBaseUrl}/templates/${template.id}/execute`, {
    formData: { requester: 'smoke', purpose: 'approval-resume' },
  });

  const instanceId = execution.instance_id;
  assert.ok(instanceId, 'execute response must include instance_id');

  const task = await waitFor(async () => {
    const tasks = await getJson(`${apiBaseUrl}/tasks?assignee=admin`);
    return tasks.find((item) => item.instance_id === instanceId && item.node_id === 'approval');
  }, `OPEN approval task for instance ${instanceId}`);

  assert.equal(task.status, 'OPEN');
  assert.ok(task.token_id, 'approval task must keep token_id for RESUME');

  await postJson(`${apiBaseUrl}/tasks/${task.id}/complete`, { action: 'approve' });

  const completed = await waitFor(async () => {
    const instance = await db.collection('v2_process_instances').findOne({ _id: instanceId });
    return instance?.state === 'COMPLETED' ? instance : null;
  }, `COMPLETED instance ${instanceId}`);

  const completedTask = await db.collection('v2_tasks').findOne({ _id: task.id });
  assert.equal(completedTask.status, 'APPROVED');

  const serviceLog = await db.collection('v2_execution_logs').findOne({
    instance_id: instanceId,
    node_id: 'svc',
    event_type: 'NODE_COMPLETED',
  });
  assert.ok(serviceLog, 'service node should complete after approval resume');

  const trace = await getJson(`${apiBaseUrl}/instances/${instanceId}/trace`);
  assert.ok(Array.isArray(trace), 'trace endpoint should return an array');
  assert.ok(
    trace.some((item) => item.event_type === 'TASK_CREATED' && item.node_id === 'approval'),
    'trace should include approval task creation',
  );
  assert.ok(
    trace.some((item) => item.event_type === 'NODE_COMPLETED' && item.node_id === 'svc'),
    'trace should include service completion',
  );
  assert.ok(
    trace.some((item) => item.event_type === 'INSTANCE_COMPLETED'),
    'trace should include instance completion',
  );

  console.log(
    `[mongo:smoke:approval] passed instance=${completed._id} task=${task.id} template=${template.id}`,
  );
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
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
    console.error('[mongo:smoke:approval] failed');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
