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

  let edgeClassName = 'react-flow__edge-path';
  if (outcome === 'positive') edgeClassName += ' condition-edge-positive';
  if (outcome === 'negative') edgeClassName += ' condition-edge-negative';
  if (isDefault) edgeClassName += ' condition-edge-default';
  if (animated || data?.animated) edgeClassName += ' condition-edge-animated';

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
            className={`condition-edge-label label-${outcome}${isDefault ? ' is-default' : ''}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
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
