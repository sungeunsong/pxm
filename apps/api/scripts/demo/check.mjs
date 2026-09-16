import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { marker, presets, libraryPreset } from './fixtures.mjs';
const access = JSON.parse(await readFile(process.env.PXM_DEMO_ACCESS_FILE || new URL('../../../../.env.demo-access.json', import.meta.url), 'utf8'));
const api = access.api;
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
async function run(id, preset, headers) { return (await json(`${api}/templates/${id}/start`, { method: 'POST', headers, body: JSON.stringify({ preset, input: {} }) })).instance_id; }
async function task(instanceId, channel) { return waitFor(() => db.collection('v2_tasks').findOne({ instance_id: instanceId, status: 'OPEN', ...(channel ? { 'payload.approver_channel': channel } : {}) }), `task for ${instanceId}`); }
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
} finally {
  for (const headers of sessions) await fetch(`${api}/auth/logout`, { method: 'POST', headers, body: '{}' }).catch(() => {});
  await client.close();
}
