# PXM 프론트엔드 정리 — 인수인계

**대상**: Codex · **브랜치**: `v2-redesign` · **범위**: `apps/web` · **작성**: 2026-09-02

> 이전 문서 `docs/ui-ux-p0-handoff.md`를 대체합니다.

---

## 0. 한 눈에

| | Before | After |
|---|---|---|
| Flow Designer 캔버스 폭 (1920px) | 786px · 41% | **1604px · 83%** |
| 18노드 워크플로우 로드 시 보이는 노드 | **0 / 18** | **18 / 18** |
| 브라우저 기본 `alert`/`confirm`/`prompt` | 57곳 | **0곳** |
| 동작하지 않는 컨트롤 | 6개 | **0개** |
| 대시보드 데이터 | 전부 목업 | 실제 API 4곳 |
| 폰트 크기 종류 | 25종 (8~28px) | **5종** (12/14/16/20/24) |
| 본문 폰트 | 11~12px | **14px** |
| 회색 램프 | slate + UI-kit 2계열 | **slate 1계열** |
| border-radius | 9종 | 토큰 5종 |

변경량: **62개 파일, +1,809 / −1,466**. 신규 3개 경로.
`tsc` 통과 · `vite build` 통과 · `eslint` 127건(기준선 127, **순증 0**).

시각 비교: https://claude.ai/code/artifact/d986ad19-4917-4378-a68a-ff61f22cd502

---

## 1. 진단 — Codex 원안과 갈렸던 지점

Codex 진단은 **Flow Designer 레이아웃**에 집중돼 있었고 방향은 맞았습니다.
다만 전체를 훑어보니 **디자이너는 19개 화면 중 하나**였고, "안 예쁘다"의 원인이 셋으로 갈렸습니다.

| 순위 | 문제 | 당시 근거 |
|---|---|---|
| 1 | **화면이 사실이 아니다** | 대시보드 전체 목업, 죽은 컨트롤 6개, `배포 vnull` |
| 2 | **정보 밀도 과다 · 제목 중복** | 본문 11~12px, 한 화면에 같은 제목 5번 |
| 3 | **공용 UI 레이어 부재** | CSS 12,897줄 중 토큰 사용 10%, `.status-badge` 24중복 |

그래서 순서를 **"어떻게 보이게 할까"가 아니라 "보이는 게 사실인가"**부터로 잡았습니다.
Codex가 지적한 `fitView` 누락은 사실 확인 후 최우선으로 올렸습니다.

**갈린 판단 3개**
- `alert` 제거: Codex 4순위 → **1순위로 올림.** 가장 싸고 가장 티 남
- 다크 테마: 둘 다 후순위 동의. 당시엔 하드코딩 색 때문에 절반이 깨질 상태였음
- 타이포: 제가 처음에 P1로 잡았다가, 스크린샷 실측 후 **레이아웃을 앞으로** 당김

---

## 2. 완료 — 1차: 신뢰 (화면이 거짓말하지 않게)

### 2-1. 캔버스 화면 맞춤 누락

노드 교체 경로가 두 갈래인데 한쪽에만 `fitView()`가 있었습니다.

- `handleRestoreHistory`(실행 추적) → 있음
- `restoreDesignerTab`(탭 전환/신규/닫기, 템플릿 로드, import) → **없음**

```diff
  flowCanvasRef.current?.setNodesAndEdges(tab.nodes, tab.edges);
+ // 노드를 교체한 뒤에는 항상 화면에 맞춘다.
+ flowCanvasRef.current?.fitView();
```

`restoreDesignerTab`이 단일 통로라 **한 줄로 5개 진입 경로가 전부 커버**됩니다.
`FlowCanvas.fitView()`는 이미 구현돼 있었습니다(rAF 2회 + 80ms 보정, padding 0.18).

### 2-2. `alert`/`confirm`/`prompt` 57곳 → 공용 피드백 레이어

17개 파일에 57곳. 실패 원인은 `console.error`에만 남고 사용자에겐 "실패했습니다"만 보였습니다.

