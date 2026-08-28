import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { Db, MongoClient } from 'mongodb';
import {
  ApiSession,
  approvalLink,
  approvalPayload,
  approveInBrowser,
  clearMailpit,
  databaseConnection,
  externalApprover,
  fixture,
  loginPage,
  mailCount,
  mappedApprover,
  poll,
  pxmApprover,
  rejectInBrowser,
  seedFixture,
  startApproval,
  taskHistory,
  userPassword,
  waitForHistory,
  waitForInstance,
  waitForMail,
  waitForOpenTasks,
  webBaseUrl,
} from './support';

test.describe.serial('PXM 동적 결재 베타 회귀', () => {
  let admin: ApiSession;
  let approverA: ApiSession;
  let approverB: ApiSession;
  let approverC: ApiSession;
  let mongoClient: MongoClient;
  let db: Db;

  test.beforeAll(async () => {
    admin = await ApiSession.login('admin', process.env.PXM_E2E_ADMIN_PASSWORD || 'E2eAdminPassword!2026');
    await seedFixture(admin);
    [approverA, approverB, approverC] = await Promise.all([
      ApiSession.login(fixture.users.a.id, userPassword),
      ApiSession.login(fixture.users.b.id, userPassword),
      ApiSession.login(fixture.users.c.id, userPassword),
    ]);
    ({ client: mongoClient, db } = await databaseConnection());
  });

  test.afterAll(async () => {
    await Promise.all([
      admin?.dispose(), approverA?.dispose(), approverB?.dispose(), approverC?.dispose(),
    ]);
    await mongoClient?.close();
  });

  test.beforeEach(async () => {
    await clearMailpit();
  });

  test('순차 3단계 결재는 화면에 전체 라인과 현재 단계를 표시하고 마지막에 한 번만 재개한다', async ({ browser }) => {
    const title = uniqueTitle('순차 3단계');
    const execution = await startApproval(admin, title, [
      step(1, '팀장', 'ALL', [pxmApprover('a')]),
      step(2, '부서장', 'ALL', [pxmApprover('b')]),
      step(3, '대표', 'ALL', [pxmApprover('c')]),
    ]);

    const tracker = await loginPage(browser, fixture.users.admin.id, process.env.PXM_E2E_ADMIN_PASSWORD || 'E2eAdminPassword!2026', 'tracker');
    const trackerRow = tracker.page.locator(`[data-testid="tracker-instance-row"][data-instance-id="${execution.instance_id}"]`);
    await expect(trackerRow).toContainText('결재 1/3단계', { timeout: 30_000 });
    await expect(trackerRow).toContainText(title);

    const a = await loginPage(browser, fixture.users.a.id, userPassword);
    await openAndAssertApprovalDetails(a.page, title, ['팀장', '부서장', '대표'], '1 / 3단계');
    await completeOpenedApproval(a.page, 'A 순차 승인');
    await waitForOpenTasks(approverB, execution.instance_id);
    expect(await resumeJobCount(db, execution.instance_id)).toBe(0);

    const b = await loginPage(browser, fixture.users.b.id, userPassword);
    await approveInBrowser(b.page, title, 'B 순차 승인');
    await waitForOpenTasks(approverC, execution.instance_id);
    expect(await resumeJobCount(db, execution.instance_id)).toBe(0);

    const c = await loginPage(browser, fixture.users.c.id, userPassword);
    await approveInBrowser(c.page, title, 'C 최종 승인');
    await waitForInstance(admin, execution.instance_id, (instance) => instance.state === 'COMPLETED');
    expect(await resumeJobCount(db, execution.instance_id)).toBe(1);

    const history = await taskHistory(admin, execution.instance_id);
    expect(history).toHaveLength(3);
    expect(history.map((item: any) => item.comment)).toEqual(expect.arrayContaining([
      'A 순차 승인', 'B 순차 승인', 'C 최종 승인',
    ]));
    expect(history.every((item: any) => item.completed_via === 'pxm_user')).toBeTruthy();
    await closeContexts(tracker.context, a.context, b.context, c.context);
  });

  test('신청자는 내 요청에서 보류와 다단계 승인 결과를 실제 데이터로 확인한다', async ({ browser }) => {
    const title = uniqueTitle('신청자 진행 현황');
    const execution = await startApproval(approverC, title, [
      step(1, '실무 검토', 'ALL', [pxmApprover('a')]),
      step(2, '최종 승인', 'ALL', [pxmApprover('b')]),
    ], { requester: fixture.users.c.name });

    const requester = await loginPage(
      browser,
      fixture.users.c.id,
      userPassword,
      'my-requests',
    );
    const requestRow = requester.page.locator(
      `[data-testid="my-request-row"][data-instance-id="${execution.instance_id}"]`,
    );
    await expect(requestRow).toContainText(title, { timeout: 30_000 });
    await requestRow.click();
    await expect(requester.page.getByRole('heading', { name: title })).toBeVisible();
    await expect(requester.page.getByText('1단계 결재 진행 중')).toBeVisible();

    const approver = await loginPage(browser, fixture.users.a.id, userPassword);
    await openAndAssertApprovalDetails(approver.page, title, ['실무 검토', '최종 승인'], '1 / 2단계');
    await approver.page.locator('[data-testid="decision-hold"]').click();
    await approver.page.locator('.form-textarea-comment').fill('예산 자료를 추가로 확인합니다.');
    await approver.page.getByRole('button', { name: '보류 적용하기' }).click();

    await expect(requester.page.locator('[data-testid="request-approval-history"]')).toContainText('보류', { timeout: 30_000 });
    await expect(requester.page.locator('[data-testid="request-approval-history"]')).toContainText('예산 자료를 추가로 확인합니다.');
    expect(await resumeJobCount(db, execution.instance_id)).toBe(0);

    await approveInBrowser(approver.page, title, '실무 검토 승인');
    await waitForOpenTasks(approverB, execution.instance_id);
    await expect(requester.page.getByText('2단계 결재 진행 중')).toBeVisible({ timeout: 30_000 });

    const finalApprover = await loginPage(browser, fixture.users.b.id, userPassword);
    await approveInBrowser(finalApprover.page, title, '최종 승인 완료');
    await waitForInstance(admin, execution.instance_id, (instance) => instance.state === 'COMPLETED');
    await expect(requester.page.getByText('모든 결재가 완료되었습니다')).toBeVisible({ timeout: 30_000 });
    await expect(requester.page.locator('[data-testid="request-approval-history"]')).toContainText('최종 승인 완료');

    await closeContexts(requester.context, approver.context, finalApprover.context);
  });

  test('ALL은 전원 승인까지 기다리고 ANY는 첫 승인 뒤 나머지를 취소한다', async () => {
    const title = uniqueTitle('ALL ANY 집계');
    const execution = await startApproval(admin, title, [
      step(1, '실무 검토', 'ALL', [pxmApprover('a'), pxmApprover('b')]),
      step(2, '임원 승인', 'ANY', [pxmApprover('b'), pxmApprover('c')]),
    ]);
    const [aTask] = await waitForOpenTasks(approverA, execution.instance_id);
    const [bTask] = await waitForOpenTasks(approverB, execution.instance_id);
    await approverA.post(`/tasks/${aTask.id}/complete`, { action: 'approve', comment: 'ALL A 승인' });
    expect(await resumeJobCount(db, execution.instance_id)).toBe(0);
    expect((await admin.get<any>(`/instances/${execution.instance_id}`)).state).toBe('WAITING');

    await approverB.post(`/tasks/${bTask.id}/complete`, { action: 'approve', comment: 'ALL B 승인' });
    const [bAny] = await waitForOpenTasks(approverB, execution.instance_id);
    await waitForOpenTasks(approverC, execution.instance_id);
    await approverB.post(`/tasks/${bAny.id}/complete`, { action: 'approve', comment: 'ANY 선착 승인' });

    await waitForInstance(admin, execution.instance_id, (instance) => instance.state === 'COMPLETED');
    const history = await waitForHistory(admin, execution.instance_id, (items) => items.length === 4);
    expect(history.filter((item: any) => item.current_step_order === 2 && item.status === 'CANCELED')).toHaveLength(1);
    expect(await resumeJobCount(db, execution.instance_id)).toBe(1);
  });

  test('반려는 기술 실패가 아니라 반려 분기로 정상 완료된다', async ({ browser }) => {
    const title = uniqueTitle('업무 반려');
    const execution = await startApproval(admin, title, [step(1, '검토', 'ALL', [pxmApprover('a')])]);
    const a = await loginPage(browser, fixture.users.a.id, userPassword);
    await rejectInBrowser(a.page, title, '예산 근거 부족으로 반려');

    const instance = await waitForInstance(admin, execution.instance_id, (row) => row.state === 'COMPLETED');
    expect(instance.state).not.toBe('FAILED');
    expect(instance.context?.data?.outputs?.approval?.outcome).toBe('rejected');
    const history = await taskHistory(admin, execution.instance_id);
    expect(history[0]).toMatchObject({ status: 'REJECTED', comment: '예산 근거 부족으로 반려' });
    const trace = await admin.get<any[]>(`/instances/${execution.instance_id}/trace`);
    expect(trace.some((event) => event.event_type === 'INSTANCE_FAILED')).toBeFalsy();
    await a.context.close();
  });

  test('운영 종료는 열린 결재를 취소하고 이후 처리를 거부한다', async ({ browser }) => {
    const title = uniqueTitle('운영 종료');
    const execution = await startApproval(admin, title, [
      step(1, '종료 검증', 'ALL', [pxmApprover('a'), pxmApprover('b')]),
    ]);
    const [aTask] = await waitForOpenTasks(approverA, execution.instance_id);
    const tracker = await loginPage(browser, fixture.users.admin.id, process.env.PXM_E2E_ADMIN_PASSWORD || 'E2eAdminPassword!2026', 'tracker');
    const row = tracker.page.locator(`[data-testid="tracker-instance-row"][data-instance-id="${execution.instance_id}"]`);
    await expect(row).toContainText(title, { timeout: 30_000 });
    await row.locator('[data-testid="tracker-terminate"]').click();
    await waitForInstance(admin, execution.instance_id, (instance) => instance.state === 'TERMINATED');

    const history = await waitForHistory(admin, execution.instance_id, (items) =>
      items.length === 2 && items.every((item: any) => item.status === 'CANCELED'));
    expect(history).toHaveLength(2);
    const lateCompletion = await approverA.rawPost(`/tasks/${aTask.id}/complete`, { action: 'approve' });
    expect(lateCompletion.status()).toBe(409);
    await tracker.context.close();
  });

  test('일시중지 중 결재 완료는 저장되지만 명시적 재개 전에는 후속 실행하지 않는다', async ({ browser }) => {
    const title = uniqueTitle('일시중지 승인');
    const execution = await startApproval(admin, title, [step(1, '중지 검증', 'ALL', [pxmApprover('a')])]);
    await waitForOpenTasks(approverA, execution.instance_id);
    const tracker = await loginPage(browser, fixture.users.admin.id, process.env.PXM_E2E_ADMIN_PASSWORD || 'E2eAdminPassword!2026', 'tracker');
    const row = tracker.page.locator(`[data-testid="tracker-instance-row"][data-instance-id="${execution.instance_id}"]`);
    await expect(row).toContainText(title, { timeout: 30_000 });
    await row.locator('[data-testid="tracker-pause-toggle"]').click();
    await waitForInstance(admin, execution.instance_id, (instance) => instance.is_paused === true);

    const a = await loginPage(browser, fixture.users.a.id, userPassword);
    await approveInBrowser(a.page, title, '중지 중 승인');
    await poll(async () => (await resumeJobCount(db, execution.instance_id)) === 1 ? true : null, 'paused resume job');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const paused = await admin.get<any>(`/instances/${execution.instance_id}`);
    expect(paused.is_paused).toBe(true);
    expect(paused.state).not.toBe('COMPLETED');

    await row.locator('[data-testid="tracker-pause-toggle"]').click();
    await waitForInstance(admin, execution.instance_id, (instance) => instance.state === 'COMPLETED');
    expect(await resumeJobCount(db, execution.instance_id)).toBe(1);
    await closeContexts(tracker.context, a.context);
  });

  test('외부 요청 키는 같은 revision 재전송을 재사용하고 변경 충돌 및 새 revision을 구분한다', async () => {
    const title = uniqueTitle('멱등성');
    const requestId = `IDEMPOTENCY-${Date.now()}`;
    const steps = [step(1, '멱등 검토', 'ALL', [pxmApprover('a')])];
    const first = await startApproval(admin, title, steps, { requestId, revision: 1, summary: '원본' });
    const replay = await startApproval(admin, title, steps, { requestId, revision: 1, summary: '원본' });
    expect(replay.instance_id).toBe(first.instance_id);
    expect(replay.idempotent_replay).toBe(true);

    const conflict = await admin.rawPost(`/templates/${fixture.workflowId}/start`,
      approvalPayload(title, steps, { requestId, revision: 1, summary: '변경됨' }));
    expect(conflict.status()).toBe(409);
    const revised = await startApproval(admin, title, steps, { requestId, revision: 2, summary: '변경됨' });
    expect(revised.instance_id).not.toBe(first.instance_id);
    await Promise.all([
      admin.post(`/instances/${first.instance_id}/terminate`, {}),
      admin.post(`/instances/${revised.instance_id}/terminate`, {}),
    ]);
  });

  test('매핑된 사용자는 PXM 웹 전용과 이메일 전용 채널을 각각 사용할 수 있다', async ({ browser }) => {
    const webTitle = uniqueTitle('매핑 웹 전용');
    const webExecution = await startApproval(admin, webTitle, [
      step(1, '웹 승인', 'ALL', [mappedApprover('a', ['pxm_user'])]),
    ]);
    const a = await loginPage(browser, fixture.users.a.id, userPassword);
    await approveInBrowser(a.page, webTitle, '매핑된 웹 승인');
    await waitForInstance(admin, webExecution.instance_id, (instance) => instance.state === 'COMPLETED');
    expect((await taskHistory(admin, webExecution.instance_id))[0]).toMatchObject({
      approval_channels: ['pxm_user'], completed_via: 'pxm_user',
    });

    await clearMailpit();
    const emailTitle = uniqueTitle('매핑 이메일 전용');
    const emailExecution = await startApproval(admin, emailTitle, [
      step(1, '이메일 승인', 'ALL', [mappedApprover('b', ['external_email'])]),
    ]);
    expect((await approverB.get<any[]>('/tasks')).some((task) => task.instance_id === emailExecution.instance_id)).toBeFalsy();
    const message = await waitForMail(fixture.users.b.email);
    const external = await openExternalApproval(browser, await approvalLink(message.ID), '매핑 이메일 승인');
    await waitForInstance(admin, emailExecution.instance_id, (instance) => instance.state === 'COMPLETED');
    expect((await taskHistory(admin, emailExecution.instance_id))[0]).toMatchObject({
      approval_channels: ['external_email'], completed_via: 'external_email', authentication_method: 'email_link',
    });
    await closeContexts(a.context, external.context);
  });

  test('미등록 외부 사용자는 이메일만 가능하고 PXM 웹 채널 요청은 거부된다', async ({ browser }) => {
    const email = `outside-${Date.now()}@partner.test`;
    const title = uniqueTitle('미등록 외부 이메일');
    const execution = await startApproval(admin, title, [
      step(1, '외부 승인', 'ALL', [externalApprover(email)]),
    ]);
    const message = await waitForMail(email);
    const external = await openExternalApproval(browser, await approvalLink(message.ID), '미등록 외부 승인');
    await waitForInstance(admin, execution.instance_id, (instance) => instance.state === 'COMPLETED');
    expect((await taskHistory(admin, execution.instance_id))[0].completed_via).toBe('external_email');

    const invalid = await admin.rawPost(`/templates/${fixture.workflowId}/start`, approvalPayload(
      uniqueTitle('미등록 PXM 거부'),
      [step(1, '잘못된 채널', 'ALL', [{
        principal: { provider: 'partner', subject: `UNKNOWN-${Date.now()}` },
        approval_channels: ['pxm_user'],
      }])],
      { requestId: `INVALID-${Date.now()}` },
    ));
    expect(invalid.status()).toBe(400);
    await external.context.close();
  });

  test('하이브리드 채널은 웹과 이메일 중 먼저 처리한 한 경로만 인정한다', async ({ browser }) => {
    const webWinsTitle = uniqueTitle('하이브리드 웹 선착');
    const webWins = await startApproval(admin, webWinsTitle, [
      step(1, '하이브리드', 'ALL', [mappedApprover('a', ['pxm_user', 'external_email'])]),
    ]);
    const webMail = await waitForMail(fixture.users.a.email);
    const webLink = await approvalLink(webMail.ID);
    const a = await loginPage(browser, fixture.users.a.id, userPassword);
    await approveInBrowser(a.page, webWinsTitle, '웹이 먼저 승인');
    await waitForInstance(admin, webWins.instance_id, (instance) => instance.state === 'COMPLETED');
    expect(await mailCount(fixture.users.a.email)).toBe(1);
    const consumed = await browser.newContext();
    const consumedPage = await consumed.newPage();
    await consumedPage.goto(webLink);
    await expect(consumedPage.getByRole('heading', { name: '승인 요청을 열 수 없습니다' })).toBeVisible();
    const webHistory = await taskHistory(admin, webWins.instance_id);
    expect(webHistory).toHaveLength(1);
    expect(webHistory[0]).toMatchObject({
      approval_channels: ['pxm_user', 'external_email'], completed_via: 'pxm_user', authentication_method: 'pxm_session',
    });
    expect(await resumeJobCount(db, webWins.instance_id)).toBe(1);

    await clearMailpit();
    const emailWinsTitle = uniqueTitle('하이브리드 이메일 선착');
    const emailWins = await startApproval(admin, emailWinsTitle, [
      step(1, '하이브리드', 'ALL', [mappedApprover('b', ['pxm_user', 'external_email'])]),
    ]);
    const emailMail = await waitForMail(fixture.users.b.email);
    const external = await openExternalApproval(browser, await approvalLink(emailMail.ID), '이메일이 먼저 승인');
    await waitForInstance(admin, emailWins.instance_id, (instance) => instance.state === 'COMPLETED');
    const [emailHistory] = await taskHistory(admin, emailWins.instance_id);
    expect(emailHistory).toMatchObject({
      approval_channels: ['pxm_user', 'external_email'], completed_via: 'external_email', authentication_method: 'email_link',
    });
    expect(await mailCount(fixture.users.b.email)).toBe(1);
    expect(await resumeJobCount(db, emailWins.instance_id)).toBe(1);
    await closeContexts(a.context, consumed, external.context);
  });
});

