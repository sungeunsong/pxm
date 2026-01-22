// 워크플로우 노드 상태
export type NodeStatus =
  | 'idle'      // 대기 중 (아직 실행 안 됨)
  | 'running'   // 실행 중
  | 'completed' // 완료
  | 'failed'    // 실패
  | 'waiting'   // 타이머/승인 대기
  | 'retrying'; // 재시도 중

// 노드 타입
export type NodeType = 'start' | 'service' | 'timer' | 'gateway' | 'approval' | 'end';

// 워크플로우 노드 데이터 (Record<string, unknown> 확장 필요)
export interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  nodeType: NodeType;
  status: NodeStatus;
  // 추가 정보
  attempt?: number;
  maxAttempts?: number;
  error?: string;
  duration?: number;
}

// 실행 이벤트 (로그용)
export interface ExecutionEvent {
  id: string;
  timestamp: string;
  eventType: string;
  nodeId?: string;
  status?: NodeStatus;
  message?: string;
  details?: Record<string, any>;
}

// 노드 상태별 색상
export const NODE_STATUS_COLORS: Record<NodeStatus, { bg: string; border: string; text: string; glow?: string }> = {
  idle: {
    bg: '#f8fafc',
    border: '#cbd5e1',
    text: '#64748b'
  },
  running: {
    bg: '#dbeafe',
    border: '#3b82f6',
    text: '#1d4ed8',
    glow: '0 0 20px rgba(59, 130, 246, 0.5)'
  },
  completed: {
    bg: '#dcfce7',
    border: '#22c55e',
    text: '#15803d'
  },
  failed: {
    bg: '#fee2e2',
    border: '#ef4444',
    text: '#dc2626',
    glow: '0 0 20px rgba(239, 68, 68, 0.5)'
  },
  waiting: {
    bg: '#fef3c7',
    border: '#f59e0b',
    text: '#d97706',
    glow: '0 0 20px rgba(245, 158, 11, 0.4)'
  },
  retrying: {
    bg: '#fae8ff',
    border: '#c026d3',
    text: '#a21caf',
    glow: '0 0 20px rgba(192, 38, 211, 0.4)'
  },
};

// 노드 타입별 아이콘
export const NODE_TYPE_ICONS: Record<NodeType, string> = {
  start: '▶',
  service: '⚡',
  timer: '⏱',
  gateway: '◇',
  approval: '✓',
  end: '⬤',
};
