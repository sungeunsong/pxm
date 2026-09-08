import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { countPlaywrightTests } from './run-result.mjs';

const packageDir = dirname(fileURLToPath(import.meta.url));
const workspaceDir = resolve(packageDir, '../..');
const resultDir = resolve(packageDir, 'test-results');
const logDir = resolve(resultDir, 'server-logs');
const runId = `${Date.now()}_${process.pid}`;
const databaseName = `pxm_e2e_${runId}`;
const apiPort = numberEnv('PXM_E2E_API_PORT', 3211);
const webPort = numberEnv('PXM_E2E_WEB_PORT', 5274);
const smtpPort = numberEnv('PXM_E2E_SMTP_PORT', 1126);
const mailpitPort = numberEnv('PXM_E2E_MAILPIT_PORT', 8126);
const mongoPort = numberEnv('PXM_E2E_MONGO_PORT', 27127);
const postgresPort = numberEnv('PXM_E2E_POSTGRES_PORT', 55432);
const demoServicePort = numberEnv('PXM_E2E_DEMO_SERVICE_PORT', 3320);
const suite = process.env.PXM_E2E_SUITE === 'demo' ? 'demo' : 'regression';
const mongoReplicaSet = 'pxmE2eRs';
const mongoDatabaseName = `pxm_e2e_${runId}`;
const mongoUrl = `mongodb://127.0.0.1:${mongoPort}/?replicaSet=${mongoReplicaSet}&directConnection=true`;
const mailpitContainer = `pxm-e2e-mailpit-${runId.replace(/_/g, '-')}`;
const mongoContainer = `pxm-e2e-mongo-${runId.replace(/_/g, '-')}`;
const postgresContainer = `pxm-e2e-postgres-${runId.replace(/_/g, '-')}`;
const bootstrapPassword = process.env.PXM_E2E_ADMIN_PASSWORD || 'E2eAdminPassword!2026';
const children = [];
let adminPool;
let testPool;
let mailpitStarted = false;
let mongoStarted = false;
let postgresStarted = false;
let exitCode = 1;
let phase = 'bootstrap';

validateDatabaseName(databaseName);

