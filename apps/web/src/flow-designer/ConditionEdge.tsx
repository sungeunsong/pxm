import React from 'react';
import { EdgeLabelRenderer, getBezierPath } from 'reactflow';
import type { EdgeProps } from 'reactflow';
import './ConditionEdge.css';

export const ConditionEdge: React.FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label: edgeLabel,
  sourceHandleId,
  animated,
  data,
}) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isDefault = Boolean(data?.isDefault);
  const label = resolveBranchLabel(edgeLabel, data?.label, sourceHandleId, isDefault);
  const outcome = resolveBranchOutcome(sourceHandleId, label);
  // 두 노드가 가깝고 거의 같은 행이면 중간 공간에 라벨이 들어갈 수 없다.
  // 그런 엣지는 선 위로, 나머지는 진행 방향의 반대쪽으로 소폭 옮긴다.
  const isCrowdedHorizontalEdge = Math.abs(targetX - sourceX) < 96 && Math.abs(targetY - sourceY) < 72;
  const labelOffsetX = isCrowdedHorizontalEdge || targetX === sourceX ? 0 : targetX > sourceX ? -18 : 18;
  const labelOffsetY = isCrowdedHorizontalEdge ? -44 : 0;

  let edgeClassName = 'react-flow__edge-path';
  if (outcome === 'positive') edgeClassName += ' condition-edge-positive';
  if (outcome === 'negative') edgeClassName += ' condition-edge-negative';
  if (isDefault) edgeClassName += ' condition-edge-default';
  if (animated || data?.animated) edgeClassName += ' condition-edge-animated';
  if (data?.executionStatus) edgeClassName += ` condition-edge-execution-${data.executionStatus}`;

  return (
    <>
      <path
        id={id}
        style={style}
        className={edgeClassName}
        d={edgePath}
        markerEnd={markerEnd}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className={`condition-edge-label label-${outcome}${isDefault ? ' is-default' : ''}${data?.executionStatus ? ' execution-label' : ''}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX + labelOffsetX}px,${labelY + labelOffsetY}px)`,
            }}
            title={label}
            aria-label={isDefault ? `${label}, 기본 경로` : label}
            data-testid="branch-edge-label"
          >
            <span className="condition-edge-label-text">{label}</span>
            {isDefault && <span className="condition-edge-default-badge">기본</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

function resolveBranchLabel(
  edgeLabel: React.ReactNode,
  dataLabel: unknown,
  sourceHandleId: string | null | undefined,
  isDefault: boolean,
) {
  if (typeof edgeLabel === 'string' && edgeLabel.trim()) return edgeLabel.trim();
  if (typeof dataLabel === 'string' && dataLabel.trim()) return dataLabel.trim();
  if (sourceHandleId === 'approved') return '승인';
  if (sourceHandleId === 'rejected') return '반려';
  if (isDefault) return '기본 경로';
  return '';
}

function resolveBranchOutcome(sourceHandleId: string | null | undefined, label: string) {
  const normalized = label.trim().toLowerCase();
  if (sourceHandleId === 'approved' || normalized === 'true' || normalized === '승인') return 'positive';
  if (sourceHandleId === 'rejected' || normalized === 'false' || normalized === '반려') return 'negative';
  return 'neutral';
}
