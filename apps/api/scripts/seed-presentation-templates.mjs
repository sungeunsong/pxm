import { MongoClient } from 'mongodb';

const mongodbUrl =
  process.env.MONGODB_URL || 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const dbName = process.env.MONGO_DB_NAME || 'pxm_db';

const client = new MongoClient(mongodbUrl);
const now = () => new Date().toISOString();

function node(id, x, y, data) {
  return {
    id,
    type: 'custom',
    position: { x, y },
    data,
  };
}

function edge(source, target, options = {}) {
  const {
    id = `${source}-${target}`,
    condition = null,
    isDefault = false,
    label,
    sourceHandle,
    stroke = '#2563eb',
  } = options;

  return {
    id,
    source,
    target,
    sourceHandle,
    type: 'smoothstep',
    animated: true,
    label,
    data: {
      condition,
      isDefault,
    },
    style: {
      stroke,
      strokeWidth: 2.5,
    },
  };
}

function startNode(id, x, y, label, fields, description) {
  return node(id, x, y, {
    label,
    nodeType: 'start',
    description,
    icon: 'play',
    formSchema: { fields },
  });
}

function gatewayNode(id, x, y, label, gatewayType, description) {
  return node(id, x, y, {
    label,
    nodeType: 'gateway',
    gatewayType,
    icon: 'diamond',
    description,
  });
}

function approvalNode(id, x, y, label, approvalLine, description) {
  return node(id, x, y, {
    label,
    nodeType: 'approval',
    icon: 'check-square',
    description,
    approvalLine,
    assignee: approvalLine?.assignee || approvalLine?.defaultAssignee || 'admin',
    approvalType: approvalLine?.mode || 'fixed',
    requireComment: true,
  });
}

function serviceNode(id, x, y, label, pluginId, icon, config, description) {
  return node(id, x, y, {
    label,
    nodeType: 'service',
    icon,
    description,
    plugin_id: pluginId,
    plugin_version: '1.0.0',
    timeout: 5000,
    retryCount: 3,
    enableRetry: true,
    ...config,
  });
}

function timerNode(id, x, y, label, durationMs, description) {
  return node(id, x, y, {
    label,
    nodeType: 'timer',
    icon: 'clock',
    description,
    durationMs: String(durationMs),
  });
}

function endNode(id, x, y, label = '완료') {
  return node(id, x, y, {
    label,
    nodeType: 'end',
    icon: 'circle-check',
    description: '워크플로우를 종료합니다.',
  });
}

function textField(id, label, defaultValue, required = true) {
  return {
    id,
    type: 'text',
    label,
    required,
    defaultValue,
  };
}

function numberField(id, label, defaultValue, required = true) {
  return {
    id,
    type: 'number',
    label,
    required,
    defaultValue,
  };
}

function selectField(id, label, defaultValue, options, required = true) {
  return {
    id,
    type: 'select',
    label,
    required,
    defaultValue,
    options,
  };
}

function toDefinition(template) {
  const timestamp = now();
  return {
    _id: template.id,
    name: template.name,
    description: template.description,
    presentation_demo: true,
    nodes: template.nodes.map((n) => ({
      node_id: n.id,
      node_type: n.data?.nodeType || 'task',
      label: n.data?.label || n.id,
      config: {
        ...(n.data || {}),
        ui_node: n,
      },
      created_at: timestamp,
      updated_at: timestamp,
    })),
    edges: template.edges.map((e, idx) => ({
      id: e.id,
      source_node_id: e.source,
      target_node_id: e.target,
      condition_expr: e.data?.condition || null,
      is_default: Boolean(e.data?.isDefault),
      eval_order: idx,
      ui_edge: e,
      created_at: timestamp,
      updated_at: timestamp,
    })),
    created_at: template.created_at || timestamp,
    updated_at: timestamp,
  };
}