| 신규 파일 | 역할 |
|---|---|
| `components/feedback/feedback-context.ts` | Context + `useFeedback()` + 타입 (컴포넌트와 분리 → Fast Refresh 유지) |
| `components/feedback/FeedbackProvider.tsx` | Toast viewport + Confirm/Prompt Dialog |
| `components/feedback/feedback.css` | **하드코딩 리터럴 0, 토큰만 사용** |
| `lib/error-message.ts` | `errorMessage(error)` — 실패 원인을 토스트 본문으로 |

```ts
const { toast, confirm, prompt } = useFeedback();

toast.success('워크플로우를 저장했습니다.', { description: 'IT 권한 신청 · v3' });
toast.error('저장에 실패했습니다.', { description: errorMessage(err) });
await confirm({ title, description?, confirmLabel?, tone?: 'default' | 'danger' }); // Promise<boolean>
await prompt({ title, label?, defaultValue?, placeholder?, required? });            // Promise<string|null>
```

- `main.tsx`에서 `<App/>`을 감쌉니다 → `/external-approval/:token` 공개 페이지까지 커버
- 토스트: 우하단, 최대 4개, 성공 3.2s / 정보 3.6s / **실패 6s**, `aria-live="polite"`
- 다이얼로그: `role="dialog" aria-modal`, **Esc** 닫기, 배경 클릭 닫기, prompt는 **Enter** 확인
- 사유 입력 후 다시 confirm하던 **2단 호출 3곳을 다이얼로그 1개로 통합**
- `handleTemplateSelect`의 "불러왔습니다" alert는 **삭제** — 화면이 이미 바뀌었는데 확인을 또 요구할 이유가 없음

**주의**: `confirm`/`prompt`가 Promise라 아래 함수들이 `async`가 됐습니다. 호출부는 전부 이벤트 핸들러라 영향 없음.
`handleCloseDesignerTab`, `onEdgeDoubleClick`, `handleDeleteField`, `terminateInstance`,
`remove`(preset 2곳), `handleDelete`(plugin/template), `revoke`/`revokeOthers`

### 2-3. 대시보드 목업 제거

관리자 랜딩 화면 전체가 창작이었습니다.

```js
const instancesCount = 12 + pendingApprovals;   // 계산이 아니라 상수
const mockEvents = [{ message: 'HR Onboarding 워크플로우 완료됨', time: '5분 전' }, ...]
```

- 헬스 모니터는 하드코딩 HTML → **엔진이 죽어도 초록불**. `Port: 3000` 표기(실제 dev는 **3011**)
- 성공률 막대 85/92/60/78%는 CSS 상수. 이 가짜를 **5초마다 폴링해 재렌더**

대체: `GET /api/templates` · `/api/instances`(state별 집계) · `/api/tasks` · `/api/health/ready`

**원칙 — 값을 만들어내지 않는다**
- `Loadable<T> = loading | ready | error` 로 3상태 명시
- 조회 실패 시 0이 아니라 **"조회 실패"** 표시
- 요약/헬스 조회는 **독립적으로 실패** 가능하게 분리
- `/health/ready`의 503도 유효한 상태로 취급 → 빨간불 + 원인 표시
- 헬스 표시등은 실제 응답 기반. **항상 초록인 상태가 없음**
- 폴링 5초 → 15초 (가짜 실시간성 연출 제거)

### 2-4. 죽은 컨트롤

| 위치 | 상태 | 처리 |
|---|---|---|
| 헤더 검색창 `메뉴, 업무, 요청명 검색 (Ctrl + K)` | `onChange` 없음, Ctrl+K 핸들러 없음 | 삭제 |
| 헤더 알림 벨 배지 `12` | 하드코딩 상수 | 삭제 |
| 헤더 물음표 버튼 | `onClick` 없음 | 삭제 |
| 결재함 필터 아이콘 | `onClick` 없음 | 삭제 |
| 결재함 페이지네이션 `< 1 >` | 고정 마크업, 목록은 전체 렌더링 | 삭제 (건수는 유지) |
| 결재함 "전체 프로세스" select | option 1개, 동작 없음 | **실제 필터로 연결** |

마지막 건은 지우는 대신 동작하게 만들었고, 옵션은 현재 결재함에 존재하는 프로세스에서만 도출합니다(`processOptions`). 없는 선택지를 보여주지 않습니다.

