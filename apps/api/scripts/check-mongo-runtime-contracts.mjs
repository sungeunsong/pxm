import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';

const client = new MongoClient(uri);

async function main() {
  await client.connect();
  const db = client.db(dbName);

  await assertReplicaSet(client);
  await assertTaskTokenUnique(db);
  await assertLeaseAcquireContract(db);
  await assertStaleJobReclaimContract(db);

  console.log(`[mongo:contracts] runtime contracts passed: ${dbName}`);
}

async function assertReplicaSet(client) {
  const hello = await client.db('admin').command({ hello: 1 });
  assert.ok(hello.setName, 'Mongo runtime requires replica set or managed cluster mode');
}

async function assertTaskTokenUnique(db) {
  const tokenId = randomUUID();
  const instanceId = randomUUID();
  const now = new Date().toISOString();

  await db.collection('v2_tasks').insertOne({
    _id: randomUUID(),
    instance_id: instanceId,
    token_id: tokenId,
    node_id: 'approval',
    assignee: 'admin',
    status: 'OPEN',
    payload: {},
    created_at: now,
    updated_at: now,
  });

  await assert.rejects(
    () =>
      db.collection('v2_tasks').insertOne({
        _id: randomUUID(),
        instance_id: instanceId,
        token_id: tokenId,
        node_id: 'approval',
        assignee: 'admin',
        status: 'OPEN',
        payload: {},
        created_at: now,
        updated_at: now,
      }),
    /duplicate key/,
    'v2_tasks.token_id must be unique for approval idempotency',
  );

  await db.collection('v2_tasks').deleteMany({ token_id: tokenId });
}

async function assertLeaseAcquireContract(db) {
  const instanceId = randomUUID();
  const definitionId = randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const futureIso = new Date(now.getTime() + 60_000).toISOString();
  const pastIso = new Date(now.getTime() - 60_000).toISOString();

  await db.collection('v2_process_instances').insertOne({
    _id: instanceId,
    process_definition_id: definitionId,
    state: 'CREATED',
    status: 'CREATED',
    context: {},
    lock_owner: null,
    lock_until: null,
    heartbeat_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  });

  const acquireFilter = (workerId, nowText) => ({
    _id: instanceId,
    $or: [{ lock_until: null }, { lock_until: { $lt: nowText } }, { lock_owner: workerId }],
  });

  const firstAcquire = await db.collection('v2_process_instances').updateOne(acquireFilter('worker-a', nowIso), {
    $set: {
      lock_owner: 'worker-a',
      lock_until: futureIso,
      heartbeat_at: nowIso,
      updated_at: nowIso,
    },
  });
  assert.equal(firstAcquire.modifiedCount, 1, 'first worker should acquire an empty lease');

  const competingAcquire = await db.collection('v2_process_instances').updateOne(acquireFilter('worker-b', nowIso), {
    $set: {
      lock_owner: 'worker-b',
      lock_until: futureIso,
      heartbeat_at: nowIso,
      updated_at: nowIso,
    },
  });
  assert.equal(competingAcquire.modifiedCount, 0, 'second worker must not acquire a live lease');

  await db.collection('v2_process_instances').updateOne(
    { _id: instanceId },
    { $set: { lock_until: pastIso, updated_at: nowIso } },
  );

  const expiredAcquire = await db.collection('v2_process_instances').updateOne(acquireFilter('worker-b', nowIso), {
    $set: {
      lock_owner: 'worker-b',
      lock_until: futureIso,
      heartbeat_at: nowIso,
      updated_at: nowIso,
    },
  });
  assert.equal(expiredAcquire.modifiedCount, 1, 'second worker should acquire an expired lease');

  await db.collection('v2_process_instances').deleteOne({ _id: instanceId });
}

async function assertStaleJobReclaimContract(db) {
  const definitionId = randomUUID();
  const instanceId = randomUUID();
  const jobId = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const pastIso = new Date(now.getTime() - 60_000).toISOString();

  await db.collection('v2_process_instances').insertOne({
    _id: instanceId,
    process_definition_id: definitionId,
    state: 'RUNNING',
    status: 'RUNNING',
    context: {},
    lock_owner: 'worker-old',
    lock_until: pastIso,
    heartbeat_at: pastIso,
    created_at: nowIso,
    updated_at: nowIso,
  });

  await db.collection('v2_engine_jobs').insertOne({
    _id: jobId,
    instance_id: instanceId,
    token_id: null,
    job_type: 'START',
    run_at: pastIso,
    attempt: 0,
    status: 'RUNNING',
    payload: {},
    lock_owner: 'worker-old',
    created_at: nowIso,
    updated_at: nowIso,
  });

  const staleIds = await db
    .collection('v2_engine_jobs')
    .aggregate([
      { $match: { status: 'RUNNING' } },
      {
        $lookup: {
          from: 'v2_process_instances',
          localField: 'instance_id',
          foreignField: '_id',
          as: 'inst',
        },
      },
      { $unwind: { path: '$inst', preserveNullAndEmptyArrays: true } },
      {
        $match: {
          $or: [
            { inst: { $exists: false } },
            { 'inst.lock_until': null },
            { 'inst.lock_until': { $lt: nowIso } },
          ],
        },
      },
      { $project: { _id: 1 } },
    ])
    .toArray();

  assert.ok(staleIds.some((doc) => doc._id === jobId), 'stale RUNNING job should be reclaimable');

  await db.collection('v2_engine_jobs').updateMany(
    { _id: { $in: staleIds.map((doc) => doc._id) } },
    { $set: { status: 'QUEUED', run_at: nowIso, updated_at: nowIso } },
  );

  const reclaimedJob = await db.collection('v2_engine_jobs').findOne({ _id: jobId });
  assert.equal(reclaimedJob.status, 'QUEUED', 'stale job should be moved back to QUEUED');

  await db.collection('v2_engine_jobs').deleteOne({ _id: jobId });
  await db.collection('v2_process_instances').deleteOne({ _id: instanceId });
}

main()
  .catch((err) => {
    console.error('[mongo:contracts] failed');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
