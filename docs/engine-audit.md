# 기존 PXM Engine 구현 상태 분석 (Engine Audit)

본 문서는 기존 PXM (Process Experience Manager) Engine의 아키텍처 및 구현 상태를 심층 분석하고, 핵심 컴포넌트의 가용성을 진단하여 V2 BPM 플랫폼으로의 확장 가능성을 확인하기 위한 감사 보고서이다.

---

## 1. 프로세스 정의 및 흐름 구조 (Process Definition / Node / Edge)

### 1.1 기존 구현 상태 (V1)
- **템플릿 저장소 (`workflow_template`)**:
  - 데이터베이스 스키마 상 `workflow_template` 테이블에 React Flow 포맷의 `nodes jsonb` 및 `edges jsonb`가 통째로 정규화되지 않은 단일 Document 형태로 저장된다.
  - 개별 노드나 엣지를 식별하는 독립 테이블이 부재하며, 인스턴스 기동 시점에 해당 JSON 배열 전체가 인스턴스 컨텍스트(`process_instance.ctx`)로 복사된다.
- **노드 탐색 및 전이 (`main.rs`)**:
  - `run_instance_job` 내에서 `process_instance.ctx`로부터 `nodes` 및 `edges` 배열을 추출한다.
  - 컨텍스트의 `"cursor"` 필드(예: `ctx.cursor = "node_1"`)를 단일 실행 포인터로 삼아 현재 실행할 노드를 선형 탐색한다.
  - `find_next_node` 및 `find_next_node_by_handle` 함수를 통해 `edges` 배열을 순차 탐색하여 `source`가 현재 노드 ID와 일치하는 타겟 노드로 `cursor`를 업데이트하고 `RESUME` Job을 발행한다.

### 1.2 구조적 제약 및 한계
- **병렬 분기 및 합류(Fork/Join) 불가**:
  - 하나의 인스턴스에 단 하나의 `"cursor"` 문자열 포인터만 존재하므로, 여러 노드를 동시에 활성화하는 병렬 실행(Multi-Token)이 구조적으로 불가능하다.
- **정규화되지 않은 그래프**:
  - 프로세스 정의가 단일 JSONB 도큐먼트 내에 배열로 뭉쳐 있어, 특정 노드의 메타데이터나 엣지의 평가 순서를 효율적으로 인덱싱하거나 쿼리하기 어렵다.
  - V2 런타임 재단용 마이그레이션 (`003_v2_runtime_foundation.sql`)에 정규화된 `v2_process_definitions`, `v2_definition_nodes`, `v2_definition_edges` 스키마가 미리 마련되어 있으나, 현 V1 엔진 코드 및 NestJS API는 이와 전혀 연동되어 있지 않다.

---

## 2. 인스턴스, 토큰, 잡 관리 구조 (Instance / Token / Job)

### 2.1 기존 구현 상태 (V1)
- **실행 인스턴스 (`process_instance`)**:
  - 인스턴스는 `CREATED`, `RUNNING`, `WAITING`, `FAILED`, `COMPLETED` 상태를 가진다.
  - 상태 보존의 Truth 소스는 DB이며, `ctx` JSONB 컬럼에 실행 중 필요한 모든 컨텍스트 데이터(Form 데이터, 외부 API 응답, 실행 이력 등)를 축적한다.
- **토큰 (Token) 개념의 부재**:
  - V1 엔진 및 데이터 스키마에는 `Token` 테이블이 부재한다.
  - `ctx` 내부의 단일 임시 필드(`"cursor"`)가 유일한 실행 포인터 역할을 수행하고 있다. 이로 인해 다중 분기 흐름을 격리 관리할 수 없다.
