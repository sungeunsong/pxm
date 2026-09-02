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
import { getRectOfNodes, getTransformForBounds } from 'reactflow';
import type { Node, Edge, Connection, NodeTypes, ReactFlowInstance } from 'reactflow';
import 'reactflow/dist/style.css';
import { useFeedback } from '../components/feedback/feedback-context';
import { CustomNode } from './CustomNode';
import type { CustomNodeData } from './form-types';
import './FlowCanvas.css';

import { ConditionEdge } from './ConditionEdge';
import { AnimatedEdge } from './AnimatedEdge';

const nodeTypes: NodeTypes = {
  custom: CustomNode,
};

const edgeTypes = {
  conditionEdge: ConditionEdge,
  animatedEdge: AnimatedEdge,
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
  onEdgesChange?: (edges: Edge[]) => void;
  readOnly?: boolean;
}

export interface FlowCanvasRef {
  updateNodeData: (nodeId: string, data: Partial<CustomNodeData>) => void;
  updateEdgeData: (edgeId: string, data: Partial<Edge>) => void;
  getNodes: () => Node[];
  getEdges: () => Edge[];
  setNodesAndEdges: (nodes: Node[], edges: Edge[]) => void;
  appendNodesAndEdges: (nodes: Node[], edges: Edge[]) => void;
  updateEdgesByNodeStatus: (nodeId: string, status: string) => void;
  /**
   * 그래프를 화면에 맞춘다.
   * rightInset을 주면 그만큼을 뺀 폭(= 속성 패널에 가리지 않는 영역)에 맞춘다.
   */
  fitView: (rightInset?: number) => void;
}

const FIT_PADDING = 0.18;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.5;
// 패널이 캔버스를 거의 다 덮는 좁은 화면에서 폭이 0 이하로 떨어지지 않게 한다.
const MIN_FIT_WIDTH = 320;

