import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';

const client = new MongoClient(uri);

async function main() {
  await client.connect();
  const db = client.db(dbName);

  await db.collection('v2_process_definitions').createIndex({ created_at: -1 });
  await db.collection('v2_process_instances').createIndex({ state: 1, created_at: -1 });
  await db.collection('v2_process_instances').createIndex({ process_definition_id: 1 });
  await db.collection('v2_tokens').createIndex({ instance_id: 1, status: 1, created_at: 1 });
  await db.collection('v2_tokens').createIndex({ instance_id: 1, node_id: 1 });
  await db.collection('v2_engine_jobs').createIndex({ status: 1, run_at: 1, _id: 1 });
  await db.collection('v2_engine_jobs').createIndex({ instance_id: 1, _id: 1 });
  await db.collection('v2_tasks').createIndex({ assignee: 1, status: 1, created_at: -1 });
  await db.collection('v2_tasks').createIndex({ token_id: 1 }, { unique: true, sparse: true });
  await db.collection('v2_event_outbox').createIndex({ instance_id: 1, created_at: 1 });
  await db.collection('v2_execution_logs').createIndex({ instance_id: 1, created_at: 1 });
  await db.collection('v2_advisory_locks').createIndex({ created_at: 1 }, { expireAfterSeconds: 3600 });

  console.log(`[mongo:init] indexes ready: ${dbName}`);
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
