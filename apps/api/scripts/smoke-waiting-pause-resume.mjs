import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = `pxm_waiting_pause_test_${process.pid}_${Date.now()}`;
const engineEntry = fileURLToPath(new URL('../../engine/target/debug/pxm-engine', import.meta.url));
const client = new MongoClient(mongoUri);
let engine;

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const approval = await seedApprovalFixture(db);
  const timer = await seedTimerFixture(db);

  engine = startEngine();
  await waitFor(() => engine.output.includes('connected and context initialized'), 5_000, 'Engine startup');
  await delay(750);

  const [approvalJobWhilePaused, timerJobWhilePaused, approvedTask] = await Promise.all([
    db.collection('v2_engine_jobs').findOne({ _id: approval.jobId }),
    db.collection('v2_engine_jobs').findOne({ _id: timer.jobId }),
    db.collection('v2_tasks').findOne({ _id: approval.taskId }),
  ]);
  assert.equal(approvalJobWhilePaused?.status, 'QUEUED', 'approved task RESUME job must wait while paused');
  assert.equal(timerJobWhilePaused?.status, 'QUEUED', 'expired TIMER job must wait while paused');
  assert.equal(approvedTask?.status, 'APPROVED', 'approval decision must remain stored while paused');
  assert.equal(await completedNodeCount(db, approval.instanceId, 'end'), 0);
  assert.equal(await completedNodeCount(db, timer.instanceId, 'timer'), 0);

  const resumedAt = new Date().toISOString();
  await db.collection('v2_process_instances').updateMany(
    { _id: { $in: [approval.instanceId, timer.instanceId] } },
    {
      $set: {
        is_paused: false,
        paused_at: null,
        paused_by: null,
        pause_origin_instance_id: null,
        updated_at: resumedAt,
      },
    },
  );

  await waitFor(async () => {
    const instances = await db.collection('v2_process_instances').find({
      _id: { $in: [approval.instanceId, timer.instanceId] },
      state: 'COMPLETED',
    }).toArray();
    return instances.length === 2;
  }, 10_000, 'approval and timer instances to complete after resume');

  assert.equal((await db.collection('v2_engine_jobs').findOne({ _id: approval.jobId }))?.status, 'COMPLETED');
  assert.equal((await db.collection('v2_engine_jobs').findOne({ _id: timer.jobId }))?.status, 'COMPLETED');
  assert.equal(await completedNodeCount(db, approval.instanceId, 'approval'), 1);
  assert.equal(await completedNodeCount(db, timer.instanceId, 'timer'), 1);
  assert.equal(await completedNodeCount(db, approval.instanceId, 'end'), 1);
  assert.equal(await completedNodeCount(db, timer.instanceId, 'end'), 1);

  console.log(
    `[waiting:pause-resume] passed db=${dbName} approval=${approval.instanceId} timer=${timer.instanceId}`,
  );
}