export const FlowCanvas = React.forwardRef<FlowCanvasRef, FlowCanvasProps>(
  ({ onNodeSelect, onNodesChange: onNodesChangeProp, onEdgesChange: onEdgesChangeProp, readOnly = false }, ref) => {
    const { confirm: confirmDialog } = useFeedback();
    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
    const reactFlowRef = React.useRef<ReactFlowInstance | null>(null);
    const wrapperRef = React.useRef<HTMLDivElement | null>(null);

    // 노드 변경 시 부모에게 알림
    React.useEffect(() => {
      onNodesChangeProp?.(nodes);
    }, [nodes, onNodesChangeProp]);

    React.useEffect(() => {
      onEdgesChangeProp?.(edges);
    }, [edges, onEdgesChangeProp]);

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

    const updateEdgeData = useCallback(
      (edgeId: string, data: Partial<Edge>) => {
        setEdges((eds) =>
          eds.map((edge) => {
            if (edge.id !== edgeId) {
              return edge;
            }
            return {
              ...edge,
              ...data,
              data: {
                ...(edge.data || {}),
                ...(data.data || {}),
              },
              style: {
                ...(edge.style || {}),
                ...(data.style || {}),
              },
            };
          })
        );
      },
      [setEdges]
    );

    // 노드와 엣지 가져오기
    const getNodes = useCallback(() => nodes, [nodes]);
    const getEdges = useCallback(() => edges, [edges]);
    // 속성 패널은 캔버스 위에 겹쳐 뜨므로, 패널이 열려 있으면 그 폭을 뺀 영역에 맞춘다.
    // 화면을 옆으로 미는 방식은 반대편 노드를 캔버스 밖으로 밀어내므로 쓰지 않는다.
    const applyFit = useCallback((rightInset: number, duration: number) => {
      const instance = reactFlowRef.current;
      const container = wrapperRef.current;
      if (!instance || !container) return;
      const nodes = instance.getNodes();
      if (nodes.length === 0) return;

      const width = Math.max(container.clientWidth - rightInset, MIN_FIT_WIDTH);
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;

      const [x, y, zoom] = getTransformForBounds(
        getRectOfNodes(nodes), width, height, MIN_ZOOM, MAX_ZOOM, FIT_PADDING,
      );
      instance.setViewport({ x, y, zoom }, { duration });
    }, []);

    const fitView = useCallback((rightInset = 0) => {
      // 노드 교체 직후에는 레이아웃이 아직 확정되지 않아 두 번 맞춘다.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => applyFit(rightInset, 350));
      });
      window.setTimeout(() => applyFit(rightInset, 250), 80);
    }, [applyFit]);

    // 노드와 엣지 설정하기 (템플릿 불러오기용)
    const setNodesAndEdges = useCallback(
      (newNodes: Node[], newEdges: Edge[]) => {
        // 기존 엣지 타입 보정 로직 (Gateway Outgoing -> conditionEdge)
        // nodes 리스트를 Map으로 만들어서 빠른 조회
        const nodeTypeMap = new Map<string, string>();
        newNodes.forEach(node => {
           nodeTypeMap.set(node.id, (node.data as CustomNodeData).nodeType);
        });

        const adjustedEdges = newEdges.map(edge => {
          const sourceType = nodeTypeMap.get(edge.source);
          if (sourceType === 'gateway') {
            return { ...edge, type: 'conditionEdge' };
          }
          return edge;
        });

        setNodes(newNodes);
        setEdges(adjustedEdges);
        // 선택 해제
        onNodeSelect?.(null);
      },
      [setNodes, setEdges, onNodeSelect]
    );

    const appendNodesAndEdges = useCallback(
      (newNodes: Node[], newEdges: Edge[]) => {
        setNodes((currentNodes) => currentNodes.concat(newNodes));
        setEdges((currentEdges) => currentEdges.concat(newEdges));
        onNodeSelect?.(newNodes[0] || null);
      },
      [setNodes, setEdges, onNodeSelect]
    );

    // 노드 상태에 따른 엣지 업데이트
    const updateEdgesByNodeStatus = useCallback(
      (nodeId: string, status: string) => {
        setEdges((eds) =>
          eds.map((edge) => {
            // 해당 노드에서 나가는 엣지
            if (edge.source === nodeId) {
              let className = '';
              let edgeType = edge.type;
              let style: any = { ...edge.style };
              
              if (status === 'running') {
                // running 상태일 때 AnimatedEdge 사용
                className = 'edge-active';
                edgeType = 'animatedEdge';
                style = {
                  ...style,
                  stroke: '#2196f3',
                  strokeWidth: 3.5,
                };
              } else if (status === 'completed') {
                className = 'edge-completed';
                edgeType = edge.data?.isGateway ? 'conditionEdge' : 'smoothstep';
                style = {
                  ...style,
                  stroke: '#4caf50',
                  strokeWidth: 3,
                  strokeDasharray: 'none',
                  strokeDashoffset: '0',
                };
              } else if (status === 'failed') {
                className = 'edge-failed';
                edgeType = edge.data?.isGateway ? 'conditionEdge' : 'smoothstep';
                style = {
                  ...style,
                  stroke: '#f44336',
                  strokeWidth: 3,
                  strokeDasharray: '8 4',
                };
              } else if (status === 'waiting') {
                className = 'edge-waiting';
                edgeType = edge.data?.isGateway ? 'conditionEdge' : 'smoothstep';
                style = {
                  ...style,
                  stroke: '#FFC107',
                  strokeWidth: 3,
                  strokeDasharray: '0.05 0.05',
                };
              }
              
              return {
                ...edge,
                type: edgeType,
                className,
                style,
                animated: false,
              };
            }
            return edge;
          })
        );
      },
      [setEdges]
    );

    // ref를 통해 메서드 노출
    React.useImperativeHandle(
      ref,
      () => ({
        updateNodeData,
        updateEdgeData,
        getNodes,
        getEdges,
        setNodesAndEdges,
        appendNodesAndEdges,
        updateEdgesByNodeStatus,
        fitView,
      }),
      [updateNodeData, updateEdgeData, getNodes, getEdges, setNodesAndEdges, appendNodesAndEdges, updateEdgesByNodeStatus, fitView]
    );

  const onConnect = useCallback(
    (params: Connection) => {
      // source 노드의 타입을 찾아서 edge type 결정
      setNodes((currentNodes) => {
        const sourceNode = currentNodes.find((n) => n.id === params.source);
        const isGateway = sourceNode?.data?.nodeType === 'gateway';
        
        setEdges((eds) => {
          // Gateway인 경우, 이미 연결된 outgoing 엣지가 있는지 확인
          let label = 'TRUE';
          if (isGateway) {
            const existingEdge = eds.find(e => e.source === params.source);
            if (existingEdge) {
              label = 'FALSE';
            }
          }

          return addEdge({
            ...params,
            type: isGateway ? 'conditionEdge' : 'smoothstep',
            animated: true,
            style: { stroke: 'var(--color-info)', strokeWidth: 2 },
            // Gateway라면 라벨 설정 (첫 번째 TRUE, 두 번째 FALSE)
            data: isGateway ? { label, animated: false } : undefined,
          }, eds);
        });
        
        return currentNodes; // setNodes 자체는 변경 없음
      });
    },
    [setNodes, setEdges]
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

  const onEdgeDoubleClick = useCallback(
    async (event: React.MouseEvent, edge: Edge) => {
      event.stopPropagation();
      const proceed = await confirmDialog({
        title: '이 연결을 삭제할까요?',
        confirmLabel: '삭제',
        tone: 'danger',
      });
      if (proceed) {
        setEdges((eds) => eds.filter((item) => item.id !== edge.id));
      }
    },
    [setEdges, confirmDialog]
  );

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
    <div className="flow-canvas-wrapper" ref={wrapperRef}>
      <ReactFlow
        onInit={(instance) => { reactFlowRef.current = instance; }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={readOnly ? undefined : onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onEdgeDoubleClick={readOnly ? undefined : onEdgeDoubleClick}
        onDrop={readOnly ? undefined : onDrop}
        onDragOver={readOnly ? undefined : onDragOver}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesUpdatable={!readOnly}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
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
              case 'script': return '#14b8a6';
              case 'timer': return '#ff9800';
              case 'gateway': return '#9c27b0';
              case 'approval': return '#ffc107';
              case 'workflow_call': return '#0891b2';
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
