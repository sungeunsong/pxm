# PXM UI/UX Design Guide

## Total.js Flow 스타일 - 네이티브 앱 같은 세련된 디자인

> **디자인 철학**: "웹이지만 네이티브 앱처럼, 단순하지만 강력하게"

---

## 🎨 핵심 디자인 원칙

### 1. **네이티브 앱 같은 느낌 (Native-like Experience)**

- **부드러운 애니메이션**: 모든 상호작용에 60fps 애니메이션
- **즉각적인 피드백**: 클릭, 호버, 드래그 시 즉시 시각적 반응
- **제스처 지원**: 드래그, 줌, 팬 등 자연스러운 인터랙션
- **로딩 없는 느낌**: Optimistic UI 업데이트 + 백그라운드 동기화

### 2. **시각적 계층 (Visual Hierarchy)**

- **깊이감**: 그림자, 레이어, z-index로 명확한 계층 구조
- **포커스 유도**: 중요한 요소는 밝게, 보조 요소는 어둡게
- **공간 활용**: 여백을 충분히 두어 답답하지 않게

### 3. **일관성 (Consistency)**

- **디자인 토큰**: 색상, 간격, 폰트 크기 등 모든 값을 변수화
- **컴포넌트 재사용**: 동일한 UI 패턴은 동일한 컴포넌트 사용
- **인터랙션 패턴**: 비슷한 동작은 비슷한 방식으로

---

## 🎭 Total.js Flow에서 배울 점

### ✅ 적용할 핵심 요소

#### 1. **다크 모드 우선 (Dark Mode First)**

```css
/* 기본 배경: 진한 다크 그레이 */
--bg-primary: #1a1d23;
--bg-secondary: #23262d;
--bg-tertiary: #2d3139;

/* 텍스트: 고대비 */
--text-primary: #e4e6eb;
--text-secondary: #b0b3b8;
--text-tertiary: #8a8d93;
```

#### 2. **노드 디자인 (Flow Nodes)**

Total.js Flow의 노드 스타일:

- **둥근 모서리**: `border-radius: 8px`
- **미묘한 그림자**: `box-shadow: 0 2px 8px rgba(0,0,0,0.3)`
- **아이콘 + 텍스트**: 왼쪽 아이콘, 오른쪽 레이블
- **상태별 색상**:
  - Start: 초록 (`#4caf50`)
  - Service: 파랑 (`#2196f3`)
  - Timer: 주황 (`#ff9800`)
  - Gateway: 보라 (`#9c27b0`)
  - Approval: 노랑 (`#ffc107`)
  - End: 빨강 (`#f44336`)
- **포트 (연결점)**: 작은 원형, 호버 시 확대
- **선택 시**: 밝은 테두리 + 글로우 효과

```css
.workflow-node {
  background: var(--bg-secondary);
  border: 2px solid transparent;
  border-radius: 8px;
  padding: 12px 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  transition: all 0.2s ease;
}

.workflow-node:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.workflow-node.selected {
  border-color: #2196f3;
  box-shadow: 0 0 0 3px rgba(33, 150, 243, 0.3);
}

.workflow-node.running {
  border-color: #4caf50;
  animation: pulse 1.5s ease-in-out infinite;
}
```

#### 3. **엣지 (연결선) 디자인**

- **부드러운 곡선**: Bezier curve 사용
- **애니메이션**: 점선이 흐르는 효과 (dashed + animation)
- **상태별 색상**:
  - 기본: 회색 (`#555`)
  - 활성: 파랑 (`#2196f3`)
  - 성공: 초록 (`#4caf50`)
  - 실패: 빨강 (`#f44336`)

```css
.workflow-edge {
  stroke: #555;
  stroke-width: 2px;
  fill: none;
  transition: stroke 0.3s ease;
}

.workflow-edge.active {
  stroke: #2196f3;
  stroke-width: 3px;
  stroke-dasharray: 5, 5;
  animation: dash 1s linear infinite;
}

@keyframes dash {
  to {
    stroke-dashoffset: -10;
  }
}
```