---

## 3. 완료 — 2차: 레이아웃 · 텍스트 · 타이포

### 3-1. Flow Designer 레이아웃

```
Before  [사이드바 260][팔레트 260][ 캔버스 786px · 41% ][속성패널 614]
After   [사이드바 260][rail 56][      캔버스 1604px · 83%           ]
```

```diff
 .flow-designer-content {
-  grid-template-columns: 260px minmax(0, 1fr) minmax(440px, 32vw);
+  position: relative;
+  grid-template-columns: auto minmax(0, 1fr);
 }
 .properties-panel {
-  min-width: 420px;
+  position: absolute; top: 0; right: 0; bottom: 0;
+  width: clamp(360px, 26vw, 440px);
 }
 .properties-panel.collapsed {
-  min-width: 0;
+  transform: translateX(100%);
 }
```

- 팔레트: 56px 아이콘 rail 기본, 토글 상태는 `localStorage`에 기억
- 속성 패널: **기본 닫힘**. 노드를 골라야 열림 (이전엔 미선택인데 메타데이터 폼이 펼쳐져 있었음)
- 헤더: 로고 + `PXM Flow Designer` + `Build, test and operate workflows` 제거 → **워크플로우 이름 + 상태 배지 1줄**
- 상단 버튼 8개 동급 → **저장 · 실행** + `···`(불러오기/가져오기/내보내기/실행 이력/설정/테마)

**오버레이로 바꾸면서 생긴 문제 2개를 같이 처리했습니다.**

1. rail에서 라벨이 사라짐 → 기본 노드 8종에 `title` 툴팁 부여
2. 우측 끝 노드가 패널 뒤에 깔림 → **패널 개폐 시 줄어든 폭에 다시 맞춤** (3-2 참고)

### 3-2. 패널이 가리는 문제 — 패닝이 아니라 재맞춤

처음에는 선택한 노드가 패널 밑에 깔리면 뷰포트를 옆으로 미는 `revealNode()`로 풀었다.
**이건 틀린 접근이었고 되돌렸다.**

보이는 폭이 440px 줄어든 상황에서 화면을 옆으로 밀면 반대편이 나간다. 실측:

```
① 왼쪽 노드 선택   우측 노드가 패널 밑     패널밑 4개 · 캔버스밖 0개
② 우측 노드 선택   342px 이동해 가림 해소   패널밑 0개 · 캔버스밖 4개  ← start가 사이드바 뒤로, 클릭 불가
③ 다시 왼쪽 선택   243px 되밀림            패널밑 2개 · 캔버스밖 0개  ← 원위치로 못 돌아옴
```

`revealNode`는 오른쪽 가림을 왼쪽 이탈로 바꿨을 뿐이고, 클릭마다 뷰포트가 흔들렸다.
당시 검증이 "우측 노드 안 가려짐"만 보고 **반대쪽에서 잃는 것을 재지 않아** 통과로 판정했다.

**바꾼 방식**: 패널 개폐 시점에 줄어든 영역으로 그래프를 다시 맞춘다.

```ts
// FlowCanvasRef
fitView: (rightInset?: number) => void;   // rightInset만큼 뺀 폭에 맞춤

// FlowDesigner — 개폐가 바뀔 때만 한 번
useEffect(() => {
  if (previousPanelOpenRef.current === isPropertiesPanelOpen) return;
  previousPanelOpenRef.current = isPropertiesPanelOpen;
  flowCanvasRef.current?.fitView(isPropertiesPanelOpen ? PROPERTIES_PANEL_WIDTH : 0);
}, [isPropertiesPanelOpen]);
```

reactflow의 `getRectOfNodes` + `getTransformForBounds`로
`container.clientWidth - rightInset` 폭에 맞는 transform을 계산해 `setViewport`한다.

검증 (18노드, 1920×1080):