try {
  await rm(resultDir, { recursive: true, force: true });
  await mkdir(logDir, { recursive: true });
  if (process.env.PXM_E2E_EXTERNAL_POSTGRES !== 'true') {
    startPostgres();
    postgresStarted = true;
    await waitForPostgres();
  }
  adminPool = new Pool(adminConnection());
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  testPool = new Pool(testConnection());
  await applyMigrations(testPool);

  startMongo();
  mongoStarted = true;
  await initializeMongoReplicaSet();

  if (process.env.PXM_E2E_EXTERNAL_MAILPIT !== 'true') {
    startMailpit();
    mailpitStarted = true;
  }
  await waitForHttp(`http://127.0.0.1:${mailpitPort}/api/v1/info`, 30_000);

  const sharedEnv = {
    ...process.env,
    DB_TYPE: 'mongodb',
    PGHOST: process.env.PXM_E2E_PGHOST || process.env.PGHOST || '127.0.0.1',
    PGPORT: String(numberEnv('PXM_E2E_PGPORT', Number(process.env.PGPORT || 5432))),
    PGUSER: process.env.PXM_E2E_PGUSER || process.env.PGUSER || 'pxm',
    PGPASSWORD: process.env.PXM_E2E_PGPASSWORD || process.env.PGPASSWORD || 'bpm',
    PGDATABASE: databaseName,
    DATABASE_URL: databaseUrl(databaseName),
    MONGODB_URL: mongoUrl,
    MONGO_DB_NAME: mongoDatabaseName,
    PXM_BOOTSTRAP_ADMIN_ID: 'admin',
    PXM_BOOTSTRAP_ADMIN_NAME: 'E2E 관리자',
    PXM_BOOTSTRAP_ADMIN_PASSWORD: bootstrapPassword,
    PXM_E2E_ADMIN_PASSWORD: bootstrapPassword,
    PXM_E2E_API_PORT: String(apiPort),
    PXM_E2E_WEB_PORT: String(webPort),
    PXM_E2E_MAILPIT_PORT: String(mailpitPort),
    PXM_E2E_MAILPIT_API_URL: `http://127.0.0.1:${mailpitPort}/api/v1`,
    PXM_E2E_DATABASE_NAME: databaseName,
    API_BASE_URL: `http://127.0.0.1:${apiPort}/api`,
    PXM_DEMO_USER: 'admin',
    PXM_DEMO_PASSWORD: bootstrapPassword,
    PXM_DEMO_SERVICE_PORT: String(demoServicePort),
    PXM_DEMO_SERVICE_URL: `http://127.0.0.1:${demoServicePort}`,
    PXM_DEMO_MAILPIT_API_URL: `http://127.0.0.1:${mailpitPort}/api/v1`,
    PXM_DEMO_ACCESS_FILE: resolve(resultDir, 'demo-access.json'),
    PXM_DEMO_ALLOW_E2E_DATABASE: suite === 'demo' ? 'true' : 'false',
  };

  const mongoInit = await runCommand('node', ['apps/api/scripts/init-mongo-indexes.mjs'], sharedEnv);
  if (mongoInit.code !== 0) throw new Error('MongoDB runtime index initialization failed');

  children.push(startProcess('engine', 'cargo', [
    'run', '--manifest-path', 'apps/engine/Cargo.toml',
  ], {
    ...sharedEnv,
    ENGINE_WORKER_ID: `e2e-engine-${runId}`,
    ENGINE_POLL_MS: '50',
    ENGINE_STALE_RECLAIM_INTERVAL_MS: '500',
  }));
  children.push(startProcess('api', 'pnpm', ['--filter', 'api', 'start'], {
    ...sharedEnv,
    NODE_ENV: 'test',
    PORT: String(apiPort),
    PGPOOL_MAX: '5',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    PXM_SMTP_FROM: 'PXM E2E <no-reply@pxm.test>',
    PXM_PUBLIC_WEB_URL: `http://127.0.0.1:${webPort}`,
    EXTERNAL_APPROVAL_POLL_MS: '1000',
    APPROVAL_NOTIFICATION_POLL_MS: '1000',
  }));
  children.push(startProcess('web', 'pnpm', [
    '--filter', 'web', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort),
  ], {
    ...sharedEnv,
    VITE_API_TARGET: `http://127.0.0.1:${apiPort}`,
  }));
  if (suite === 'demo') {
    children.push(startProcess('demo-service', 'node', ['apps/api/scripts/demo/service.mjs'], sharedEnv));
  }

  await Promise.all([
    waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, 60_000),
    waitForHttp(`http://127.0.0.1:${webPort}`, 60_000),
    ...(suite === 'demo' ? [waitForHttp(`http://127.0.0.1:${demoServicePort}/health`, 30_000)] : []),
  ]);

  if (suite === 'demo') {
    phase = 'scenario';
    for (const [label, args] of [
      ['reset', ['apps/api/scripts/demo/manage.mjs', 'reset']],
      ['seed', ['apps/api/scripts/demo/manage.mjs', 'seed']],
      ['scenario check', ['apps/api/scripts/demo/check.mjs']],
    ]) {
      const step = await runCommand('node', args, sharedEnv);
      if (step.code !== 0) throw new Error(`Demo ${label} failed`);
    }
  }

  phase = 'regression';
  const result = await runCommand('pnpm', [
    '--filter', '@pxm/e2e', 'exec', 'playwright', 'test', '--config',
    suite === 'demo' ? 'playwright.demo.config.ts' : 'playwright.config.ts',
  ], sharedEnv);
  const executedTests = await readExecutedTestCount();
  exitCode = result.code ?? 1;
  if (exitCode === 0) {
    process.stdout.write(`PXM ${suite} browser regression passed. Executed tests: ${executedTests}\n`);
    await rm(logDir, { recursive: true, force: true });
  } else if (executedTests === 0) {
    exitCode = 3;
    process.stderr.write(`PXM browser regression did not run any tests. Runner/configuration failure. Artifacts: ${resultDir}\n`);
  } else {
    process.stderr.write(`PXM browser regression failed. Executed tests: ${executedTests}. Artifacts: ${resultDir}\n`);
  }
} catch (error) {
  exitCode = phase === 'bootstrap' ? 2 : phase === 'scenario' ? 1 : 3;
  const category = phase === 'bootstrap' ? 'infrastructure bootstrap' : phase === 'scenario' ? 'demo scenario' : 'test runner';
  const retry = phase === 'bootstrap' ? ' This failure may be retried.' : '';
  process.stderr.write(`PXM E2E ${category} failed before a browser regression result was available.${retry}\n`);
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
} finally {
  await stopChildren();
  if (testPool) await testPool.end().catch(() => undefined);
  if (mailpitStarted) {
    spawnSync('docker', ['stop', '--time', '5', mailpitContainer], {
      cwd: workspaceDir,
      stdio: 'ignore',
    });
  }
  if (mongoStarted) {
    spawnSync('docker', ['stop', '--time', '5', mongoContainer], {
      cwd: workspaceDir,
      stdio: 'ignore',
    });
  }
  if (adminPool) {
    await adminPool.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()',
      [databaseName],
    ).catch(() => undefined);
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => undefined);
    await adminPool.end().catch(() => undefined);
  }
  if (postgresStarted) {
    spawnSync('docker', ['stop', '--time', '5', postgresContainer], {
      cwd: workspaceDir,
      stdio: 'ignore',
    });
  }
}

process.exitCode = exitCode;

function adminConnection() {
  if (process.env.PXM_E2E_EXTERNAL_POSTGRES === 'true') {
    const configuredUrl = process.env.PXM_E2E_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
    if (configuredUrl) {
      return { connectionString: replaceDatabase(configuredUrl, process.env.PXM_E2E_ADMIN_DATABASE || 'postgres') };
    }
    return {
      host: process.env.PXM_E2E_PGHOST || process.env.PGHOST || '127.0.0.1',
      port: numberEnv('PXM_E2E_PGPORT', Number(process.env.PGPORT || 5432)),
      user: process.env.PXM_E2E_PGUSER || process.env.PGUSER || 'pxm',
      password: process.env.PXM_E2E_PGPASSWORD || process.env.PGPASSWORD || 'bpm',
      database: process.env.PXM_E2E_ADMIN_DATABASE || 'postgres',
    };
  }
  return {
    host: '127.0.0.1',
    port: postgresPort,
    user: 'pxm_e2e',
    password: 'pxm_e2e_password',
    database: 'postgres',
  };
}

function testConnection() {
  const admin = adminConnection();
  if ('connectionString' in admin) return { connectionString: replaceDatabase(admin.connectionString, databaseName) };
  return { ...admin, database: databaseName };
}

function databaseUrl(name) {
  if (process.env.PXM_E2E_EXTERNAL_POSTGRES === 'true') {
    const configured = process.env.PXM_E2E_ADMIN_DATABASE_URL || process.env.DATABASE_URL;
    if (configured) return replaceDatabase(configured, name);
  }
  const admin = adminConnection();
  if ('connectionString' in admin) return replaceDatabase(admin.connectionString, name);
  const url = new URL('postgres://127.0.0.1');
  url.hostname = admin.host;
  url.port = String(admin.port);
  url.username = admin.user;
  url.password = admin.password;
  url.pathname = `/${name}`;
  return url.toString();
}

function replaceDatabase(connectionString, name) {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

async function applyMigrations(pool) {
  const migrationDir = resolve(workspaceDir, 'infra/db/migrations');
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await readFile(resolve(migrationDir, file), 'utf8'));
  }
}

function startMailpit() {
  const result = spawnSync('docker', [
    'run', '--detach', '--rm', '--name', mailpitContainer,
    '-p', `127.0.0.1:${smtpPort}:1025`,
    '-p', `127.0.0.1:${mailpitPort}:8025`,
    'axllent/mailpit:v1.30.5',
  ], { cwd: workspaceDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Mailpit start failed: ${result.stderr || result.stdout}`);
}

function startPostgres() {
  const result = spawnSync('docker', [
    'run', '--detach', '--rm', '--name', postgresContainer,
    '-e', 'POSTGRES_USER=pxm_e2e',
    '-e', 'POSTGRES_PASSWORD=pxm_e2e_password',
    '-e', 'POSTGRES_DB=postgres',
    '-p', `127.0.0.1:${postgresPort}:5432`,
    'postgres:16',
  ], { cwd: workspaceDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`PostgreSQL start failed: ${result.stderr || result.stdout}`);
}

async function waitForPostgres() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const ready = spawnSync('docker', [
      'exec', postgresContainer, 'pg_isready', '-U', 'pxm_e2e', '-d', 'postgres',
    ], { cwd: workspaceDir, stdio: 'ignore' });
    if (ready.status === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('Timed out waiting for isolated PostgreSQL');
}

function startMongo() {
  const result = spawnSync('docker', [
    'run', '--detach', '--rm', '--name', mongoContainer,
    '--network', 'host',
    'mongo:7.0',
    'mongod', '--replSet', mongoReplicaSet, '--bind_ip_all', '--port', String(mongoPort),
  ], { cwd: workspaceDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`MongoDB start failed: ${result.stderr || result.stdout}`);
}

async function initializeMongoReplicaSet() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const initiate = spawnSync('docker', [
      'exec', mongoContainer, 'mongosh', '--quiet', '--port', String(mongoPort), '--eval',
      `try { rs.status().ok } catch (error) { rs.initiate({_id:'${mongoReplicaSet}',members:[{_id:0,host:'127.0.0.1:${mongoPort}'}]}).ok }`,
    ], { cwd: workspaceDir, encoding: 'utf8' });
    if (initiate.status === 0 && initiate.stdout.trim().endsWith('1')) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('Timed out initializing isolated MongoDB replica set');
}

function startProcess(name, command, args, env) {
  const log = createWriteStream(resolve(logDir, `${name}.log`), { flags: 'a' });
  const child = spawn(command, args, { cwd: workspaceDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.once('exit', (code, signal) => {
    log.write(`\n[runner] ${name} exited code=${code} signal=${signal}\n`);
    log.end();
  });
  return { name, child };
}

async function stopChildren() {
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function runCommand(command, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: workspaceDir, env, stdio: 'inherit' });
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
    child.once('error', (error) => resolvePromise({ code: null, signal: null, error }));
  });
}

async function readExecutedTestCount() {
  try {
    return countPlaywrightTests(JSON.parse(await readFile(resolve(resultDir, 'results.json'), 'utf8')));
  } catch {
    return 0;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function validateDatabaseName(name) {
  if (!/^pxm_e2e_[0-9_]+$/.test(name)) throw new Error(`Unsafe E2E database name: ${name}`);
}

function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
