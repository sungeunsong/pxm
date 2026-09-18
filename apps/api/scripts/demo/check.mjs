import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { marker, presets, libraryPreset, multiStagePreset, demoCommands } from './fixtures.mjs';
const access = JSON.parse(await readFile(process.env.PXM_DEMO_ACCESS_FILE || new URL('../../../../.env.demo-access.json', import.meta.url), 'utf8'));
const api = access.api;
const publicApi = api.replace(/\/api\/?$/, '/api/v1');
const mailpit = process.env.PXM_DEMO_MAILPIT_API_URL || 'http://127.0.0.1:8025/api/v1';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(api).hostname)) throw new Error('Local demo API required');
const client = new MongoClient(process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0');
const db = client.db(access.database);
const sessions = [];
async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}
async function publicJson(path, apiKey, init = {}) {
  const response = await fetch(`${publicApi}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-business-actor': JSON.stringify({ id: 'DEMO-API-001', name: 'Demo API Requester', provider: 'demo-check' }),
      ...init.headers,
    },
  });
  const body = await response.json();
  assert.ok(response.ok, `${response.status} ${path}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}
async function login(id) {
  const response = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id, password: access.accounts[id] }) });
  assert.ok(response.ok, `login ${id}`);
  const cookies = response.headers.getSetCookie().map(v => v.split(';')[0]);
  const headers = { 'content-type': 'application/json', cookie: cookies.join('; '), 'x-csrf-token': decodeURIComponent(cookies.find(v => v.startsWith('pxm_csrf='))?.slice(9) || '') };
  sessions.push(headers);
  return headers;
}
async function waitFor(fn, description) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 300)); }
  throw new Error(`Timed out: ${description}`);
}
async function run(id, preset, headers, input = {}) {
  return (await json(`${api}/templates/${id}/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...(preset ? { preset } : {}), input }),
  })).instance_id;
}
async function task(instanceId, channel) { return waitFor(() => db.collection('v2_tasks').findOne({ instance_id: instanceId, status: 'OPEN', ...(channel ? { 'payload.approver_channel': channel } : {}) }), `task for ${instanceId}`); }
async function assigneeTask(instanceId, assignee) { return waitFor(() => db.collection('v2_tasks').findOne({ instance_id: instanceId, assignee, status: 'OPEN' }), `task for ${assignee} in ${instanceId}`); }
async function complete(taskId, action, headers) { return json(`${api}/tasks/${taskId}/complete`, { method: 'POST', headers, body: JSON.stringify({ action, comment: '데모 검증' }) }); }
async function finished(id) {
  return waitFor(async () => { const row = await db.collection('v2_process_instances').findOne({ _id: id }); if (row?.state === 'FAILED') throw new Error(`Workflow failed ${id}: ${JSON.stringify(row.context).slice(-900)}`); return row?.state === 'COMPLETED' ? row : null; }, `completion for ${id}`);
}
async function mailIds() { return (await json(`${mailpit}/messages`)).messages.map(m => m.ID); }
async function newMail(before, subject) {
  const message = await waitFor(async () => (await json(`${mailpit}/messages`)).messages.find(m => !before.includes(m.ID) && m.Subject.includes(subject) && m.To.some(to => to.Address === 'partner-approver@pxm.local')), subject);
  return json(`${mailpit}/message/${message.ID}`);
}
try {
  await client.connect();
  const manifest = await db.collection('pxm_demo_manifests').findOne({ _id: marker });
  assert.ok(manifest, 'Run demo:seed first');
  const requester = await login('demo-requester1');
  const approver = await login('demo-approver1');
  const approver2 = await login('demo-approver2');
  const delegate = await login('demo-delegate1');
  const manager = await login('demo-secadmin');
  assert.ok(access.api_keys?.trigger?.api_key, 'API trigger key missing; run demo:seed first');
  assert.ok(access.api_keys?.approver?.api_key, 'API approver key missing; run demo:seed first');

  const registeredCommands = await json(`${api}/commands?activeOnly=true`, { headers: manager });
  for (const command of demoCommands) {
    const registered = registeredCommands.find(item => item.command_id === command.command_id);
    assert.ok(registered, `Demo command missing: ${command.command_id}`);
    assert.deepEqual(registered.fixed_args, command.fixed_args);
    assert.deepEqual(registered.arg_order, command.arg_order);
  }
  console.log('PASS 시연용 command 등록 + Fixed Args/Argument Order 계약');

  const commandMessage = '금요일 발표 서버 정상';
  const commandId = await run(manifest.workflows.commandTerminal, undefined, requester, { message: commandMessage });
  const commandRun = await finished(commandId);
  assert.equal(commandRun.context.data.outputs.commandResult.exit_code, 0);
  assert.equal(commandRun.context.data.outputs.commandResult.stdout, commandMessage);
  console.log('PASS 실행 입력값 → 허용 명령 인자 바인딩 + 터미널 출력 데이터');

  const versionGateId = await run(manifest.workflows.nodeVersionGate, undefined, requester);
  const versionGateRun = await finished(versionGateId);
  assert.match(versionGateRun.context.data.outputs.nodeVersionCheck.raw, /^v\d+\.\d+\.\d+/);
  assert.ok(versionGateRun.context.data.outputs.nodeVersionCheck.major >= 20);
  assert.ok(await db.collection('v2_tokens').findOne({ instance_id: versionGateId, node_id: 'supported' }));
  console.log('PASS Node.js 버전 명령 stdout → JS 판독 → 20 이상 분기');

  const apiStart = await publicJson(`/templates/${manifest.workflows.basic}/execute`, access.api_keys.trigger.api_key, {
    method: 'POST',
    headers: { 'idempotency-key': `demo-check-start-${Date.now()}` },
    body: JSON.stringify({
      formData: { emp_id: 'E-1001', privilege_level: 'read', target_system: 'API 포털' },
    }),
  });
  const apiTask = await assigneeTask(apiStart.instance_id, 'demo-approver1');
  const openHistory = await publicJson('/tasks/history?status=OPEN&limit=100', access.api_keys.approver.api_key);
  assert.ok(openHistory.items.some(item => item.task_id === apiTask._id), 'API approval task missing from OPEN history');
  const taskDetail = await publicJson(`/tasks/${apiTask._id}`, access.api_keys.approver.api_key);
  assert.equal(taskDetail.status, 'OPEN');
  await publicJson(`/tasks/${apiTask._id}/complete`, access.api_keys.approver.api_key, {
    method: 'POST',
    headers: { 'idempotency-key': `demo-check-approve-${Date.now()}` },
    body: JSON.stringify({ action: 'approve', comment: 'API 결재 시연 자동 검증' }),
  });
  await finished(apiStart.instance_id);
  const apiResult = await publicJson(`/instances/${apiStart.instance_id}/result`, access.api_keys.trigger.api_key);
  assert.equal(apiResult.status, 'COMPLETED');
  const approvedHistory = await publicJson(`/tasks/history?status=APPROVED&instance_id=${apiStart.instance_id}`, access.api_keys.approver.api_key);
  assert.ok(approvedHistory.items.some(item => item.task_id === apiTask._id), 'Approved task missing from API history');
  console.log('PASS API 실행 → 결재 상태/상세 조회 → API 승인 → 완료 결과 조회');

  const libraryId = await run(manifest.workflows.jsLibrary, libraryPreset.alias, requester);
  const libraryRun = await finished(libraryId);
  assert.deepEqual(libraryRun.context.data.outputs.libraryResult, {
    count: 5,
    unique: [12, 7, 30],
    sortedUnique: [7, 12, 30],
    total: 68,
  });
  console.log('PASS 승인된 lodash 고정 버전 실행');
  for (const action of ['approve', 'reject']) {
    const id = await run(manifest.workflows.basic, presets[0].alias, requester);
    const pending = await task(id);
    assert.equal(pending.assignee, 'demo-approver1');
    if (action === 'approve') {
      await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./manage.mjs', import.meta.url)), 'reset'], {
        env: { ...process.env, API_BASE_URL: api, MONGO_DB_NAME: access.database }, timeout: 15000,
      }), error => error.code === 1 && error.stderr.includes('demo executions are still active'));
      assert.ok(await db.collection('v2_tasks').findOne({ _id: pending._id, status: 'OPEN' }));
      console.log('PASS 대기 중 실행 reset 거부 및 결재 보존');
    }
    await complete(pending._id, action, approver);
    await finished(id);
    assert.ok(await db.collection('v2_tokens').findOne({ instance_id: id, node_id: action === 'approve' ? 'approved' : 'rejected' }));
    console.log(`PASS 기본 결재 ${action}`);
  }
  const autoId = await run(manifest.workflows.integrated, presets[0].alias, requester);
  const auto = await finished(autoId);
  assert.equal(auto.context.data.outputs.hr.rows[0].emp_id, 'E-1001');
  assert.deepEqual(auto.context.data.outputs.risk, { level: 'AUTO', score: 0 });
  assert.equal(auto.context.data.outputs.provisioning.body.granted, true);
  assert.equal(auto.context.data.outputs.provisioning.body.emp_id, 'E-1001');
  assert.equal(await db.collection('v2_tasks').countDocuments({ instance_id: autoId }), 0);
  console.log('PASS 종합 시연 자동 처리 + HTTP 입력/응답');
  const rejectId = await run(manifest.workflows.integrated, presets[1].alias, requester);
  await complete((await task(rejectId))._id, 'reject', approver);
  const rejected = await finished(rejectId);
  assert.equal(rejected.context.data.outputs.provisioning, undefined);
  assert.ok(await db.collection('v2_tokens').findOne({ instance_id: rejectId, node_id: 'rejected' }));
  console.log('PASS 종합 시연 내부 반려 (권한 반영 없음)');
  const before = await mailIds();
  const approvedId = await run(manifest.workflows.integrated, presets[1].alias, requester);
  await complete((await task(approvedId))._id, 'approve', approver);
  const message = await newMail(before, '승인이 필요한 요청');
  const token = message.Text.match(/\/external-approval\/([A-Za-z0-9_-]{40,200})/)?.[1];
  assert.ok(token, 'approval link in Mailpit');
  const beforeOtp = await mailIds();
  await json(`${api}/external-approvals/${token}/otp`, { method: 'POST' });
  const otpMessage = await newMail(beforeOtp, '외부 승인 인증번호');
  const otp = otpMessage.Text.match(/\b(\d{6})\b/)?.[1];
  assert.ok(otp);
  await json(`${api}/external-approvals/${token}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve', otp }) });
  const approved = await finished(approvedId);
  assert.equal(approved.context.data.outputs.provisioning.body.emp_id, 'E-2001');
  assert.equal(approved.context.data.outputs.provisioning.body.granted, true);
  assert.equal((await fetch(`${api}/external-approvals/${token}`)).status, 410);
  console.log('PASS 종합 시연 내부 승인 → 이메일 OTP 승인 → HTTP 반영');

  const delegationId = await run(manifest.workflows.delegation, undefined, requester, {
    emp_id: 'E-1001', privilege_level: 'read', target_system: '개발 포털',
  });
  const originalTask = await assigneeTask(delegationId, 'demo-approver1');
  assert.equal(originalTask.payload?.approval_deadline?.deadline_seconds, 60);
  assert.equal(originalTask.payload?.approval_deadline?.escalation_grace_seconds, 60);
  const originalInbox = await json(`${api}/tasks`, { headers: approver });
  assert.ok(!originalInbox.some(item => item.id === originalTask._id), '위임 중인 Task가 원래 승인자에게 보이면 안 됨');
  const delegateInbox = await json(`${api}/tasks`, { headers: delegate });
  const delegatedTask = delegateInbox.find(item => item.id === originalTask._id);
  assert.equal(delegatedTask?.delegation?.original_assignee, 'demo-approver1');
  await complete(originalTask._id, 'approve', delegate);
  await finished(delegationId);
  const delegatedHistory = await db.collection('v2_tasks').findOne({ _id: originalTask._id });
  assert.equal(delegatedHistory?.completion?.actor_id, 'demo-delegate1');
  assert.equal(delegatedHistory?.completion?.delegation?.original_assignee, 'demo-approver1');
  console.log('PASS 실습 3 전용 위임 + 1분 독촉/1분 상위 알림 계약 + 대리 승인');

  const multiStageId = await run(manifest.workflows.multiStage, multiStagePreset.alias, requester);
  const firstApproverTask = await assigneeTask(multiStageId, 'demo-approver1');
  await json(`${api}/tasks/${firstApproverTask._id}/hold`, {
    method: 'POST', headers: approver, body: JSON.stringify({ comment: '변경 범위 추가 확인 필요' }),
  });
  assert.equal((await db.collection('v2_tasks').findOne({ _id: firstApproverTask._id }))?.payload?.hold?.comment, '변경 범위 추가 확인 필요');
  await json(`${api}/instances/${multiStageId}/pause`, { method: 'POST', headers: manager, body: '{}' });
  assert.equal((await db.collection('v2_process_instances').findOne({ _id: multiStageId }))?.is_paused, true);
  await json(`${api}/instances/${multiStageId}/resume`, { method: 'POST', headers: manager, body: '{}' });
  assert.equal((await db.collection('v2_process_instances').findOne({ _id: multiStageId }))?.is_paused, false);
  await complete(firstApproverTask._id, 'approve', approver);
  assert.ok(await assigneeTask(multiStageId, 'demo-approver2'), 'ALL 단계의 두 번째 결재가 남아 있어야 함');
  assert.equal(await db.collection('v2_tasks').countDocuments({ instance_id: multiStageId, assignee: 'demo-secadmin', status: 'OPEN' }), 0);
  await complete((await assigneeTask(multiStageId, 'demo-approver2'))._id, 'approve', approver2);
  await complete((await assigneeTask(multiStageId, 'demo-secadmin'))._id, 'approve', manager);
  await finished(multiStageId);
  const delivery = await waitFor(() => db.collection('webhook_deliveries').findOne({ instance_id: multiStageId, status: 'SENT' }), `webhook delivery for ${multiStageId}`);
  assert.equal(delivery.response_status, 200);
  assert.equal(await db.collection('v2_tasks').countDocuments({ instance_id: multiStageId, status: 'OPEN' }), 0);
  console.log('PASS 보류 + 일시중지/재개 + 다단계 ALL → ANY 결재 + 결과 Webhook');
} finally {
  for (const headers of sessions) await fetch(`${api}/auth/logout`, { method: 'POST', headers, body: '{}' }).catch(() => {});
  await client.close();
}
