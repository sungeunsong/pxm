import React, { useCallback } from 'react';
import ReactFlow, {
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
} from 'reactflow';
import type { Node, Edge, Connection, NodeTypes } from 'reactflow';
import 'reactflow/dist/style.css';
import { CustomNode } from './CustomNode';
import type { CustomNodeData } from './CustomNode';
import './FlowCanvas.css';

const nodeTypes: NodeTypes = {
  custom: CustomNode,
};

const initialNodes: Node<CustomNodeData>[] = [
  {
    id: '1',
    type: 'custom',
    position: { x: 100, y: 100 },
    data: { label: 'Start', nodeType: 'start', description: '워크플로우 시작' },
  },
];

const initialEdges: Edge[] = [];

export interface FlowCanvasProps {
  onNodeSelect?: (node: Node | null) => void;
  onNodesChange?: (nodes: Node[]) => void;
}

export interface FlowCanvasRef {
  updateNodeData: (nodeId: string, data: Partial<CustomNodeData>) => void;
  getNodes: () => Node[];
  getEdges: () => Edge[];
  setNodesAndEdges: (nodes: Node[], edges: Edge[]) => void;
}

export const FlowCanvas = React.forwardRef<FlowCanvasRef, FlowCanvasProps>(
  ({ onNodeSelect, onNodesChange: onNodesChangeProp }, ref) => {
    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

    // 노드 변경 시 부모에게 알림
    React.useEffect(() => {
      onNodesChangeProp?.(nodes);
    }, [nodes, onNodesChangeProp]);

    // 노드 데이터 업데이트 핸들러
    const updateNodeData = useCallback(
      (nodeId: string, data: Partial<CustomNodeData>) => {
        setNodes((nds) =>
          nds.map((node) => {
            if (node.id === nodeId) {
              const updatedNode = {
                ...node,
                data: { ...node.data, ...data },
              };
              // 선택된 노드 정보도 업데이트
              onNodeSelect?.(updatedNode);
              return updatedNode;
            }
            return node;
          })
        );
      },
      [setNodes, onNodeSelect]
    );

    // 노드와 엣지 가져오기
    const getNodes = useCallback(() => nodes, [nodes]);
    const getEdges = useCallback(() => edges, [edges]);

    // 노드와 엣지 설정하기 (템플릿 불러오기용)
    const setNodesAndEdges = useCallback(
      (newNodes: Node[], newEdges: Edge[]) => {
        setNodes(newNodes);
        setEdges(newEdges);
        // 선택 해제
        onNodeSelect?.(null);
      },
      [setNodes, setEdges, onNodeSelect]
    );

    // ref를 통해 메서드 노출
    React.useImperativeHandle(
      ref,
      () => ({
        updateNodeData,
        getNodes,
        getEdges,
        setNodesAndEdges,
      }),
      [updateNodeData, getNodes, getEdges, setNodesAndEdges]
    );

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => addEdge({
        ...params,
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'var(--color-info)', strokeWidth: 2 },
      }, eds));
    },
    [setEdges]
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onNodeSelect?.(node);
    },
    [onNodeSelect]
  );

  const onPaneClick = useCallback(() => {
    onNodeSelect?.(null);
  }, [onNodeSelect]);

  // 드래그 앤 드롭 핸들러
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const reactFlowBounds = (event.target as HTMLElement)
        .closest('.react-flow')
        ?.getBoundingClientRect();

      if (!reactFlowBounds) return;

      const position = {
        x: event.clientX - reactFlowBounds.left - 90,
        y: event.clientY - reactFlowBounds.top - 30,
      };

      const nodeData = JSON.parse(type) as CustomNodeData;
      const newNode: Node<CustomNodeData> = {
        id: `${Date.now()}`,
        type: 'custom',
        position,
        data: nodeData,
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes]
  );

  return (
    <div className="flow-canvas-wrapper">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodeTypes={nodeTypes}
        fitView
        attributionPosition="bottom-left"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--border-subtle)"
        />
        <Controls
          className="flow-controls"
          showInteractive={false}
        />
        <MiniMap
          className="flow-minimap"
          nodeColor={(node) => {
            const data = node.data as CustomNodeData;
            switch (data.nodeType) {
              case 'start': return '#4caf50';
              case 'service': return '#2196f3';
              case 'timer': return '#ff9800';
              case 'gateway': return '#9c27b0';
              case 'approval': return '#ffc107';
              case 'end': return '#f44336';
              default: return '#666';
            }
          }}
          maskColor="rgba(0, 0, 0, 0.6)"
        />
      </ReactFlow>
    </div>
  );
});
