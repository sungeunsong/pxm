import { MongoClient } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  marker, groupId, users, employees, fixtures, presets, demoLibrary, externalPrincipalMapping, demoCommands,
} from './fixtures.mjs';

const mode = process.argv[2];
if (!['seed', 'reset'].includes(mode)) throw new Error('Usage: manage.mjs seed|reset');
const apiUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3011/api';
const publicApiUrl = apiUrl.replace(/\/api\/?$/, '/api/v1');
const mongoUrl = process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';
const serviceUrl = process.env.PXM_DEMO_SERVICE_URL || 'http://127.0.0.1:3020';
const accessFile = process.env.PXM_DEMO_ACCESS_FILE || fileURLToPath(new URL('../../../../.env.demo-access.json', import.meta.url));
const liveDemo = {
  userId: 'demo-live-manager',
  serviceAccountId: 'demo-live-client',
  apiKeyName: '발표 · 현장 발급 키',
  temporaryGroupName: '발표 · 임시 검증 그룹',
  temporaryGroupDescription: '발표 중 그룹 생성과 삭제 정책 확인',
};
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
async function ensureWorkflow(key, payload, manifest, workflowPresets = presets, forceUpdate = false) {
  let current = manifest.workflows[key] ? await request(`/templates/${manifest.workflows[key]}`) : null;
  if (!current) {
    // Recover a create that succeeded immediately before a process interruption.
    const all = await request('/templates?activeOnly=false');
    const matches = all.filter(w => w.group_id === groupId && w.name === payload.name && w.tags?.includes(marker));
    if (matches.length > 1) throw new Error(`Duplicate owned fixture: ${key}`);
    current = matches[0];
  }
  const ownedByManifest = Boolean(current && manifest.workflows[key] === current.id);
  if (current && (current.group_id !== groupId || (!ownedByManifest && !current.tags?.includes(marker)))) throw new Error(`Fixture ownership changed: ${key}`);
  const same = !forceUpdate && current && Object.keys(payload).every(field => JSON.stringify(current[field]) === JSON.stringify(payload[field]));
  if (!current || !same) current = await request(current ? `/templates/${current.id}` : '/templates', current ? 'PUT' : 'POST', payload);
  manifest.workflows[key] = current.id;
  await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $set: { workflows: manifest.workflows } });
  if (current.lifecycle_status !== 'PUBLISHED' || current.active_published_version !== current.version) await request(`/templates/${current.id}/deploy`, 'POST', {});
  const existing = await request(`/templates/${current.id}/input-presets`);
  const desiredAliases = new Set(workflowPresets.map(preset => preset.alias));
  for (const stale of existing.filter(preset => preset.alias.startsWith('demo-') && !desiredAliases.has(preset.alias))) {
    await request(`/templates/${current.id}/input-presets/${stale.id}`, 'DELETE');
  }
  for (const preset of workflowPresets) {
    const old = existing.find(p => p.alias === preset.alias);
    const body = { ...preset, scope: 'group', ...(old ? { id: old.id } : {}) };
    if (!old || old.name !== preset.name || old.scope !== 'group' || JSON.stringify(old.values) !== JSON.stringify(preset.values)) await request(`/templates/${current.id}/input-presets`, 'POST', body);
  }
}
async function ensureDemoCommands() {
  const current = await request('/commands');
  for (const command of demoCommands) {
    const existing = current.find(item => item.command_id === command.command_id);
    const same = existing && Object.keys(command).every(
      field => JSON.stringify(existing[field]) === JSON.stringify(command[field]),
    );
    if (!same) await request('/commands', 'POST', command);
  }
}
async function ensureScriptLibrary(manifest) {
  const libraries = await request('/script-libraries/admin');
  let library = libraries.find(item => item.package_name === demoLibrary.package_name && item.version === demoLibrary.version);
  if (!library) library = await request('/script-libraries', 'POST', demoLibrary);
  const availableToDemoGroup = library.status === 'approved'
    && (library.allowed_group_ids.length === 0 || library.allowed_group_ids.includes(groupId));
  if (!availableToDemoGroup) {
    const preservedGroups = library.allowed_group_ids.length > 0 ? library.allowed_group_ids : [];
    library = await request(`/script-libraries/${library.id}/approve`, 'POST', {
      allowed_group_ids: [...new Set([...preservedGroups, groupId])],
    });
  }
  manifest.library_id = library.id;
  await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $set: { library_id: library.id } });
  return library;
}
/**
 * reset에서 승인된 JS 라이브러리를 발표 전 상태로 되돌린다.
 *
 * 라이브러리 레코드만 지우면 실습 4는 그대로 실행된다. 승인 시점의 번들이
 * 배포 버전 안에 박히기 때문이다(그게 "배포 버전에 고정"의 실제 동작이다).
 * 그래서 워크플로우에 남은 번들까지 함께 걷어내, 발표자가 lodash를 준비·승인하고
 * 실습 4를 다시 저장·배포해야 실행되는 상태로 만든다. 스크립트와 노드 구성은 건드리지 않는다.
 */