| 단계 | 보이는 영역 안 | 패널 밑 | 캔버스 밖 |
|---|---|---|---|
| 불러온 직후 (패널 닫힘) | 18/18 | 0 | 0 |
| 왼쪽 노드 선택 → 패널 열림 | 18/18 | 0 | 0 |
| 우측 끝 노드 선택 | 18/18 | 0 | 0 |
| 패널 닫기 | 18/18 | 0 | 0 |
| 다시 우측 끝 노드 선택 | 18/18 | 0 | 0 |

**화면은 패널이 열리고 닫힐 때만 움직인다.** 열린 뒤에는 어떤 노드를 골라도 좌표가 그대로다.

**트레이드오프**: 패널을 열면 그래프가 약 27% 작게 다시 맞춰지고, 사용자가 직접 조절한
줌·위치가 초기화된다. 대신 가려지거나 화면 밖으로 나가는 노드가 없고 동작이 항상 같다.
예측 가능성을 택한 결정이다.

### 3-3. 텍스트 — 같은 이름을 다섯 번 부르고 있었음

실행 모니터링 화면 하나에서:

```
사이드바        실행 모니터링
헤더 제목       운영자 / 모니터링 담당 상세 화면 구성   ← 기획서 목차가 제품에
헤더 서브타이틀  실행 모니터링, 실패 대응, 재시도/운영 조치…
헤더 주황 버블   운영자/모니터링 담당은 실행 현황 모니터링…
본문 H2        워크플로우 실시간 트래커 TRACKER
```

- `App.tsx`: 헤더 **서브타이틀 전체 삭제**, **info 버블 10개 전체 삭제**
- 헤더 제목을 `PAGE_TITLE` 사전으로 통일 — 사이드바 라벨과 같은 업무 용어
- 페이지 안 중복 H2 **14곳 제거** (설명 `<p>`는 유일한 설명이 되므로 유지)
- 영문 eyebrow 제거: `OPERATIONS CONTROL` `APPROVAL NOTIFICATIONS` `MANAGEMENT AUDIT` `REQUEST STATUS`

| Before | After |
|---|---|
| 종합 상황실 / 대시보드 | 대시보드 |
| 운영자 / 모니터링 담당 상세 화면 구성 | 실행 모니터링 |
| Credential Store 관리 | 연동 자격증명 |
| Access Management | 사용자 및 권한 |
| Command Registry 관리 | 명령어 관리 |
| Plugin Control / Registry 관리 | 플러그인 제어 / 플러그인 등록 |
| 실행·Outbox 운영 상태 | 운영 상태 |

상태·필터 라벨은 신규 `lib/status-label.ts`로 모았습니다.
`instanceStateLabel` / `approvalStatusLabel` / `deliveryStatusLabel`.
**모르는 코드는 지어내지 않고 원문을 그대로 돌려줍니다.**

- 필터 `전체 목록 (ALL)` → `전체`, `결재대기 (WAITING)` → `대기 중`
- 배지 `COMPLETED` → `완료`, `FAILED` → `실패`
- 컬럼 `실시간 전이상태` → `상태`, `기동 시간` → `시작`, `인스턴스 고유 ID` → `실행 ID`
- `3 nodes / 2 edges` → `노드 3개 / 연결 2개`

### 3-4. 타이포 · 색 · radius — 837건 일괄 치환

**폰트 25종 → 5종.** 8·8.5·9·9.5·10·10.5·11·11.5·12·12.5·13·13.5·14·15·16·17·18·20·21·22·23·24·25·27·28px 이 섞여 있었습니다.

| 버킷 | 용도 | 개수 |
|---|---|---|
| 12px | 캡션 · 배지 (**하한**) | 185 |
| **14px** | **본문 (기본)** | **287** |
| 16px | 소제목 | 33 |
| 20px | 제목 | 29 |
| 24px | 디스플레이 | 11 |

최대 항목: `12→14` 161건, `11→12` 113건, `13→14` 90건. `--font-size-*` 토큰도 이 스케일로 재정의.

**회색 램프 2계열 → slate 1계열** (266건). UI-kit 계열이 전부 사라졌습니다.

```
#667085 → #64748b (46)   #dfe5ef → #e2e8f0 (22)   #98a2b3 → #94a3b8 (20)
#172033 → #1e293b (14)   #344054 → #334155 (11)   #475467 → #475569 (9)
#101828 → #0f172a        #f2f4f7 → #f1f5f9        #eaecf0 → #e2e8f0
```

