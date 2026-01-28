# PXM MVP Roadmap (DB truth + Outbox + SSE)

## A. Engine / Runtime (Core, Must)

- [x] Bootstrap
- [x] Outbox → SSE
- [x] Instance → Job → Worker loop
- [x] Token execution (Start/Service/Timer) ✅ 1/22 완료
- [x] Lock / Lease / Heartbeat ✅ 1/22 완료
- [x] Retry / Timer ✅ 1/22 완료 (Exponential backoff + Jitter)
- [ ] Gateway 노드 구현 (조건 분기)
- [ ] Engine crash recovery
- [ ] Approval 노드 + Task 생성

## B. Identity / Access (Product Essential)

- [ ] Tenant / Org / User 모델
- [ ] Auth (local / SSO)
- [ ] Role / Permission (RBAC)
- [ ] Approval assignee rule
- [ ] Delegate / Proxy approval
- [ ] Audit log (who did what)

## C. Workflow Product (User-facing)

- [x] Runtime Trace UI (WorkflowGraph, WorkflowNode, ExecutionTimeline) ✅ 1/22 완료
- [x] SSE 기반 실시간 상태 업데이트 ✅ 1/22 완료
- [x] 테마 시스템 (Dark/Light) ✅ 1/22 완료
- [ ] Flow Designer (nodes / edges) - 다음 우선순위
- [ ] 노드 팔레트 (Start/Approval/Service/Gateway/Timer/End)
- [ ] 드래그&드롭, 엣지 연결
- [ ] 노드 속성 패널 (우측)
- [ ] Template versioning
- [ ] Instance Inbox (작업함)
- [ ] Notification (mail/webhook)

## D. Ops / Platform

- [ ] Migration/version policy
- [ ] Observability (metrics/logs)
- [ ] Backfill / Repair tool
- [ ] Admin UI

### 세부 TODO

## 0. Bootstrap ✅

- [x] Monorepo (pnpm workspace) 구성
- [x] apps/api (Nest) health
- [x] apps/api SSE hello/ping
- [x] apps/web (Vite) 부팅
- [x] apps/engine (Rust) 부팅
- [x] infra Postgres + init schema

## 1. Real Outbox → SSE (핵심 슬라이스)

- [x] DB: event_outbox insert 테스트용 SQL/seed 추가
- [x] API: Postgres 연결(PG pool) + outbox polling
- [x] API: /instances/:id/stream 에서 outbox 이벤트를 SSE로 스트리밍 (Last-Event-ID 지원)
- [x] WEB: SSE 연결해서 이벤트 로그 콘솔/패널에 출력

## 2. Instance create → engine_jobs (시작 트리거)

- [x] API: POST /instances (instance row + engine_jobs START)
- [x] ENGINE: engine_jobs SKIP LOCKED fetch
- [x] ENGINE: instance status RUNNING + outbox INSTANCE_RUNNING 기록

## 3. Runtime trace (와 포인트)

- [x] WEB: 간단 그래프(노드 5개) 렌더 ✅ 1/22 완료
- [x] WEB: NODE_STARTED/NODE_COMPLETED 이벤트로 하이라이트/edge 애니메이션 ✅ 1/22 완료
- [x] WEB: ExecutionTimeline 컴포넌트 ✅ 1/22 완료
- [ ] WEB: 실패 노드 에러 카드 표시 (retry count, next retry time)
- [ ] WEB: Edge 애니메이션 개선 (토큰 흐름 시각화)

## 4. Lock / Lease / Retry (운영급 심장)

- [x] ENGINE: advisory lock + lease + heartbeat ✅ 1/22 완료
- [x] ENGINE: retry policy (exp backoff + jitter) + RETRY_SCHEDULED outbox ✅ 1/22 완료
- [x] ENGINE: Timer 노드 구현 (TIMER_SCHEDULED, duration_ms) ✅ 1/22 완료
- [ ] ENGINE: Crash recovery (좀비 인스턴스 회수)
- [ ] ENGINE: Cleanup worker (오래된 lock 정리)

프로젝트: pxm (pnpm 모노레포)
구성: apps/api(Nest) + apps/web(Vite React) + apps/engine(Rust) + packages/contracts + infra(Postgres)
현재 상태: /health OK, /instances/TEST/stream SSE ping OK, web 5173 OK, engine tick OK
DB: infra/docker-compose + 001_init.sql 적용됨(process_instance, engine_jobs, event_outbox, tasks)

## 🎯 다음 단계 우선순위 (2026-01-28 기준)

### Phase 0: UI 디자인 시스템 구축 (선행 작업) ⭐

**목표**: Total.js Flow 스타일의 네이티브 앱 같은 세련된 디자인 시스템

**참고**: `UI_DESIGN_GUIDE.md` 문서 참조

0. **디자인 시스템 기초** (1-2일) ✅ 완료 (1/28)
   - [x] `design-system.css` 생성 (CSS 변수: 색상, 간격, 그림자, 애니메이션)
   - [x] 타이포그래피 설정 (Inter 폰트)
   - [x] 다크 모드 우선 색상 팔레트
   - [x] 아이콘 시스템 (Lucide React 설치)

