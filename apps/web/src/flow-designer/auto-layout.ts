// 워크플로우 자동 배치
// apps/web/src/flow-designer/auto-layout.ts
//
// 왜 dagre인가.
// - React Flow(v11)는 엣지 경로를 자기가 그린다(bezier / smoothstep). ELK의 강점인 엣지 라우팅
//   결과(bend point)는 전용 엣지 컴포넌트를 새로 만들지 않으면 쓸 수 없다. 지금 필요한 것은
//   노드 좌표뿐이므로 계층 배치만 잘하면 된다.
// - elkjs는 배포 패키지가 dagre의 대여섯 배이고 비동기(worker) 실행을 전제한다. 이미 1.4MB인
//   web 번들에 그만큼을 더할 이유가 없다.
// - 노드 폭이 168~240px로 제각각인데 둘 다 노드별 크기를 받는다.
// - 반려 → 재승인 같은 순환이 있다. dagre는 순환을 임시로 끊어 배치하고 되돌린다.
//
// 배치 후에도 사용자가 노드를 자유롭게 옮길 수 있고, 좌표만 바꾸므로 워크플로우 내용은 그대로다.

import dagre from '@dagrejs/dagre';

type LayoutGraph = InstanceType<typeof dagre.graphlib.Graph>;
import type { Edge, Node } from 'reactflow';

/** 측정값이 없을 때 쓰는 카드 크기. CustomNode.css의 min-width / 2줄 높이와 맞춘다. */
const FALLBACK_NODE_WIDTH = 200;
const FALLBACK_NODE_HEIGHT = 64;

/** 같은 단계(세로) 노드 사이 간격 */
const NODE_SEPARATION = 48;
/** 단계와 단계(가로) 사이 간격. 분기 라벨이 엣지 가운데 놓이므로 넉넉히 준다. */
const RANK_SEPARATION = 96;

/**
 * 분기 노드의 출력 핸들은 화면상 위아래가 정해져 있다.
 * (gateway: true 위 / false 아래, approval: approved 위 / rejected 아래 — CustomNode.tsx)
 * dagre는 핸들 위치를 모르므로 대상이 반대로 놓이면 분기 직후 두 선이 X자로 엇갈린다.
 * 배치가 끝난 뒤 같은 열에 있는 두 대상의 세로 위치만 맞바꿔 준다.
 */
const HANDLE_ROW: Record<string, number> = {
  true: 0,
  approved: 0,
  false: 1,
  rejected: 1,
};

export interface AutoLayoutOptions {
  /** 흐름 방향. 워크플로우는 좌에서 우로 읽는다. */
  direction?: 'LR' | 'TB';
}

export interface AutoLayoutResult {
  /** 새 좌표가 반영된 노드 */
  nodes: Node[];
  /** 좌표가 실제로 바뀐 노드 수 */
  movedCount: number;
}

type PlacedNode = { x: number; y: number; width: number; height: number };

/** 두 노드가 같은 열이라고 볼 만큼 가로로 겹치는가 */
function sameColumn(a: PlacedNode, b: PlacedNode): boolean {
  const overlap = Math.min(a.x + a.width / 2, b.x + b.width / 2) - Math.max(a.x - a.width / 2, b.x - b.width / 2);
  return overlap > Math.min(a.width, b.width) / 2;
}

/**
 * 한 분기에서 나온 두 대상이 같은 열에 있는데 핸들 순서와 위아래가 반대면 세로 위치를 맞바꾼다.
 *
 * 열을 건너뛰는 간선(중간 열 위를 지나가는 선)에 걸린 노드는 건드리지 않는다.
 * 그런 노드를 옮기면 지나가는 선이 다른 카드를 관통하게 되어, 교차 하나를 없애려다
 * 더 큰 문제를 만든다. 실제 워크플로우에서 그렇게 되는 것을 확인했다.
 */