같이 정리: 파랑 `#3568dc`·`#2458d6` → `#2563eb` / 빨강 `#b42318`·`#991b1b` → `#b91c1c` /
Material 잔재 `#f44336` `#4caf50` `#ff9800` `#2196f3` 제거.

**radius 9종 → 토큰 5종** (88건). `7→8` 23건, `9→8` 22건, `10→12` 16건, `14→12` 15건.

### 3-5. 공용 Button 계약 (PXM-31)

`Button`이 지정한 몇 개 prop만 받고 나머지를 조용히 버렸습니다.
**JSX는 하이픈이 들어간 속성명을 타입 검사 없이 통과시키므로**, `aria-label`을 넘겨도
컴파일 에러 없이 사라졌고 접근성 tree에 이름이 남지 않았습니다.

```diff
-export interface ButtonProps {
-  variant?; size?; icon?; iconPosition?; children?;
-  onClick?; disabled?; className?; type?;   // ← 이게 전부. 나머지는 버려짐
-}
+type ButtonBaseProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
+  variant?; size?; icon?; iconPosition?;
+};
+export type ButtonProps =
+  | (ButtonBaseProps & { children: React.ReactNode })
+  // 아이콘 전용: 읽어줄 글자가 없으므로 이름을 타입으로 강제
+  | (ButtonBaseProps & { children?: undefined; 'aria-label': string });
```

- `...rest`를 `<button>`에 전달 → `aria-*` `title` `form` `name` `onFocus` 등이 살아남습니다
- `React.forwardRef`로 ref 전달 지원
- 아이콘 `<span>`에 `aria-hidden="true"` — 장식이므로 이름 계산에서 제외
- **타입 제약이 도입 즉시 몰랐던 결함 2건을 잡았습니다**:
  `CommandRegistryPage`·`CredentialsPage`의 이름 없는 삭제 버튼

부수 정리: `InboxPage`의 순수 헬퍼 4개(`readField` `getTaskTitle` `getRequester` `getProcessLabel`)를
모듈 스코프로 올려 `react-hooks/exhaustive-deps` 경고 2건을 없앴습니다.

---

## 4. 검증 방법

```
npx tsc -b --force   통과
npx vite build       통과 (8.6s)
npx eslint src       127 problems (기준선 127 · 순증 0)
```

lint는 **총량이 아니라 기준선 대비 증감**으로 봤습니다. `git stash`로 HEAD 상태를 만들어
같은 명령을 돌린 뒤 비교했습니다. 새로 만든 코드가 유발한 2건은 그 자리에서 처리했습니다.
- `react-refresh/only-export-components` → 훅을 `feedback-context.ts`로 분리해 **해소**
- `react-hooks/set-state-in-effect` → 외부 API 동기화라 사유를 적고 라인 단위 disable

**정합성 스윕** (전부 0건)
1. 남은 네이티브 `alert`/`confirm`/`prompt`
2. `await` 빠진 `confirmDialog`/`promptDialog` 호출
3. 훅 값을 쓰면서 `useFeedback()` 선언이 없는 파일

**브라우저 실측** — Playwright + Chromium, 1920×1080, admin 로그인.
폰트를 키우면 고정 높이 레이아웃이 깨질 수 있으므로 10개 화면에서
가로 스크롤과 요소 오버플로를 자동 스캔했습니다.

```
dashboard clean  inbox clean  tracker clean  request clean  access clean
operations clean audit clean  presets clean  credentials clean
designer → react-flow 캔버스 패닝(정상) + 연결 핸들 6px(의도된 디자인)
```

실제로 걸린 2건은 처리: `.custom-node-label`, `.credential-audit-action` 말줄임 추가.

18노드 템플릿 검증은 `git stash`로 변경 전 상태를 복원해 **진짜 before를 찍어** 비교했습니다.

### PXM-31 완료 조건 검증 결과

