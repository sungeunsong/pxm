import React from 'react';
import { EdgeLabelRenderer, getBezierPath } from 'reactflow';
import type { EdgeProps } from 'reactflow';
import './ConditionEdge.css';

export const ConditionEdge: React.FC<EdgeProps> = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
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

  const label = data?.label;
  const isAnimated = data?.animated;
  
  const labelUpperCase = label ? String(label).toUpperCase() : '';
  const isTrue = labelUpperCase === 'TRUE';
  const isFalse = labelUpperCase === 'FALSE';
  const isCondition = isTrue || isFalse;

  let edgeClassName = 'react-flow__edge-path';
  if (isTrue) edgeClassName += ' condition-edge-true';
  if (isFalse) edgeClassName += ' condition-edge-false';
  if (isAnimated) edgeClassName += ' condition-edge-animated';

  return (
    <>
      <path
        id={data?.id}
        style={style}
        className={edgeClassName}
        d={edgePath}
        markerEnd={markerEnd}
      />
      {isCondition && (
        <EdgeLabelRenderer>
          <div
            className={`condition-edge-label ${isTrue ? 'label-true' : 'label-false'}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
          >
            {labelUpperCase}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};