function alignBranchTargets(graph: LayoutGraph, nodes: Node[], edges: Edge[]): void {
  const placed = (id: string) => graph.node(id) as PlacedNode | undefined;

  // 열 번호를 x 중심값 순서로 매긴다.
  const columns = [...new Set(nodes.map((node) => placed(node.id)?.x).filter((x): x is number => x !== undefined))]
    .sort((a, b) => a - b);
  const columnOf = (id: string) => {
    const node = placed(id);
    return node ? columns.indexOf(node.x) : -1;
  };

  // 열을 건너뛰는 간선의 양 끝 노드
  const spanning = new Set<string>();
  edges.forEach((edge) => {
    const from = columnOf(edge.source);
    const to = columnOf(edge.target);
    if (from < 0 || to < 0) return;
    if (Math.abs(to - from) > 1) {
      spanning.add(edge.source);
      spanning.add(edge.target);
    }
  });

  const branches = new Map<string, Array<{ target: string; row: number }>>();
  edges.forEach((edge) => {
    const row = edge.sourceHandle ? HANDLE_ROW[edge.sourceHandle] : undefined;
    if (row === undefined) return;
    const list = branches.get(edge.source) || [];
    list.push({ target: edge.target, row });
    branches.set(edge.source, list);
  });

  branches.forEach((targets) => {
    if (targets.length !== 2) return;
    if (targets.some((entry) => spanning.has(entry.target))) return;
    const pair = targets.map((entry) => ({ row: entry.row, node: placed(entry.target) }));
    const [first, second] = pair;
    if (!first.node || !second.node) return;
    if (!sameColumn(first.node, second.node)) return;

    const upper = first.row <= second.row ? first : second;
    const lower = upper === first ? second : first;
    if (upper.node!.y <= lower.node!.y) return; // 이미 핸들 순서대로다

    const swap = upper.node!.y;
    upper.node!.y = lower.node!.y;
    lower.node!.y = swap;
  });
}

function sizeOf(node: Node): { width: number; height: number } {
  // React Flow가 렌더 후 채워 주는 실측값을 우선 쓴다. 카드 폭이 내용에 따라 다르기 때문이다.
  const width = node.width || (node.style?.width as number) || FALLBACK_NODE_WIDTH;
  const height = node.height || (node.style?.height as number) || FALLBACK_NODE_HEIGHT;
  return { width, height };
}

/**
 * 계층형으로 다시 배치한 노드를 돌려준다. 원본 배열은 건드리지 않는다.
 * 엣지가 가리키는 노드가 없으면(끊어진 엣지) 그 엣지는 무시한다.
 */
export function computeAutoLayout(
  nodes: Node[],
  edges: Edge[],
  options: AutoLayoutOptions = {},
): AutoLayoutResult {
  if (nodes.length === 0) return { nodes, movedCount: 0 };

  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: options.direction || 'LR',
    nodesep: NODE_SEPARATION,
    ranksep: RANK_SEPARATION,
    marginx: 0,
    marginy: 0,
  });

  const known = new Set(nodes.map((node) => node.id));
  nodes.forEach((node) => graph.setNode(node.id, sizeOf(node)));
  edges.forEach((edge) => {
    if (!known.has(edge.source) || !known.has(edge.target)) return;
    if (edge.source === edge.target) return; // 자기 자신으로 도는 엣지는 배치에 영향을 주지 않는다
    graph.setEdge(edge.source, edge.target);
  });

  dagre.layout(graph);
  alignBranchTargets(graph, nodes, edges);

  let movedCount = 0;
  const laidOut = nodes.map((node) => {
    const placed = graph.node(node.id);
    if (!placed) return node;
    const { width, height } = sizeOf(node);
    // dagre는 중심 좌표를, React Flow는 좌상단 좌표를 쓴다.
    const position = {
      x: Math.round(placed.x - width / 2),
      y: Math.round(placed.y - height / 2),
    };
    if (position.x !== Math.round(node.position.x) || position.y !== Math.round(node.position.y)) {
      movedCount += 1;
    }
    return { ...node, position };
  });

  return { nodes: laidOut, movedCount };
}
