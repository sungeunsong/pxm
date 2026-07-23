import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';

const client = new MongoClient(uri);

async function main() {
  await client.connect();
  const db = client.db(dbName);

  await ensureValidators(db);
  await db.collection('v2_process_definitions').createIndex({ created_at: -1 });
  await db.collection('v2_process_instances').createIndex({ state: 1, created_at: -1 });
  await db.collection('v2_process_instances').createIndex({ process_definition_id: 1 });
  await db.collection('v2_tokens').createIndex({ instance_id: 1, status: 1, created_at: 1 });
  await db.collection('v2_tokens').createIndex({ instance_id: 1, node_id: 1 });
  await db.collection('v2_engine_jobs').createIndex({ status: 1, run_at: 1, _id: 1 });
  await db.collection('v2_engine_jobs').createIndex({ instance_id: 1, _id: 1 });
  await db.collection('v2_start_idempotency').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection('v2_instance_command_idempotency').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection('v2_schedule_jobs').createIndex({ active: 1, status: 1, next_run_at: 1, _id: 1 });
  await db.collection('v2_schedule_jobs').createIndex({ definition_id: 1 });
  await db.collection('v2_schedule_runs').createIndex({ definition_id: 1, created_at: -1 });
  await db.collection('v2_schedule_runs').createIndex({ schedule_job_id: 1, created_at: -1 });
  await db.collection('v2_tasks').createIndex({ assignee: 1, status: 1, created_at: -1 });
  await db.collection('v2_tasks').createIndex({ status: 1, created_at: -1, _id: -1 }, { name: 'idx_v2_tasks_history' });
  await db.collection('v2_tasks').createIndex({ token_id: 1 }, { unique: true, sparse: true });
  await db.collection('v2_tasks').createIndex(
    { 'payload.external_approval.token_hash': 1 },
    { unique: true, sparse: true, name: 'ux_v2_tasks_external_approval_token_hash' },
  );
  await db.collection('v2_tasks').createIndex(
    { status: 1, 'payload.approver_channel': 1, 'payload.external_approval.delivery_status': 1, created_at: 1 },
    { name: 'idx_v2_tasks_external_approval_dispatch' },
  );
  await db.collection('v2_event_outbox').createIndex({ instance_id: 1, created_at: 1 });
  await db.collection('v2_execution_logs').createIndex({ instance_id: 1, created_at: 1 });
  await ensureAdvisoryLockIndexes(db);
  await pruneExpiredAdvisoryLocks(db);

  console.log(`[mongo:init] indexes ready: ${dbName}`);
}

