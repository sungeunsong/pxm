import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const mongoUri =
  process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = `pxm_pause_test_${process.pid}_${Date.now()}`;
const engineEntry = fileURLToPath(
  new URL('../../engine/target/debug/pxm-engine', import.meta.url),
);
const client = new MongoClient(mongoUri);
let engine;

async function main() {
  await client.connect();
  const db = client.db(dbName);
  const fixture = await seedFixture(db);

  engine = spawn(engineEntry, [], {
    env: {
      ...process.env,
      DB_TYPE: 'mongodb',
      MONGODB_URL: mongoUri,
      MONGO_DB_NAME: dbName,
      ENGINE_WORKER_ID: 'pause-control-worker',
      ENGINE_POLL_MS: '50',
      ENGINE_STALE_RECLAIM_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine.output = '';
  engine.stdout.on('data', (chunk) => {
    engine.output += chunk.toString();
  });
  engine.stderr.on('data', (chunk) => {
    engine.output += chunk.toString();
  });

  await waitFor(
    () => engine.output.includes('connected and context initialized'),
    5_000,
    'Engine startup',
  );
  await delay(750);
  assert.equal(
    (await db.collection('v2_engine_jobs').findOne({ _id: fixture.jobId }))
      ?.status,
    'QUEUED',
  );
  assert.equal(
    (
      await db
        .collection('v2_process_instances')
        .findOne({ _id: fixture.instanceId })
    )?.state,
    'CREATED',
  );

  await db
    .collection('v2_process_instances')
    .updateOne(
      { _id: fixture.instanceId },
      {
        $set: {
          is_paused: false,
          paused_at: null,
          paused_by: null,
          updated_at: new Date().toISOString(),
        },
      },
    );

  await waitFor(
    async () => {
      const [job, instance] = await Promise.all([
        db.collection('v2_engine_jobs').findOne({ _id: fixture.jobId }),
        db
          .collection('v2_process_instances')
          .findOne({ _id: fixture.instanceId }),
      ]);
      return job?.status === 'COMPLETED' && instance?.state === 'COMPLETED';
    },
    10_000,
    'resumed instance completion',
  );

  console.log(`[instance:pause-resume] passed db=${dbName}`);
}

async function seedFixture(db) {
  const definitionId = randomUUID();
  const instanceId = randomUUID();
  const tokenId = randomUUID();
  const jobId = 1;
  const now = new Date().toISOString();
  const nodes = [
    {
      node_id: 'start',
      node_type: 'start',
      config: { nodeType: 'start', label: 'Start' },
    },
    {
      node_id: 'end',
      node_type: 'end',
      config: { nodeType: 'end', label: 'End' },
    },
  ];
  const edges = [
    {
      id: 'edge_1',
      source_node_id: 'start',
      target_node_id: 'end',
      condition_expr: null,
      is_default: true,
      eval_order: 0,
    },
  ];

  await db.collection('v2_process_definitions').insertOne({
    _id: definitionId,
    name: 'Pause control fixture',
    version: 1,
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_process_definition_versions').insertOne({
    _id: `${definitionId}:1`,
    definition_id: definitionId,
    version: 1,
    name: 'Pause control fixture',
    metadata: {},
    nodes,
    edges,
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_process_instances').insertOne({
    _id: instanceId,
    process_definition_id: definitionId,
    state: 'CREATED',
    status: 'CREATED',
    is_paused: true,
    paused_at: now,
    paused_by: 'smoke-test',
    context: {
      runtime: { snapshot: { workflow: { id: definitionId, version: 1 } } },
      data: {},
    },
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_tokens').insertOne({
    _id: tokenId,
    instance_id: instanceId,
    node_id: 'start',
    status: 'ACTIVE',
    parent_token_id: null,
    scope_key: null,
    created_at: now,
    updated_at: now,
  });
  await db.collection('v2_engine_jobs').insertOne({
    _id: jobId,
    instance_id: instanceId,
    token_id: tokenId,
    job_type: 'START',
    run_at: now,
    attempt: 0,
    status: 'QUEUED',
    payload: { node_id: 'start', reason: 'pause_control_fixture' },
    created_at: now,
    updated_at: now,
  });
  return { instanceId, jobId };
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (engine?.exitCode !== null)
      throw new Error(
        `${label} failed because Engine exited (${engine?.exitCode})\n${engine?.output}`,
      );
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
    console.error('[instance:pause-resume] failed');
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
