#!/usr/bin/env node

import { MongoClient } from 'mongodb';

const args = parseArgs(process.argv.slice(2));
const uri = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';
const dryRun = args.yes !== 'true' && args.yes !== true;

const client = new MongoClient(uri);

main()
  .catch((error) => {
    console.error(`[benchmark:cleanup] failed: ${error?.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });

async function main() {
  await client.connect();
  const db = client.db(dbName);

  const definitions = await db
    .collection('v2_process_definitions')
    .find({
      $or: [
        { group: 'benchmark' },
        { tags: 'benchmark' },
        { name: /^Benchmark / },
        { name: /^Schedule Benchmark / },
        { 'metadata.group': 'benchmark' },
        { 'metadata.tags': 'benchmark' },
      ],
    })
    .project({ _id: 1, name: 1 })
    .toArray();

  const definitionIds = definitions.map((doc) => doc._id);
  const instances = definitionIds.length
    ? await db
        .collection('v2_process_instances')
        .find({ process_definition_id: { $in: definitionIds } })
        .project({ _id: 1 })
        .toArray()
    : [];
  const instanceIds = instances.map((doc) => doc._id);

  const scheduleJobs = definitionIds.length
    ? await db
        .collection('v2_schedule_jobs')
        .find({ definition_id: { $in: definitionIds } })
        .project({ _id: 1 })
        .toArray()
    : [];
  const scheduleJobIds = scheduleJobs.map((doc) => doc._id);

  const plan = [
    ['v2_process_definitions', definitionIds.length ? { _id: { $in: definitionIds } } : null],
    ['v2_process_instances', instanceIds.length ? { _id: { $in: instanceIds } } : null],
    ['v2_engine_jobs', instanceIds.length ? { instance_id: { $in: instanceIds } } : null],
    ['v2_tokens', instanceIds.length ? { instance_id: { $in: instanceIds } } : null],
    ['v2_tasks', instanceIds.length ? { instance_id: { $in: instanceIds } } : null],
    ['v2_execution_logs', instanceIds.length ? { instance_id: { $in: instanceIds } } : null],
    ['v2_event_outbox', instanceIds.length ? { instance_id: { $in: instanceIds } } : null],
    ['v2_schedule_jobs', scheduleJobIds.length ? { _id: { $in: scheduleJobIds } } : null],
    ['v2_schedule_runs', definitionIds.length ? { definition_id: { $in: definitionIds } } : null],
  ];

  const counts = {};
  for (const [collectionName, filter] of plan) {
    counts[collectionName] = filter ? await db.collection(collectionName).countDocuments(filter) : 0;
  }

  console.log(
    JSON.stringify(
      {
        dry_run: dryRun,
        db: dbName,
        benchmark_definitions: definitions.length,
        benchmark_instances: instances.length,
        benchmark_schedule_jobs: scheduleJobs.length,
        collections: counts,
        sample_definitions: definitions.slice(0, 10).map((doc) => ({
          id: doc._id,
          name: doc.name,
        })),
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    console.log('[benchmark:cleanup] dry run only. Re-run with --yes to delete.');
    return;
  }

  for (const [collectionName, filter] of plan) {
    if (!filter) continue;
    const result = await db.collection(collectionName).deleteMany(filter);
    console.log(`[benchmark:cleanup] deleted ${result.deletedCount} from ${collectionName}`);
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    parsed[key] = inlineValue ?? argv[index + 1] ?? true;
    if (inlineValue === undefined && argv[index + 1]?.startsWith('--') === false) {
      index += 1;
    }
  }
  return parsed;
}
