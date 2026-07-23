import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = `pxm_restart_test_${process.pid}_${Date.now()}`;
const apiPort = 32_000 + (process.pid % 1_000);
const apiEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const engineEntry = fileURLToPath(new URL('../../engine/target/debug/pxm-engine', import.meta.url));
const client = new MongoClient(mongoUri);
const children = new Set();

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const fixture = await seedRecoveryFixture(db);

  const firstApi = startProcess(process.execPath, [apiEntry], {
    PORT: String(apiPort),
    DB_TYPE: 'mongodb',
    MONGODB_URL: mongoUri,
    MONGO_DB_NAME: dbName,
    SCHEDULE_START_ENABLED: 'false',
    DB_WATCH_START_ENABLED: 'false',
  });
  await waitForHealth(apiPort, firstApi);
  await killProcess(firstApi, 'SIGKILL');

  const restartedApi = startProcess(process.execPath, [apiEntry], {
    PORT: String(apiPort),
    DB_TYPE: 'mongodb',
    MONGODB_URL: mongoUri,
    MONGO_DB_NAME: dbName,
    SCHEDULE_START_ENABLED: 'false',
    DB_WATCH_START_ENABLED: 'false',
  });
  await waitForHealth(apiPort, restartedApi);
  assert.equal((await db.collection('v2_engine_jobs').findOne({ _id: fixture.recoveryJobId }))?.status, 'RUNNING');
  await killProcess(restartedApi, 'SIGKILL');

  const past = new Date(Date.now() - 120_000).toISOString();
  await db.collection('v2_process_instances').updateMany(
    { _id: { $in: [fixture.recoveryInstanceId, fixture.terminalInstanceId] } },
    { $set: { lock_until: past, heartbeat_at: past, updated_at: past } },
  );
  await db.collection('v2_engine_jobs').updateMany(
    { _id: { $in: [fixture.recoveryJobId, fixture.terminalJobId] } },
    { $set: { updated_at: past } },
  );

  const engine = startProcess(engineEntry, [], {
    DB_TYPE: 'mongodb',
    MONGODB_URL: mongoUri,
    MONGO_DB_NAME: dbName,
    ENGINE_WORKER_ID: 'restart-recovery-worker',
    ENGINE_POLL_MS: '50',
    ENGINE_STALE_RECLAIM_INTERVAL_MS: '100',
    ENGINE_STALE_JOB_SECONDS: '60',
  });
  await waitFor(async () => {
    const jobs = await db.collection('v2_engine_jobs').find({ _id: { $in: [fixture.recoveryJobId, fixture.terminalJobId] } }).toArray();
    return jobs.length === 2 && jobs.every((job) => job.status === 'COMPLETED');
  }, 15_000, engine, 'recovered jobs to complete');
  await killProcess(engine, 'SIGKILL');

  const recoveryInstance = await db.collection('v2_process_instances').findOne({ _id: fixture.recoveryInstanceId });
  assert.equal(recoveryInstance?.state, 'COMPLETED');
  assert.equal((await db.collection('v2_process_instances').findOne({ _id: fixture.terminalInstanceId }))?.state, 'COMPLETED');
  assert.equal((await db.collection('v2_engine_jobs').findOne({ _id: fixture.recentRunningJobId }))?.status, 'RUNNING');
  const eventCount = await db.collection('v2_event_outbox').countDocuments({ instance_id: fixture.recoveryInstanceId });
  const logCount = await db.collection('v2_execution_logs').countDocuments({ instance_id: fixture.recoveryInstanceId });

  const secondRestart = startProcess(engineEntry, [], {
    DB_TYPE: 'mongodb',
    MONGODB_URL: mongoUri,
    MONGO_DB_NAME: dbName,
    ENGINE_WORKER_ID: 'restart-verification-worker',
    ENGINE_POLL_MS: '50',
    ENGINE_STALE_RECLAIM_INTERVAL_MS: '100',
    ENGINE_STALE_JOB_SECONDS: '60',
  });
  await waitFor(async () => secondRestart.output.includes('connected and context initialized'), 5_000, secondRestart, 'second Engine restart');
  await delay(500);
  await killProcess(secondRestart, 'SIGKILL');

  assert.equal(await db.collection('v2_event_outbox').countDocuments({ instance_id: fixture.recoveryInstanceId }), eventCount);
  assert.equal(await db.collection('v2_execution_logs').countDocuments({ instance_id: fixture.recoveryInstanceId }), logCount);
  assert.equal((await db.collection('v2_engine_jobs').findOne({ _id: fixture.recentRunningJobId }))?.status, 'RUNNING');

  console.log(`[process:restart-recovery] passed db=${dbName} api_restarts=1 engine_restarts=2`);
}