function step(order: number, label: string, mode: 'ALL' | 'ANY', approvers: any[]) {
  return { order, label, mode, approvers };
}

function uniqueTitle(label: string) {
  return `[E2E ${Date.now()}-${Math.random().toString(16).slice(2, 7)}] ${label}`;
}

async function resumeJobCount(db: Db, instanceId: string) {
  return db.collection('v2_engine_jobs').countDocuments({ instance_id: instanceId, job_type: 'RESUME' });
}

async function openAndAssertApprovalDetails(page: Page, title: string, labels: string[], currentStep: string) {
  await page.goto(`${webBaseUrl}/#/inbox`);
  await page.getByPlaceholder('요청명, 신청자 검색').fill(title);
  const row = page.locator('[data-testid="inbox-task-row"]', { hasText: title });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText(currentStep, { exact: false })).toBeVisible();
  for (const label of labels) await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
}

async function completeOpenedApproval(page: Page, comment: string) {
  await page.locator('.form-textarea-comment').fill(comment);
  await page.getByRole('button', { name: '승인 완료하기' }).click();
  await expect(page.getByRole('heading', { name: '내 결재함' })).toBeVisible();
}

async function openExternalApproval(browser: Browser, url: string, comment: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: fixture.workflowName })).toBeVisible();
  await page.getByLabel('의견 (선택)').fill(comment);
  await page.locator('[data-testid="external-approve"]').click();
  await expect(page.getByRole('heading', { name: '승인했습니다' })).toBeVisible();
  return { context, page };
}

async function closeContexts(...contexts: BrowserContext[]) {
  await Promise.all(contexts.map((context) => context.close()));
}
