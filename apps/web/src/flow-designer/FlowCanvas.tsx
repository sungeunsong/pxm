import React, { useCallback } from 'react';
import ReactFlow, {
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
} from 'reactflow';
import { getRectOfNodes, getTransformForBounds } from 'reactflow';
import type { Node, Edge, Connection, NodeChange, NodeTypes, ReactFlowInstance, Viewport, XYPosition } from 'reactflow';
import {
  CheckSquare,
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
  Undo2,
  X,
} from 'lucide-react';
import 'reactflow/dist/style.css';
import { useFeedback } from '../components/feedback/feedback-context';
import { computeAutoLayout } from './auto-layout';
import { CustomNode } from './CustomNode';
import type { CustomNodeData, ExecutionNodeStatus } from './form-types';
import './FlowCanvas.css';

import { ConditionEdge } from './ConditionEdge';
import { AnimatedEdge } from './AnimatedEdge';
import { CanvasContextMenu } from './CanvasContextMenu';
import type { CanvasContextMenuItem } from './CanvasContextMenu';
import type { PluginManifest } from '../api/plugins';
import { buildNodeCatalog } from './node-catalog';
import type { NodeCatalogItem } from './node-catalog';
import { NodeQuickAddMenu } from './NodeQuickAddMenu';

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
  plugins?: PluginManifest[];
  executionMode?: 'design' | 'live' | 'trace';
  onOpenExecutionDetails?: () => void;
  onClearExecution?: () => void;
  readOnly?: boolean;
}

export interface FlowCanvasRef {
  updateNodeData: (nodeId: string, data: Partial<CustomNodeData>) => void;
  updateEdgeData: (edgeId: string, data: Partial<Edge>) => void;
  getNodes: () => Node[];
  getEdges: () => Edge[];
  setNodesAndEdges: (nodes: Node[], edges: Edge[]) => void;
  appendNodesAndEdges: (nodes: Node[], edges: Edge[]) => void;
  setNodeExecutionStatus: (nodeId: string, status: ExecutionNodeStatus) => void;
  setExecutionStatuses: (statuses: Record<string, ExecutionNodeStatus>) => void;
  getNodeExecutionStatus: (nodeId: string) => ExecutionNodeStatus | undefined;
  clearExecutionState: () => void;
  /**
   * 그래프를 화면에 맞춘다.
   * rightInset을 주면 그만큼을 뺀 폭(= 속성 패널에 가리지 않는 영역)에 맞춘다.
   * minZoom을 주면 그보다 작게는 줄이지 않고 그래프 중심에 맞춘다 (발표 모드 가독성).
   */
  fitView: (rightInset?: number, options?: { minZoom?: number }) => void;
  /** 계층형으로 다시 배치한다. 좌표만 바뀐다 */
  autoLayout: () => void;
  /** 자동 정렬 직전 배치로 되돌린다 */
  undoAutoLayout: () => void;
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
  kind: 'pane' | 'nodes' | 'edge' | 'node-search';
  anchor: XYPosition;
  flowPosition: XYPosition;
  boundary: { left: number; top: number; right: number; bottom: number };
  nodes?: Node<CustomNodeData>[];
  edge?: Edge;
};

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

function stripExecutionStatus(node: Node): Node {
  const data = node.data as CustomNodeData;
  if (!data.executionStatus) return node;
  const definitionData = { ...data };
  delete definitionData.executionStatus;
  return { ...node, data: definitionData };
}

type EdgeExecutionStatus = ExecutionNodeStatus | 'idle';

