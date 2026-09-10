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
import type { Node, Edge, Connection, NodeTypes, ReactFlowInstance, Viewport, XYPosition } from 'reactflow';
import {
  CheckSquare,
  ChevronLeft,
  Clipboard,
  ClipboardPaste,
  CopyPlus,
  FlaskConical,
  GitBranch,
  Maximize2,
  MousePointer2,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import 'reactflow/dist/style.css';
import { useFeedback } from '../components/feedback/feedback-context';
import { CustomNode } from './CustomNode';
import type { CustomNodeData } from './form-types';
import './FlowCanvas.css';

import { ConditionEdge } from './ConditionEdge';
import { AnimatedEdge } from './AnimatedEdge';
import { CanvasContextMenu } from './CanvasContextMenu';
import type { CanvasContextMenuItem } from './CanvasContextMenu';

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
    data: { label: 'Start', nodeType: 'start' },
  },
];

const initialEdges: Edge[] = [];

export interface FlowCanvasProps {
  onNodeSelect?: (node: Node | null) => void;
  onNodesChange?: (nodes: Node[]) => void;
  onEdgesChange?: (edges: Edge[]) => void;
  canPaste?: boolean;
  onCopyGraph?: (nodes: Node<CustomNodeData>[], edges: Edge[]) => void;
  onPasteAt?: (position: XYPosition) => void;
  onTestNode?: (node: Node<CustomNodeData>) => void;
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
   * minZoom을 주면 그보다 작게는 줄이지 않고 그래프 중심에 맞춘다 (발표 모드 가독성).
   */
  fitView: (rightInset?: number, options?: { minZoom?: number }) => void;
  /** 현재 뷰포트. 발표 모드 진입 전 상태를 기억해 두는 용도다 */
  getViewport: () => Viewport | null;
  /** 기억해 둔 뷰포트로 되돌린다 */
  setViewport: (viewport: Viewport, options?: { duration?: number }) => void;
}

const FIT_PADDING = 0.18;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 1.5;
// 패널이 캔버스를 거의 다 덮는 좁은 화면에서 폭이 0 이하로 떨어지지 않게 한다.
const MIN_FIT_WIDTH = 320;

type CanvasMenuState = {
  kind: 'pane' | 'nodes' | 'edge' | 'add-node';
  anchor: XYPosition;
  flowPosition: XYPosition;
  boundary: { left: number; top: number; right: number; bottom: number };
  nodes?: Node<CustomNodeData>[];
  edge?: Edge;
};

const BASIC_NODE_OPTIONS: Array<{ label: string; data: CustomNodeData }> = [
  { label: 'Start', data: { nodeType: 'start', label: 'Start' } },
  { label: 'Timer', data: { nodeType: 'timer', label: 'Timer' } },
  {
    label: 'JS Node',
    data: {
      nodeType: 'script', label: 'JS Node', scriptType: 'javascript',
      code: "return { message: 'hello from js node', formData: input.formData };",
      outputPath: 'scriptResults.jsNode', scriptTimeoutMs: 1000,
    },
  },
  {
    label: 'Command',
    data: {
      nodeType: 'command', label: 'Command',
      commandId: 'builtin.echo', commandArgumentsJson: '{\n  "message": "hello from command node"\n}',
      outputPath: 'commandResults.echo', commandTimeoutMs: 1000,
    },
  },
  { label: 'Gateway', data: { nodeType: 'gateway', label: 'Gateway' } },
  { label: 'Approval', data: { nodeType: 'approval', label: 'Approval' } },
  {
    label: 'Workflow Call',
    data: {
      nodeType: 'workflow_call', label: 'Workflow Call',
      workflowCallMode: 'async', workflowInputMode: 'inherit_form_data', outputPath: 'workflowCalls.child',
    },
  },
  { label: 'End', data: { nodeType: 'end', label: 'End' } },
];

function normalizeBranchEdges(nodes: Node[], edges: Edge[]) {
  const nodeTypeById = new Map(
    nodes.map((node) => [node.id, (node.data as CustomNodeData).nodeType]),
  );

  return edges.map((edge) => {
    const sourceType = nodeTypeById.get(edge.source);
    if (sourceType !== 'gateway' && sourceType !== 'approval') return edge;
    return {
      ...edge,
      type: 'conditionEdge',
      data: {
        ...(edge.data || {}),
        branchSourceType: sourceType,
      },
    };
  });
}

