const apiBaseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:3011/api';
const mailpitApiUrl =
  process.env.MAILPIT_API_URL || 'http://127.0.0.1:8025/api/v1';
const userId = process.env.PXM_DEMO_USER || 'admin';
const password = process.env.PXM_DEMO_PASSWORD || 'admin1234';
const runId = Date.now();
const recipient =
  process.env.PXM_DEMO_APPROVER_EMAIL || `approval-test+${runId}@pxm.local`;
const workflowName = 'TEST · 외부 이메일 OTP 승인';

const login = await fetch(`${apiBaseUrl}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: userId, password }),
});
if (!login.ok)
  throw new Error(`login failed: ${login.status} ${await login.text()}`);
const cookies = login.headers.getSetCookie();
const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
const csrf = decodeURIComponent(
  cookies
    .map((value) => value.split(';')[0])
    .find((value) => value.includes('pxm_csrf='))
    ?.split('=')[1] || '',
);
const headers = {
  'content-type': 'application/json',
  cookie,
  'x-csrf-token': csrf,
};

const node = (id, x, nodeType, label, description, extra = {}) => ({
  id,
  type: 'custom',
  position: { x, y: 220 },
  data: { nodeType, label, description, ...extra },
});
const edge = (source, target) => ({
  id: `edge-${source}-${target}`,
  source,
  target,
  type: 'smoothstep',
  animated: true,
});

const payload = {
  name: workflowName,
  description:
    'Mailpit에서 승인 링크와 OTP 수신 및 외부 승인/반려 흐름을 검증하는 테스트 워크플로우',
  tags: ['test', 'approval', 'external-email', 'otp'],
  version_note: '외부 이메일 OTP 승인 테스트 fixture',
  nodes: [
    node(
      'start',
      80,
      'start',
      '승인 요청 시작',
      '테스트 요청 정보를 입력합니다.',
      {
        triggerType: 'manual',
        formSchema: {
          fields: [
            {
              id: 'requestTitle',
              type: 'text',
              label: '요청 제목',
              required: true,
            },
            {
              id: 'amount',
              type: 'number',
              label: '요청 금액',
              required: true,
            },
            { id: 'requester', type: 'text', label: '요청자', required: true },
          ],
        },
      },
    ),
    node(
      'external-approval',
      380,
      'approval',
      '외부 이메일 승인',
      '이메일 링크와 OTP로 승인자를 확인합니다.',
      {
        approvalType: 'single',
        approverChannel: 'external_email',
        assignee: recipient,
        externalApprovalRequireOtp: true,
        externalApprovalExpiresInHours: 24,
      },
    ),
    node(
      'end',
      700,
      'end',
      '승인 처리 완료',
      '승인 또는 반려 결과로 워크플로우를 종료합니다.',
    ),
  ],
  edges: [edge('start', 'external-approval'), edge('external-approval', 'end')],
};

const existingResponse = await fetch(
  `${apiBaseUrl}/templates?activeOnly=false`,
  { headers: { cookie } },
);
if (!existingResponse.ok)
  throw new Error(
    `template list failed: ${existingResponse.status} ${await existingResponse.text()}`,
  );
const existing = (await existingResponse.json()).find(
  (item) => item.name === workflowName,
);
const saveResponse = await fetch(
  existing
    ? `${apiBaseUrl}/templates/${existing.id}`
    : `${apiBaseUrl}/templates`,
  {
    method: existing ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify(payload),
  },
);
if (!saveResponse.ok)
  throw new Error(
    `template save failed: ${saveResponse.status} ${await saveResponse.text()}`,
  );
const workflow = await saveResponse.json();

const executeResponse = await fetch(
  `${apiBaseUrl}/templates/${workflow.id}/execute`,
  {
    method: 'POST',
    headers,
    body: JSON.stringify({
      formData: {
        requestTitle: '외부 이메일 승인 테스트',
        amount: 125000,
        requester: userId,
      },
    }),
  },
);
if (!executeResponse.ok)
  throw new Error(
    `workflow execute failed: ${executeResponse.status} ${await executeResponse.text()}`,
  );
const execution = await executeResponse.json();

const message = await waitForMail(recipient, '승인이 필요한 요청', 20_000);
if (!message) throw new Error('approval link email was not received');
const approvalMail = await readMail(message.ID);
const approvalToken = approvalMail.Text?.match(
  /\/external-approval\/([A-Za-z0-9_-]{40,200})/,
)?.[1];
if (!approvalToken) throw new Error('approval token was not found in email');

if (process.env.PXM_DEMO_AUTO_COMPLETE !== 'true') {
  console.log(
    JSON.stringify(
      {
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        instance_id: execution.instance_id,
        recipient,
        approval_mail_received: true,
        approval_url: `http://localhost:5174/external-approval/${approvalToken}`,
      },
      null,
      2,
    ),
  );
} else {
  await completeApprovalE2e();
}

async function completeApprovalE2e() {
  const approvalDetails = await readApi(
    `${apiBaseUrl}/external-approvals/${approvalToken}`,
  );
  if (!approvalDetails.requires_otp)
    throw new Error('approval request did not require OTP');
  const otpResponse = await readApi(
    `${apiBaseUrl}/external-approvals/${approvalToken}/otp`,
    { method: 'POST' },
  );
  const otpMessage = await waitForMail(recipient, '외부 승인 인증번호', 20_000);
  if (!otpMessage) throw new Error('OTP email was not received');
  const otpMail = await readMail(otpMessage.ID);
  const otp = otpMail.Text?.match(/\b(\d{6})\b/)?.[1];
  if (!otp) throw new Error('OTP was not found in email');

  const completion = await readApi(
    `${apiBaseUrl}/external-approvals/${approvalToken}/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'approve',
        comment: 'Mailpit external approval E2E',
        otp,
      }),
    },
  );
  const replayStatus = await fetch(
    `${apiBaseUrl}/external-approvals/${approvalToken}`,
  ).then((response) => response.status);
  if (replayStatus !== 410)
    throw new Error(`consumed link returned ${replayStatus}, expected 410`);

  const history = await readApi(
    `${apiBaseUrl}/tasks/history?instance_id=${encodeURIComponent(execution.instance_id)}`,
    { headers: { cookie } },
  );
  const completedTask = history.items?.find(
    (item) => item.approver_channel === 'external_email',
  );
  if (
    !completedTask ||
    completedTask.status !== 'APPROVED' ||
    completedTask.authentication_method !== 'email_otp'
  )
    throw new Error(
      'completed external approval was not found in task history',
    );

  console.log(
    JSON.stringify(
      {
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        instance_id: execution.instance_id,
        recipient,
        approval_mail_received: true,
        otp_mail_received: otpResponse.sent === true,
        approval_status: completion.status,
        authentication_method: completedTask.authentication_method,
        consumed_link_status: replayStatus,
      },
      null,
      2,
    ),
  );
}

async function waitForMail(email, subject, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitApiUrl}/messages`);
    if (response.ok) {
      const body = await response.json();
      const message = (body.messages || []).find(
        (item) =>
          (item.To || []).some((target) => target.Address === email) &&
          item.Subject.includes(subject),
      );
      if (message) return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function readMail(id) {
  const response = await fetch(
    `${mailpitApiUrl}/message/${encodeURIComponent(id)}`,
  );
  if (!response.ok) throw new Error(`mail read failed: ${response.status}`);
  return response.json();
}

async function readApi(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      `API request failed: ${response.status} ${body?.message || JSON.stringify(body)}`,
    );
  return body;
}
