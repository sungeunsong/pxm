import { randomUUID } from 'crypto';
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

function edge(source, target, id = `${source}-${target}`) {
  return {
    id,
    source,
    target,
    type: 'smoothstep',
    animated: true,
    style: { stroke: 'var(--color-info)', strokeWidth: 2 },
  };
}

function startNode(id, x, y, label, fields) {
  return node(id, x, y, {
    label,
    nodeType: 'start',
    description: '요청 정보를 입력하고 워크플로우를 시작합니다.',
    formSchema: { fields },
  });
}

function approvalNode(id, x, y, label, assignee = 'admin') {
  return node(id, x, y, {
    label,
    nodeType: 'approval',
    description: '지정된 승인자가 요청을 검토합니다.',
    assignee,
    approvalType: 'single',
    requireComment: false,
  });
}

function pluginNode(id, x, y, data) {
  return node(id, x, y, {
    nodeType: 'service',
    ...data,
  });
}

function endNode(id, x, y, label = 'End') {
  return node(id, x, y, {
    label,
    nodeType: 'end',
    description: '워크플로우를 완료합니다.',
  });
}

function toDefinition(template) {
  const createdAt = now();
  return {
    _id: template.id,
    name: template.name,
    description: template.description,
    nodes: template.nodes.map((n) => ({
      node_id: n.id,
      node_type: n.data?.nodeType || 'task',
      config: {
        ...(n.data || {}),
        ui_node: n,
      },
    })),
    edges: template.edges.map((e, idx) => ({
      id: e.id || randomUUID(),
      source_node_id: e.source,
      target_node_id: e.target,
      condition_expr: e.data?.condition || null,
      is_default: e.data?.isDefault || false,
      eval_order: idx,
      ui_edge: e,
    })),
    created_at: createdAt,
    updated_at: createdAt,
  };
}

const templates = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Demo - Slack Notification',
    description: 'Start -> Slack Send Message -> End. 승인 없이 바로 완료되는 기본 플러그인 실행 예제입니다.',
    nodes: [
      startNode('start', 80, 120, 'Request Start', [
        {
          id: 'requester',
          type: 'text',
          label: 'Requester',
          required: true,
          defaultValue: 'kim.admin',
        },
        {
          id: 'message',
          type: 'text',
          label: 'Message',
          required: true,
          defaultValue: 'PXM plugin demo notification',
        },
      ]),
      pluginNode('slack', 360, 120, {
        label: 'Slack Send Message',
        description: '요청 내용을 Slack 채널에 알립니다.',
        plugin_id: 'connector.slack.send_message',
        plugin_version: '1.0.0',
        icon: 'message-square',
        category: 'Collaboration',
        channel: '#it-ops',
        message: 'PXM plugin demo notification',
        timeout: 5000,
        retryCount: 3,
        enableRetry: true,
      }),
      endNode('end', 640, 120),
    ],
    edges: [edge('start', 'slack'), edge('slack', 'end')],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Demo - Access Approval With ACRA',
    description: 'Start -> Approval(admin) -> ACRA Grant Permission -> Slack -> End. 승인 후 권한 부여와 알림까지 완료됩니다.',
    nodes: [
      startNode('start', 60, 170, 'Access Request', [
        {
          id: 'requester',
          type: 'text',
          label: 'Requester',
          required: true,
          defaultValue: 'lee.user',
        },
        {
          id: 'targetSystem',
          type: 'text',
          label: 'Target System',
          required: true,
          defaultValue: 'ACRA-POINT',
        },
        {
          id: 'permissionCode',
          type: 'text',
          label: 'Permission Code',
          required: true,
          defaultValue: 'POINT_READ',
        },
      ]),
      approvalNode('approval', 320, 170, 'Manager Approval'),
      pluginNode('acra', 610, 170, {
        label: 'ACRA Grant Permission',
        description: '승인된 사용자에게 ACRA 권한 코드를 부여합니다.',
        plugin_id: 'connector.acra.grant_permission',
        plugin_version: '1.0.0',
        icon: 'shield-check',
        category: 'Access',
        targetSystem: 'ACRA-POINT',
        permissionCode: 'POINT_READ',
        subjectTemplate: '{{formData.requester}}',
        timeout: 5000,
        retryCount: 3,
        enableRetry: true,
      }),
      pluginNode('slack', 900, 170, {
        label: 'Slack Completion Notice',
        description: '권한 부여 완료를 운영 채널에 알립니다.',
        plugin_id: 'connector.slack.send_message',
        plugin_version: '1.0.0',
        icon: 'message-square',
        category: 'Collaboration',
        channel: '#access-ops',
        message: 'ACRA access request completed',
        timeout: 5000,
        retryCount: 3,
        enableRetry: true,
      }),
      endNode('end', 1190, 170),
    ],
    edges: [
      edge('start', 'approval'),
      edge('approval', 'acra'),
      edge('acra', 'slack'),
      edge('slack', 'end'),
    ],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Demo - NIT Ticket Approval',
    description: 'Start -> Approval(admin) -> NIT Create Issue -> Slack -> End. 승인 후 NIT 티켓을 만들고 완료 알림을 보냅니다.',
    nodes: [
      startNode('start', 60, 250, 'Ticket Request', [
        {
          id: 'requester',
          type: 'text',
          label: 'Requester',
          required: true,
          defaultValue: 'park.dev',
        },
        {
          id: 'summary',
          type: 'text',
          label: 'Issue Summary',
          required: true,
          defaultValue: '신규 개발 VM 접근 요청',
        },
      ]),
      approvalNode('approval', 320, 250, 'Team Lead Approval'),
      pluginNode('nit', 610, 250, {
        label: 'NIT Create Issue',
        description: '승인된 요청을 NIT 작업 티켓으로 등록합니다.',
        plugin_id: 'connector.nit.create_issue',
        plugin_version: '1.0.0',
        icon: 'ticket',
        category: 'Issue Management',
        projectKey: 'PXM',
        titleTemplate: '{{formData.summary}}',
        priority: 'MEDIUM',
        timeout: 5000,
        retryCount: 3,
        enableRetry: true,
      }),
      pluginNode('slack', 900, 250, {
        label: 'Slack Ticket Notice',
        description: 'NIT 티켓 생성 결과를 알립니다.',
        plugin_id: 'connector.slack.send_message',
        plugin_version: '1.0.0',
        icon: 'message-square',
        category: 'Collaboration',
        channel: '#dev-ops',
        message: 'NIT ticket has been created',
        timeout: 5000,
        retryCount: 3,
        enableRetry: true,
      }),
      endNode('end', 1190, 250),
    ],
    edges: [
      edge('start', 'approval'),
      edge('approval', 'nit'),
      edge('nit', 'slack'),
      edge('slack', 'end'),
    ],
  },
];

try {
  await client.connect();
  const db = client.db(dbName);
  await db.collection('v2_process_definitions').deleteMany({});
  await db
    .collection('v2_process_definitions')
    .insertMany(templates.map(toDefinition));
  console.log(
    `[seed:plugin-demo] replaced templates with ${templates.length} plugin demo templates`,
  );
} finally {
  await client.close();
}
