import { expect, request, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { MongoClient } from 'mongodb';

export const apiBaseUrl = `http://127.0.0.1:${process.env.PXM_E2E_API_PORT || 3211}`;
export const webBaseUrl = `http://127.0.0.1:${process.env.PXM_E2E_WEB_PORT || 5274}`;
export const mailpitApiUrl = process.env.PXM_E2E_MAILPIT_API_URL
  || `http://127.0.0.1:${process.env.PXM_E2E_MAILPIT_PORT || 8126}/api/v1`;
export const adminPassword = process.env.PXM_E2E_ADMIN_PASSWORD || 'E2eAdminPassword!2026';
export const userPassword = 'E2eApproverPassword!2026';

export const fixture = {
  groupId: 'e2e-approvals',
  workflowId: '',
  workflowName: 'PXM 브라우저 동적 결재 회귀',
  users: {
    admin: { id: 'admin', name: 'E2E 관리자', email: 'admin@pxm.test' },
    a: { id: 'approver-a', name: '승인자 A', email: 'approver-a@pxm.test', subject: 'EMP-A' },
    b: { id: 'approver-b', name: '승인자 B', email: 'approver-b@pxm.test', subject: 'EMP-B' },
    c: { id: 'approver-c', name: '승인자 C', email: 'approver-c@pxm.test', subject: 'EMP-C' },
    manager: { id: 'approval-manager', name: '결재 그룹 관리자', email: 'approval-manager@pxm.test' },
  },
};

export class ApiSession {
  private constructor(
    readonly context: APIRequestContext,
    readonly csrf: string,
  ) {}

  static async login(userId: string, password: string): Promise<ApiSession> {
    const context = await request.newContext({ baseURL: apiBaseUrl });
    const response = await context.post('/api/auth/login', {
      data: { user_id: userId, password },
    });
    expect(response.ok(), `login failed for ${userId}: ${await response.text()}`).toBeTruthy();
    const state = await context.storageState();
    const csrf = state.cookies.find((cookie) => cookie.name === 'pxm_csrf')?.value || '';
    expect(csrf, `csrf cookie missing for ${userId}`).not.toBe('');
    return new ApiSession(context, csrf);
  }

  async get<T = any>(path: string): Promise<T> {
    const response = await this.context.get(`/api${path}`);
    return readResponse<T>(response, 'GET', path);
  }

  async post<T = any>(path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.context.post(`/api${path}`, {
      data,
      headers: { 'x-csrf-token': this.csrf, ...headers },
    });
    return readResponse<T>(response, 'POST', path);
  }

  async put<T = any>(path: string, data?: unknown): Promise<T> {
    const response = await this.context.put(`/api${path}`, {
      data,
      headers: { 'x-csrf-token': this.csrf },
    });
    return readResponse<T>(response, 'PUT', path);
  }

  async rawPost(path: string, data?: unknown, headers: Record<string, string> = {}) {
    return this.context.post(`/api${path}`, {
      data,
      headers: { 'x-csrf-token': this.csrf, ...headers },
    });
  }

  rawGet(path: string) {
    return this.context.get(`/api${path}`);
  }

  async dispose() {
    await this.context.dispose();
  }
}

export async function seedFixture(admin: ApiSession) {
  await clearMailpit();
  await admin.post('/authz/groups', {
    id: fixture.groupId,
    name: 'E2E 동적 결재 그룹',
    description: 'Playwright 격리 테스트 그룹',
  });
  for (const user of [fixture.users.a, fixture.users.b, fixture.users.c]) {
    await admin.post('/authz/users', {
      id: user.id,
      display_name: user.name,
      email: user.email,
      role: 'user',
      group_ids: [fixture.groupId],
      memberships: [{ group_id: fixture.groupId, role: 'user' }],
      password: userPassword,
    });
    await admin.post('/authz/external-principal-mappings', {
      provider: 'acrapoint',
      subject: user.subject,
      group_id: fixture.groupId,
      pxm_user_id: user.id,
      display_name: user.name,
      email: user.email,
      department: 'E2E 결재팀',
    });
  }
  await admin.post('/authz/users', {
    id: fixture.users.manager.id,
    display_name: fixture.users.manager.name,
    email: fixture.users.manager.email,
    role: 'group_manager',
    group_ids: [fixture.groupId],
    memberships: [{ group_id: fixture.groupId, role: 'group_manager' }],
    password: userPassword,
  });

  const template = await admin.post<any>('/templates', dynamicApprovalTemplate());
  fixture.workflowId = template.id;
  await admin.post(`/templates/${template.id}/deploy`, {});
}

export function dynamicApprovalTemplate() {
  const node = (id: string, x: number, y: number, nodeType: string, label: string, data = {}) => ({
    id,
    type: 'custom',
    position: { x, y },
    data: { nodeType, label, ...data },
  });
  return {
    name: fixture.workflowName,
    description: 'PXM-17 Playwright 동적 결재 회귀 fixture',
    group: 'E2E 동적 결재 그룹',
    group_id: fixture.groupId,
    tags: ['e2e', 'approval', 'regression'],
    version_note: 'PXM-17 isolated browser fixture',
    nodes: [
      node('start', 0, 120, 'start', '시작'),
      node('approval', 260, 120, 'approval', '동적 결재', {
        approvalLineSource: 'dynamic',
        approvalType: 'dynamic',
        approvalRequestPath: 'approval_request',
        externalApprovalRequireOtp: false,
        externalApprovalExpiresInHours: 24,
      }),
      node('approved-end', 560, 40, 'end', '승인 종료'),
      node('rejected-end', 560, 220, 'end', '반려 종료'),
    ],
    edges: [
      { id: 'start-approval', source: 'start', target: 'approval' },
      { id: 'approval-approved', source: 'approval', sourceHandle: 'approved', target: 'approved-end' },
      { id: 'approval-rejected', source: 'approval', sourceHandle: 'rejected', target: 'rejected-end' },
    ],
  };
}

export async function startApproval(
  admin: ApiSession,
  title: string,
  steps: any[],
  options: { requestId?: string; revision?: number; summary?: string; requester?: string } = {},
) {
  const requestId = options.requestId || `E2E-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return admin.post<any>(`/templates/${fixture.workflowId}/start`, approvalPayload(
    title,
    steps,
    { ...options, requestId },
  ));
}

export function approvalPayload(
  title: string,
  steps: any[],
  options: { requestId: string; revision?: number; summary?: string; requester?: string },
) {
  return {
    formData: {
      approval_request: {
        source: { provider: 'playwright' },
        request_id: options.requestId,
        revision: options.revision || 1,
        content: {
          title,
          summary: options.summary || `${title} 자동 회귀 검증`,
          requester: options.requester || fixture.users.admin.name,
          source_url: 'https://example.test/e2e',
        },
        approval_line: { steps },
      },
    },
  };
}

export function pxmApprover(
  key: 'a' | 'b' | 'c',
  channels: Array<'pxm_user' | 'external_email'> = ['pxm_user'],
) {
  const user = fixture.users[key];
  return {
    principal: { provider: 'pxm', subject: user.id },
    display: { name: user.name, email: user.email, department: 'E2E 결재팀' },
    delivery: { email: user.email },
    approval_channels: channels,
  };
}

export function mappedApprover(
  key: 'a' | 'b' | 'c',
  channels: Array<'pxm_user' | 'external_email'>,
) {
  const user = fixture.users[key];
  return {
    principal: { provider: 'acrapoint', subject: user.subject },
    approval_channels: channels,
  };
}

export function externalApprover(email: string) {
  return {
    principal: { provider: 'partner', subject: `external-${email}` },
    display: { name: '외부 승인자', email },
    delivery: { email },
    approval_channels: ['external_email'],
  };
}

export async function loginPage(browser: Browser, userId: string, password: string, route = 'inbox') {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(`${webBaseUrl}/#/${route}`);
  await page.getByLabel('사용자 ID').fill(userId);
  await page.getByLabel('비밀번호').fill(password);
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page.locator('.header-profile')).toContainText(userId);
  return { context, page };
}

