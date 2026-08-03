import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const workspace = resolve(import.meta.dirname, '../../..');
const runId = `${Date.now()}-${process.pid}`;
const sourceName = `pxm-rehearsal-source-${runId}`;
const restoreName = `pxm-rehearsal-restore-${runId}`;
const sourcePort = Number(process.env.PXM_REHEARSAL_SOURCE_PORT || 27217);
const restorePort = Number(process.env.PXM_REHEARSAL_RESTORE_PORT || 27218);
const replicaSet = 'pxmRehearsalRs';
const sourceDb = `pxm_rehearsal_${Date.now()}_${process.pid}`;
const sourceUrl = `mongodb://127.0.0.1:${sourcePort}/?replicaSet=${replicaSet}&directConnection=true`;
const temporaryDir = await mkdtemp(join(tmpdir(), 'pxm-rehearsal-'));
const archive = join(temporaryDir, 'pxm.archive.gz');
let sourceStarted = false;
let restoreStarted = false;

try {
  startMongo(sourceName, sourcePort, ['--replSet', replicaSet]);
  sourceStarted = true;
  await initializeReplicaSet(sourceName, sourcePort);
  seedBackupFixture(sourceName, sourcePort, sourceDb);

  run('docker', [
    'exec', sourceName, 'mongodump', '--port', String(sourcePort), '--db', sourceDb,
    '--archive=/tmp/pxm.archive.gz', '--gzip',
  ]);
  run('docker', ['cp', `${sourceName}:/tmp/pxm.archive.gz`, archive]);

  startMongo(restoreName, restorePort, []);
  restoreStarted = true;
  await waitForMongo(restoreName, restorePort);
  run('docker', ['cp', archive, `${restoreName}:/tmp/pxm.archive.gz`]);
  run('docker', [
    'exec', restoreName, 'mongorestore', '--port', String(restorePort),
    '--archive=/tmp/pxm.archive.gz', '--gzip',
  ]);
  verifyRestore(restoreName, restorePort, sourceDb);

  await runAsync('node', ['apps/api/scripts/smoke-process-restart-recovery.mjs'], {
    ...process.env,
    MONGODB_URL: sourceUrl,
    PXM_PLUGIN_MANIFEST_DIR: resolve(workspace, 'apps/api/plugin-manifests'),
  });
  process.stdout.write(`[beta:rehearsal] passed backup_restore=1 api_restart=1 engine_restart=2 db=${sourceDb}\n`);
} finally {
  if (restoreStarted) stopContainer(restoreName);
  if (sourceStarted) stopContainer(sourceName);
  await rm(temporaryDir, { recursive: true, force: true });
}

function startMongo(name, port, extraArgs) {
  const result = spawnSync('docker', [
    'run', '--detach', '--rm', '--name', name, '--network', 'host', 'mongo:7.0',
    'mongod', '--bind_ip_all', '--port', String(port), ...extraArgs,
  ], { cwd: workspace, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`failed to start ${name}: ${result.stderr || result.stdout}`);
}

async function initializeReplicaSet(name, port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = spawnSync('docker', [
      'exec', name, 'mongosh', '--quiet', '--port', String(port), '--eval',
      `try { rs.status().ok } catch { rs.initiate({_id:'${replicaSet}',members:[{_id:0,host:'127.0.0.1:${port}'}]}).ok }`,
    ], { cwd: workspace, encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim().endsWith('1')) return;
    await delay(500);
  }
  throw new Error('timed out initializing rehearsal replica set');
}

async function waitForMongo(name, port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync('docker', [
      'exec', name, 'mongosh', '--quiet', '--port', String(port), '--eval', 'db.runCommand({ping:1}).ok',
    ], { cwd: workspace, encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim().endsWith('1')) return;
    await delay(300);
  }
  throw new Error(`timed out waiting for ${name}`);
}

function seedBackupFixture(container, port, database) {
  const document = JSON.stringify({
    _id: `backup-fixture-${runId}`,
    name: 'PXM backup restore rehearsal fixture',
    nodes: [],
    edges: [],
    lifecycle_status: 'PUBLISHED',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  run('docker', [
    'exec', container, 'mongosh', '--quiet', '--port', String(port), '--eval',
    `db.getSiblingDB(${JSON.stringify(database)}).v2_process_definitions.insertOne(${document}).acknowledged`,
  ]);
}

function verifyRestore(container, port, database) {
  const result = spawnSync('docker', [
    'exec', container, 'mongosh', '--quiet', '--port', String(port), '--eval',
    `db.getSiblingDB(${JSON.stringify(database)}).v2_process_definitions.countDocuments({_id:${JSON.stringify(`backup-fixture-${runId}`)}})`,
  ], { cwd: workspace, encoding: 'utf8' });
  if (result.status !== 0 || result.stdout.trim() !== '1') {
    throw new Error(`restored workflow fixture was not found: ${result.stderr || result.stdout}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
}

function runAsync(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: workspace, env, stdio: 'inherit' });
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function stopContainer(name) {
  spawnSync('docker', ['stop', '--time', '5', name], { cwd: workspace, stdio: 'ignore' });
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
