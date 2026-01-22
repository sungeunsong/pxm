import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  type WorkflowNodeData,
  NODE_STATUS_COLORS,
  NODE_TYPE_ICONS,
  type NodeStatus
} from './types';

// 커스텀 노드 Props 타입
interface WorkflowNodeProps {
  data: WorkflowNodeData;
  id: string;
}

// 상태 배지 컴포넌트
function StatusBadge({ status, attempt, maxAttempts }: {
  status: NodeStatus;
  attempt?: number;
  maxAttempts?: number;
}) {
  const labels: Record<NodeStatus, string> = {
    idle: '',
    running: 'Running',
    completed: 'Done',
    failed: 'Failed',
    waiting: 'Waiting',
    retrying: `Retry ${attempt ?? 0}/${maxAttempts ?? 5}`,
  };

  if (status === 'idle') return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: -8,
        right: -8,
        padding: '2px 6px',
        borderRadius: 8,
        fontSize: 10,
        fontWeight: 600,
        backgroundColor: NODE_STATUS_COLORS[status].border,
        color: '#fff',
        boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
        animation: status === 'running' || status === 'retrying' ? 'pulse 1.5s infinite' : undefined,
      }}
    >
      {labels[status]}
    </div>
  );
}

// 스피너 컴포넌트
function Spinner() {
  return (
    <div
      style={{
        width: 14,
        height: 14,
        border: '2px solid rgba(59, 130, 246, 0.3)',
        borderTopColor: '#3b82f6',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
        marginRight: 6,
      }}
    />
  );
}

// 메인 워크플로우 노드 컴포넌트
function WorkflowNodeComponent({ data }: WorkflowNodeProps) {
  const colors = NODE_STATUS_COLORS[data.status];
  const icon = NODE_TYPE_ICONS[data.nodeType];
  const isActive = data.status === 'running' || data.status === 'retrying';
  const isWaiting = data.status === 'waiting';

  return (
    <>
      {/* 입력 핸들 (start 제외) */}
      {data.nodeType !== 'start' && (
        <Handle
          type="target"
          position={Position.Left}
          style={{
            width: 10,
            height: 10,
            backgroundColor: colors.border,
            border: '2px solid #fff',
          }}
        />
      )}

      {/* 노드 본체 */}
      <div
        style={{
          minWidth: 140,
          padding: '12px 16px',
          borderRadius: data.nodeType === 'start' || data.nodeType === 'end' ? 24 : 12,
          backgroundColor: colors.bg,
          border: `2px solid ${colors.border}`,
          boxShadow: colors.glow || '0 4px 12px rgba(0,0,0,0.08)',
          transition: 'all 0.3s ease',
          position: 'relative',
          ...(isActive && {
            animation: 'glow 1.5s ease-in-out infinite alternate',
          }),
          ...(isWaiting && {
            animation: 'pulse-border 2s ease-in-out infinite',
          }),
        }}
      >
        {/* 상태 배지 */}
        <StatusBadge
          status={data.status}
          attempt={data.attempt}
          maxAttempts={data.maxAttempts}
        />

        {/* 노드 내용 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* 스피너 (실행 중일 때) */}
          {isActive && <Spinner />}

          {/* 아이콘 */}
          <span style={{ fontSize: 16 }}>{icon}</span>

          {/* 라벨 */}
          <span
            style={{
              fontWeight: 600,
              fontSize: 13,
              color: colors.text,
            }}
          >
            {data.label}
          </span>
        </div>

        {/* 에러 메시지 */}
        {data.status === 'failed' && data.error && (
          <div
            style={{
              marginTop: 8,
              padding: '4px 8px',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              borderRadius: 6,
              fontSize: 11,
              color: '#dc2626',
              maxWidth: 180,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {data.error}
          </div>
        )}

        {/* 타이머 표시 */}
        {data.nodeType === 'timer' && data.status === 'waiting' && data.duration && (
          <div
            style={{
              marginTop: 8,
              fontSize: 11,
              color: colors.text,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span style={{ animation: 'blink 1s infinite' }}>⏳</span>
            {Math.ceil(data.duration / 1000)}s remaining
          </div>
        )}
      </div>

      {/* 출력 핸들 (end 제외) */}
      {data.nodeType !== 'end' && (
        <Handle
          type="source"
          position={Position.Right}
          style={{
            width: 10,
            height: 10,
            backgroundColor: colors.border,
            border: '2px solid #fff',
          }}
        />
      )}
    </>
  );
}

export const WorkflowNode = memo(WorkflowNodeComponent);