async function seedApprovalFixture(db) {
  const definitionId = randomUUID();
  const instanceId = randomUUID();
  const tokenId = randomUUID();
  const taskId = randomUUID();
  const jobId = 1;
  const now = new Date().toISOString();
  const nodes = [
    node('approval', 'approval', { approvalLine: { mode: 'fixed', assignee: 'admin' } }),
    node('end', 'end'),
  ];
  const edges = [edge('approval', 'end')];
  await seedDefinition(db, definitionId, 'Paused approval fixture', nodes, edges, now);
  await db.collection('v2_process_instances').insertOne(
    instanceDoc(instanceId, definitionId, 'RUNNING', now),
  );
  await db.collection('v2_tokens').insertOne(tokenDoc(tokenId, instanceId, 'approval', 'WAITING', now));
  await db.collection('v2_tasks').insertOne({
    _id: taskId,
    instance_id: instanceId,
    token_id: tokenId,
    node_id: 'approval',
    assignee: 'admin',
    status: 'APPROVED',
    payload: { approval_model: 'fixed' },
    completion: {
      action: 'approve',
      status: 'APPROVED',
      actor_id: 'admin',
      idempotency_key: 'waiting-pause-approval',
      completed_at: now,
    },
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_engine_jobs').insertOne(
    jobDoc(jobId, instanceId, tokenId, 'RESUME', now, {
      action: 'approve',
      completed_node_id: 'approval',
      task_id: taskId,
    }),
  );
  return { instanceId, taskId, jobId };
}

async function seedTimerFixture(db) {
  const definitionId = randomUUID();
  const instanceId = randomUUID();
  const tokenId = randomUUID();
  const jobId = 2;
  const now = new Date().toISOString();
  const nodes = [node('timer', 'timer', { durationMs: '100' }), node('end', 'end')];
  const edges = [edge('timer', 'end')];
  await seedDefinition(db, definitionId, 'Paused timer fixture', nodes, edges, now);
  await db.collection('v2_process_instances').insertOne(
    instanceDoc(instanceId, definitionId, 'WAITING', now),
  );
  await db.collection('v2_tokens').insertOne(tokenDoc(tokenId, instanceId, 'timer', 'WAITING', now));
  await db.collection('v2_engine_jobs').insertOne(
    jobDoc(jobId, instanceId, tokenId, 'TIMER', new Date(Date.now() - 1_000).toISOString(), {
      node_id: 'timer',
    }),
  );
  return { instanceId, jobId };
}

async function seedDefinition(db, id, name, nodes, edges, now) {
  await db.collection('v2_process_definitions').insertOne({
    _id: id,
    name,
    version: 1,
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_process_definition_versions').insertOne({
    _id: `${id}:1`,
    definition_id: id,
    version: 1,
    name,
    metadata: {},
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  });
}

function instanceDoc(id, definitionId, state, now) {
  return {
    _id: id,
    process_definition_id: definitionId,
    state,
    status: state,
    is_paused: true,
    paused_at: now,
    paused_by: 'smoke-test',
    pause_origin_instance_id: id,
    context: {
      runtime: { snapshot: { workflow: { id: definitionId, version: 1 } } },
      data: {},
    },
    created_at: now,
    updated_at: now,
  };
}

function tokenDoc(id, instanceId, nodeId, status, now) {
  return {
    _id: id,
    instance_id: instanceId,
    node_id: nodeId,
    status,
    parent_token_id: null,
    scope_key: null,
    created_at: now,
    updated_at: now,
  };
}

function jobDoc(id, instanceId, tokenId, jobType, runAt, payload) {
  const now = new Date().toISOString();
  return {
    _id: id,
    instance_id: instanceId,
    token_id: tokenId,
    job_type: jobType,
    run_at: runAt,
    attempt: 0,
    status: 'QUEUED',
    payload,
    created_at: now,
    updated_at: now,
  };
}

function node(nodeId, nodeType, config = {}) {
  return { node_id: nodeId, node_type: nodeType, config: { nodeType, ...config } };
}

function edge(source, target) {
  return {
    id: `edge_${source}_${target}`,
    source_node_id: source,
    target_node_id: target,
    condition_expr: null,
    is_default: true,
    eval_order: 0,
  };
}

async function completedNodeCount(db, instanceId, nodeId) {
  return db.collection('v2_execution_logs').countDocuments({
    instance_id: instanceId,
    node_id: nodeId,
    event_type: 'NODE_COMPLETED',
  });
}

function startEngine() {
  const child = spawn(engineEntry, [], {
    env: {
      ...process.env,
      DB_TYPE: 'mongodb',
      MONGODB_URL: mongoUri,
      MONGO_DB_NAME: dbName,
      ENGINE_WORKER_ID: 'waiting-pause-worker',
      ENGINE_POLL_MS: '50',
      ENGINE_STALE_RECLAIM_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.output += chunk.toString(); });
  return child;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (engine?.exitCode !== null) {
      throw new Error(`${label} failed because Engine exited (${engine?.exitCode})\n${engine?.output}`);
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}\n${engine?.output || ''}`);
}

async function stopEngine() {
  if (!engine || engine.exitCode !== null) return;
  const exited = once(engine, 'exit');
  engine.kill('SIGKILL');
  await exited;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error('[waiting:pause-resume] failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopEngine();
    try {
      await client.db(dbName).dropDatabase();
    } finally {
      await client.close();
    }
  });