async function resetScriptLibraryDemo(manifest) {
  const workflowId = manifest.workflows.jsLibrary;
  const stripBundles = (nodes = []) => nodes.map(node => {
    if (!node?.config?.scriptLibraryBundles) return node;
    const config = { ...node.config };
    delete config.scriptLibraryBundles;
    if (config.ui_node?.data?.scriptLibraryBundles) {
      config.ui_node = { ...config.ui_node, data: { ...config.ui_node.data } };
      delete config.ui_node.data.scriptLibraryBundles;
    }
    return { ...node, config };
  });

  if (workflowId) {
    for (const [collection, filter] of [
      ['v2_process_definitions', { _id: workflowId }],
      ['v2_process_definition_versions', { definition_id: workflowId }],
    ]) {
      for (const doc of await db.collection(collection).find(filter).toArray()) {
        const nodes = stripBundles(doc.nodes);
        if (JSON.stringify(nodes) !== JSON.stringify(doc.nodes)) {
          await db.collection(collection).updateOne({ _id: doc._id }, { $set: { nodes } });
        }
      }
    }
  }

  const removed = await db.collection('v2_script_libraries').deleteMany({
    package_name: demoLibrary.package_name, version: demoLibrary.version,
  });
  manifest.script_library_demo_needs_rebind = true;
  await db.collection('pxm_demo_manifests').updateOne(
    { _id: marker },
    { $set: { script_library_demo_needs_rebind: true }, $unset: { library_id: '' } },
  );
  if (removed.deletedCount) {
    console.log(`승인된 JS 라이브러리 초기화: ${demoLibrary.package_name}@${demoLibrary.version} 제거. 발표 중 직접 준비·승인한 뒤 실습 4를 다시 저장·배포한다.`);
  }
}
async function ensureDelegation(manifest) {
  const workflowId = manifest.workflows.delegation;
  if (!workflowId) throw new Error('Delegation practice workflow is missing');
  const current = await request(`/authz/approval-delegations?groupId=${groupId}`);
  const fixture = current.find(item =>
    item.status === 'active' && item.delegator_id === 'demo-approver1' && item.delegate_id === 'demo-delegate1'
    && item.scope === 'selected' && item.workflow_ids?.includes(workflowId)
    && new Date(item.ends_at) > new Date(),
  );
  if (fixture) return fixture;
  return request('/authz/approval-delegations', 'POST', {
    group_id: groupId,
    delegator_id: 'demo-approver1',
    delegate_id: 'demo-delegate1',
    scope: 'selected',
    workflow_ids: [workflowId],
    include_existing: true,
    starts_at: '2026-01-01T00:00:00.000Z',
    ends_at: '2099-12-31T23:59:59.000Z',
    reason: '데모 시나리오: 원래 승인자 휴가',
  });
}
async function ensureExternalPrincipalMapping(manifest) {
  const mappings = await request('/authz/external-principal-mappings');
  let mapping = mappings.find(item =>
    item.provider === externalPrincipalMapping.provider && item.subject === externalPrincipalMapping.subject,
  );
  if (mapping && mapping.group_id !== groupId) throw new Error('Demo external principal mapping is owned by another group');
  if (!mapping) {
    mapping = await request('/authz/external-principal-mappings', 'POST', externalPrincipalMapping);
  } else {
    const patch = {
      group_id: externalPrincipalMapping.group_id,
      pxm_user_id: externalPrincipalMapping.pxm_user_id,
      display_name: externalPrincipalMapping.display_name,
      email: externalPrincipalMapping.email,
      department: externalPrincipalMapping.department,
    };
    const changed = Object.entries(patch).some(([key, value]) => mapping[key] !== value);
    if (changed) mapping = await request(`/authz/external-principal-mappings/${mapping.id}`, 'PUT', patch);
    if (mapping.status !== 'active') {
      mapping = await request(`/authz/external-principal-mappings/${mapping.id}/status`, 'PUT', { status: 'active' });
    }
  }
  manifest.external_mapping_id = mapping.id;
  await db.collection('pxm_demo_manifests').updateOne(
    { _id: marker }, { $set: { external_mapping_id: mapping.id } },
  );
  return mapping;
}
async function ensureWebhookEndpoint(manifest) {
  const endpoints = await request('/webhooks/endpoints');
  const name = '데모 · 결재 결과 수신';
  const sourceProvider = 'pxm-demo-hr';
  let endpoint = endpoints.find(item => item.name === name || item.source_provider === sourceProvider);
  if (!endpoint) {
    endpoint = await request('/webhooks/endpoints', 'POST', {
      name,
      source_provider: sourceProvider,
      url: `${serviceUrl}/webhook`,
      secret: randomBytes(32).toString('base64url'),
      timeout_ms: 3000,
      max_attempts: 3,
    });
  } else {
    endpoint = await request(`/webhooks/endpoints/${endpoint.id}`, 'PUT', {
      name, source_provider: sourceProvider, url: `${serviceUrl}/webhook`,
      timeout_ms: 3000, max_attempts: 3, active: true,
    });
  }
  manifest.webhook_endpoint_id = endpoint.id;
  await db.collection('pxm_demo_manifests').updateOne(
    { _id: marker }, { $set: { webhook_endpoint_id: endpoint.id } },
  );
  return endpoint;
}
async function ensureApiDemoAccess(access, manifest) {
  const serviceAccountId = 'pxm-demo-api-client';
  const accounts = await request(`/authz/service-accounts?groupId=${groupId}`);
  const currentAccount = accounts.find(item => item.id === serviceAccountId);
  if (currentAccount && (currentAccount.group_id !== groupId || currentAccount.description !== marker)) {
    throw new Error('Demo API service account ID is already owned by other data');
  }
  if (!currentAccount || currentAccount.status !== 'active' || currentAccount.name !== '데모 · 외부 업무 시스템') {
    await request('/authz/service-accounts', 'POST', {
      id: serviceAccountId,
      name: '데모 · 외부 업무 시스템',
      group_id: groupId,
      description: marker,
      status: 'active',
    });
  }

  const workflowId = manifest.workflows.basic;
  if (!workflowId) throw new Error('Basic approval workflow is missing for API demo');
  const listedKeys = await request(`/authz/api-keys?groupId=${groupId}`);
  access.api_keys ||= {};

  const specs = [
    {
      slot: 'trigger', name: '데모 · API 실행 키', owner_type: 'SERVICE_ACCOUNT', owner_id: serviceAccountId,
      scopes: ['workflow:read', 'workflow:execute'],
    },
    {
      slot: 'approver', name: '데모 · API 결재 키', owner_type: 'USER', owner_id: 'demo-approver1',
      scopes: ['workflow:read', 'task:approve'],
    },
  ];
  const ensured = {};
  for (const spec of specs) {
    const saved = access.api_keys[spec.slot];
    let current = saved?.id ? listedKeys.find(item => item.id === saved.id) : null;
    const same = current && current.status === 'active' && current.name === spec.name
      && current.owner_type === spec.owner_type && current.owner_id === spec.owner_id
      && current.group_id === groupId && current.workflow_access === 'allowlist'
      && JSON.stringify([...current.scopes].sort()) === JSON.stringify([...spec.scopes].sort())
      && JSON.stringify(current.allowed_workflow_ids) === JSON.stringify([workflowId]);
    let usable = false;
    if (same && saved?.api_key) {
      const response = await fetch(`${publicApiUrl}/templates?activeOnly=true`, {
        headers: { authorization: `Bearer ${saved.api_key}` },
      });
      usable = response.ok;
    }
    if (!usable) {
      const stale = current || listedKeys.find(item => item.name === spec.name && item.status === 'active');
      if (stale) await request(`/authz/api-keys/${stale.id}/disable`, 'PUT');
      current = await request('/authz/api-keys', 'POST', {
        name: spec.name,
        owner_type: spec.owner_type,
        owner_id: spec.owner_id,
        group_id: groupId,
        scopes: spec.scopes,
        workflow_access: 'allowlist',
        allowed_workflow_ids: [workflowId],
        rate_limit_per_minute: 120,
      });
      access.api_keys[spec.slot] = { id: current.id, name: current.name, api_key: current.api_key };
      await saveAccess(access);
    }
    ensured[spec.slot] = access.api_keys[spec.slot];
  }
  manifest.api_key_ids = Object.fromEntries(Object.entries(ensured).map(([slot, item]) => [slot, item.id]));
  manifest.service_account_id = serviceAccountId;
  await db.collection('pxm_demo_manifests').updateOne(
    { _id: marker },
    { $set: { api_key_ids: manifest.api_key_ids, service_account_id: serviceAccountId } },
  );
  return { service_account_id: serviceAccountId, keys: ensured };
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

async function resetLiveDemoArtifacts() {
  const keys = await db.collection('pxm_api_keys').find({
    group_id: groupId,
    $or: [{ name: liveDemo.apiKeyName }, { owner_id: liveDemo.serviceAccountId }],
  }, { projection: { _id: 1 } }).toArray();
  const keyIds = keys.map(key => key._id);
  if (keyIds.length) {
    await db.collection('pxm_api_key_usage_logs').deleteMany({ api_key_id: { $in: keyIds } });
    await db.collection('pxm_api_keys').deleteMany({ _id: { $in: keyIds } });
  }
  await db.collection('pxm_service_accounts').deleteMany({ _id: liveDemo.serviceAccountId, group_id: groupId });
  await db.collection('pxm_sessions').deleteMany({ user_id: liveDemo.userId });
  await db.collection('pxm_users').deleteMany({ _id: liveDemo.userId });

  const temporaryGroups = await db.collection('pxm_groups').find({
    name: liveDemo.temporaryGroupName,
    description: liveDemo.temporaryGroupDescription,
  }, { projection: { _id: 1 } }).toArray();
  for (const temporaryGroup of temporaryGroups) {
    const temporaryGroupId = temporaryGroup._id;
    const linkedCounts = await Promise.all([
      db.collection('v2_process_definitions').countDocuments({ $or: [{ group_id: temporaryGroupId }, { 'metadata.group_id': temporaryGroupId }] }),
      db.collection('pxm_api_keys').countDocuments({ group_id: temporaryGroupId }),
      db.collection('pxm_service_accounts').countDocuments({ group_id: temporaryGroupId }),
      db.collection('pxm_users').countDocuments({ group_ids: temporaryGroupId }),
    ]);
    if (linkedCounts.some(Boolean)) throw new Error(`Reset refused: temporary live-demo group ${temporaryGroupId} owns resources`);
    await db.collection('pxm_groups').deleteOne({ _id: temporaryGroupId });
  }

  if (keyIds.length || temporaryGroups.length) {
    console.log(`현장 생성 시연 데이터 정리: API Key ${keyIds.length}건, 임시 그룹 ${temporaryGroups.length}건`);
  }
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
    if (mode === 'reset') {
      await resetRuns(manifest);
      await resetLiveDemoArtifacts();
    }
    let access;
    try { access = JSON.parse(await readFile(accessFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (access && (access.database !== dbName || access.api !== apiUrl)) throw new Error('Local demo password file belongs to another database/API');
    access ||= { database: dbName, api: apiUrl, accounts: {} };
    const directory = await request('/authz/users');
    for (const user of users) {
      const existing = directory.find(u => u.id === user.id);
      if (existing && (existing.group_ids.length !== 1 || existing.group_ids[0] !== groupId)) throw new Error(`User ID collision: ${user.id}`);
      const passwordMissing = !access.accounts[user.id];
      const password = access.accounts[user.id] || randomPassword();
      if (passwordMissing) {
        access.accounts[user.id] = password;
        await saveAccess(access);
      }
      const needsUpdate = !existing || passwordMissing || existing.display_name !== user.display_name
        || existing.email !== user.email || existing.role !== user.role
        || existing.memberships?.length !== 1 || existing.memberships[0]?.group_id !== groupId || existing.memberships[0]?.role !== user.role;
      if (needsUpdate) await request('/authz/users', 'POST', {
        ...user, group_ids: [groupId], memberships: [{ group_id: groupId, role: user.role }],
        ...(passwordMissing ? { password } : {}),
      });
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
    // SSH 실습은 접속 대상이 환경마다 달라 자격증명을 만들지 않는다.
    // 그룹에 SSH 자격증명이 등록되어 있으면 그것을 실습 9에 연결하고, 없으면 실습 9를 건너뛴다.
    const sshCredential = (await request(`/credentials?groupId=${groupId}`)).find(c => c.type === 'ssh' && c.active);
    if (sshCredential) manifest.credentials.ssh = sshCredential.id;
    else {
      delete manifest.credentials.ssh;
      console.warn('SSH 실습 건너뜀: 그룹에 SSH 자격증명이 없습니다. 연동 자격증명에서 SSH를 하나 만든 뒤 다시 실행하세요.');
    }
    await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $set: { credentials: manifest.credentials } });
    for (const employee of employees) await db.collection('pxm_demo_employees').updateOne({ _id: `${marker}:${employee.emp_id}` }, { $set: { ...employee, demo_marker: marker } }, { upsert: true });
    const library = await ensureScriptLibrary(manifest);
    await ensureDemoCommands();
    const externalMapping = await ensureExternalPrincipalMapping(manifest);
    const webhookEndpoint = await ensureWebhookEndpoint(manifest);
    for (const { key, payload, presets: workflowPresets } of fixtures(manifest.credentials, dbName, serviceUrl)) {
      await ensureWorkflow(
        key,
        payload,
        manifest,
        workflowPresets,
        mode === 'seed' && key === 'jsLibrary' && manifest.script_library_demo_needs_rebind === true,
      );
    }
    if (mode === 'seed' && manifest.script_library_demo_needs_rebind === true) {
      delete manifest.script_library_demo_needs_rebind;
      await db.collection('pxm_demo_manifests').updateOne(
        { _id: marker },
        { $unset: { script_library_demo_needs_rebind: '' } },
      );
    }
    if (mode === 'reset') await resetScriptLibraryDemo(manifest);
    const apiDemo = await ensureApiDemoAccess(access, manifest);
    const delegation = await ensureDelegation(manifest);
    await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $set: { delegation_id: delegation.id } });
    console.log(JSON.stringify({ group: group.name, group_id: groupId, workflows: manifest.workflows, credentials: manifest.credentials, external_mapping: `${externalMapping.provider}/${externalMapping.subject}`, webhook_endpoint: webhookEndpoint.name, approval_demo: { delegation: 'demo-approver1 -> demo-delegate1 (실습 3)', reminder_after: '1분', escalation_after: '추가 1분', multi_stage: 'demo-approver1 + demo-approver2 ALL -> demo-secadmin/외부 승인자 ANY' }, library: `${library.package_name}@${library.version}`, api_demo: { service_account: apiDemo.service_account_id, keys: Object.fromEntries(Object.entries(apiDemo.keys).map(([slot, item]) => [slot, item.name])) }, accounts: ['admin (기존 계정)', ...users.map(u => u.id)], password_file: accessFile, web: 'http://localhost:5174', api_playground: 'http://localhost:5175', mailpit: 'http://localhost:8025', service: serviceUrl, next: 'pnpm demo:service 및 pnpm dev:api-playground 실행 후 시연.md 참고' }, null, 2));
  } finally { await db.collection('pxm_demo_manifests').updateOne({ _id: marker }, { $unset: { busy: '' } }); }
} catch (error) { console.error(`[demo:${mode}] ${error.message}`); process.exitCode = 1; }
finally { if (headers) await request('/auth/logout', 'POST', {}).catch(() => {}); await client.close(); }