| 조건 | 결과 |
|---|---|
| 공용 Button이 native/aria 속성 전달 | 통과 — `ButtonHTMLAttributes` 확장 + `...rest` |
| 아이콘 전용 버튼을 이름으로 찾을 수 있음 | 통과 — 10개 화면 **이름 없는 버튼 0건** |
| 18노드 로드 시 전체 노드가 첫 화면에 | 통과 — `18/18`, 패널 닫힘 |
| 우측 끝 노드가 패널 뒤에 가리지 않음 | 통과 — 패널 개폐 시 재맞춤. 5단계 시퀀스 전부 `18/18`, 패널밑 0, 캔버스밖 0 |
| 10개 화면 가로 스크롤·overflow 없음 | 통과 — **0건** |
| 네이티브 alert/confirm/prompt 0건 | 통과 |
| 대시보드가 실패를 꾸미지 않음 | 통과 — 4개 API 500 주입 시 카드 5개 전부 `조회 실패` |
| `pnpm --filter web build` | 통과 |
| eslint 순증 없음 | 통과 — 기준선 126 → **125** |
| `git diff --check` | 통과 |

**측정 신뢰성**: 접근성 스캐너가 "0건"을 내는 게 고장이 아님을 확인하기 위해,
이름 없는 버튼을 DOM에 주입했다가 제거하는 음성 대조군을 돌렸습니다(0 → 1 → 0).
대시보드 검증은 처음에 통과처럼 보였는데, 로그인 직후 이미 성공 데이터를 받은 상태라
해시만 바꿔선 재요청하지 않는 게 원인이었습니다. 리로드를 넣어 다시 측정했습니다.

기준선도 다시 쟀습니다. 이전 측정은 `git stash push`에 `-u`가 빠져 신규 파일이
기준선에 섞여 있었습니다. `-u`를 붙인 실제 기준선은 **126건**입니다.

---

## 5. 이어받을 때 지켜야 할 규칙

이 정리를 되돌리지 않으려면 아래 5개만 지키면 됩니다.

1. **`alert`/`confirm`/`prompt` 금지.** `useFeedback()`을 쓰세요. 실패 토스트에는 `errorMessage(error)`로 원인을 반드시 붙입니다.
2. **아이콘 전용 버튼에는 `aria-label`이 필수입니다.** 공용 `Button`이 타입으로 강제하므로 빠뜨리면 `tsc`가 막습니다. 직접 만든 `<button>`도 같은 규칙을 지키세요.
3. **없는 값을 그리지 마세요.** API가 모르면 `-`나 `조회 실패`를 표시합니다. `vnull`은 이래서 나왔습니다.
4. **동작하지 않는 컨트롤을 두지 마세요.** 붙이지 못할 버튼은 만들지 않습니다.
5. **폰트는 12/14/16/20/24만.** 본문은 14px, 12px은 캡션 하한입니다. 13px·11px을 새로 만들지 마세요.
6. **색은 slate 램프 + 토큰만.** `--text-*` `--border-*` `--bg-*`를 쓰고, 새 회색을 도입하지 마세요.

제목 규칙: **화면당 제목은 하나.** 사이드바 라벨 = 헤더 제목. 페이지 안에서 다시 제목을 달지 않습니다.

---

## 6. 다음 계획

### P2 — 공용 컴포넌트 추출 (PXM-32 1차 완료)

`PageHeader` · `DataTable` · `StatusBadge` · `EmptyState` · `Drawer`를
`apps/web/src/components/ui/`에 추가하고 각각 실제 화면 2곳 이상에 적용했습니다.
API와 접근성 계약은 `docs/ui-components.md`를 기준으로 합니다.

아직 적용하지 않은 화면에는 아래와 같은 기존 구현이 남아 있으므로, 새 기능을 수정할 때
공용 컴포넌트로 단계적으로 치환합니다.

```
.status-badge          39곳 정의
.retry-modal           13곳
.webhook-modal         11곳
.workflow-table         7곳
*-summary-card / *-intro / *-empty  각 페이지마다 별도
```

CSS 13,169줄 중 토큰 사용은 1,494회. 하드코딩 hex가 아직 **1,220개** 남아 있습니다.
(회색 램프는 통일됐으니 이제 남은 건 대부분 토큰으로 치환 가능한 것들입니다.)