/**
 * 되돌릴 수 없는 동작은 확인창을 거친다. 확인까지 눌러야 요청이 전송된다.
 * 버튼을 눌렀다는 것만으로는 아무것도 보장되지 않는다.
 *
 * Drawer도 role="dialog"이므로 확인창 클래스로 좁힌다. getByRole('dialog')는 둘 다 잡는다.
 */
export async function confirmDialogAction(page: Page, confirmLabel: string) {
  const dialog = page.locator('.pxm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * 결재 처리는 확인창을 거친 뒤 성공 토스트까지 확인해야 한다.
 * 목록으로 돌아온 것만 보면 접수 실패를 놓친다.
 */
export async function submitDecision(page: Page, actionLabel: string, confirmLabel: string) {
  await page.getByRole('button', { name: actionLabel }).click();
  await confirmDialogAction(page, confirmLabel);
  await expect(page.locator('.pxm-toast-title', { hasText: `${confirmLabel} 처리했습니다.` })).toBeVisible({
    timeout: 15_000,
  });
}

export async function approveInBrowser(page: Page, title: string, comment: string) {
  await openInboxTask(page, title);
  await page.locator('.form-textarea-comment').fill(comment);
  await submitDecision(page, '승인 완료하기', '승인');
}

export async function rejectInBrowser(page: Page, title: string, comment: string) {
  await openInboxTask(page, title);
  await page.locator('[data-testid="decision-reject"]').click();
  await page.locator('.form-textarea-comment').fill(comment);
  await page.getByLabel('반려 사유를 확인했습니다.').check();
  await submitDecision(page, '반려 처리하기', '반려');
}

export async function openInboxTask(page: Page, title: string) {
  await page.goto(`${webBaseUrl}/#/inbox`);
  const search = page.getByPlaceholder('요청명, 신청자 검색');
  await search.fill(title);
  const row = page.locator('[data-testid="inbox-task-row"]', { hasText: title });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

export async function waitForInstance(admin: ApiSession, instanceId: string, predicate: (instance: any) => boolean) {
  return poll(async () => {
    const instance = await admin.get<any>(`/instances/${instanceId}`);
    return predicate(instance) ? instance : null;
  }, `instance ${instanceId}`);
}

export async function waitForOpenTasks(session: ApiSession, instanceId: string, count = 1) {
  return poll(async () => {
    const tasks = await session.get<any[]>('/tasks');
    const matches = tasks.filter((task) => task.instance_id === instanceId && task.status === 'OPEN');
    return matches.length === count ? matches : null;
  }, `${count} open task(s) for ${instanceId}`);
}

export async function taskHistory(admin: ApiSession, instanceId: string) {
  const page = await admin.get<any>(`/instances/${instanceId}/tasks?limit=100`);
  return page.items || [];
}

export async function waitForHistory(
  admin: ApiSession,
  instanceId: string,
  predicate: (items: any[]) => boolean,
) {
  return poll(async () => {
    const items = await taskHistory(admin, instanceId);
    return predicate(items) ? items : null;
  }, `task history for ${instanceId}`);
}

export async function waitForMail(recipient: string, subjectPart = '승인이 필요한 요청') {
  return poll(async () => {
    const response = await fetch(`${mailpitApiUrl}/messages`);
    if (!response.ok) return null;
    const body = await response.json();
    return (body.messages || []).find((message: any) =>
      (message.To || []).some((target: any) => target.Address === recipient)
      && String(message.Subject || '').includes(subjectPart),
    ) || null;
  }, `mail for ${recipient}`, 30_000);
}

export async function approvalLink(messageId: string) {
  const response = await fetch(`${mailpitApiUrl}/message/${encodeURIComponent(messageId)}`);
  expect(response.ok).toBeTruthy();
  const message = await response.json();
  const token = String(message.Text || '').match(/\/external-approval\/([A-Za-z0-9_-]{40,200})/)?.[1];
  expect(token, 'external approval token missing from email').toBeTruthy();
  return `${webBaseUrl}/external-approval/${token}`;
}

export async function mailCount(recipient: string, subjectPart = '승인이 필요한 요청') {
  const response = await fetch(`${mailpitApiUrl}/messages`);
  const body = await response.json();
  return (body.messages || []).filter((message: any) =>
    (message.To || []).some((target: any) => target.Address === recipient)
    && String(message.Subject || '').includes(subjectPart),
  ).length;
}

export async function clearMailpit() {
  await fetch(`${mailpitApiUrl}/messages`, { method: 'DELETE' }).catch(() => undefined);
}

export async function databaseConnection() {
  if (!process.env.MONGODB_URL || !process.env.MONGO_DB_NAME) {
    throw new Error('MONGODB_URL and MONGO_DB_NAME are required for E2E assertions');
  }
  const client = new MongoClient(process.env.MONGODB_URL);
  await client.connect();
  return { client, db: client.db(process.env.MONGO_DB_NAME) };
}

export async function poll<T>(operation: () => Promise<T | null>, description: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ''}`);
}

async function readResponse<T>(response: any, method: string, path: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`${method} ${path} failed: ${response.status()} ${JSON.stringify(body)}`);
  }
  return body as T;
}