const templates = [
  {
    id: '90000000-0000-4000-8000-000000000001',
    name: '발표용 01 - 기본 알림 자동화',
    description:
      '신청 폼 입력 후 Slack 알림을 보내고 종료하는 가장 단순한 자동화 흐름입니다.',
    nodes: [
      startNode(
        'start',
        80,
        180,
        '신청 접수',
        [
          textField('requester', '요청자', 'kim.user'),
          textField('message', '알림 메시지', '신규 요청이 접수되었습니다.'),
        ],
        '요청자가 기본 정보를 입력합니다.',
      ),
      serviceNode(
        'slack_notify',
        390,
        180,
        'Slack 알림',
        'connector.slack.send_message',
        'message-square',
        {
          category: 'Collaboration',
          channel: '#pxm-demo',
          message: '{{formData.message}}',
        },
        '요청 내용을 담당 채널에 전송합니다.',
      ),
      endNode('end', 700, 180),
    ],
    edges: [edge('start', 'slack_notify'), edge('slack_notify', 'end')],
  },
  {
    id: '90000000-0000-4000-8000-000000000002',
    name: '발표용 02 - 결재 후 권한 부여',
    description:
      '권한 신청, 관리자 승인, ACRA 권한 부여, 완료 알림까지 이어지는 결재 포함 흐름입니다.',
    nodes: [
      startNode(
        'start',
        60,
        220,
        '권한 신청',
        [
          textField('requester', '신청자', 'lee.operator'),
          selectField('targetSystem', '대상 시스템', 'ACRA-POINT', [
            'ACRA-POINT',
            'PXM-ADMIN',
            'REPORTING',
          ]),
          textField('permissionCode', '권한 코드', 'POINT_READ'),
          textField('reason', '신청 사유', '월간 운영 리포트 확인'),
        ],
        '신청자가 시스템과 권한 코드를 입력합니다.',
      ),
      approvalNode(
        'manager_approval',
        330,
        220,
        '관리자 결재',
        { mode: 'fixed', assignee: 'admin' },
        '관리자가 신청 사유와 권한 범위를 검토합니다.',
      ),
      serviceNode(
        'acra_grant',
        620,
        220,
        'ACRA 권한 부여',
        'connector.acra.grant_permission',
        'shield-check',
        {
          category: 'Access',
          targetSystem: '{{formData.targetSystem}}',
          permissionCode: '{{formData.permissionCode}}',
          subjectTemplate: '{{formData.requester}}',
        },
        '승인된 사용자에게 권한을 부여합니다.',
      ),
      serviceNode(
        'slack_done',
        910,
        220,
        '완료 알림',
        'connector.slack.send_message',
        'message-square',
        {
          category: 'Collaboration',
          channel: '#access-ops',
          message: '권한 신청 처리가 완료되었습니다.',
        },
        '처리 완료 상태를 운영 채널에 알립니다.',
      ),
      endNode('end', 1190, 220),
    ],
    edges: [
      edge('start', 'manager_approval'),
      edge('manager_approval', 'acra_grant'),
      edge('acra_grant', 'slack_done'),
      edge('slack_done', 'end'),
    ],
  },
  {
    id: '90000000-0000-4000-8000-000000000003',
    name: '발표용 03 - 병렬 온보딩 처리',
    description:
      '입사자 요청을 접수한 뒤 HR 조회, AD 그룹 부여, Jira 티켓 생성을 병렬로 실행하고 다시 합류하는 흐름입니다.',
    nodes: [
      startNode(
        'start',
        40,
        300,
        '입사자 온보딩 요청',
        [
          textField('employeeId', '사번', 'E-2026-001'),
          textField('employeeName', '이름', 'Han Starter'),
          textField('department', '부서', 'Platform'),
        ],
        '입사자 기본 정보와 부서를 입력합니다.',
      ),
      gatewayNode(
        'split_parallel',
        290,
        300,
        '병렬 분기',
        'parallel',
        '서로 독립적인 온보딩 작업을 동시에 시작합니다.',
      ),
      serviceNode(
        'hr_lookup',
        570,
        120,
        'HR 사용자 조회',
        'connector.hr.lookup_user',
        'users',
        {
          category: 'HR',
          userTemplate: '{{formData.employeeId}}',
          includeManager: true,
        },
        'HR 시스템에서 입사자와 매니저 정보를 조회합니다.',
      ),
      serviceNode(
        'ad_group',
        570,
        300,
        'AD 그룹 부여',
        'connector.ad.grant_group',
        'user-plus',
        {
          category: 'Directory',
          userTemplate: '{{formData.employeeId}}',
          groupDn: 'CN=Platform-Onboarding,OU=Groups,DC=example,DC=com',
        },
        '부서 기본 그룹을 AD에 부여합니다.',
      ),
      serviceNode(
        'jira_ticket',
        570,
        480,
        'Jira 준비 티켓',
        'connector.jira.create_issue',
        'ticket',
        {
          category: 'Issue Management',
          projectKey: 'IT',
          issueType: 'Task',
          summary: '입사자 장비/계정 준비',
        },
        'IT 준비 작업을 Jira 티켓으로 생성합니다.',
      ),
      gatewayNode(
        'join_parallel',
        890,
        300,
        '병렬 합류',
        'parallel',
        '세 작업이 모두 도착하면 다음 단계로 진행합니다.',
      ),
      serviceNode(
        'slack_done',
        1160,
        300,
        '온보딩 완료 알림',
        'connector.slack.send_message',
        'message-square',
        {
          category: 'Collaboration',
          channel: '#hr-it-onboarding',
          message: '입사자 온보딩 준비가 완료되었습니다.',
        },
        'HR/IT 채널에 온보딩 완료를 알립니다.',
      ),
      endNode('end', 1440, 300),
    ],
    edges: [
      edge('start', 'split_parallel'),
      edge('split_parallel', 'hr_lookup', { id: 'split-hr', stroke: '#0891b2' }),
      edge('split_parallel', 'ad_group', { id: 'split-ad', stroke: '#7c3aed' }),
      edge('split_parallel', 'jira_ticket', { id: 'split-jira', stroke: '#f97316' }),
      edge('hr_lookup', 'join_parallel', { id: 'hr-join', stroke: '#0891b2' }),
      edge('ad_group', 'join_parallel', { id: 'ad-join', stroke: '#7c3aed' }),
      edge('jira_ticket', 'join_parallel', { id: 'jira-join', stroke: '#f97316' }),
      edge('join_parallel', 'slack_done'),
      edge('slack_done', 'end'),
    ],
  },
  {
    id: '90000000-0000-4000-8000-000000000004',
    name: '발표용 04 - 조건 분기 비용 승인',
    description:
      '금액 조건에 따라 고액 요청은 재무 결재를 거치고, 일반 요청은 바로 티켓 생성으로 진행하는 조건 분기 흐름입니다.',
    nodes: [
      startNode(
        'start',
        50,
        260,
        '비용 처리 요청',
        [
          textField('requester', '요청자', 'cho.finance'),
          numberField('amount', '금액', 1500),
          textField('summary', '요청 내용', 'SaaS 라이선스 구매'),
        ],
        '요청자가 금액과 처리 내용을 입력합니다.',
      ),
      gatewayNode(
        'amount_gateway',
        320,
        260,
        '금액 조건 확인',
        'exclusive',
        '금액이 기준을 넘는지 평가합니다.',
      ),
      approvalNode(
        'finance_approval',
        610,
        120,
        '재무 결재',
        {
          mode: 'condition',
          rules: [{ condition: 'amount > 1000', assignee: 'finance' }],
          defaultAssignee: 'admin',
        },
        '고액 요청은 재무 담당자의 승인을 받습니다.',
      ),
      timerNode(
        'settlement_wait',
        610,
        380,
        '처리 대기',
        2000,
        '일반 요청은 짧은 대기 후 자동 처리됩니다.',
      ),
      serviceNode(
        'nit_ticket',
        910,
        260,
        'NIT 처리 티켓',
        'connector.nit.create_issue',
        'ticket',
        {
          category: 'Issue Management',
          projectKey: 'FIN',
          priority: 'HIGH',
          titleTemplate: '{{formData.summary}}',
        },
        '비용 처리 작업을 NIT 티켓으로 등록합니다.',
      ),
      serviceNode(
        'slack_done',
        1190,
        260,
        '처리 결과 알림',
        'connector.slack.send_message',
        'message-square',
        {
          category: 'Collaboration',
          channel: '#finance-ops',
          message: '비용 처리 워크플로우가 완료되었습니다.',
        },
        '요청 처리 결과를 알립니다.',
      ),
      endNode('end', 1470, 260),
    ],
    edges: [
      edge('start', 'amount_gateway'),
      edge('amount_gateway', 'finance_approval', {
        id: 'amount-high',
        condition: 'amount > 1000',
        label: '1000 초과',
        sourceHandle: 'true',
        stroke: '#dc2626',
      }),
      edge('amount_gateway', 'settlement_wait', {
        id: 'amount-normal',
        isDefault: true,
        label: '기본',
        sourceHandle: 'false',
        stroke: '#16a34a',
      }),
      edge('finance_approval', 'nit_ticket'),
      edge('settlement_wait', 'nit_ticket'),
      edge('nit_ticket', 'slack_done'),
      edge('slack_done', 'end'),
    ],
  },
];

try {
  await client.connect();
  const db = client.db(dbName);
  const collection = db.collection('v2_process_definitions');

  for (const template of templates) {
    const definition = toDefinition(template);
    const { created_at, ...definitionUpdate } = definition;
    await collection.updateOne(
      { _id: definition._id },
      {
        $set: definitionUpdate,
        $setOnInsert: {
          created_at,
        },
      },
      { upsert: true },
    );
  }

  console.log(
    `[seed:presentation] upserted ${templates.length} presentation templates`,
  );
  for (const template of templates) {
    console.log(`- ${template.name} (${template.id})`);
  }
} finally {
  await client.close();
}
