# UI 디자인 방향 정리

## 🎯 목표

**"Total.js Flow처럼 네이티브 앱 같은 느낌이 나면서도 세련된 UI"**

---

## 📋 생성된 문서

### 1. `UI_DESIGN_GUIDE.md` (메인 가이드)

Total.js Flow 스타일의 세련된 디자인 시스템 전체 가이드

**주요 내용**:

- 핵심 디자인 원칙 (네이티브 앱 느낌, 시각적 계층, 일관성)
- Total.js Flow에서 배울 점
- 노드 디자인 (색상, 그림자, 애니메이션)
- 엣지 (연결선) 디자인
- 3-column 레이아웃
- 실시간 데이터 플로우 표시
- 드래그&드롭 피드백
- 구체적인 구현 계획 (Phase별)
- 컴포넌트 예시 코드
- 애니메이션 가이드
- 아이콘 시스템

### 2. `apps/web/src/design-system.css` (실제 구현)

CSS 변수 및 유틸리티 클래스

**주요 내용**:

- CSS 변수 (색상, 간격, 그림자, 애니메이션)
- 다크/라이트 테마
- 타이포그래피 유틸리티
- 레이아웃 유틸리티
- 애니메이션 키프레임
- 스크롤바, 포커스 스타일

### 3. `TODO.md` (업데이트)

Phase 0: UI 디자인 시스템 구축 추가

---

## 🎨 핵심 디자인 특징

### 1. **다크 모드 우선**

```css
--bg-primary: #1a1d23; /* 진한 다크 그레이 */
--bg-secondary: #23262d;
--text-primary: #e4e6eb; /* 고대비 텍스트 */
```

### 2. **노드별 색상 구분**

- Start: 초록 (#4caf50)
- Service: 파랑 (#2196f3)
- Timer: 주황 (#ff9800)
- Gateway: 보라 (#9c27b0)
- Approval: 노랑 (#ffc107)
- End: 빨강 (#f44336)

### 3. **부드러운 애니메이션**

- 노드 호버: `transform: translateY(-2px)`
- 실행 중: `pulse` 애니메이션
- 엣지 흐름: `dash` 애니메이션 (점선이 흐르는 효과)

### 4. **3-Column 레이아웃**

```
┌─────────────────────────────────────────────────┐
│  Header (Logo, Title, Actions)                  │
├──────┬──────────────────────────────┬───────────┤
│ 노드  │        Canvas               │  속성     │
│ 팔레트│      (Workflow Graph)       │  패널     │
│ 240px│         (flex-1)             │  320px    │
└──────┴──────────────────────────────┴───────────┘
```

### 5. **실시간 피드백**

- 드래그 시작: `opacity: 0.7`
- 드롭 가능 영역: `border: 2px dashed #2196f3`
- 노드 실행 중: LED 같은 표시 + 깜빡임

---

## 🚀 다음 단계

### Phase 0: UI 디자인 시스템 구축 (4-5일)

#### Week 1

1. **디자인 시스템 기초** (1-2일)
   - [x] `design-system.css` 생성 ✅
   - [ ] Inter 폰트 적용
   - [ ] Lucide React 아이콘 설치
   - [ ] 기존 `index.css`에 import

2. **기본 컴포넌트** (2일)
   - [ ] Button 컴포넌트
   - [ ] Panel 컴포넌트
   - [ ] Input, Select, Checkbox
   - [ ] Tooltip, Modal

3. **레이아웃** (1일)
   - [ ] 3-column 레이아웃 구조
   - [ ] 헤더 컴포넌트
   - [ ] 반응형 설정

---

## 📦 필요한 패키지

```bash
# 아이콘
pnpm add lucide-react

# 폰트 (Google Fonts CDN 사용 또는)
pnpm add @fontsource/inter

# Flow 라이브러리 (선택)
pnpm add reactflow  # 또는 직접 구현
```

---

## 💡 참고 자료

### Total.js 관련

- [Total.js Flow](https://www.totaljs.com/flow/)
- [Total.js UI Builder](https://www.totaljs.com/uibuilder/)

### 유사 프로젝트

- **Node-RED**: Flow-based programming
- **n8n**: Workflow automation
- **Retool**: Low-code platform

### 디자인 영감

- Dribbble: "flow designer"
- Behance: "workflow ui"

---

## ✅ 체크리스트

### 즉시 시작 가능

- [x] UI_DESIGN_GUIDE.md 작성
- [x] design-system.css 생성
- [x] TODO.md 업데이트

### 다음 작업

- [ ] design-system.css를 index.css에 import
- [ ] Inter 폰트 설정
- [ ] Lucide React 설치
- [ ] Button 컴포넌트 구현
- [ ] Panel 컴포넌트 구현

---

## 🎨 최종 비전

> "사용자가 처음 보는 순간 '와, 이거 진짜 멋있다'라고 느끼고,  
> 사용하면서 '이거 정말 편하다'라고 느끼는 제품"

**핵심 가치**:

1. ✨ **Visual Excellence** - 시각적 완성도
2. 🎯 **Smooth Interaction** - 부드러운 인터랙션
3. 🧭 **Intuitive UX** - 직관적인 사용성
4. 💼 **Professional Feel** - 프로페셔널한 느낌

---

## 📝 다음 회의 때 논의할 사항

1. **React Flow vs 직접 구현**
   - React Flow: 빠른 구현, 풍부한 기능
   - 직접 구현: 완전한 커스터마이징, 가벼움

2. **아이콘 스타일**
   - Lucide (추천): 깔끔, 일관성
   - Heroicons: 심플
   - 커스텀 SVG: 브랜드 정체성

3. **애니메이션 수준**
   - 기본: 호버, 클릭 피드백
   - 중급: 노드 실행 펄스, 엣지 흐름
   - 고급: 토큰 이동 시각화, 파티클 효과

4. **반응형 우선순위**
   - 데스크톱 우선 (워크플로우 디자이너는 큰 화면에서 주로 사용)
   - 모바일: 뷰어 모드 (편집 불가, 조회만)
