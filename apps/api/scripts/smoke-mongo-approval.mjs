import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:3000/api';
const mongoUri =
  process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';
const userId = process.env.PXM_DEMO_USER || 'admin';
const password = process.env.PXM_DEMO_PASSWORD || 'admin1234';

const client = new MongoClient(mongoUri);

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const session = await login();

  const template = await postJson(
    `${apiBaseUrl}/templates`,
    {
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
          data: {
            label: 'Dynamic Sequential Approval',
            nodeType: 'approval',
            approvalLineSource: 'dynamic',
            approvalRequestPath: 'approval_request',
          },
        },
        {
          id: 'end',
          type: 'custom',
          position: { x: 440, y: 0 },
          data: { label: 'End', nodeType: 'end' },
        },
      ],
      edges: [
        { id: 'e-start-approval', source: 'start', target: 'approval' },
        { id: 'e-approval-end', source: 'approval', target: 'end' },
      ],
    },
    session,
  );

  const execution = await postJson(
    `${apiBaseUrl}/templates/${template.id}/execute`,
    {
      formData: {
        approval_request: {
          source: 'smoke',
          request_id: `SMOKE-${Date.now()}`,
          content: {
            title: '3단계 순차 결재',
            summary: 'PXM-9 smoke test',
            requester: 'admin',
            source_url: 'https://example.test/approvals/1',
          },
          approval_line: {
            steps: [
              { order: 1, label: '팀장', assignee: 'admin' },
              { order: 2, label: '부서장', assignee: 'admin' },
              { order: 3, label: '대표', assignee: 'admin' },
            ],
          },
        },
      },
    },
    session,
  );

  const instanceId = execution.instance_id;
  assert.ok(instanceId, 'execute response must include instance_id');

  const task = await waitFor(async () => {
    const tasks = await getJson(`${apiBaseUrl}/tasks?assignee=admin`, session);
    return tasks.find(
      (item) => item.instance_id === instanceId && item.node_id === 'approval',
    );
  }, `OPEN approval task for instance ${instanceId}`);

  assert.equal(task.status, 'OPEN');
  assert.ok(task.token_id, 'approval task must keep token_id for RESUME');
  assert.ok(
    task.approval_request_id,
    'approval task must belong to an ApprovalRequest',
  );
  assert.ok(
    task.approval_step_id,
    'approval task must belong to an ApprovalStep',
  );

  const waitingRequest = await db
    .collection('v2_approval_requests')
    .findOne({ _id: task.approval_request_id });
  assert.equal(waitingRequest?.status, 'IN_PROGRESS');
  assert.equal(waitingRequest?.token_id, task.token_id);
  assert.equal(waitingRequest?.total_steps, 3);
  assert.equal(waitingRequest?.external_request_id?.startsWith('SMOKE-'), true);
  assert.equal(waitingRequest?.content_snapshot?.title, '3단계 순차 결재');
  assert.equal(waitingRequest?.approval_line_snapshot?.steps?.length, 3);
  const waitingStep = await db
    .collection('v2_approval_steps')
    .findOne({ _id: task.approval_step_id });
  assert.equal(waitingStep?.request_id, task.approval_request_id);
  assert.equal(waitingStep?.step_order, 1);
  assert.equal(waitingStep?.status, 'OPEN');

  let currentTask = task;
  for (let stepOrder = 1; stepOrder <= 3; stepOrder += 1) {
    await postJson(
      `${apiBaseUrl}/tasks/${currentTask.id}/complete`,
      { action: 'approve' },
      session,
    );

    if (stepOrder < 3) {
      const nextOrder = stepOrder + 1;
      const request = await db
        .collection('v2_approval_requests')
        .findOne({ _id: task.approval_request_id });
      const instance = await db
        .collection('v2_process_instances')
        .findOne({ _id: instanceId });
      assert.equal(request?.status, 'IN_PROGRESS');
      assert.equal(request?.current_step_order, nextOrder);
      assert.equal(instance?.state, 'WAITING');
      assert.equal(
        await db.collection('v2_engine_jobs').countDocuments({
          instance_id: instanceId,
          token_id: task.token_id,
          job_type: 'RESUME',
        }),
        0,
        'intermediate approval must not resume the Engine',
      );
      currentTask = await waitFor(async () => {
        const tasks = await getJson(
          `${apiBaseUrl}/tasks?assignee=admin`,
          session,
        );
        return tasks.find(
          (item) =>
            item.instance_id === instanceId &&
            item.status === 'OPEN' &&
            item.payload?.step_order === nextOrder,
        );
      }, `OPEN approval task for step ${nextOrder}`);
    }
  }

  const completed = await waitFor(async () => {
    const instance = await db
      .collection('v2_process_instances')
      .findOne({ _id: instanceId });
    return instance?.state === 'COMPLETED' ? instance : null;
  }, `COMPLETED instance ${instanceId}`);

  const completedTask = await db
    .collection('v2_tasks')
    .findOne({ _id: task.id });
  assert.equal(completedTask.status, 'APPROVED');
  const completedRequest = await db
    .collection('v2_approval_requests')
    .findOne({ _id: task.approval_request_id });
  assert.equal(completedRequest?.status, 'APPROVED');
  assert.equal(completedRequest?.current_step_order, 3);
  assert.equal(
    await db.collection('v2_approval_steps').countDocuments({
      request_id: task.approval_request_id,
      status: 'APPROVED',
    }),
    3,
  );
  assert.equal(
    await db.collection('v2_engine_jobs').countDocuments({
      instance_id: instanceId,
      token_id: task.token_id,
      job_type: 'RESUME',
    }),
    1,
    'approval aggregate must resume the Engine exactly once',
  );

  const trace = await getJson(
    `${apiBaseUrl}/instances/${instanceId}/trace`,
    session,
  );
  assert.ok(Array.isArray(trace), 'trace endpoint should return an array');
  assert.ok(
    trace.some(
      (item) =>
        item.event_type === 'TASK_CREATED' && item.node_id === 'approval',
    ),
    'trace should include approval task creation',
  );
  assert.ok(
    trace.some(
      (item) =>
        item.event_type === 'APPROVAL_REQUEST_COMPLETED' &&
        item.payload?.approval_request_id === task.approval_request_id,
    ),
    'trace should include aggregate approval completion',
  );
  assert.ok(
    trace.some((item) => item.event_type === 'INSTANCE_COMPLETED'),
    'trace should include instance completion',
  );

  console.log(
    `[mongo:smoke:approval] passed instance=${completed._id} task=${task.id} template=${template.id}`,
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
  return {
    cookie: cookies.map((value) => value.split(';')[0]).join('; '),
    csrf: decodeURIComponent(
      cookies
        .map((value) => value.split(';')[0])
        .find((value) => value.startsWith('pxm_csrf='))
        ?.split('=')[1] || '',
    ),
  };
}

async function getJson(url, session) {
  const response = await fetch(url, {
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function postJson(url, body, session) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${await response.text()}`,
    );
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

  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`,
  );
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