export const FlowCanvas = React.forwardRef<FlowCanvasRef, FlowCanvasProps>(
  ({
    onNodeSelect,
    onNodesChange: onNodesChangeProp,
    onEdgesChange: onEdgesChangeProp,
    canPaste = false,
    onCopyGraph,
    onPasteAt,
    onTestNode,
    readOnly = false,
  }, ref) => {
    const { confirm: confirmDialog } = useFeedback();
    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
    const reactFlowRef = React.useRef<ReactFlowInstance | null>(null);
    const wrapperRef = React.useRef<HTMLDivElement | null>(null);
    const [contextMenu, setContextMenu] = React.useState<CanvasMenuState | null>(null);

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
    const applyFit = useCallback((rightInset: number, duration: number, minZoom = MIN_ZOOM) => {
      const instance = reactFlowRef.current;
      const container = wrapperRef.current;
      if (!instance || !container) return;
      const nodes = instance.getNodes();
      if (nodes.length === 0) return;

      const width = Math.max(container.clientWidth - rightInset, MIN_FIT_WIDTH);
      const height = container.clientHeight;
      if (width <= 0 || height <= 0) return;

      const bounds = getRectOfNodes(nodes);
      const [x, y, zoom] = getTransformForBounds(
        bounds, width, height, MIN_ZOOM, MAX_ZOOM, FIT_PADDING,
      );

      // 라벨이 읽히는 배율을 지켜야 하는 경우, 다 담기지 않더라도 그래프 중심을 잡아준다.
      if (zoom < minZoom) {
        instance.setViewport({
          x: width / 2 - (bounds.x + bounds.width / 2) * minZoom,
          y: height / 2 - (bounds.y + bounds.height / 2) * minZoom,
          zoom: minZoom,
        }, { duration });
        return;
      }

      instance.setViewport({ x, y, zoom }, { duration });
    }, []);

    const fitView = useCallback((rightInset = 0, options?: { minZoom?: number }) => {
      const minZoom = options?.minZoom;
      // 노드 교체 직후에는 레이아웃이 아직 확정되지 않아 두 번 맞춘다.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => applyFit(rightInset, 350, minZoom));
      });
      window.setTimeout(() => applyFit(rightInset, 250, minZoom), 80);
    }, [applyFit]);

    const getViewport = useCallback(() => reactFlowRef.current?.getViewport() || null, []);

    const setViewportTo = useCallback((viewport: Viewport, options?: { duration?: number }) => {
      reactFlowRef.current?.setViewport(viewport, { duration: options?.duration ?? 300 });
    }, []);

    // 노드와 엣지 설정하기 (템플릿 불러오기용)
    const setNodesAndEdges = useCallback(
      (newNodes: Node[], newEdges: Edge[]) => {
        setNodes(newNodes);
        setEdges(normalizeBranchEdges(newNodes, newEdges));
        // 선택 해제
        onNodeSelect?.(null);
      },
      [setNodes, setEdges, onNodeSelect]
    );

    const appendNodesAndEdges = useCallback(
      (newNodes: Node[], newEdges: Edge[]) => {
        setNodes((currentNodes) => {
          const combinedNodes = currentNodes.concat(newNodes);
          setEdges((currentEdges) => currentEdges.concat(normalizeBranchEdges(combinedNodes, newEdges)));
          return combinedNodes;
        });
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
              let style: React.CSSProperties = { ...edge.style };
              const isBranchEdge = edge.type === 'conditionEdge' ||
                edge.data?.branchSourceType === 'gateway' ||
                edge.data?.branchSourceType === 'approval';
              
              if (status === 'running') {
                // running 상태일 때 AnimatedEdge 사용
                className = 'edge-active';
                edgeType = isBranchEdge ? 'conditionEdge' : 'animatedEdge';
                style = {
                  ...style,
                  stroke: '#2196f3',
                  strokeWidth: 3.5,
                };
              } else if (status === 'completed') {
                className = 'edge-completed';
                edgeType = isBranchEdge ? 'conditionEdge' : 'smoothstep';
                style = {
                  ...style,
                  stroke: '#4caf50',
                  strokeWidth: 3,
                  strokeDasharray: 'none',
                  strokeDashoffset: '0',
                };
              } else if (status === 'failed') {
                className = 'edge-failed';
                edgeType = isBranchEdge ? 'conditionEdge' : 'smoothstep';
                style = {
                  ...style,
                  stroke: '#f44336',
                  strokeWidth: 3,
                  strokeDasharray: '8 4',
                };
              } else if (status === 'waiting') {
                className = 'edge-waiting';
                edgeType = isBranchEdge ? 'conditionEdge' : 'smoothstep';
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
                data: {
                  ...(edge.data || {}),
                  animated: isBranchEdge && status === 'running',
                },
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
        getViewport,
        setViewport: setViewportTo,
      }),
      [updateNodeData, updateEdgeData, getNodes, getEdges, setNodesAndEdges, appendNodesAndEdges, updateEdgesByNodeStatus, fitView, getViewport, setViewportTo]
    );

  const onConnect = useCallback(
    (params: Connection) => {
      // source 노드의 타입을 찾아서 edge type 결정
      setNodes((currentNodes) => {
        const sourceNode = currentNodes.find((n) => n.id === params.source);
        const sourceType = sourceNode?.data?.nodeType;
        const isGateway = sourceType === 'gateway';
        const isBranch = isGateway || sourceType === 'approval';
        
        setEdges((eds) => {
          const outgoingCount = eds.filter((edge) => edge.source === params.source).length;
          const label = isGateway ? `분기 ${outgoingCount + 1}` : undefined;

          return addEdge({
            ...params,
            type: isBranch ? 'conditionEdge' : 'smoothstep',
            animated: true,
            style: { stroke: 'var(--color-info)', strokeWidth: 2 },
            data: isBranch ? {
              ...(label ? { label } : {}),
              branchSourceType: sourceType,
            } : undefined,
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
    setContextMenu(null);
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

  const contextPosition = useCallback((event: React.MouseEvent) => {
    const wrapper = wrapperRef.current;
    const instance = reactFlowRef.current;
    if (!wrapper || !instance) return null;
    const bounds = wrapper.getBoundingClientRect();
    return {
      anchor: { x: event.clientX, y: event.clientY },
      flowPosition: instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      boundary: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    };
  }, []);

  const selectedGraph = useCallback((targetNodes: Node<CustomNodeData>[]) => {
    const selectedIds = new Set(targetNodes.map((node) => node.id));
    return {
      nodes: targetNodes,
      edges: edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)),
    };
  }, [edges]);

  const selectNodes = useCallback((targetNodes: Node<CustomNodeData>[]) => {
    const selectedIds = new Set(targetNodes.map((node) => node.id));
    setNodes((items) => items.map((node) => ({ ...node, selected: selectedIds.has(node.id) })));
    setEdges((items) => items.map((edge) => ({ ...edge, selected: false })));
  }, [setEdges, setNodes]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    if (event.shiftKey) {
      setContextMenu(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = contextPosition(event);
    if (!position) return;
    const currentSelection = nodes.filter((item) => item.selected) as Node<CustomNodeData>[];
    const targetNodes = node.selected && currentSelection.length > 1
      ? currentSelection
      : [node as Node<CustomNodeData>];
    selectNodes(targetNodes);
    setContextMenu({ kind: 'nodes', ...position, nodes: targetNodes });
  }, [contextPosition, nodes, selectNodes]);

  const onSelectionContextMenu = useCallback((event: React.MouseEvent, selectedNodes: Node[]) => {
    if (event.shiftKey) {
      setContextMenu(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = contextPosition(event);
    if (!position) return;
    const targetNodes = selectedNodes as Node<CustomNodeData>[];
    selectNodes(targetNodes);
    setContextMenu({ kind: 'nodes', ...position, nodes: targetNodes });
  }, [contextPosition, selectNodes]);

  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: Edge) => {
    if (event.shiftKey || readOnly) {
      setContextMenu(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = contextPosition(event);
    if (!position) return;
    setNodes((items) => items.map((node) => ({ ...node, selected: false })));
    setEdges((items) => items.map((item) => ({ ...item, selected: item.id === edge.id })));
    setContextMenu({ kind: 'edge', ...position, edge });
  }, [contextPosition, readOnly, setEdges, setNodes]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    if (event.shiftKey) {
      setContextMenu(null);
      return;
    }
    event.preventDefault();
    const position = contextPosition(event);
    if (!position) return;
    wrapperRef.current?.focus({ preventScroll: true });
    setNodes((items) => items.map((node) => ({ ...node, selected: false })));
    setEdges((items) => items.map((edge) => ({ ...edge, selected: false })));
    setContextMenu({ kind: 'pane', ...position });
  }, [contextPosition, setEdges, setNodes]);

  const addBasicNode = useCallback((data: CustomNodeData, position: XYPosition) => {
    const newNode: Node<CustomNodeData> = {
      id: `node-${Date.now()}`,
      type: 'custom',
      position,
      selected: true,
      data: { ...data },
    };
    setNodes((items) => [...items.map((node) => ({ ...node, selected: false })), newNode]);
  }, [setNodes]);

  const duplicateNodes = useCallback((targetNodes: Node<CustomNodeData>[]) => {
    const graph = selectedGraph(targetNodes);
    const existingIds = new Set([...nodes.map((node) => node.id), ...edges.map((edge) => edge.id)]);
    const idMap = new Map<string, string>();
    const uniqueId = (prefix: string) => {
      let index = 0;
      let value = '';
      do value = `${prefix}-${Date.now()}-${index++}`; while (existingIds.has(value));
      existingIds.add(value);
      return value;
    };
    const duplicatedNodes = graph.nodes.map((node) => {
      const id = uniqueId(`copy-${node.id}`);
      idMap.set(node.id, id);
      return {
        ...node,
        id,
        position: { x: node.position.x + 56, y: node.position.y + 56 },
        selected: true,
        dragging: false,
        data: {
          ...node.data,
          label: node.data.label ? `${node.data.label} copy` : 'Copied node',
          executionStatus: undefined,
        },
      };
    });
    const duplicatedEdges = graph.edges.map((edge) => ({
      ...edge,
      id: uniqueId(`copy-${edge.id}`),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      selected: false,
      data: edge.data ? { ...edge.data } : edge.data,
      style: edge.style ? { ...edge.style } : edge.style,
    }));
    setNodes((items) => items.map((node) => ({ ...node, selected: false })).concat(duplicatedNodes));
    setEdges((items) => items.map((edge) => ({ ...edge, selected: false })).concat(duplicatedEdges));
  }, [edges, nodes, selectedGraph, setEdges, setNodes]);

  const deleteNodes = useCallback(async (targetNodes: Node<CustomNodeData>[]) => {
    const ids = new Set(targetNodes.map((node) => node.id));
    const connectedEdges = edges.filter((edge) => ids.has(edge.source) || ids.has(edge.target));
    const proceed = await confirmDialog({
      title: targetNodes.length === 1 ? '이 노드를 삭제할까요?' : `선택한 노드 ${targetNodes.length}개를 삭제할까요?`,
      description: connectedEdges.length > 0
        ? `연결된 엣지 ${connectedEdges.length}개도 함께 삭제됩니다.`
        : '연결된 엣지는 없습니다.',
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (!proceed) return;
    setNodes((items) => items.filter((node) => !ids.has(node.id)));
    setEdges((items) => items.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)));
    onNodeSelect?.(null);
  }, [confirmDialog, edges, onNodeSelect, setEdges, setNodes]);

  const deleteEdge = useCallback(async (edge: Edge) => {
    const proceed = await confirmDialog({
      title: '이 연결을 삭제할까요?',
      description: `${edge.source} → ${edge.target} 연결이 삭제됩니다.`,
      confirmLabel: '삭제',
      tone: 'danger',
    });
    if (proceed) setEdges((items) => items.filter((item) => item.id !== edge.id));
  }, [confirmDialog, setEdges]);

  const openSourceNode = useCallback((edge: Edge) => {
    const source = nodes.find((node) => node.id === edge.source) as Node<CustomNodeData> | undefined;
    if (!source) return;
    selectNodes([source]);
    onNodeSelect?.(source);
  }, [nodes, onNodeSelect, selectNodes]);

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

      const instance = reactFlowRef.current;
      if (!instance) return;

      // client 좌표를 현재 pan/zoom이 적용된 flow 좌표로 바꾼다.
      const position = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

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

  const openKeyboardMenu = useCallback(() => {
    const wrapper = wrapperRef.current;
    const instance = reactFlowRef.current;
    if (!wrapper || !instance) return;
    const bounds = wrapper.getBoundingClientRect();
    const selectedNodes = nodes.filter((node) => node.selected) as Node<CustomNodeData>[];
    const selectedEdge = edges.find((edge) => edge.selected);
    const selectedElement = wrapper.querySelector<HTMLElement>(
      selectedNodes.length > 0 ? '.react-flow__node.selected' : '.react-flow__edge.selected',
    );
    const selectedBounds = selectedElement?.getBoundingClientRect();
    const clientX = selectedBounds ? selectedBounds.right : bounds.left + bounds.width / 2;
    const clientY = selectedBounds ? selectedBounds.top + selectedBounds.height / 2 : bounds.top + bounds.height / 2;
    const base = {
      anchor: { x: clientX, y: clientY },
      flowPosition: instance.screenToFlowPosition({ x: clientX, y: clientY }),
      boundary: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    };
    if (selectedNodes.length > 0) {
      setContextMenu({ kind: 'nodes', ...base, nodes: selectedNodes });
    } else if (selectedEdge && !readOnly) {
      setContextMenu({ kind: 'edge', ...base, edge: selectedEdge });
    } else {
      setContextMenu({ kind: 'pane', ...base });
    }
  }, [edges, nodes, readOnly]);

  const handleCanvasKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const selectedNodes = nodes.filter((node) => node.selected) as Node<CustomNodeData>[];
    const isCopy = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c';
    const isPaste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
    if (!readOnly && isCopy && selectedNodes.length > 0) {
      event.preventDefault();
      const graph = selectedGraph(selectedNodes);
      onCopyGraph?.(graph.nodes, graph.edges);
      return;
    }
    if (!readOnly && isPaste && canPaste && onPasteAt) {
      event.preventDefault();
      const wrapper = wrapperRef.current;
      const instance = reactFlowRef.current;
      if (!wrapper || !instance) return;
      const bounds = wrapper.getBoundingClientRect();
      onPasteAt(instance.screenToFlowPosition({
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      }));
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      openKeyboardMenu();
    }
  }, [canPaste, nodes, onCopyGraph, onPasteAt, openKeyboardMenu, readOnly, selectedGraph]);

  let contextMenuTitle = '';
  let contextMenuItems: CanvasContextMenuItem[] = [];
  if (contextMenu?.kind === 'add-node') {
    contextMenuTitle = '기본 노드 추가';
    contextMenuItems = [
      {
        id: 'back', label: '캔버스 메뉴로', icon: <ChevronLeft size={15} />,
        onSelect: () => setContextMenu({ ...contextMenu, kind: 'pane' }),
      },
      ...BASIC_NODE_OPTIONS.map((option, index) => ({
        id: `add-${option.data.nodeType}`,
        label: option.label,
        icon: <Plus size={14} />,
        separatorBefore: index === 0,
        onSelect: () => addBasicNode(option.data, contextMenu.flowPosition),
      })),
    ];
  } else if (contextMenu?.kind === 'pane') {
    contextMenuTitle = '캔버스';
    contextMenuItems = readOnly
      ? [{ id: 'fit', label: '전체 화면에 맞춤', icon: <Maximize2 size={15} />, onSelect: () => fitView() }]
      : [
        {
          id: 'add', label: '노드 추가…', icon: <Plus size={15} />,
          onSelect: () => setContextMenu({ ...contextMenu, kind: 'add-node' }),
        },
        {
          id: 'paste', label: '붙여넣기', icon: <ClipboardPaste size={15} />, shortcut: 'Ctrl+V',
          disabled: !canPaste, onSelect: () => onPasteAt?.(contextMenu.flowPosition),
        },
        {
          id: 'select-all', label: '모두 선택', icon: <MousePointer2 size={15} />, separatorBefore: true,
          onSelect: () => {
            const allNodes = nodes as Node<CustomNodeData>[];
            selectNodes(allNodes);
          },
        },
        { id: 'fit', label: '전체 화면에 맞춤', icon: <Maximize2 size={15} />, onSelect: () => fitView() },
      ];
  } else if (contextMenu?.kind === 'nodes' && contextMenu.nodes) {
    const targetNodes = contextMenu.nodes;
    const isMultiple = targetNodes.length > 1;
    contextMenuTitle = isMultiple ? `노드 ${targetNodes.length}개 선택` : targetNodes[0]?.data.label || '노드';
    contextMenuItems = [
      ...(!isMultiple ? [{
        id: 'properties', label: readOnly ? '속성 보기' : '속성 열기', icon: <Settings2 size={15} />,
        onSelect: () => onNodeSelect?.(targetNodes[0] || null),
      }] : []),
      ...(!readOnly && !isMultiple && targetNodes[0]?.data.nodeType === 'service' ? [{
        id: 'test-node', label: '이 노드 테스트', icon: <FlaskConical size={15} />,
        onSelect: () => onTestNode?.(targetNodes[0]),
      }] : []),
      ...(!readOnly ? [
        {
          id: 'copy', label: isMultiple ? '선택 항목 복사' : '복사', icon: <Clipboard size={15} />,
          shortcut: 'Ctrl+C', separatorBefore: true,
          onSelect: () => {
            const graph = selectedGraph(targetNodes);
            onCopyGraph?.(graph.nodes, graph.edges);
          },
        },
        {
          id: 'duplicate', label: isMultiple ? '선택 항목 복제' : '복제', icon: <CopyPlus size={15} />,
          onSelect: () => duplicateNodes(targetNodes),
        },
        {
          id: 'delete', label: isMultiple ? '선택 항목 삭제' : '삭제', icon: <Trash2 size={15} />,
          shortcut: 'Delete', separatorBefore: true, tone: 'danger' as const,
          onSelect: () => deleteNodes(targetNodes),
        },
      ] : []),
    ];
  } else if (contextMenu?.kind === 'edge' && contextMenu.edge) {
    const edge = contextMenu.edge;
    const sourceType = (nodes.find((node) => node.id === edge.source)?.data as CustomNodeData | undefined)?.nodeType;
    contextMenuTitle = '연결';
    contextMenuItems = [
      ...(sourceType === 'gateway' ? [{
        id: 'branch-settings', label: '분기 설정 열기', icon: <GitBranch size={15} />,
        onSelect: () => openSourceNode(edge),
      }] : []),
      ...(sourceType === 'approval' ? [{
        id: 'approval-route', label: '결과 경로 확인', icon: <CheckSquare size={15} />,
        onSelect: () => openSourceNode(edge),
      }] : []),
      {
        id: 'delete-edge', label: '연결 삭제', icon: <Trash2 size={15} />,
        separatorBefore: sourceType === 'gateway' || sourceType === 'approval', tone: 'danger',
        onSelect: () => deleteEdge(edge),
      },
    ];
  }

  return (
    <div
      className="flow-canvas-wrapper"
      ref={wrapperRef}
      tabIndex={-1}
      onKeyDownCapture={handleCanvasKeyDown}
    >
      <ReactFlow
        onInit={(instance) => { reactFlowRef.current = instance; }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={readOnly ? undefined : onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onMoveStart={() => setContextMenu(null)}
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
              case 'start': return '#10b981';
              case 'service': return '#3b82f6';
              case 'script': return '#14b8a6';
              case 'command': return '#64748b';
              case 'timer': return '#f59e0b';
              case 'gateway': return '#8b5cf6';
              case 'approval': return '#ec4899';
              case 'workflow_call': return '#0891b2';
              case 'end': return '#ef4444';
              default: return '#64748b';
            }
          }}
          nodeStrokeColor="rgba(15, 23, 42, 0.52)"
          nodeStrokeWidth={1.5}
          maskColor="rgba(15, 23, 42, 0.14)"
        />
      </ReactFlow>
      {contextMenu && contextMenuItems.length > 0 && (
        <CanvasContextMenu
          title={contextMenuTitle}
          anchor={contextMenu.anchor}
          boundary={contextMenu.boundary}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
});
