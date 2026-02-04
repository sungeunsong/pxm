import React, { useEffect, useRef } from 'react';
import { getSmoothStepPath } from 'reactflow';
import type { EdgeProps } from 'reactflow';

export const AnimatedEdge: React.FC<EdgeProps> = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
}) => {
  const pathRef = useRef<SVGPathElement>(null);
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  useEffect(() => {
    const path = pathRef.current;
    if (!path) return;

    // SVG path의 실제 길이 측정
    const pathLength = path.getTotalLength();

    // 초기 상태: 선이 안 보임
    path.style.strokeDasharray = `${pathLength}`;
    path.style.strokeDashoffset = `${pathLength}`;

    // 약간의 지연 후 애니메이션 시작 (DOM 업데이트 대기)
    const timer = setTimeout(() => {
      path.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1)';
      path.style.strokeDashoffset = '0';
    }, 50);

    return () => {
      clearTimeout(timer);
    };
  }, [edgePath]);

  return (
    <g>
      <path
        ref={pathRef}
        id={id}
        d={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: '#2196f3',
          strokeWidth: 3.5,
          fill: 'none',
          filter: 'drop-shadow(0 0 10px rgba(33, 150, 243, 1))',
        }}
      />
    </g>
  );
};