- **비동기 잡 큐 (`engine_jobs`)**:
  - DB를 퍼시스턴트 잡 큐로 사용한다. `START`, `RESUME`, `TIMER`, `RETRY` 타입의 작업들이 등록된다.
  - `status` 필드는 `READY`, `RUNNING`, `DONE`, `FAILED` 상태를 갖는다.
  - 멀티 워커(Multi-Worker) 환경에서 경쟁 상태(Race Condition)를 예방하기 위해 `fetch_and_mark_running` 함수 내에서 `FOR UPDATE SKIP LOCKED` 행 잠금을 사용하여 안전하게 1개의 Job을 독점 선점한다.

### 2.2 V2 토큰 기반 모델 전환 준비도
- `003_v2_runtime_foundation.sql` 마이그레이션에는 정규화된 `v2_tokens` 테이블(상태: `ACTIVE`, `WAITING`, `COMPLETED`, `CONSUMED`, `FAILED`)과 `v2_engine_jobs` 테이블이 준비되어 있다.
- 기존 Engine은 `v2/types.rs`에 V2용 토큰 상태와 잡 타입을 구조체 및 열거형(Enum)으로 일부 스켈레톤 형태로만 정의해 둔 상태이며, 실제 런타임 루프는 V1 테이블에 강결합되어 동작하고 있다.

---

## 3. 노드 유형별 지원 기능 진단 (Approval / Gateway / Service / Timer / Retry)

### 3.1 인적 결재 프로세스 (`Approval`)
- **지원 여부**: **지원됨 (기본 모델)**
- **동작 방식**: 
  - `Approval` 노드 진입 시, 엔진은 `tasks` 테이블에 `assignee` 정보와 함께 `status = 'OPEN'` 상태로 사용자 업무 태스크를 신규 적재한다.
  - 인스턴스 상태를 `WAITING`으로 변경하고 `INSTANCE_WAITING` 이벤트를 outbox에 발행한 뒤, 현재 Job 처리를 마쳐 엔진 스레드를 일시 정지(Block) 상태로 유지한다.
  - 결재자가 NestJS API (`POST /tasks/:id/complete`)를 호출하여 해당 Task를 `APPROVED` 또는 `REJECTED`로 처리하면, API가 인스턴스 상태를 `RUNNING`으로 복구하고 `engine_jobs`에 `RESUME` Job을 인서트하여 엔진을 복귀시킨다.

### 3.2 분기 노드 (`Gateway`)
- **지원 여부**: **부분 지원됨**
- **동작 방식**:
  - `evaluate_condition` 내장 함수를 통해 컨텍스트의 `formData` 필드를 기준으로 단순 조건 연산자(`==`, `>`, `<`)를 문자열 파싱하여 평가한다.
  - 조건 평가 결과가 `true`면 sourceHandle이 `"true"`인 엣지를 선택하고, `false`면 `"false"`인 엣지를 선택하여 전이한다.
- **한계점**:
  - 복합 논리식 평가 엔진이 부재하며, BPM 표준인 AND / OR / XOR Fork 및 Join 동기화가 불가능하다.

### 3.3 자동화 노드 (`Service`)
- **지원 여부**: **지원됨 (하드코딩 방식)**
- **동작 방식**:
  - `node_service_http` 함수를 통해 reqwest 기반 비동기 HTTP 호출을 직접 수행한다.
  - 성공 시 응답 결과 바디 전체를 `process_instance.ctx` 내 `"service_http"` 속성으로 임베딩 저장한다.
- **한계점**:
  - 플러그인 개념이 부재하여 HTTP API 호출 경로가 코드에 하드코딩되어 있다. 외부 서비스 연동 추가 시마다 엔진 코어 변경이 불가피하다.

### 3.4 대기 타이머 (`Timer`)
- **지원 여부**: **지원됨**
- **동작 방식**:
  - 노드의 `durationMs` 설정값을 읽어, 현재 시간 기준 만료 시점(`run_at = now() + durationMs`)에 실행되도록 예약된 `TIMER` 타입의 Job을 `engine_jobs` 테이블에 생성한다.
  - 인스턴스를 `WAITING`으로 유지한 뒤, 지정된 시간이 지나 READY 상태가 된 타이머 잡을 워커가 감지하여 다음 노드로 전이를 재개한다.