#### 4. **패널 레이아웃 (3-Column Layout)**

```
┌─────────────────────────────────────────────────┐
│  Header (Logo, Title, Actions)                  │
├──────┬──────────────────────────────┬───────────┤
│      │                              │           │
│ 노드  │        Canvas               │  속성     │
│ 팔레트│      (Workflow Graph)       │  패널     │
│      │                              │           │
│ 240px│         (flex-1)             │  320px    │
│      │                              │           │
└──────┴──────────────────────────────┴───────────┘
```

#### 5. **실시간 데이터 플로우 표시**

Total.js의 "traffic indicator" 참고:

- 노드 입출력에 작은 LED 같은 표시
- 데이터가 흐를 때 깜빡이는 효과
- 처리량에 따라 색상 변화 (초록 → 노랑 → 빨강)

```tsx
<div className="node-port">
  <div className="port-indicator" data-active={isActive}>
    <div className="pulse" />
  </div>
</div>
```

#### 6. **드래그&드롭 피드백**

- **드래그 시작**: 노드가 약간 투명해짐 (`opacity: 0.7`)
- **드래그 중**: 마우스 커서 변경 (`cursor: grabbing`)
- **드롭 가능 영역**: 하이라이트 (`border: 2px dashed #2196f3`)
- **드롭 불가 영역**: 빨간 테두리 + 금지 커서

#### 7. **미니맵 (Canvas Overview)**

- 우측 하단에 작은 미니맵
- 현재 뷰포트 표시 (반투명 사각형)
- 클릭으로 빠른 이동

---

## 🎯 구체적인 구현 계획

### Phase 1: 디자인 시스템 구축

#### 1.1 CSS 변수 정의 (`apps/web/src/design-system.css`)

```css
:root {
  /* Colors - Dark Theme */
  --bg-primary: #1a1d23;
  --bg-secondary: #23262d;
  --bg-tertiary: #2d3139;
  --bg-elevated: #363940;

  --text-primary: #e4e6eb;
  --text-secondary: #b0b3b8;
  --text-tertiary: #8a8d93;

  --border-subtle: #3a3d45;
  --border-strong: #555860;

  /* Node Colors */
  --node-start: #4caf50;
  --node-service: #2196f3;
  --node-timer: #ff9800;
  --node-gateway: #9c27b0;
  --node-approval: #ffc107;
  --node-end: #f44336;

  /* Status Colors */
  --status-running: #4caf50;
  --status-waiting: #ff9800;
  --status-failed: #f44336;
  --status-completed: #2196f3;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;

  /* Border Radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;

  /* Shadows */
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.2);
  --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.3);
  --shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.4);
  --shadow-glow: 0 0 0 3px rgba(33, 150, 243, 0.3);

  /* Transitions */
  --transition-fast: 0.15s ease;
  --transition-base: 0.2s ease;
  --transition-slow: 0.3s ease;

  /* Z-index */
  --z-canvas: 1;
  --z-nodes: 10;
  --z-edges: 5;
  --z-panel: 100;
  --z-modal: 1000;
  --z-tooltip: 2000;
}
```

#### 1.2 타이포그래피

```css
/* Fonts */
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap");

body {
  font-family:
    "Inter",
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.text-xs {
  font-size: 12px;
}
.text-sm {
  font-size: 14px;
}
.text-base {
  font-size: 16px;
}
.text-lg {
  font-size: 18px;
}
.text-xl {
  font-size: 20px;
}
.text-2xl {
  font-size: 24px;
}
```

### Phase 2: 컴포넌트 라이브러리

#### 2.1 Button Component

```tsx
// apps/web/src/components/Button.tsx
interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = "primary",
  size = "md",
  icon,
  children,
  onClick,
  disabled,
}) => {
  return (
    <button
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <span className="btn-icon">{icon}</span>}
      <span>{children}</span>
    </button>
  );
};
```