1. **기본 컴포넌트 라이브러리** (2일) ✅ 완료 (1/28)
   - [x] Button 컴포넌트 (primary, secondary, ghost, danger)
   - [x] Panel 컴포넌트 (collapsible, header, actions)
   - [x] Input 컴포넌트 (label, error, helperText, icons)
   - [x] Select 컴포넌트 (dropdown, placeholder, error)
   - [x] Checkbox 컴포넌트 (label, helperText, error)
   - [x] ComponentShowcase 페이지 (한글 설명)
   - [ ] Tooltip, Modal 컴포넌트 (필요시 추가)

2. **레이아웃 시스템** (1일) - 다음 단계
   - [ ] 3-column 레이아웃 (노드 팔레트 240px | 캔버스 flex-1 | 속성 패널 320px)
   - [ ] 반응형 브레이크포인트 (모바일, 태블릿, 데스크톱)
   - [ ] 헤더 컴포넌트 (로고, 타이틀, 액션 버튼)

### Phase 1: Flow Designer 기본 구현

**목표**: 사용자가 워크플로우를 시각적으로 설계할 수 있는 캔버스 제공

1. **노드 팔레트 UI** (1-2일)
   - [ ] 좌측 사이드바에 노드 타입 목록 (Start, Service, Timer, Gateway, Approval, End)
   - [ ] 드래그 가능한 노드 아이템 (grab cursor, opacity 효과)
   - [ ] 노드 아이콘 및 설명 (Lucide 아이콘 사용)
   - [ ] 노드별 색상 구분 (Total.js 스타일)

2. **캔버스 기본 기능** (2-3일)
   - [ ] React Flow 또는 직접 구현 선택
   - [ ] 노드 드래그&드롭
   - [ ] 노드 간 엣지 연결
   - [ ] 줌/팬 기능
   - [ ] 미니맵 (선택)

3. **노드 속성 패널** (2일)
   - [ ] 우측 패널: 선택된 노드의 속성 편집
   - [ ] Service 노드: URL, Method, Headers, Timeout, Retry 설정
   - [ ] Timer 노드: duration_ms 설정
   - [ ] Gateway 노드: 조건식 입력
   - [ ] Approval 노드: 승인자 선택

4. **템플릿 저장/불러오기** (1일)
   - [ ] POST /templates API (process_def 저장)
   - [ ] GET /templates API (템플릿 목록)
   - [ ] 캔버스 → JSON 직렬화
   - [ ] JSON → 캔버스 복원

### Phase 2: Gateway 노드 실행 (엔진 강화)

**목표**: 조건 분기 로직 실행

5. **Gateway 노드 구현** (2-3일)
   - [ ] ENGINE: 조건식 평가 (ctx 기반)
   - [ ] ENGINE: 다중 아웃바운드 엣지 처리
   - [ ] ENGINE: 조건에 따른 토큰 라우팅
   - [ ] 테스트: 간단한 if-else 분기

### Phase 3: Approval 노드 + 작업함

**목표**: 사람 승인 워크플로우

6. **Approval 노드 + Task 생성** (3일)
   - [ ] ENGINE: Approval 노드에서 task 생성 + INSTANCE_WAITING
   - [ ] API: POST /tasks/:id/approve, /tasks/:id/reject
   - [ ] API: 승인 후 RESUME job 생성
   - [ ] WEB: Inbox 페이지 (내 작업함)
   - [ ] WEB: 승인/반려 버튼

### Phase 4: 제품 완성도

7. **에러 처리 UI** (1일)
   - [ ] WEB: 실패 노드 에러 카드 (retry count, next retry time)
   - [ ] WEB: 에러 상세 모달

8. **템플릿 갤러리** (1-2일)
   - [ ] 기본 템플릿 3개 (권한요청, 구매요청, 계정생성)
   - [ ] 템플릿 선택 → 인스턴스 생성 플로우

9. **Identity/Access 기본** (3-4일)
   - [ ] User, Org 모델
   - [ ] 로그인/로그아웃 (JWT)
   - [ ] 승인자 자동 할당 (매니저)

## TODO의 축

🧠 Axis 1. Engine / Runtime (지금 하고 있는 것)

pxm이 BPM 엔진으로서 신뢰 가능한가?

DB truth

Token 이동

Retry / Timer

Lock / Lease

Runtime Trace

➡️ 엔진 완성도

🔐 Axis 2. Identity / Access (사용자 관리)

누가 무엇을 할 수 있는가?

사용자 / 조직 / 테넌트

Role / Permission

Approval Assignee

대리 승인 / 위임

외부 IdP 연동

➡️ 실제 회사에서 쓸 수 있나?

🎨 Axis 3. Product / UX

이걸 쓰고 싶나?

Flow Designer

Runtime Trace 시각화

Inbox

알림

템플릿 갤러리

➡️ “오 이거 쓰고 싶다” 포인트