### 3.5 실패 재시도 정책 (`Retry`)
- **지원 여부**: **지원됨 (우수함)**
- **동작 방식**:
  - `RetryPolicy` 구조체를 통해 최대 재시도 횟수, 초기 지연 시간, 최대 지연 상한, 지수 백오프 배율(Exponential Backoff), Jitter(지터) 비율을 관리한다.
  - HTTP 408, 429 및 5xx대 시스템 에러 발생 시 재시도 대상(Retryable)으로 식별하여, 지수 백오프+지터가 적용된 미래 시점의 `RETRY` Job을 큐에 예약 삽입한다.
  - 최대 재시도 횟수 초과 시, 최종 실패(`NODE_FAILED`, `INSTANCE_FAILED`) 이벤트를 Outbox에 누적 적재하고 인스턴스를 `FAILED` 상태로 완전 종료한다.

---

## 4. 로깅, 아웃박스 및 동기화 락 구조 (Execution Log / Outbox / Lock)

### 4.1 감사 로그 (`Execution Log`)
- **기존 구현 상태 (V1)**: 
  - 상세 추적을 위한 독립적인 감사 로그 테이블이 존재하지 않으며, standard output 로깅 및 `event_outbox`에 전적으로 의존한다.
- **V2 구조와의 Gap**:
  - 정규화된 `v2_execution_logs` 스키마가 설계 완료되었으나 엔진 로직과의 연결 처리는 구현되지 않은 상태이다.

### 4.2 아웃박스 패턴 (`Event Outbox`)
- **기존 구현 상태 (V1)**:
  - `event_outbox` 테이블을 활용하여 분산 트랜잭션의 정합성을 안전하게 다룬다.
  - 엔진의 상태 전이 트랜잭션과 동일한 DB 세션에서 `emit_outbox` 함수를 실행하여 `INSTANCE_RUNNING`, `NODE_STARTED`, `NODE_COMPLETED`, `TASK_CREATED`, `TIMER_SCHEDULED` 등의 세밀한 수명 주기 이벤트를 원자적으로 저장한다.

### 4.3 동기화 락 및 경쟁 방지 (`Instance Lock`)
- **기존 구현 상태 (V1)**:
  - **분산 락 (Lease Lock)**: `process_instance` 테이블 내 `lock_owner`, `lock_until`, `heartbeat_at` 컬럼을 확보하여 하트비트 루프(`start_heartbeat_task`)가 주기적으로 임차 유효 기간을 자동 갱신(Renew)한다.
  - **DB Advisory Lock**: PostgreSQL 전용 시스템 함수인 `pg_try_advisory_lock(hashtext($1))` 및 `pg_advisory_unlock`을 사용하여 데이터베이스 세션 레벨 분산 락을 이중 보증한다.
  - **인스턴스 회수 (`Reclaim Stale Jobs`)**: 지정 유효 기간이 만료되었음에도 락이 묶여 있는 유령 실행 건을 스캔하여 복구하는 `reclaim_stale_running_jobs` 가 완벽하게 구동 중이다.

---

## 5. 결론 및 진단 요약

기존 PXM Engine V1은 비록 병렬 토큰 처리 구조가 부재하고 외부 연동이 하드코딩되어 있으나, **분산 락을 통한 다중 워커 중복 차단 기법, 트랜잭셔널 아웃박스 패턴 적용, 견고한 지수 백오프 재시도 메커니즘** 등 백엔드 분산 런타임의 최핵심 뼈대를 매우 훌륭하고 모범적인 형태로 이미 선구축해 둔 상태이다. 

따라서 기존 엔진 코어의 고품질 분산 런타임 메커니즘을 전면 폐기하지 않고 적극적으로 포팅 및 재활용하되, **DB 의존성 차단을 위한 Port/Adapter 구조 도입** 및 **Token 기반의 V2 테이블 매핑** 작업을 수행하는 리팩토링 노선이 가장 안전하고 효율적이다.