async function seedRecoveryFixture(db) {
  const definitionId = randomUUID();
  const recoveryInstanceId = randomUUID();
  const terminalInstanceId = randomUUID();
  const recentRunningInstanceId = randomUUID();
  const recoveryJobId = 1;
  const terminalJobId = 2;
  const recentRunningJobId = 3;
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 120_000).toISOString();
  const nodes = [
    { node_id: 'start', node_type: 'start', config: { nodeType: 'start', label: 'Start' } },
    { node_id: 'end', node_type: 'end', config: { nodeType: 'end', label: 'End' } },
  ];
  const edges = [{ id: 'edge_1', source_node_id: 'start', target_node_id: 'end', condition_expr: null, is_default: true, eval_order: 0 }];
  await db.collection('v2_process_definitions').insertOne({
    _id: definitionId,
    name: 'Restart recovery fixture',
    version: 1,
    lifecycle_status: 'PUBLISHED',
    active_published_version: 1,
    metadata: { lifecycle_status: 'PUBLISHED', active_published_version: 1 },
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_process_definition_versions').insertOne({
    _id: `${definitionId}:1`,
    definition_id: definitionId,
    version: 1,
    name: 'Restart recovery fixture',
    metadata: {},
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  });

  const context = { runtime: { snapshot: { workflow: { id: definitionId, version: 1 } } }, data: { formData: {}, outputs: {} } };
  await db.collection('v2_process_instances').insertMany([
    instanceDoc(recoveryInstanceId, definitionId, 'RUNNING', context, 'dead-worker', future, now),
    instanceDoc(terminalInstanceId, definitionId, 'COMPLETED', context, 'dead-worker', future, now),
    instanceDoc(recentRunningInstanceId, definitionId, 'RUNNING', context, null, null, now),
  ]);
  await db.collection('v2_tokens').insertOne({
    _id: randomUUID(),
    instance_id: recoveryInstanceId,
    node_id: 'start',
    status: 'ACTIVE',
    parent_token_id: null,
    scope_key: null,
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_engine_jobs').insertMany([
    jobDoc(recoveryJobId, recoveryInstanceId, 'dead-worker', now),
    jobDoc(terminalJobId, terminalInstanceId, 'dead-worker', now),
    jobDoc(recentRunningJobId, recentRunningInstanceId, 'worker-in-acquire-gap', now),
  ]);

  return { recoveryInstanceId, terminalInstanceId, recentRunningInstanceId, recoveryJobId, terminalJobId, recentRunningJobId };
}

function instanceDoc(id, definitionId, state, context, lockOwner, lockUntil, now) {
  return {
    _id: id,
    process_definition_id: definitionId,
    state,
    status: state,
    context,
    lock_owner: lockOwner,
    lock_until: lockUntil,
    heartbeat_at: now,
    created_at: now,
    updated_at: now,
  };
}

function jobDoc(id, instanceId, lockOwner, now) {
  return {
    _id: id,
    instance_id: instanceId,
    token_id: null,
    job_type: 'START',
    run_at: now,
    attempt: 0,
    status: 'RUNNING',
    lock_owner: lockOwner,
    payload: { node_id: 'start', reason: 'restart_recovery_fixture' },
    created_at: now,
    updated_at: now,
  };
}

function startProcess(command, args, extraEnv) {
  const child = spawn(command, args, {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child.output += chunk.toString(); });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForHealth(port, child) {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
    return response?.ok === true;
  }, 10_000, child, `API health on port ${port}`);
}

async function waitFor(check, timeoutMs, child, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (child.exitCode !== null) throw new Error(`${label} failed because process exited (${child.exitCode})\n${child.output}`);
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}\n${child.output}`);
}

async function killProcess(child, signal) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
  .catch((error) => {
    console.error('[process:restart-recovery] failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) {
      child.kill('SIGKILL');
    }
    try {
      await client.db(dbName).dropDatabase();
    } finally {
      await client.close();
    }
  });
