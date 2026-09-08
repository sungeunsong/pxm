import { MongoClient } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { marker, groupId, users, employees, fixtures, presets } from './fixtures.mjs';

const mode = process.argv[2];
if (!['seed', 'reset'].includes(mode)) throw new Error('Usage: manage.mjs seed|reset');
const apiUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3011/api';
const mongoUrl = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';
const serviceUrl = process.env.PXM_DEMO_SERVICE_URL || 'http://127.0.0.1:3020';
const accessFile = process.env.PXM_DEMO_ACCESS_FILE || fileURLToPath(new URL('../../../../.env.demo-access.json', import.meta.url));
// This command owns a small fixture namespace in a local development database only.
for (const url of [apiUrl, serviceUrl]) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Demo requires loopback API/service URLs');
}
const allowedDatabase = /^pxm_(db|demo[a-z0-9_]*)$/.test(dbName)
  || (process.env.PXM_DEMO_ALLOW_E2E_DATABASE === 'true' && /^pxm_e2e_[0-9_]+$/.test(dbName));
if (process.env.NODE_ENV === 'production' || !/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(mongoUrl) || !allowedDatabase) {
  throw new Error('Demo commands require a local development MongoDB database (pxm_db or pxm_demo*)');
}
const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 });
const db = client.db(dbName);
let headers;
const randomPassword = () => randomBytes(18).toString('base64url');
async function login(user_id, password) {
  const response = await fetch(`${apiUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id, password }) });
  if (!response.ok) throw new Error(`Login failed for ${user_id}: HTTP ${response.status}`);
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]);
  return { 'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf-token': decodeURIComponent(cookies.find(v => v.startsWith('pxm_csrf='))?.slice('pxm_csrf='.length) || '') };
}
async function request(path, method = 'GET', body, session = headers) {
  const response = await fetch(`${apiUrl}${path}`, { method, headers: session, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 600)}`);
  return response.status === 204 ? null : response.json();
}
async function saveAccess(access) {
  await writeFile(accessFile, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 });
  await chmod(accessFile, 0o600);
}
async function ensureWorkflow(key, payload, manifest) {
  let current = manifest.workflows[key] ? await request(`/templates/${manifest.workflows[key]}`) : null;
  if (!current) {
    // Recover a create that succeeded immediately before a process interruption.
    const all = await request('/templates?activeOnly=false');
    const matches = all.filter(w => w.group_id === groupId && w.name === payload.name && w.tags?.includes(marker));
    if (matches.length > 1) throw new Error(`Duplicate owned fixture: ${key}`);
    current = matches[0];
  }
  if (current && (current.group_id !== groupId || !current.tags?.includes(marker))) throw new Error(`Fixture ownership changed: ${key}`);
  const same = current && Object.keys(payload).every(field => JSON.stringify(current[field]) === JSON.stringify(payload[field]));
  if (!current || !same) current = await request(current ? `/templates/${current.id}` : '/templates', current ? 'PUT' : 'POST', payload);
  manifest.workflows[key] = current.id;
  await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $set: { workflows: manifest.workflows } });
  if (current.lifecycle_status !== 'PUBLISHED' || current.active_published_version !== current.version) await request(`/templates/${current.id}/deploy`, 'POST', {});
  const existing = await request(`/templates/${current.id}/input-presets`);
  for (const preset of presets) {
    const old = existing.find(p => p.alias === preset.alias);
    const body = { ...preset, scope: 'group', ...(old ? { id: old.id } : {}) };
    if (!old || old.name !== preset.name || old.scope !== 'group' || JSON.stringify(old.values) !== JSON.stringify(preset.values)) await request(`/templates/${current.id}/input-presets`, 'POST', body);
  }
}
async function resetRuns(manifest) {
  const ids = Object.values(manifest.workflows);
  if (!ids.length) return;
  for (const id of ids) {
    const workflow = await request(`/templates/${id}`);
    if (workflow.group_id !== groupId || !workflow.tags?.includes(marker)) throw new Error('Reset refused: workflow ownership changed');
  }
  const runs = await db.collection('v2_process_instances').find({ process_definition_id: { $in: ids } }).toArray();
  if (runs.some(run => !['COMPLETED', 'FAILED', 'TERMINATED', 'CANCELED'].includes(run.state))) {
    throw new Error('Reset refused: demo executions are still active. Finish or terminate them in the console, then retry.');
  }
  const runIds = runs.map(run => run._id);
  if (await db.collection('v2_advisory_locks').countDocuments({ _id: { $in: runIds } })) throw new Error('Reset refused: engine still owns a demo execution');
  // Only related rows are removed. Global counters, dispatch cursors, audit history and all other workflows are retained.
  const tasks = await db.collection('v2_tasks').find({ instance_id: { $in: runIds } }, { projection: { _id: 1 } }).toArray();
  const requests = await db.collection('v2_approval_requests').find({ instance_id: { $in: runIds } }, { projection: { _id: 1 } }).toArray();
  const taskIds = tasks.map(t => t._id);
  const requestIds = requests.map(r => r._id);
  const notifications = await db.collection('approval_notification_deliveries').find({ task_id: { $in: taskIds } }, { projection: { _id: 1 } }).toArray();
  const webhooks = await db.collection('webhook_deliveries').find({ instance_id: { $in: runIds } }, { projection: { _id: 1 } }).toArray();
  for (const [name, filter] of [
    ['approval_notification_deliveries', { task_id: { $in: taskIds } }],
    ['webhook_deliveries', { instance_id: { $in: runIds } }],
  ]) {
    if (await db.collection(name).countDocuments({ ...filter, status: { $in: ['PENDING', 'RUNNING'] } })) {
      throw new Error(`Reset refused: ${name} still has pending/running delivery work; retry after delivery completes`);
    }
  }
  const filters = {
    v2_process_instances: { _id: { $in: runIds } },
    v2_approval_steps: { request_id: { $in: requestIds } },
    approval_notification_deliveries: { task_id: { $in: taskIds } },
    approval_notification_attempts: { delivery_id: { $in: notifications.map(n => n._id) } },
    webhook_deliveries: { instance_id: { $in: runIds } },
    webhook_delivery_attempts: { delivery_id: { $in: webhooks.map(w => w._id) } },
  };
  for (const name of ['v2_tokens', 'v2_engine_jobs', 'v2_event_outbox', 'v2_tasks', 'v2_approval_requests', 'v2_start_idempotency', 'v2_instance_command_idempotency']) filters[name] = { instance_id: { $in: runIds } };
  const session = client.startSession();
  try { await session.withTransaction(async () => { for (const [name, filter] of Object.entries(filters)) await db.collection(name).deleteMany(filter, { session }); }); }
  finally { await session.endSession(); }
  console.log(`데모 실행 이력 초기화: ${runs.length}건`);
}