async function ensureValidators(db) {
  await upsertValidator(db, 'v2_process_definitions', {
    bsonType: 'object',
    required: ['_id', 'name', 'nodes', 'edges', 'created_at', 'updated_at'],
    properties: {
      _id: { bsonType: 'string' },
      name: { bsonType: 'string' },
      nodes: { bsonType: 'array' },
      edges: { bsonType: 'array' },
      created_at: { bsonType: 'string' },
      updated_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_process_instances', {
    bsonType: 'object',
    required: ['_id', 'process_definition_id', 'state', 'context', 'created_at', 'updated_at'],
    properties: {
      _id: { bsonType: 'string' },
      process_definition_id: { bsonType: 'string' },
      state: { enum: ['CREATED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'TERMINATED'] },
      context: { bsonType: 'object' },
      lock_owner: { bsonType: ['string', 'null'] },
      lock_until: { bsonType: ['string', 'null'] },
      heartbeat_at: { bsonType: ['string', 'null'] },
      created_at: { bsonType: 'string' },
      updated_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_tokens', {
    bsonType: 'object',
    required: ['_id', 'instance_id', 'node_id', 'status', 'created_at', 'updated_at'],
    properties: {
      _id: { bsonType: 'string' },
      instance_id: { bsonType: 'string' },
      node_id: { bsonType: 'string' },
      status: { enum: ['ACTIVE', 'WAITING', 'COMPLETED', 'CONSUMED', 'FAILED'] },
      parent_token_id: { bsonType: ['string', 'null'] },
      scope_key: { bsonType: ['string', 'null'] },
      created_at: { bsonType: 'string' },
      updated_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_engine_jobs', {
    bsonType: 'object',
    required: ['_id', 'instance_id', 'job_type', 'run_at', 'attempt', 'status', 'payload', 'created_at', 'updated_at'],
    properties: {
      _id: { bsonType: ['long', 'int', 'double'] },
      instance_id: { bsonType: 'string' },
      token_id: { bsonType: ['string', 'null'] },
      job_type: { enum: ['START', 'RESUME', 'RETRY', 'TIMER', 'REMINDER', 'ESCALATION'] },
      run_at: { bsonType: 'string' },
      attempt: { bsonType: ['int', 'long', 'double'] },
      status: { enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'] },
      payload: { bsonType: 'object' },
      created_at: { bsonType: 'string' },
      updated_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_start_idempotency', {
    bsonType: 'object',
    required: ['_id', 'request_hash', 'instance_id', 'definition_id', 'expires_at', 'created_at'],
    properties: {
      _id: { bsonType: 'string' },
      request_hash: { bsonType: 'string' },
      instance_id: { bsonType: 'string' },
      definition_id: { bsonType: 'string' },
      expires_at: { bsonType: 'date' },
      created_at: { bsonType: 'date' },
    },
  });

  await upsertValidator(db, 'v2_instance_command_idempotency', {
    bsonType: 'object',
    required: ['_id', 'request_hash', 'result', 'expires_at', 'created_at'],
    properties: {
      _id: { bsonType: 'string' },
      request_hash: { bsonType: 'string' },
      result: { bsonType: 'object' },
      expires_at: { bsonType: 'date' },
      created_at: { bsonType: 'date' },
    },
  });

  await upsertValidator(db, 'v2_schedule_jobs', {
    bsonType: 'object',
    required: [
      '_id',
      'definition_id',
      'definition_name',
      'start_node_id',
      'schedule_type',
      'next_run_at',
      'active',
      'status',
      'input',
      'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'string' },
      definition_id: { bsonType: 'string' },
      definition_name: { bsonType: 'string' },
      start_node_id: { bsonType: 'string' },
      schedule_type: { enum: ['interval', 'cron'] },
      interval_seconds: { bsonType: ['int', 'long', 'double', 'null'] },
      cron_expression: { bsonType: ['string', 'null'] },
      input: { bsonType: 'object' },
      next_run_at: { bsonType: 'string' },
      active: { bsonType: 'bool' },
      status: { enum: ['WAITING', 'RUNNING', 'DISABLED'] },
      lock_owner: { bsonType: ['string', 'null'] },
      locked_until: { bsonType: ['string', 'null'] },
      last_run_at: { bsonType: ['string', 'null'] },
      last_instance_id: { bsonType: ['string', 'null'] },
      last_error: { bsonType: ['string', 'null'] },
      created_at: { bsonType: 'string' },
      updated_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_schedule_runs', {
    bsonType: 'object',
    required: [
      '_id',
      'schedule_job_id',
      'definition_id',
      'scheduled_for',
      'fired_at',
      'status',
      'created_at',
    ],
    properties: {
      _id: { bsonType: 'string' },
      schedule_job_id: { bsonType: 'string' },
      definition_id: { bsonType: 'string' },
      instance_id: { bsonType: ['string', 'null'] },
      scheduled_for: { bsonType: 'string' },
      fired_at: { bsonType: 'string' },
      status: { enum: ['STARTED', 'FAILED'] },
      error: { bsonType: ['string', 'null'] },
      created_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_tasks', {
    bsonType: 'object',
    required: ['_id', 'instance_id', 'token_id', 'node_id', 'assignee', 'status', 'payload', 'created_at', 'updated_at'],
    properties: {
      _id: { bsonType: 'string' },
      instance_id: { bsonType: 'string' },
      token_id: { bsonType: ['string', 'null'] },
      node_id: { bsonType: 'string' },
      assignee: { bsonType: 'string' },
      status: { enum: ['OPEN', 'APPROVED', 'REJECTED', 'CANCELED'] },
      payload: { bsonType: 'object' },
      created_at: { bsonType: 'string' },
      updated_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_execution_logs', {
    bsonType: 'object',
    required: ['instance_id', 'event_type', 'payload', 'created_at'],
    properties: {
      instance_id: { bsonType: 'string' },
      token_id: { bsonType: ['string', 'null'] },
      node_id: { bsonType: ['string', 'null'] },
      event_type: { bsonType: 'string' },
      payload: { bsonType: 'object' },
      created_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_event_outbox', {
    bsonType: 'object',
    required: ['instance_id', 'event_type', 'payload', 'created_at'],
    properties: {
      instance_id: { bsonType: 'string' },
      token_id: { bsonType: ['string', 'null'] },
      node_id: { bsonType: ['string', 'null'] },
      event_type: { bsonType: 'string' },
      payload: { bsonType: 'object' },
      created_at: { bsonType: 'string' },
    },
  });

  await upsertValidator(db, 'v2_advisory_locks', {
    bsonType: 'object',
    required: ['_id', 'created_at'],
    properties: {
      _id: { bsonType: 'string' },
      created_at: { bsonType: 'string' },
    },
  });
}

async function upsertValidator(db, collectionName, jsonSchema) {
  const validator = { $jsonSchema: jsonSchema };
  try {
    await db.createCollection(collectionName, {
      validator,
      validationLevel: 'moderate',
      validationAction: 'error',
    });
  } catch (err) {
    if (err?.codeName !== 'NamespaceExists' && err?.code !== 48) {
      throw err;
    }
    await db.command({
      collMod: collectionName,
      validator,
      validationLevel: 'moderate',
      validationAction: 'error',
    });
  }
}

async function ensureAdvisoryLockIndexes(db) {
  const collection = db.collection('v2_advisory_locks');
  const indexes = await collection.indexes();
  const conflictingIndex = indexes.find(
    (index) => index.name === 'created_at_1' && index.expireAfterSeconds !== undefined,
  );
  if (conflictingIndex) {
    await collection.dropIndex(conflictingIndex.name);
  }
  await collection.createIndex({ created_at: 1 });
}

async function pruneExpiredAdvisoryLocks(db) {
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  await db.collection('v2_advisory_locks').deleteMany({ created_at: { $lt: staleBefore } });
}

main()
  .catch((err) => {
    console.error('[mongo:init] failed');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });
