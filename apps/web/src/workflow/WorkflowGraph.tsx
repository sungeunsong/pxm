import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { WorkflowNode } from './WorkflowNode';
import { type WorkflowNodeData, type NodeStatus, NODE_STATUS_COLORS } from './types';
import { type ThemeMode, themes, getNodeStatusColors } from './theme';

// 노드 타입 별칭
type WfNode = Node<WorkflowNodeData>;

// 커스텀 노드 타입 등록
const nodeTypes: NodeTypes = {
  workflow: WorkflowNode as any,
};

// 초기 노드 정의 (start → service → timer → end)
const createInitialNodes = (): WfNode[] => [
  {
    id: 'start',
    type: 'workflow',
    position: { x: 50, y: 150 },
    data: {
      label: 'Start',
      nodeType: 'start',
      status: 'idle',
    },
  },
  {
    id: 'service_http',
    type: 'workflow',
    position: { x: 250, y: 150 },
    data: {
      label: 'HTTP Service',
      nodeType: 'service',
      status: 'idle',
    },
  },
  {
    id: 'timer',
    type: 'workflow',
    position: { x: 480, y: 150 },
    data: {
      label: 'Timer',
      nodeType: 'timer',
      status: 'idle',
    },
  },
  {
    id: 'end',
    type: 'workflow',
    position: { x: 680, y: 150 },
    data: {
      label: 'End',
      nodeType: 'end',
      status: 'idle',
    },
  },
];

// 초기 엣지 정의
const createInitialEdges = (): Edge[] => [
  {
    id: 'e-start-service',
    source: 'start',
    target: 'service_http',
    animated: false,
    style: { stroke: '#cbd5e1', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1' },
  },
  {
    id: 'e-service-timer',
    source: 'service_http',
    target: 'timer',
    animated: false,
    style: { stroke: '#cbd5e1', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1' },
  },
  {
    id: 'e-timer-end',
    source: 'timer',
    target: 'end',
    animated: false,
    style: { stroke: '#cbd5e1', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#cbd5e1' },
  },
];

interface WorkflowGraphProps {
  nodeStatuses: Record<string, { status: NodeStatus; attempt?: number; error?: string; duration?: number }>;
  activeEdge?: { source: string; target: string } | null;
  themeMode?: ThemeMode;
}

export function WorkflowGraph({ nodeStatuses, activeEdge, themeMode = 'dark' }: WorkflowGraphProps) {
  const colors = themes[themeMode];
  const statusColors = getNodeStatusColors(themeMode);

  const initialNodes = useMemo(() => createInitialNodes(), []);
  const initialEdges = useMemo(() => createInitialEdges(), []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // 노드 상태 업데이트
  useMemo(() => {
    setNodes((nds) =>
      nds.map((node) => {
        const statusInfo = nodeStatuses[node.id];
        if (statusInfo) {
          return {
            ...node,
            data: {
              ...node.data,
              status: statusInfo.status,
              attempt: statusInfo.attempt,
              error: statusInfo.error,
              duration: statusInfo.duration,
            },
          };
        }
        return node;
      })
    );
  }, [nodeStatuses, setNodes]);

  // 엣지 애니메이션 업데이트
  useMemo(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        const isActive = activeEdge?.source === edge.source && activeEdge?.target === edge.target;
        const sourceStatus = nodeStatuses[edge.source]?.status;
        const targetStatus = nodeStatuses[edge.target]?.status;

        // 완료된 경로는 초록색으로
        const isCompleted = sourceStatus === 'completed' &&
          (targetStatus === 'completed' || targetStatus === 'running' || targetStatus === 'waiting');

        const color = isActive ? '#3b82f6' : isCompleted ? '#22c55e' : '#cbd5e1';

        return {
          ...edge,
          animated: isActive,
          style: {
            stroke: color,
            strokeWidth: isActive ? 3 : 2,
            transition: 'all 0.3s ease',
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: color,
          },
        };
      })
    );
  }, [activeEdge, nodeStatuses, setEdges]);

  // MiniMap 노드 색상
  const nodeColor = useCallback((node: Node) => {
    const data = node.data as WorkflowNodeData | undefined;
    const status = data?.status || 'idle';
    return statusColors[status].border;
  }, [statusColors]);

  return (
    <div style={{ width: '100%', height: '100%', backgroundColor: colors.graphBg, transition: 'background-color 0.3s' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.5}
        maxZoom={1.5}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color={colors.graphDots}
        />
        <Controls
          style={{
            backgroundColor: colors.bgSecondary,
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            transition: 'all 0.3s',
          }}
        />
        <MiniMap
          nodeColor={nodeColor}
          maskColor={themeMode === 'dark' ? 'rgba(15, 23, 42, 0.8)' : 'rgba(248, 250, 252, 0.8)'}
          style={{
            backgroundColor: colors.bgSecondary,
            borderRadius: 8,
            border: `1px solid ${colors.border}`,
            transition: 'all 0.3s',
          }}
        />
      </ReactFlow>
    </div>
  );
}