try {
  await client.connect();
  headers = await login(process.env.PXM_DEMO_USER || 'admin', process.env.PXM_DEMO_PASSWORD || 'admin1234');
  let manifest = await db.collection('pxm_demo_manifests').findOne({ _id: marker });
  const groups = await request('/authz/groups?includeDeleted=true');
  let group = groups.find(g => g.id === groupId);
  if (group && group.description !== marker) throw new Error('Demo group ID is already owned by other data');
  if (group && group.status !== 'active') throw new Error('Restore the demo group before seeding');
  const localGroup = await db.collection('pxm_groups').findOne({ _id: groupId });
  if (group && !localGroup) throw new Error('API and MongoDB do not point to the same database');
  if (!group) {
    group = await request('/authz/groups', 'POST', { id: groupId, name: '데모 · 보안운영팀', description: marker });
    if (!await db.collection('pxm_groups').findOne({ _id: groupId })) throw new Error('API and MongoDB database mismatch');
  }
  if (!manifest) {
    manifest = { _id: marker, group_id: groupId, workflows: {}, credentials: {} };
    await db.collection('pxm_demo_manifests').insertOne(manifest);
  }
  // Atomic lock prevents two fixture commands from creating duplicate resources.
  const lock = await db.collection('pxm_demo_manifests').updateOne({ _id: marker, busy: { $ne: true } }, { $set: { busy: true } });
  if (!lock.modifiedCount) throw new Error('Another demo command is running (or interrupted); inspect pxm_demo_manifests.busy before retrying');
  try {
    if (mode === 'reset') await resetRuns(manifest);
    let access;
    try { access = JSON.parse(await readFile(accessFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (access && (access.database !== dbName || access.api !== apiUrl)) throw new Error('Local demo password file belongs to another database/API');
    access ||= { database: dbName, api: apiUrl, accounts: {} };
    const directory = await request('/authz/users');
    for (const user of users) {
      const existing = directory.find(u => u.id === user.id);
      if (existing && (existing.group_ids.length !== 1 || existing.group_ids[0] !== groupId)) throw new Error(`User ID collision: ${user.id}`);
      const password = access.accounts[user.id] || randomPassword();
      if (!existing || !access.accounts[user.id]) {
        access.accounts[user.id] = password;
        await saveAccess(access);
        await request('/authz/users', 'POST', { ...user, group_ids: [groupId], memberships: [{ group_id: groupId, role: user.role }], password });
      }
      const session = await login(user.id, password);
      await request('/auth/logout', 'POST', {}, session);
    }
    const credentialSpecs = [
      ['hr', '데모 · 직원 DB', 'connection_string', mongoUrl],
      ['access', '데모 · 권한 반영 API', 'bearer_token', randomPassword()],
    ];
    const credentials = await request(`/credentials?groupId=${groupId}`);
    for (const [key, name, type, secret_value] of credentialSpecs) {
      const current = credentials.find(c => c.id === manifest.credentials[key]) || credentials.find(c => c.name === name && c.description === marker);
      if (current && (current.group_id !== groupId || current.description !== marker || !current.active)) throw new Error(`Credential ownership/state changed: ${key}`);
      manifest.credentials[key] = current?.id || (await request('/credentials', 'POST', { group_id: groupId, name, type, secret_value, description: marker })).id;
      await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $set: { credentials: manifest.credentials } });
    }
    for (const employee of employees) await db.collection('pxm_demo_employees').updateOne({ _id: `${marker}:${employee.emp_id}` }, { $set: { ...employee, demo_marker: marker } }, { upsert: true });
    for (const { key, payload } of fixtures(manifest.credentials, dbName, serviceUrl)) await ensureWorkflow(key, payload, manifest);
    console.log(JSON.stringify({ group: group.name, group_id: groupId, workflows: manifest.workflows, credentials: manifest.credentials, accounts: ['admin (기존 계정)', ...users.map(u => u.id)], password_file: accessFile, web: 'http://localhost:5174', mailpit: 'http://localhost:8025', service: serviceUrl, next: 'pnpm demo:service 실행 후 docs/demo-practice.md 참고' }, null, 2));
  } finally { await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $unset: { busy: '' } }); }
} catch (error) { console.error(`[demo:${mode}] ${error.message}`); process.exitCode = 1; }
finally { if (headers) await request('/auth/logout', 'POST', {}).catch(() => {}); await client.close(); }