```css
/* Button Styles */
.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border: none;
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-base);
  white-space: nowrap;
}

.btn-primary {
  background: #2196f3;
  color: white;
}

.btn-primary:hover {
  background: #1976d2;
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.btn-sm {
  padding: var(--space-xs) var(--space-sm);
  font-size: 12px;
}
.btn-md {
  padding: var(--space-sm) var(--space-md);
  font-size: 14px;
}
.btn-lg {
  padding: var(--space-md) var(--space-lg);
  font-size: 16px;
}
```

#### 2.2 Panel Component

```tsx
// apps/web/src/components/Panel.tsx
interface PanelProps {
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  collapsible?: boolean;
}

export const Panel: React.FC<PanelProps> = ({
  title,
  actions,
  children,
  collapsible,
}) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="panel">
      {title && (
        <div className="panel-header">
          <h3 className="panel-title">{title}</h3>
          <div className="panel-actions">
            {actions}
            {collapsible && (
              <button onClick={() => setCollapsed(!collapsed)}>
                {collapsed ? "▼" : "▲"}
              </button>
            )}
          </div>
        </div>
      )}
      {!collapsed && <div className="panel-body">{children}</div>}
    </div>
  );
};
```

### Phase 3: Flow Designer 구현

#### 3.1 노드 팔레트 (Node Palette)

```tsx
// apps/web/src/flow-designer/NodePalette.tsx
const NODE_TYPES = [
  { type: "start", label: "Start", icon: "▶️", color: "var(--node-start)" },
  {
    type: "service",
    label: "Service",
    icon: "⚙️",
    color: "var(--node-service)",
  },
  { type: "timer", label: "Timer", icon: "⏱️", color: "var(--node-timer)" },
  {
    type: "gateway",
    label: "Gateway",
    icon: "◆",
    color: "var(--node-gateway)",
  },
  {
    type: "approval",
    label: "Approval",
    icon: "✓",
    color: "var(--node-approval)",
  },
  { type: "end", label: "End", icon: "⏹️", color: "var(--node-end)" },
];

export const NodePalette = () => {
  return (
    <div className="node-palette">
      <div className="palette-header">
        <h3>Nodes</h3>
      </div>
      <div className="palette-body">
        {NODE_TYPES.map((node) => (
          <div
            key={node.type}
            className="palette-node"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("nodeType", node.type);
            }}
            style={{ "--node-color": node.color } as any}
          >
            <span className="node-icon">{node.icon}</span>
            <span className="node-label">{node.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
```

```css
.node-palette {
  width: 240px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
}

.palette-node {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  margin: var(--space-sm);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--node-color);
  cursor: grab;
  transition: all var(--transition-base);
}

.palette-node:hover {
  background: var(--bg-elevated);
  transform: translateX(4px);
}

.palette-node:active {
  cursor: grabbing;
  opacity: 0.7;
}
```

#### 3.2 속성 패널 (Properties Panel)

```tsx
// apps/web/src/flow-designer/PropertiesPanel.tsx
export const PropertiesPanel = ({ selectedNode }) => {
  if (!selectedNode) {
    return (
      <div className="properties-panel">
        <div className="panel-empty">
          <p>Select a node to edit properties</p>
        </div>
      </div>
    );
  }

  return (
    <div className="properties-panel">
      <div className="panel-header">
        <h3>{selectedNode.type} Properties</h3>
      </div>
      <div className="panel-body">
        {/* Node-specific properties */}
        {selectedNode.type === "service" && (
          <ServiceNodeProperties node={selectedNode} />
        )}
        {selectedNode.type === "timer" && (
          <TimerNodeProperties node={selectedNode} />
        )}
        {/* ... */}
      </div>
    </div>
  );
};
```

---

## 🚀 애니메이션 가이드

### 1. 노드 애니메이션

```css
/* 노드 등장 */
@keyframes nodeAppear {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.workflow-node {
  animation: nodeAppear 0.3s ease;
}

/* 실행 중 펄스 */
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.workflow-node.running {
  animation: pulse 1.5s ease-in-out infinite;
}

/* 성공 체크 */
@keyframes checkmark {
  0% {
    stroke-dashoffset: 100;
  }
  100% {
    stroke-dashoffset: 0;
  }
}
```