function decorateEdgeForExecution(edge: Edge, status: EdgeExecutionStatus, nodes: Node[]): Edge {
  const sourceType = (nodes.find((node) => node.id === edge.source)?.data as CustomNodeData | undefined)?.nodeType;
  const isBranchEdge = edge.type === 'conditionEdge' || sourceType === 'gateway' || sourceType === 'approval';
  const statusStyle: React.CSSProperties = status === 'running'
    ? { stroke: '#2563eb', strokeWidth: 3.5 }
    : status === 'completed'
      ? { stroke: '#16a34a', strokeWidth: 3, strokeDasharray: 'none', strokeDashoffset: '0' }
      : status === 'failed'
        ? { stroke: '#dc2626', strokeWidth: 3, strokeDasharray: '8 4' }
        : status === 'waiting'
          ? { stroke: '#d97706', strokeWidth: 3, strokeDasharray: '4 4' }
          : { stroke: '#94a3b8', strokeWidth: 2, strokeDasharray: 'none', strokeDashoffset: '0' };
  return {
    ...edge,
    type: status === 'running' && !isBranchEdge ? 'animatedEdge' : isBranchEdge ? 'conditionEdge' : 'smoothstep',
    className: `edge-${status === 'running' ? 'active' : status}`,
    animated: false,
    style: { ...edge.style, ...statusStyle },
    data: {
      ...(edge.data || {}),
      animated: isBranchEdge && status === 'running',
      executionStatus: status,
    },
  };
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
    plugins = [],
    executionMode = 'design',
    onOpenExecutionDetails,
    onClearExecution,
    readOnly = false,
  }, ref) => {
    const { confirm: confirmDialog, toast } = useFeedback();
    const [nodes, setNodes, applyNodeChanges] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
    const reactFlowRef = React.useRef<ReactFlowInstance | null>(null);
    const wrapperRef = React.useRef<HTMLDivElement | null>(null);
    const [contextMenu, setContextMenu] = React.useState<CanvasMenuState | null>(null);
    const [layoutUndo, setLayoutUndo] = React.useState<Map<string, XYPosition> | null>(null);
    const [fitAfterLayoutUndo, setFitAfterLayoutUndo] = React.useState(false);
    const [executionStatuses, setExecutionStatusesState] = React.useState<Map<string, ExecutionNodeStatus>>(new Map());
    const nodeCatalog = React.useMemo(
      () => buildNodeCatalog(plugins, contextMenu?.kind === 'node-search' && Boolean(contextMenu.edge)),
      [contextMenu?.edge, contextMenu?.kind, plugins],
    );
    const renderedNodes = React.useMemo(() => nodes.map((node) => {
      const status = executionStatuses.get(node.id);
      return status ? { ...node, data: { ...node.data, executionStatus: status } } : node;
    }), [executionStatuses, nodes]);
    const renderedEdges = React.useMemo(() => edges.map((edge) => {
      if (executionMode === 'design') return edge;
      // 두 끝 노드가 모두 실행된 연결만 통과 경로로 본다. 도착 노드만 보면 여러 분기가
      // 합류하는 그래프에서 실행되지 않은 분기까지 완료 색으로 표시된다.
      const sourceVisited = executionStatuses.has(edge.source);
      const targetStatus = executionStatuses.get(edge.target);
      const status: EdgeExecutionStatus = sourceVisited && targetStatus ? targetStatus : 'idle';
      return decorateEdgeForExecution(edge, status, nodes);
    }), [edges, executionMode, executionStatuses, nodes]);

    const onNodesChange = useCallback((changes: NodeChange[]) => {
      // 자동 정렬 후 사용자가 배치를 편집하면 이전 스냅샷은 더 이상 안전한 실행 취소가 아니다.
      if (changes.some((change) => change.type === 'remove' || change.type === 'add' || (change.type === 'position' && change.dragging))) {
        setLayoutUndo(null);
      }
      applyNodeChanges(changes);
    }, [applyNodeChanges]);

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

    // 자동 정렬은 좌표만 바꾼다. 되돌릴 수 있게 직전 좌표를 한 벌 들고 있는다.
    // 저장하기 전까지는 서버의 원본 배치가 그대로이므로, 되돌리지 않고 탭을 닫아도 잃는 것이 없다.
    // 스냅샷을 ref가 아니라 state로 두는 이유는 메뉴에 되돌리기 항목을 그릴지 판단해야 하기 때문이다.
    const applyAutoLayout = useCallback(() => {
      if (nodes.length < 2) {
        toast.info('정렬할 노드가 없습니다.');
        return;
      }
      const { nodes: laidOut, movedCount } = computeAutoLayout(nodes, edges);
      if (movedCount === 0) {
        toast.info('이미 정렬된 상태입니다.');
        return;
      }
      setLayoutUndo(new Map(nodes.map((node) => [node.id, { ...node.position }])));
      const positions = new Map(laidOut.map((node) => [node.id, node.position]));
      setNodes((nds) => nds.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      }));
      fitView();
      toast.success(`노드 ${movedCount}개를 다시 배치했습니다.`, {
        description: '되돌리려면 Ctrl+Z 또는 캔버스 메뉴의 자동 정렬 되돌리기를 쓰세요.',
      });
    }, [edges, fitView, nodes, setNodes, toast]);

    const undoAutoLayout = useCallback(() => {
      if (!layoutUndo) return;
      setNodes((nds) => nds.map((node) => {
        const position = layoutUndo.get(node.id);
        return position ? { ...node, position } : node;
      }));
      setLayoutUndo(null);
      setFitAfterLayoutUndo(true);
      toast.info('자동 정렬 전 배치로 되돌렸습니다.');
    }, [layoutUndo, setNodes, toast]);

    React.useEffect(() => {
      if (!fitAfterLayoutUndo) return;
      fitView();
      setFitAfterLayoutUndo(false);
    }, [fitAfterLayoutUndo, fitView]);

    const getViewport = useCallback(() => reactFlowRef.current?.getViewport() || null, []);

    const setViewportTo = useCallback((viewport: Viewport, options?: { duration?: number }) => {
      reactFlowRef.current?.setViewport(viewport, { duration: options?.duration ?? 300 });
    }, []);

    // 노드와 엣지 설정하기 (템플릿 불러오기용)
    const setNodesAndEdges = useCallback(
      (newNodes: Node[], newEdges: Edge[]) => {
        // 탭 전환·템플릿 불러오기 후에 이전 탭의 자동 정렬을 되돌리지 않는다.
        setLayoutUndo(null);
        const definitionNodes = newNodes.map(stripExecutionStatus);
        setExecutionStatusesState(new Map());
        setNodes(definitionNodes);
        setEdges(normalizeBranchEdges(definitionNodes, newEdges));
        // 선택 해제
        onNodeSelect?.(null);
      },
      [setNodes, setEdges, onNodeSelect]
    );

    const appendNodesAndEdges = useCallback(
      (newNodes: Node[], newEdges: Edge[]) => {
        const definitionNodes = newNodes.map(stripExecutionStatus);
        setNodes((currentNodes) => {
          const combinedNodes = currentNodes.concat(definitionNodes);
          setEdges((currentEdges) => currentEdges.concat(normalizeBranchEdges(combinedNodes, newEdges)));
          return combinedNodes;
        });
        onNodeSelect?.(definitionNodes[0] || null);
      },
      [setNodes, setEdges, onNodeSelect]
    );

    const setNodeExecutionStatus = useCallback((nodeId: string, status: ExecutionNodeStatus) => {
      setExecutionStatusesState((current) => {
        const next = new Map(current);
        next.set(nodeId, status);
        return next;
      });
    }, []);

    const setExecutionStatuses = useCallback((statuses: Record<string, ExecutionNodeStatus>) => {
      setExecutionStatusesState(new Map(Object.entries(statuses)));
    }, []);

    const getNodeExecutionStatus = useCallback(
      (nodeId: string) => executionStatuses.get(nodeId),
      [executionStatuses],
    );

    const clearExecutionState = useCallback(() => {
      setExecutionStatusesState(new Map());
    }, []);

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
        setNodeExecutionStatus,
        setExecutionStatuses,
        getNodeExecutionStatus,
        clearExecutionState,
        fitView,
        autoLayout: applyAutoLayout,
        undoAutoLayout,
        getViewport,
        setViewport: setViewportTo,
      }),
      [updateNodeData, updateEdgeData, getNodes, getEdges, setNodesAndEdges, appendNodesAndEdges, setNodeExecutionStatus, setExecutionStatuses, getNodeExecutionStatus, clearExecutionState, fitView, applyAutoLayout, undoAutoLayout, getViewport, setViewportTo]
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
      onNodeSelect?.(nodes.find((item) => item.id === node.id) || node);
    },
    [nodes, onNodeSelect]
  );

  const onPaneClick = useCallback(() => {
    wrapperRef.current?.focus({ preventScroll: true });
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
    const definitionNode = nodes.find((item) => item.id === node.id) as Node<CustomNodeData> | undefined;
    if (!definitionNode) return;
    const targetNodes = node.selected && currentSelection.length > 1
      ? currentSelection
      : [definitionNode];
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
    const selectedIds = new Set(selectedNodes.map((node) => node.id));
    const targetNodes = nodes.filter((node) => selectedIds.has(node.id)) as Node<CustomNodeData>[];
    selectNodes(targetNodes);
    setContextMenu({ kind: 'nodes', ...position, nodes: targetNodes });
  }, [contextPosition, nodes, selectNodes]);

  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: Edge) => {
    if (event.shiftKey || readOnly) {
      setContextMenu(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const position = contextPosition(event);
    if (!position) return;
    const definitionEdge = edges.find((item) => item.id === edge.id);
    if (!definitionEdge) return;
    setNodes((items) => items.map((node) => ({ ...node, selected: false })));
    setEdges((items) => items.map((item) => ({ ...item, selected: item.id === edge.id })));
    setContextMenu({ kind: 'edge', ...position, edge: definitionEdge });
  }, [contextPosition, edges, readOnly, setEdges, setNodes]);

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

  const onPaneDoubleClick = useCallback((event: React.MouseEvent) => {
    if (readOnly) return;
    event.preventDefault();
    const position = contextPosition(event);
    if (!position) return;
    setNodes((items) => items.map((node) => ({ ...node, selected: false })));
    setEdges((items) => items.map((edge) => ({ ...edge, selected: false })));
    onNodeSelect?.(null);
    setContextMenu({ kind: 'node-search', ...position });
  }, [contextPosition, onNodeSelect, readOnly, setEdges, setNodes]);

  const addCatalogNode = useCallback((item: NodeCatalogItem, position: XYPosition, splitEdge?: Edge) => {
    const existingIds = new Set([...nodes.map((node) => node.id), ...edges.map((edge) => edge.id)]);
    const uniqueId = (prefix: string) => {
      let index = 0;
      let value = '';
      do value = `${prefix}-${Date.now()}-${index++}`; while (existingIds.has(value));
      existingIds.add(value);
      return value;
    };
    const nodeId = uniqueId('node');
    const newNode: Node<CustomNodeData> = {
      id: nodeId,
      type: 'custom',
      position,
      selected: true,
      data: { ...item.data },
    };
    setNodes((items) => [...items.map((node) => ({ ...node, selected: false })), newNode]);
    if (splitEdge) {
      const beforeEdge: Edge = {
        ...splitEdge,
        id: uniqueId(`edge-${splitEdge.source}-${nodeId}`),
        target: nodeId,
        targetHandle: undefined,
        selected: false,
      };
      const afterEdge: Edge = {
        id: uniqueId(`edge-${nodeId}-${splitEdge.target}`),
        source: nodeId,
        target: splitEdge.target,
        targetHandle: splitEdge.targetHandle,
        type: 'smoothstep',
        animated: splitEdge.animated,
        markerEnd: splitEdge.markerEnd,
        style: splitEdge.style ? { ...splitEdge.style } : undefined,
        selected: false,
      };
      setEdges((items) => items.filter((edge) => edge.id !== splitEdge.id).concat(beforeEdge, afterEdge));
    }
    setContextMenu(null);
  }, [edges, nodes, setEdges, setNodes]);

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

  const openQuickAddAtCenter = useCallback(() => {
    const wrapper = wrapperRef.current;
    const instance = reactFlowRef.current;
    if (!wrapper || !instance || readOnly) return;
    const bounds = wrapper.getBoundingClientRect();
    const clientX = bounds.left + bounds.width / 2;
    const clientY = bounds.top + bounds.height / 2;
    setContextMenu({
      kind: 'node-search',
      anchor: { x: clientX, y: clientY },
      flowPosition: instance.screenToFlowPosition({ x: clientX, y: clientY }),
      boundary: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    });
  }, [readOnly]);

  const handleCanvasKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const selectedNodes = nodes.filter((node) => node.selected) as Node<CustomNodeData>[];
    const isCopy = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c';
    const isPaste = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
    if (!readOnly && event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      openQuickAddAtCenter();
      return;
    }
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
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      // 자동 정렬 직후에만 받는다. 일반 편집 실행취소는 아직 없다.
      if (readOnly || !layoutUndo) return;
      event.preventDefault();
      undoAutoLayout();
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      openKeyboardMenu();
    }
  }, [canPaste, layoutUndo, nodes, onCopyGraph, onPasteAt, openKeyboardMenu, openQuickAddAtCenter, readOnly, selectedGraph, undoAutoLayout]);

  let contextMenuTitle = '';
  let contextMenuItems: CanvasContextMenuItem[] = [];
  if (contextMenu?.kind === 'pane') {
    contextMenuTitle = '캔버스';
    contextMenuItems = readOnly
      ? [{ id: 'fit', label: '전체 화면에 맞춤', icon: <Maximize2 size={15} />, onSelect: () => fitView() }]
      : [
        {
          id: 'add', label: '노드 추가…', icon: <Plus size={15} />,
          onSelect: () => setContextMenu({ ...contextMenu, kind: 'node-search' }),
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
        ...(layoutUndo ? [{
          id: 'undo-auto-layout', label: '자동 정렬 되돌리기', icon: <Undo2 size={15} />,
          shortcut: 'Ctrl+Z', separatorBefore: true, onSelect: () => undoAutoLayout(),
        }] : []),
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
      {
        id: 'insert-node', label: '사이에 노드 추가…', icon: <Plus size={15} />,
        onSelect: () => setContextMenu({ ...contextMenu, kind: 'node-search' }),
      },
      ...(sourceType === 'gateway' ? [{
        id: 'branch-settings', label: '분기 설정 열기', icon: <GitBranch size={15} />,
        separatorBefore: true,
        onSelect: () => openSourceNode(edge),
      }] : []),
      ...(sourceType === 'approval' ? [{
        id: 'approval-route', label: '결과 경로 확인', icon: <CheckSquare size={15} />,
        separatorBefore: true,
        onSelect: () => openSourceNode(edge),
      }] : []),
      {
        id: 'delete-edge', label: '연결 삭제', icon: <Trash2 size={15} />,
        separatorBefore: true, tone: 'danger',
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
        nodes={renderedNodes}
        edges={renderedEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={readOnly ? undefined : onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onDoubleClick={(event) => {
          if ((event.target as Element).classList.contains('react-flow__pane')) {
            onPaneDoubleClick(event);
          }
        }}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionContextMenu={onSelectionContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onMoveStart={() => setContextMenu(null)}
        onEdgeDoubleClick={readOnly ? undefined : onEdgeDoubleClick}
        zoomOnDoubleClick={false}
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
            if (executionMode !== 'design') {
              switch (data.executionStatus) {
                case 'running': return '#2563eb';
                case 'waiting': return '#d97706';
                case 'completed': return '#16a34a';
                case 'failed': return '#dc2626';
                default: return '#94a3b8';
              }
            }
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
        {executionMode !== 'design' && (
          <Panel position="top-left" className="execution-node-legend" aria-label="노드 실행 상태 범례">
            <div className="execution-node-legend-items">
              <span><i className="running" />실행 중</span>
              <span><i className="waiting" />대기</span>
              <span><i className="completed" />완료</span>
              <span><i className="failed" />실패</span>
              <span><i className="idle" />미실행</span>
            </div>
            {(onOpenExecutionDetails || onClearExecution) && (
              <div className="execution-node-legend-actions">
                {onOpenExecutionDetails && (
                  <button type="button" onClick={onOpenExecutionDetails}>실행 상세</button>
                )}
                {onClearExecution && (
                  <button type="button" onClick={onClearExecution} aria-label="실행 표시 지우기" title="실행 표시 지우기">
                    <X size={13} />
                    표시 지우기
                  </button>
                )}
              </div>
            )}
          </Panel>
        )}
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
      {contextMenu?.kind === 'node-search' && !readOnly && (
        <NodeQuickAddMenu
          title={contextMenu.edge ? '연결 사이에 노드 추가' : '노드 추가'}
          anchor={contextMenu.anchor}
          boundary={contextMenu.boundary}
          items={nodeCatalog}
          onSelect={(item) => addCatalogNode(item, contextMenu.flowPosition, contextMenu.edge)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
});
