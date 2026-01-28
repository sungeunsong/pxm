# 최근 작업 내역 (2026-01-22)

## 📅 작업 기간

2026-01-22 (1월 22일)

## ✅ 완료된 작업

### 1. Engine (Rust) - Lock/Lease 시스템 구현

**커밋**: `5733ac7` - "엔진쪽 잡 lock,lease처리"

#### 구현 내용

- **Advisory Lock + Lease 하이브리드 방식**
  - `pg_try_advisory_lock(hash(instance_id))` 사용
  - `lock_owner`, `lock_until`, `heartbeat_at` 컬럼 활용
  - 동시 실행 방지 메커니즘
- **Heartbeat 기반 Lease 갱신**
  - 주기적으로 `heartbeat_at` 업데이트
  - `lock_until` 연장 (renew)
  - 좀비 인스턴스 회수 준비 (cleanup worker는 미구현)

#### 파일 변경

- `apps/engine/src/main.rs` - Lock/Lease 로직 추가
- `apps/engine/Cargo.toml` - 관련 의존성 추가

---

### 2. Engine (Rust) - Timer 노드 구현

**커밋**: `ce1e436` - "타이머 및 UI 구현"

#### 구현 내용

- **TimerConfig 구조체**

  ```rust
  struct TimerConfig {
      duration_ms: i64,
      timer_type: String,
      node_id: String,
      on_expire: String,
  }
  ```

- **Timer 실행 흐름**
  1. Timer 노드 진입 → `TIMER_SCHEDULED` + `INSTANCE_WAITING` 이벤트
  2. `duration_ms` 후 TIMER job 실행
  3. Timer 완료 → `RESUME` job 생성 → 다음 노드로 진행

- **환경변수**
  - `TIMER_DURATION_MS` (기본값: 5000ms)

- **워크플로우 예시**
  - `start → service → timer → end`

#### 주요 함수

- `schedule_timer()` - 타이머 스케줄링
- `run_timer_job()` - 타이머 job 실행
- `node_timer()` - 타이머 노드 처리

---

### 3. Engine (Rust) - Retry Policy 구현

**커밋**: `ce1e436` - "타이머 및 UI 구현"

#### 구현 내용

- **RetryPolicy 구조체**
  - Exponential backoff + Jitter
  - Thundering herd 방지
  - max_delay 상한 설정

- **환경변수**
  - `RETRY_MAX_ATTEMPTS` (기본값: 5)
  - `RETRY_INITIAL_DELAY_MS` (기본값: 1000)
  - `RETRY_MAX_DELAY_MS` (기본값: 60000)
  - `RETRY_MULTIPLIER` (기본값: 2.0)
  - `RETRY_JITTER_FACTOR` (기본값: 0.1)
  - `HTTP_TIMEOUT_SECS` (기본값: 10)

- **Outbox 표준 포맷**
  ```json
  {
    "retry_info": {
      "attempt": 1,
      "max_attempts": 5,
      "next_delay_ms": 1200,
      "will_retry": true,
      "reason": "HTTP 500 error"
    }
  }
  ```

#### 주요 함수

- `should_retry()` - 재시도 여부 판단
- `calculate_backoff()` - 백오프 시간 계산
- `build_retry_info()` - retry_info 생성

---

### 4. Web UI - Workflow 시각화 구현

**커밋**: `ce1e436` - "타이머 및 UI 구현"

#### 새로 생성된 컴포넌트

```
apps/web/src/workflow/
├── WorkflowGraph.tsx        # 워크플로우 그래프 렌더링
├── WorkflowNode.tsx          # 개별 노드 컴포넌트
├── RuntimeTrace.tsx          # 런타임 추적 UI
├── ExecutionTimeline.tsx     # 실행 타임라인
├── useWorkflowState.ts       # 상태 관리 훅
├── types.ts                  # 타입 정의
├── styles.css                # 스타일링
├── ThemeContext.tsx          # 테마 컨텍스트
├── ThemeToggle.tsx           # 테마 토글 버튼
└── theme.ts                  # 테마 설정
```

#### 주요 기능

1. **WorkflowGraph**
   - 노드 및 엣지 렌더링
   - SSE 이벤트 기반 실시간 업데이트
   - 노드 상태 하이라이트 (running, completed, failed, waiting)

2. **ExecutionTimeline**
   - 시간순 이벤트 로그
   - 이벤트 타입별 아이콘 및 색상
   - 자동 스크롤

3. **테마 시스템**
   - Dark/Light 모드 지원
   - Context API 기반 전역 테마 관리
   - 토글 버튼

4. **SSE 연결**
   - `/instances/:id/stream` 엔드포인트 연결
   - 실시간 이벤트 수신 및 UI 업데이트
   - 재연결 로직

#### 스타일링

- 모던한 다크 테마 기본 적용
- 그라디언트 배경
- 노드 상태별 색상 구분
- 부드러운 애니메이션

---

### 5. API (NestJS) - 테스트 엔드포인트 추가

**커밋**: `ce1e436` - "타이머 및 UI 구현"

#### 구현 내용

- **FlakyController** (`apps/api/src/debug/flaky.controller.ts`)
  - 재시도 테스트용 엔드포인트
  - 의도적으로 실패하는 HTTP 엔드포인트
  - Retry Policy 검증용

---

## 📊 통계

- **총 커밋**: 4개
- **변경된 파일**: 25개
- **추가된 라인**: 5,944줄
- **삭제된 라인**: 78줄

---

## 🎯 다음 단계

TODO.md의 "다음 단계 우선순위" 섹션 참조

### 최우선 과제

1. **Flow Designer 기본 구현**
   - 노드 팔레트 UI
   - 캔버스 드래그&드롭
   - 노드 속성 패널
   - 템플릿 저장/불러오기

2. **Gateway 노드 실행**
   - 조건식 평가
   - 다중 아웃바운드 엣지 처리
   - 조건 기반 토큰 라우팅

3. **Approval 노드 + 작업함**
   - Task 생성
   - 승인/반려 API
   - Inbox 페이지

---

## 📝 참고 문서

- `CLAUDE.md` - 프로젝트 컨텍스트 및 최근 구현 상세
- `PRODUCT_REQUIREMENTS.md` - 제품 요구사항 전체
- `TODO.md` - 전체 로드맵 및 체크리스트
