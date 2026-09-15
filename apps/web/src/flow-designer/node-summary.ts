// 노드 카드 두 번째 줄에 표시할 설정 요약
// apps/web/src/flow-designer/node-summary.ts
//
// 표시 원칙
// - 실제 설정값이 있으면 설정 요약을, 없으면 사용자가 적은 설명을, 그것도 없으면 일반 설명을 쓴다
// - 자격증명·토큰·이메일 주소·승인자 ID·명령 인자 같은 민감값은 넣지 않는다
// - Gateway 분기 조건은 엣지에 이미 표시되므로 카드에서 반복하지 않는다

import type { CustomNodeData } from './form-types';

type NodeType = CustomNodeData['nodeType'];
type NodeData = CustomNodeData & Record<string, unknown>;

const GENERIC_DESCRIPTION: Record<NodeType, string> = {
  start: '워크플로우 시작',
  service: '외부 시스템 호출',
  script: 'JavaScript 실행',
  command: 'Allowlist command 실행',
  timer: '대기 후 진행',
  gateway: '조건 분기',
  approval: '결재 승인',
  workflow_call: '다른 워크플로우 호출',
  end: '워크플로우 종료',
};

const TIMER_TYPE_LABEL: Record<string, string> = {
  delay: 'Delay',
  interval: 'Interval',
  cron: 'Cron',
};

const GATEWAY_TYPE_LABEL: Record<string, string> = {
  exclusive: 'Exclusive (XOR)',
  parallel: 'Parallel (AND)',
  inclusive: 'Inclusive (OR)',
};

const APPROVAL_TYPE_LABEL: Record<string, string> = {
  single: '단일 승인',
  multiple: '다중 승인',
  sequential: '순차 승인',
};

const VALUE_MAX_LENGTH = 24;

function text(data: NodeData, key: string): string {
  const value = data[key];
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(value: string): string {
  if (value.length <= VALUE_MAX_LENGTH) return value;
  return `${value.slice(0, VALUE_MAX_LENGTH - 1)}…`;
}

function join(parts: Array<string | undefined | null>): string {
  return parts.filter((part): part is string => Boolean(part && part.length)).join(' · ');
}

// URL 전체 대신 호스트(상대 URL은 경로)만 남긴다.
// 파싱할 수 없는 값에는 query, userinfo, 템플릿 변수가 섞일 수 있으므로 원문을 노출하지 않는다.
function hostOf(url: string): string {
  if (!url) return '';
  if (!url.includes('{{')) {
    try {
      return new URL(url).host || truncate(url);
    } catch {
      // 아래 정규식으로 처리
    }
  }
  const matched = url.match(/^[a-zA-Z][\w+.-]*:\/\/([^/?#]+)/);
  if (matched) {
    const authorityWithoutUserInfo = matched[1].split('@').at(-1) || '';
    return authorityWithoutUserInfo.includes('{{') ? 'URL 설정됨' : truncate(authorityWithoutUserInfo);
  }
  if (url.startsWith('/')) {
    return truncate(url.split(/[?#]/, 1)[0]);
  }
  return 'URL 설정됨';
}

function durationLabel(raw: string): string {
  const ms = Number(raw);
  if (!raw || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))}초`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Number(minutes.toFixed(minutes < 10 ? 1 : 0))}분`;
  const hours = minutes / 60;
  return `${Number(hours.toFixed(hours < 10 ? 1 : 0))}시간`;
}

function secondsLabel(raw: string): string {
  const seconds = Number(raw);
  if (!raw || !Number.isFinite(seconds) || seconds <= 0) return '';
  return durationLabel(String(seconds * 1000));
}

function startSummary(data: NodeData): string {
  const triggerType = text(data, 'triggerType') || 'manual';

  if (triggerType === 'schedule') {
    const scheduleType = text(data, 'scheduleType') || 'interval';
    if (scheduleType === 'cron') {
      return join(['Cron', truncate(text(data, 'cronExpression'))]);
    }
    return join(['주기 실행', secondsLabel(text(data, 'intervalSeconds'))]);
  }

  if (triggerType === 'db_watch') {
    const source = text(data, 'dbWatchCollection') || text(data, 'dbWatchDatabase');
    return join(['DB Watch', truncate(source), text(data, 'dbWatchOperation')]);
  }

  const fieldCount = data.formSchema?.fields?.length || 0;
  return join(['수동/API', fieldCount ? `입력 ${fieldCount}개` : '']);
}

function serviceSummary(data: NodeData): string {
  const pluginId = text(data, 'plugin_id');

  if (pluginId === 'connector.db.mongodb.query') {
    return join([
      'MongoDB',
      truncate(text(data, 'collection') || text(data, 'database')),
      text(data, 'operation'),
    ]);
  }

  if (pluginId === 'builtin.ssh') {
    return join(['SSH', text(data, 'command') ? '명령 설정됨' : '']);
  }

  const url = text(data, 'url');
  if (pluginId === 'builtin.http_request' || url) {
    const method = (text(data, 'method') || 'GET').toUpperCase();
    return join([method, hostOf(url)]);
  }

  return join([truncate(text(data, 'category')), truncate(pluginId)]);
}

function approvalSummary(data: NodeData): string {
  const deadline = data.approvalDeadlineEnabled
    ? `${text(data, 'approvalDeadlineValue') || '1'}${({ minutes: '분', hours: '시간', days: '일' } as Record<string, string>)[text(data, 'approvalDeadlineUnit') || 'days']}`
    : '';
  const lineSource =
    text(data, 'approvalLineSource') || (text(data, 'approvalType') === 'dynamic' ? 'dynamic' : 'fixed');
  if (lineSource === 'dynamic') return join(['요청에서 결재선 전달', deadline && `기한 ${deadline}`]);

  const channels = Array.isArray(data.approvalChannels) && data.approvalChannels.length
    ? data.approvalChannels
    : [text(data, 'approverChannel') || 'pxm_user'];
  const allowsPxm = channels.includes('pxm_user');
  const allowsExternal = channels.includes('external_email');
  const externalLabel = data.externalApprovalRequireOtp ? '이메일+OTP' : '이메일';
  const channelLabel = allowsPxm && allowsExternal
    ? `PXM 웹+${externalLabel}`
    : allowsExternal
      ? externalLabel
      : 'PXM 웹';

  const approvalType = text(data, 'approvalType');
  return join(['고정', channelLabel, APPROVAL_TYPE_LABEL[approvalType] || APPROVAL_TYPE_LABEL.single, deadline && `기한 ${deadline}`]);
}

function workflowCallSummary(data: NodeData): string {
  // 호출 대상이 없으면 아직 설정 전이므로 일반 설명으로 넘긴다
  const target = text(data, 'targetWorkflowName');
  if (!target) return '';
  const mode = text(data, 'workflowCallMode') || text(data, 'callMode') || 'async';
  return join([truncate(target), mode === 'wait' ? '완료까지 대기' : '비동기 호출']);
}

function configSummary(data: NodeData): string {
  switch (data.nodeType) {
    case 'start':
      return startSummary(data);
    case 'service':
      return serviceSummary(data);
    case 'script': {
      const outputPath = text(data, 'outputPath');
      const libraryCount = Array.isArray(data.scriptLibraries) ? data.scriptLibraries.length : 0;
      if (!outputPath && !text(data, 'code')) return '';
      return join([
        'JavaScript',
        libraryCount > 0 ? `라이브러리 ${libraryCount}개` : '',
        outputPath ? `출력 ${truncate(outputPath)}` : '',
      ]);
    }
    case 'command': {
      const commandId = truncate(text(data, 'commandId'));
      if (!commandId) return '';
      const outputPath = text(data, 'outputPath');
      return join([commandId, outputPath ? `출력 ${truncate(outputPath)}` : '']);
    }
    case 'timer': {
      const duration = durationLabel(text(data, 'durationMs'));
      if (!duration) return '';
      const timerType = text(data, 'timerType') || 'delay';
      return join([TIMER_TYPE_LABEL[timerType] || TIMER_TYPE_LABEL.delay, duration]);
    }
    case 'gateway':
      return GATEWAY_TYPE_LABEL[text(data, 'gatewayType') || 'exclusive'] || GATEWAY_TYPE_LABEL.exclusive;
    case 'approval':
      return approvalSummary(data);
    case 'workflow_call':
      return workflowCallSummary(data);
    case 'end': {
      const resultPath = text(data, 'resultPath');
      return resultPath ? `결과 ${truncate(resultPath)}` : '';
    }
    default:
      return '';
  }
}

// 카드 두 번째 줄 텍스트. 설정 요약 > 사용자 설명 > 일반 설명 순으로 고른다
export function nodeSummaryLine(data: CustomNodeData): string {
  const source = data as NodeData;
  const summary = configSummary(source).trim();
  if (summary) return summary;
  const description = (data.description || '').trim();
  if (description) return description;
  return GENERIC_DESCRIPTION[data.nodeType] || '';
}

// 마우스를 올렸을 때 보여줄 전체 내용 (요약과 설명을 함께)
export function nodeSummaryTitle(data: CustomNodeData): string {
  const summary = nodeSummaryLine(data);
  const description = (data.description || '').trim();
  const lines = [data.label, summary];
  if (description && description !== summary) lines.push(description);
  return lines.filter(Boolean).join('\n');
}