### 2. 엣지 애니메이션

```css
/* 데이터 흐름 */
@keyframes flow {
  to {
    stroke-dashoffset: -20;
  }
}

.workflow-edge.active {
  stroke-dasharray: 10, 5;
  animation: flow 1s linear infinite;
}
```

### 3. 패널 슬라이드

```css
.panel-enter {
  transform: translateX(100%);
}

.panel-enter-active {
  transform: translateX(0);
  transition: transform 0.3s ease;
}
```

---

## 📱 반응형 디자인

### 브레이크포인트

```css
/* Mobile */
@media (max-width: 768px) {
  .node-palette {
    width: 100%;
    height: 200px;
  }
  .properties-panel {
    width: 100%;
  }
  /* 3-column → 1-column stack */
}

/* Tablet */
@media (min-width: 769px) and (max-width: 1024px) {
  .node-palette {
    width: 200px;
  }
  .properties-panel {
    width: 280px;
  }
}

/* Desktop */
@media (min-width: 1025px) {
  .node-palette {
    width: 240px;
  }
  .properties-panel {
    width: 320px;
  }
}
```

---

## 🎨 아이콘 시스템

### 추천 라이브러리

1. **Lucide React** (추천) - 깔끔하고 일관된 아이콘

   ```bash
   pnpm add lucide-react
   ```

2. **Heroicons** - Tailwind 팀 제작, 심플한 디자인

### 사용 예시

```tsx
import {
  Play,
  Settings,
  Clock,
  GitBranch,
  CheckCircle,
  XCircle,
} from "lucide-react";

const nodeIcons = {
  start: <Play size={16} />,
  service: <Settings size={16} />,
  timer: <Clock size={16} />,
  gateway: <GitBranch size={16} />,
  approval: <CheckCircle size={16} />,
  end: <XCircle size={16} />,
};
```

---

## 🎯 다음 단계 체크리스트

### Week 1: 디자인 시스템

- [ ] `design-system.css` 생성 (CSS 변수)
- [ ] 기본 컴포넌트 (Button, Panel, Input, Select)
- [ ] 아이콘 시스템 설정
- [ ] 타이포그래피 정리

### Week 2: Flow Designer 기본

- [ ] 3-column 레이아웃
- [ ] 노드 팔레트 UI
- [ ] 캔버스 (React Flow 또는 직접 구현)
- [ ] 속성 패널 기본 구조

### Week 3: 인터랙션

- [ ] 드래그&드롭
- [ ] 노드 연결
- [ ] 줌/팬
- [ ] 미니맵

### Week 4: 폴리시

- [ ] 애니메이션 추가
- [ ] 실시간 데이터 플로우 표시
- [ ] 다크/라이트 모드 토글
- [ ] 반응형 최적화

---

## 💡 참고 자료

### Total.js 관련

- [Total.js Flow 공식 문서](https://www.totaljs.com/flow/)
- [Total.js UI Builder](https://www.totaljs.com/uibuilder/)

### 유사 프로젝트

- **Node-RED**: Flow-based programming
- **n8n**: Workflow automation
- **Retool**: Low-code platform
- **Appsmith**: Internal tools builder

### 디자인 영감

- [Dribbble - Flow Designer](https://dribbble.com/search/flow-designer)
- [Behance - Workflow UI](https://www.behance.net/search/projects?search=workflow%20ui)

---

## 🎨 최종 목표

> "사용자가 처음 보는 순간 '와, 이거 진짜 멋있다'라고 느끼고,  
> 사용하면서 '이거 정말 편하다'라고 느끼는 제품"

**핵심 가치**:

1. **Visual Excellence** - 시각적 완성도
2. **Smooth Interaction** - 부드러운 인터랙션
3. **Intuitive UX** - 직관적인 사용성
4. **Professional Feel** - 프로페셔널한 느낌