공용 컴포넌트는 `components/feedback/`와 `lib/status-label.ts`의 원칙을 이어받습니다.
**토큰만 사용하고, 공용 구조를 페이지 CSS에서 다시 정의하지 않습니다.**

### P3 — 다크 테마 (지금은 해볼 만함)

회색이 한 램프로 정리돼서 `[data-theme="dark"]` 토큰만 바꾸면 대부분 따라옵니다.
남은 하드코딩 hex 1,220개를 P2에서 토큰으로 밀어낸 **다음**에 하는 게 순서상 맞습니다.

### P4 — 노드 표현 (Codex 원안)

- zoom 단계별 정보량: 축소=아이콘+업무명 / 보통=+한 줄 설명 / 선택=+담당자·검증오류
- 승인 노드에 담당자 avatar, `ALL 2/3` 진행률
- 업무 구간 그룹핑
- 기술 타입(`Approval`)보다 업무명(`팀장 승인`)을 크게

### P5 — Overview / 프레젠테이션 모드

기존 읽기 전용 실행 추적 모드를 확장. 별도 그래프 데이터를 만들면 편집 화면과 불일치하므로
**반드시 같은 워크플로우 정의에서 파생**해야 합니다.

---

## 7. UI 밖 이슈 — 고치지 않고 보고만 합니다

### 7-1. 배포 상태 데이터 불일치 (백엔드)

```
전체 템플릿                        29개
  lifecycle_status = PUBLISHED    23개
  active_published_version = null 27개
  published_at             = null 27개
```

화면에 `배포 vnull`이 뜨던 원인입니다. UI는 버전을 모를 때 숫자를 지어내지 않고
`배포`만 표시하도록 고쳤지만(`publishedLabel()`), **publish 시점에
`active_published_version`이 채워지지 않는 문제는 그대로**입니다.

### 7-2. 인스턴스 목록이 50건으로 잘림

`apps/api/src/db/adapters/mongodb.adapter.ts`의 `listInstances`가
`.sort({created_at:-1}).limit(50)` 하드코딩입니다.
대시보드 집계가 전체가 아니라 **최근 50건 기준**입니다.
지금은 총량이 50 이하라 우연히 일치하지만, 넘어가면 "실패 2건"이 "최근 50건 중 2건"이 됩니다.
→ `/api/instances/stats` 집계 엔드포인트 권장 (DB `$group` 한 번).

### 7-3. 기타

- `/api/tasks`는 actor-scoped → 대시보드의 "내 결재 대기"는 전사 수치가 아닙니다.
- `InboxPage`가 3초마다 3개 엔드포인트를 폴링하고, 실패해도 사용자에게 표시하지 않습니다.
  (폴링이라 토스트는 스팸이 됩니다. 인라인 배너가 적절)
- `PluginRegistryPage` 미사용 변수 6개 — 기준선부터 존재.
- 반응형 breakpoint가 `640/650/768/800/900/1000/1024/1100/1180px`로 제각각. 3단계 수렴 권장.

---

## 8. 파일 지도

**신규**
```
apps/web/src/components/feedback/feedback-context.ts    Context · useFeedback() · 타입
apps/web/src/components/feedback/FeedbackProvider.tsx   Toast + Confirm/Prompt Dialog
apps/web/src/components/feedback/feedback.css           토큰만 사용
apps/web/src/lib/error-message.ts                       errorMessage(error)
apps/web/src/lib/status-label.ts                        상태 코드 → 한글
```

**크게 바뀐 것**
```
apps/web/src/App.tsx                        PAGE_TITLE 사전, 서브타이틀·info버블·죽은 컨트롤 제거
apps/web/src/components/Header.tsx          디자이너 상단바 재작성 (··· 메뉴)
apps/web/src/dashboard/DashboardPage.tsx    전면 재작성 (목업 → 실제 API)
apps/web/src/flow-designer/FlowDesigner.css 3열 grid → 2열 + 오버레이
apps/web/src/flow-designer/FlowCanvas.tsx   revealNode() 추가
apps/web/src/design-system.css              폰트 스케일 재정의
```

전 CSS 파일이 폰트/색/radius 일괄 치환의 영향을 받았습니다.
