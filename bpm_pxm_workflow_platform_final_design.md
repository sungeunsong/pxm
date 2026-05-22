# BPM/PXM Workflow Platform 바이브코딩 최종 설계문서

## 기존 PXM Engine 재사용 + DB 의존성 제거 + Plugin Connector 확장 + BPM Web

---

## 0. 문서 목적

이 문서는 기존에 구현된 PXM Workflow Engine을 최대한 재사용하면서, 범용 BPM/PXM Workflow Platform으로 확장하기 위한 바이브코딩용 최종 설계문서이다.

이 문서의 목적은 다음과 같다.

1. 기존 PXM Engine을 무조건 폐기하지 않고 먼저 분석한다.
2. 재사용 가능한 Engine 구조는 유지한다.
3. DB는 Source of Truth로 유지하되, Core/Engine이 특정 DB에 직접 의존하지 않도록 Port/Adapter 구조를 도입한다.
4. 기존 고정 Node/Service 실행 구조에서 Plugin Connector 방식으로 전환한다.
5. BPM Web을 역할별 업무 포털로 제공한다.
6. ACRA Point, NIT, HR, AD, Slack, Jira 같은 시스템은 Core에 결합하지 않고 Plugin Connector로 연동한다.
7. Node API와 Rust Engine의 역할을 명확히 분리한다.
8. 신청, 승인, 자동화, 외부 연동, 실행 추적을 하나의 Workflow Platform에서 제공한다.

---

## 1. 최종 목표

이 프로젝트의 최종 목표는 다음과 같다.

> 기존 PXM Engine의 Job/Token 기반 실행 구조를 최대한 살리면서, DB 의존성을 제거하고, BPM Web과 Plugin Connector 구조를 추가하여 범용 워크플로우 플랫폼을 구축한다.

### 1.1 핵심 방향

- DB가 Source of Truth이다.
- 단, Core/Engine은 특정 DB 구현에 직접 의존하지 않는다.
- Node API는 사용자 요청, 인증/인가, 템플릿 관리, 인스턴스 생성, Task 승인/반려, 조회 API를 담당한다.
- Rust Engine은 Workflow 실행만 담당한다.
- Engine은 Job/Token 기반으로 동작한다.
- 외부 시스템 연동은 대부분 `SERVICE Node + Plugin Connector` 방식으로 처리한다.
- ACRA Point, NIT, HR, AD, Slack, Jira, Email 같은 연동은 Engine Core를 수정하지 않고 Plugin으로 확장한다.
- BPM Web은 역할별 업무 포털로 구성한다.
- 신청자는 워크플로우 도식을 직접 실행하지 않는다. 템플릿 기반 신청 폼을 제출한다.
- 승인자는 Engine이 생성한 Task를 결재함에서 처리한다.
- 설계자는 Flow Designer에서 템플릿을 설계하고 배포한다.
- 운영자는 실행 상태, 실패, 재시도, 로그를 모니터링한다.

---

## 2. 초기 설계 대비 주요 변경점

이번 설계는 초창기 PXM 설계에서 몇 가지 중요한 방향 전환이 있었다.

### 2.1 DB 의존성 제거

초기 설계는 PostgreSQL 중심 구현에 가까웠다.

하지만 최종 방향은 다음과 같다.

> DB는 Source of Truth로 유지하되, Core/Engine은 특정 DB에 직접 의존하지 않는다.

이를 위해 Port/Adapter 구조를 사용한다.

```text
Core / Engine Logic
  ↓
Repository Port / Storage Port
  ↓
DB Adapter
  ├─ PostgreSQL Adapter
  ├─ MongoDB Adapter
  ├─ MySQL Adapter
  └─ Oracle Adapter
```

원칙:

```text
- Engine Core에서 SQL 직접 사용 금지
- Engine Core에서 Mongo Query 직접 사용 금지
- Engine Core에서 특정 DB Driver 직접 사용 금지
- DB별 기능 차이는 Adapter 내부에서 처리
- Job Claim, Lock, Transaction, Query Pattern은 표준 Port로 추상화
```

### 2.2 Plugin Connector 방식 도입

기존 PXM은 Plugin 방식이 아니었을 가능성이 높다.

기존 방식은 Node Type 또는 특정 Service 실행 로직이 코드에 직접 연결되어 있었을 수 있다.

최종 방향은 다음과 같다.

> 업무 연동 기능은 Engine Core에 하드코딩하지 않고, Plugin Connector로 확장한다.

```text
기존:
Service Node 또는 내부 연동 로직을 코드에 직접 구현

변경:
SERVICE Node 공통 실행 모델
+ plugin_id 기반 Connector 실행
```

예:

```text
connector.acra.grant_permission
connector.nit.create_issue
connector.hr.lookup_user
connector.slack.send_message
connector.jira.create_issue
builtin.http_request
```

### 2.3 SSE는 MVP 필수에서 제외

초기에는 Outbox + SSE 기반 실시간 Runtime Trace가 강하게 고려되었다.

최종 MVP 방향은 다음과 같다.

```text
MVP:
DB 조회 기반 Runtime Trace

Later:
Outbox + SSE
Edge Animation
실시간 Trace
```

즉 `event_outbox`는 유지하되, MVP 화면은 DB 조회 기반으로 먼저 구현한다.

### 2.4 BPM Web을 역할별 업무 포털로 재정의

BPM Web은 단순 Flow Designer가 아니다.

역할별 화면 묶음이다.

```text
설계자/관리자:
- 템플릿 목록
- Flow Designer
- 배포/활성화

신청자:
- 신청 카탈로그
- 신청 폼
- 내 신청 내역
- 진행 상태 조회

승인자:
- 내 결재함
- 결재 상세
- 승인/반려
- 처리 이력

운영자:
- 실행 모니터링
- 실패/재시도
- 로그
- Job Queue 상태
```

핵심:

```text
사용자 = 템플릿 기반 신청 폼 제출
설계자 = 템플릿 설계/배포
승인자 = Task 처리
Engine = 자동 실행
```

### 2.5 BPM 기본 Web과 Host UI 양쪽 지원

BPM은 기본 Web UI를 제공한다.

동시에 Host 제품도 같은 Node API를 호출해서 자체 화면을 만들 수 있다.

```text
BPM 기본 Web:
- 테스트/운영/독립 제품화에 유리

Host Product UI:
- 기존 제품 UX에 자연스럽게 삽입 가능

공통:
- 동일 Node API 사용
- 동일 DB 상태 사용
```

핵심 문장:

> 화면은 여러 개일 수 있지만, 실행 API와 DB 상태는 하나이다.

### 2.6 Approval 결재라인 모델 확장

Approval은 단순 고정 승인만이 아니라 다음 방식을 지원할 수 있게 설계한다.

```text
1. 관리자 고정형 결재라인
2. 조건 기반 자동 선택형 결재라인
3. 관리자 후보 지정 + 신청자 선택형 결재라인
```

MVP 우선순위:

```text
1단계: 관리자 고정형
2단계: 조건 기반 자동 선택형
3단계: 후보 결재라인 중 신청자 선택형
```

### 2.7 범용 Workflow Platform 유지

ACRA Point나 NIT는 Core에 박는 것이 아니다.

BPM/PXM Core는 범용 Workflow Platform으로 유지한다.

ACRA Point와 NIT는 주요 적용 대상일 수 있지만, Core 설계에 종속되지 않는다.

```text
BPM/PXM Core
├─ Workflow Engine
├─ BPM Web
├─ Plugin Registry
├─ Approval / Task
└─ Runtime Trace

Plugins
├─ ACRA Point Connector
├─ NIT Connector
├─ HR Connector
├─ AD Connector
├─ Slack Connector
├─ Jira Connector
└─ Email Connector
```

즉 필요한 연동은 각각 Plugin으로 추가한다.

```text
connector.acra.grant_permission
connector.acra.revoke_permission
connector.nit.create_issue
connector.nit.register_wiki_candidate
connector.hr.lookup_user
connector.ad.grant_group
```

### 2.8 기존 PXM Engine은 Audit 후 재사용

기존 PXM Engine은 무조건 폐기하지 않는다.

먼저 분석한다.

```text
engine-audit.md
gap-analysis.md
reuse-plan.md
db-dependency-audit.md
db-adapter-plan.md
plugin-migration-audit.md
plugin-conversion-plan.md
```

---

## 3. 기존 PXM Engine 점검 원칙

기존 PXM Engine은 무조건 폐기하지 않는다.

먼저 현재 구현 상태를 분석하고, 재사용 가능 여부를 판단한다.

### 3.1 반드시 점검할 항목

기존 프로젝트에서 다음 항목이 구현되어 있는지 확인한다.

- process_definition 또는 유사한 프로세스 정의 구조
- process_node 또는 유사한 노드 정의 구조
- process_edge 또는 유사한 연결/전이 구조
- process_instance 또는 유사한 실행 인스턴스 구조
- token 또는 execution pointer 개념
- engine_jobs 또는 유사한 Job Queue 구조
- Worker가 DB에서 Job을 가져와 실행하는 구조
- Approval 대기/재개 구조
- Gateway 조건 평가 구조
- Service Node 실행 구조
- Timer 처리 구조
- Retry 처리 구조
- execution_log 구조
- event_outbox 구조
- Instance Lock 또는 중복 실행 방지 구조
- DB Transaction으로 상태 전이를 묶는 구조
- 특정 DB에 직접 의존하는 코드
- 하드코딩된 Service 실행 코드
- Plugin으로 분리 가능한 내부 연동 코드

### 3.2 분석 산출물

기존 구현 분석 후 다음 문서를 작성한다.

```text
docs/engine-audit.md
docs/gap-analysis.md
docs/reuse-plan.md
docs/db-dependency-audit.md
docs/db-adapter-plan.md
docs/plugin-migration-audit.md
docs/plugin-conversion-plan.md
```

---

## 4. 기존 구현 재사용 판단 기준

### 4.1 그대로 유지

다음 조건을 만족하면 기존 구현을 유지한다.

- DB 기반 상태 관리 구조가 명확하다.
- Job과 Token 개념이 분리되어 있다.
- Worker가 DB에서 Job을 가져와 실행한다.
- Node 실행 결과가 DB에 기록된다.
- 기존 구조가 신규 BPM Web/API와 연결 가능하다.
- 테스트 가능한 단위로 구현되어 있다.
- Core Logic과 DB Query가 어느 정도 분리되어 있다.

### 4.2 리팩토링 후 유지

다음 조건이면 구조는 살리되 리팩토링한다.

- 개념은 맞지만 명명이나 책임 분리가 불명확하다.
- API Layer와 Engine Layer 책임이 섞여 있다.
- Retry/Timer/Lock/Log가 부분적으로만 구현되어 있다.
- Plugin 방식과 연결하기 위해 Adapter가 필요하다.
- 기존 코드가 특정 Node Type에 과하게 결합되어 있다.
- 특정 DB Query가 Core Logic에 섞여 있다.

### 4.3 폐기 또는 재작성

다음 조건이면 폐기 또는 재작성을 검토한다.

- 상태가 메모리 중심으로 관리된다.
- DB 상태와 실제 실행 상태가 쉽게 불일치할 수 있다.
- Job 중복 실행 방지 장치가 없다.
- Approval 대기/재개 흐름이 불명확하다.
- Gateway/Token 흐름이 BPM 요구사항과 맞지 않는다.
- 외부 시스템 호출 결과와 상태 전이가 원자적으로 기록되지 않는다.
- 특정 제품/서비스 연동이 Engine Core에 강하게 박혀 있다.
- DB별 교체가 사실상 불가능한 구조다.

---

## 5. 최종 시스템 아키텍처

### 5.1 구성요소

최종 시스템은 다음 구성요소로 나뉜다.

```text
BPM Web
Node API / BFF
Rust Workflow Engine / Worker
Storage Port / DB Adapter
Database
Plugin Registry
Secret Store
External Systems
```

### 5.2 BPM Web

BPM Web은 역할별 업무 포털이다.

역할:

- 설계자/관리자
- 신청자/일반 사용자
- 승인자/결재자
- 운영자/모니터링 담당

### 5.3 Node API / BFF

Node API는 브라우저와 Host 제품이 호출하는 API 계층이다.

담당 역할:

- 인증/인가
- RBAC
- 테넌트 처리
- 프로세스 템플릿 CRUD
- Flow Designer 저장 API
- Plugin Registry API
- 인스턴스 생성 API
- Task 승인/반려 API
- 작업함 조회 API
- 실행 상태 조회 API
- Runtime Trace 조회 API
- 파일 첨부 API
- Secret 참조 관리 API

Node API는 워크플로우를 직접 실행하지 않는다.

실행이 필요한 경우 `engine_jobs`에 Job을 생성하여 Rust Engine을 트리거한다.

### 5.4 Rust Workflow Engine / Worker

Rust Engine은 실제 워크플로우 실행을 담당한다.

담당 역할:

- engine_jobs polling
- Job 선점
- Instance Lock/Lease 획득
- Token 현재 위치 조회
- Node 실행
- Gateway 조건 평가
- Approval Task 생성 후 대기
- Service/Plugin Node 실행
- Timer Job 생성
- Retry Job 생성
- Token 이동
- Instance 상태 변경
- execution_log 기록
- event_outbox 기록

### 5.5 Storage Port / DB Adapter

Engine Core와 Node Domain Logic은 특정 DB에 직접 의존하지 않는다.

DB 접근은 Port Interface를 통해 수행한다.

Adapter가 실제 DB별 구현을 담당한다.

```text
WorkflowRepositoryPort
JobQueuePort
InstanceLockPort
TokenRepositoryPort
TaskRepositoryPort
ExecutionLogPort
OutboxPort
PluginRegistryPort
SecretRefPort
```

Adapter 예:

```text
PostgresWorkflowRepository
MongoWorkflowRepository
MySqlWorkflowRepository
OracleWorkflowRepository
```

### 5.6 Database

DB는 Source of Truth이다.

DB에는 다음 데이터가 저장된다.

- 프로세스 정의
- 노드/엣지 정의
- 실행 인스턴스
- Token 위치
- Engine Job
- Approval Task
- 실행 로그
- Outbox 이벤트
- Plugin 정의 또는 참조
- Secret 참조

### 5.7 External Systems

외부 시스템 예시는 다음과 같다.

- ACRA Point
- NIT
- HR 시스템
- AD/LDAP
- Slack
- Jira
- Email
- Webhook
- 내부 자산 시스템
- DB Query 대상 시스템

---

## 6. DB 의존성 제거 설계

### 6.1 목표

DB 의존성 제거의 목표는 다음과 같다.

```text
DB는 Source of Truth로 유지한다.
그러나 Core/Engine은 특정 DB의 SQL, Query 문법, Driver에 직접 의존하지 않는다.
```

### 6.2 금지 사항

Engine Core에서 다음을 직접 사용하지 않는다.

```text
- SQL 문자열
- Mongo Query 객체
- 특정 DB Driver
- PostgreSQL 전용 함수
- MySQL 전용 문법
- Oracle 전용 문법
- MongoDB Collection 직접 접근
```

### 6.3 허용 사항

DB별 구현은 Adapter 내부에 둔다.

```text
PostgreSQL Adapter:
- SELECT ... FOR UPDATE SKIP LOCKED
- Advisory Lock
- Transaction

MongoDB Adapter:
- findOneAndUpdate 기반 claim
- lease field 기반 lock
- document update transaction 또는 compensation

MySQL Adapter:
- SELECT ... FOR UPDATE
- status/locked_at 기반 claim
- transaction

Oracle Adapter:
- FOR UPDATE SKIP LOCKED
- transaction
```

### 6.4 표준 Port 예시

```rust
trait JobQueuePort {
    async fn claim_due_job(&self, worker_id: &str, now: DateTime) -> Result<Option<EngineJob>>;
    async fn complete_job(&self, job_id: JobId) -> Result<()>;
    async fn fail_job(&self, job_id: JobId, error: JobError) -> Result<()>;
    async fn schedule_retry(&self, job_id: JobId, run_at: DateTime, attempt: i32) -> Result<()>;
}
```

```rust
trait InstanceLockPort {
    async fn try_acquire(&self, instance_id: InstanceId, worker_id: &str, ttl: Duration) -> Result<bool>;
    async fn renew(&self, instance_id: InstanceId, worker_id: &str, ttl: Duration) -> Result<()>;
    async fn release(&self, instance_id: InstanceId, worker_id: &str) -> Result<()>;
}
```

### 6.5 표준 데이터 접근 패턴

DB별 구현은 달라도 Core에서 보는 의미는 같아야 한다.

```text
1. Due Job Claim
2. Instance Lock Acquire
3. Token Load
4. Node/Edge Load
5. State Transition Commit
6. Retry Schedule
7. Task Create
8. Outbox Append
```

### 6.6 Codex 점검 지시

기존 코드에서 다음을 찾아라.

```text
- Engine Core 내부 SQL 사용 위치
- Engine Core 내부 Mongo Query 사용 위치
- DB Driver가 직접 주입되는 위치
- 특정 DB 기능에 의존하는 Job Claim 로직
- 특정 DB 기능에 의존하는 Lock 로직
- Transaction이 Core에 직접 노출되는 위치
```

산출물:

```text
docs/db-dependency-audit.md
docs/db-adapter-plan.md
```

---

## 7. BPM Web 화면 구조

BPM Web은 역할별로 다른 화면을 제공한다.

### 7.1 설계자/관리자 화면

설계자/관리자는 업무 프로세스를 설계하고 배포한다.

주요 화면:

- 대시보드
- 프로세스 템플릿 목록
- 새 템플릿 생성
- Flow Designer
- 노드 설정 패널
- Gateway 조건 설정
- Approval 승인선 설정
- Service/Plugin 설정
- 플러그인/커넥터 관리
- 버전 관리
- 배포/활성화
- 실행 모니터링
- 감사 로그

설계자 흐름:

```text
템플릿 목록
→ 새 템플릿 생성
→ Flow Designer
→ 노드 배치
→ 조건/승인/플러그인 설정
→ 저장
→ 검증
→ 배포/활성화
```

### 7.2 신청자/일반 사용자 화면

신청자는 워크플로우 도식을 직접 실행하지 않는다.

신청자는 관리자가 배포한 템플릿 기반 신청 폼을 사용한다.

주요 화면:

- 신청 카탈로그
- 신청 폼
- 내 신청 내역
- 신청 상세
- 진행 상태 조회
- 반려 사유 확인
- 수정 후 재신청
- 첨부/코멘트

신청자 흐름:

```text
신청 카탈로그
→ 템플릿 선택
→ 신청 폼 입력
→ 제출
→ 인스턴스 생성
→ 내 신청 내역에서 진행 상태 확인
```

### 7.3 승인자/결재자 화면

승인자는 워크플로우를 설계하거나 실행하지 않는다.

승인자는 Engine이 생성한 Approval Task를 결재함에서 처리한다.

승인자 화면에는 관리자용 메뉴를 노출하지 않는다.

권장 메뉴:

- 대시보드
- 내 결재함
- 처리 이력
- 내 신청 내역
- 알림/공지
- 설정

승인자 흐름:

```text
내 결재함
→ 승인 대기 Task 선택
→ 결재 상세 확인
→ 승인 / 반려 / 보류
→ 코멘트 입력
→ 처리 완료
→ Engine 재개
```

### 7.4 운영자/모니터링 담당 화면

운영자는 실행 상태와 장애를 모니터링한다.

주요 화면:

- 실행 모니터링 대시보드
- 인스턴스 목록
- 실패 인스턴스 상세
- Retry 대기 목록
- Timer 대기 목록
- Job Queue 상태
- Worker 상태
- 실행 로그
- event_outbox 이벤트
- 운영 조치 패널

운영자 흐름:

```text
실행 모니터링
→ 실패 인스턴스 확인
→ 실패 원인 분석
→ 재시도 또는 중단
→ 운영 로그 기록
```

---

## 8. 핵심 도메인 개념

### 8.1 Template

Template은 설계자가 만든 업무 설계도이다.

예:

```text
권한 신청 프로세스 v1
계정 생성 요청 프로세스 v1
서버 작업 승인 프로세스 v2
NIT 이슈 처리 자동화 v1
```

Template에는 다음이 포함된다.

- process_definition
- process_nodes
- process_edges
- node config
- edge condition
- approval rule
- plugin config
- form schema
- version

### 8.2 Instance

Instance는 사용자가 실제로 신청해서 생성된 실행 건이다.

예:

```text
김민수의 운영 서버 SSH 권한 신청 건 #123
NIT Wiki 등록 요청 건 #456
```

Instance는 특정 Template Version을 기준으로 생성된다.

### 8.3 Task

Task는 사람에게 할당된 승인/반려 작업이다.

Approval Node에 도달하면 Engine이 Task를 생성한다.

예:

```text
팀장 승인 Task
보안팀 승인 Task
운영팀장 승인 Task
위키 반영 승인 Task
```

### 8.4 Token

Token은 워크플로우 실행 위치이다.

현재 인스턴스가 어느 노드에 있는지 나타낸다.

병렬 분기가 있을 경우 여러 Token이 존재할 수 있다.

### 8.5 Job

Job은 Engine이 실행해야 하는 일감이다.

예:

```text
START
RESUME
TIMER
RETRY
```

구분:

```text
Token = 현재 어디에 있는가
Job = 언제 무엇을 실행할 것인가
Task = 사람이 처리해야 하는 작업
```

---

## 9. Template → Instance → Task 흐름

기본 흐름은 다음과 같다.

```text
1. 설계자가 Template을 생성하고 배포한다.
2. 신청자가 Template 기반 신청 폼을 제출한다.
3. Node API가 process_instance를 생성한다.
4. Node API가 초기 Token을 생성한다.
5. Node API가 START Job을 engine_jobs에 생성한다.
6. Rust Engine이 START Job을 가져간다.
7. Engine이 자동 Node를 실행한다.
8. Approval Node에 도달하면 Task를 생성하고 WAITING 상태로 둔다.
9. 승인자가 내 결재함에서 Task를 승인/반려한다.
10. Node API가 Task 상태를 완료 처리하고 RESUME Job을 생성한다.
11. Engine이 RESUME Job을 가져가 다음 노드로 진행한다.
12. Service/Plugin Node가 외부 시스템을 호출한다.
13. End Node에 도달하면 Instance를 COMPLETED로 처리한다.
```

---

## 10. Approval 설계

### 10.1 Approval Node 기본 동작

Approval Node는 사람이 판단해야 하는 지점이다.

Engine 동작:

```text
Approval Node 도착
→ Task 존재 여부 확인
→ Task가 없으면 생성
→ Token 상태 WAITING
→ Job 완료
→ 사용자 승인 대기
```

사용자 승인 후:

```text
승인자 approve/reject
→ Node API가 Task 완료 처리
→ engine_jobs에 RESUME Job 생성
→ Engine이 RESUME Job 처리
→ 승인 결과에 따라 다음 Edge 선택
```

### 10.2 결재라인 방식

다음 방식을 지원할 수 있다.

#### 10.2.1 관리자 고정형

관리자가 Approval Node에 승인자를 고정한다.

예:

```text
팀장 승인
→ 보안팀 승인
```

신청자는 결재라인을 선택하지 않는다.

#### 10.2.2 조건 기반 자동 선택형

신청 값이나 조직 정보에 따라 결재라인을 자동 선택한다.

예:

```text
운영계 서버 권한이면 보안팀 승인 추가
개발계 서버 권한이면 팀장 승인만
관리자 권한이면 시스템 오너 승인 추가
```

#### 10.2.3 관리자 후보 지정 + 신청자 선택형

관리자가 허용한 결재라인 후보 중 신청자가 하나를 선택한다.

예:

```text
일반 권한 신청
- 팀장 승인

운영계 권한 신청
- 팀장 승인
- 보안팀 승인

긴급 권한 신청
- 팀장 승인
- 보안팀 승인
- 운영팀장 승인
```

신청자는 임의로 결재라인을 만들지 않는다.

신청자는 관리자가 허용한 후보 중 선택한다.

### 10.3 MVP 우선순위

MVP에서는 다음 순서로 구현한다.

```text
1. 관리자 고정형 결재라인
2. 조건 기반 자동 선택형
3. 관리자 후보 지정 + 신청자 선택형
```

---

## 11. Plugin 방식 설계

### 11.1 Plugin의 의미

Plugin은 워크플로우에 꽂아 쓸 수 있는 업무 기능 노드이다.

예:

- HTTP Request
- Jira 이슈 생성
- Slack 알림
- ACRA Point 권한 부여
- NIT 이슈 생성
- NIT Wiki 후보 등록
- HR 사용자 조회
- AD 권한 부여
- Email 발송
- Webhook 호출

### 11.2 Core Node와 Connector Plugin

#### Core Node

Engine이 직접 의미를 이해해야 하는 노드이다.

예:

```text
START
FORM
APPROVAL
GATEWAY
TIMER
END
```

#### Connector Plugin

외부 시스템 연동이나 자동 작업을 수행하는 노드이다.

Engine 입장에서는 대부분 SERVICE Node이다.

예:

```text
connector.acra.grant_permission
connector.nit.create_issue
connector.nit.register_wiki_candidate
connector.hr.lookup_user
connector.ad.grant_group
connector.slack.send_message
connector.jira.create_issue
builtin.http_request
```

### 11.3 node_type과 plugin_id

`node_type`은 Engine의 실행 의미이다.

예:

```text
SERVICE
APPROVAL
GATEWAY
TIMER
END
```

`plugin_id`는 구체 기능이다.

예:

```text
connector.acra.grant_permission
connector.nit.create_issue
connector.slack.send_message
connector.jira.create_issue
```

정리:

```text
node_type = 어떻게 실행할지에 대한 큰 분류
plugin_id = 그 분류 안에서 정확히 무엇을 실행할지 결정하는 키
```

장표용 문장:

```text
SERVICE는 외부 작업을 실행하는 공통 틀이고,
plugin_id는 Jira / Slack / ACRA / NIT 등 실제 실행 기능을 고르는 키이다.
```

### 11.4 SERVICE Node 실행 흐름

SERVICE Node의 공통 실행 흐름:

```text
1. process_nodes에서 node 정보 조회
2. node_type이 SERVICE인지 확인
3. plugin_id로 executor 또는 HTTP Spec 선택
4. node.config 로드
5. input_mapping 적용
6. secrets_ref로 Secret 조회
7. 외부 시스템 호출 또는 내부 작업 실행
8. 응답 수신
9. output_mapping으로 ctx 저장
10. 성공 시 다음 노드 이동
11. 실패 시 retry_policy 확인
12. execution_log / event_outbox 기록
```

---

## 12. 기존 PXM의 Plugin 전환 설계

### 12.1 배경

기존 PXM Engine은 Plugin 기반 확장 구조를 전제로 설계된 것이 아닐 수 있다.

기존 구조에서는 Node Type 또는 특정 Service Node 구현이 코드에 직접 연결되어 있을 가능성이 있다.

예:

```text
if node.type == "HTTP" then executeHttp()
if node.type == "APPROVAL" then createApprovalTask()
if node.type == "GATEWAY" then evaluateGateway()
```

또는 특정 내부 서비스 연동이 Engine 코드나 API 코드에 직접 박혀 있을 수 있다.

```text
executeHrLookup()
executeAdGrant()
executeAcraPermission()
executeSlackNotify()
```

### 12.2 기존 방식의 한계

기존 고정 노드 / 하드코딩 방식의 한계는 다음과 같다.

```text
1. 새 내부 서비스 연동이 생길 때마다 Engine Core 수정 가능성이 커진다.
2. Frontend Node Palette와 설정 UI도 매번 수정해야 한다.
3. Node API와 Engine 양쪽에 연동별 분기 코드가 늘어난다.
4. Jira, Slack, ACRA Point, NIT, HR, AD 같은 기능이 추가될수록 유지보수가 어려워진다.
5. Secret, Retry, Timeout, Output Mapping 규칙을 연동마다 다르게 구현하게 될 위험이 있다.
6. 특정 고객사/제품용 연동이 Core Engine에 섞이면 재사용성이 떨어진다.
```

즉 기존 방식은 다음과 같은 문제가 있다.

```text
업무 기능 추가 = Engine 수정 + API 수정 + Front 수정 + 테스트 범위 증가
```

이번 설계에서는 이 구조를 다음 방향으로 전환한다.

```text
업무 기능 추가 = Plugin Spec 추가 + Executor/HTTP Spec 추가 + Registry 등록
```

### 12.3 전환 목표

```text
기존:
고정 Node Type 또는 하드코딩 Service 실행

변경:
SERVICE Node 공통 실행 모델 + plugin_id 기반 Connector 실행
```

### 12.4 전환 단계

#### 1단계: 기존 Service Node 감싸기

기존에 HTTP Service Node가 있다면 우선 유지한다.

단, 실행 진입점을 다음 형태로 바꾼다.

```text
SERVICE Node 실행
→ plugin_id 확인
→ plugin executor registry 조회
→ executor 실행
```

초기에는 모든 기존 Service Node를 다음 Plugin으로 매핑할 수 있다.

```text
plugin_id = builtin.http_request
node_type = SERVICE
executor_type = HTTP_SPEC
```

#### 2단계: 내부 서비스 연동을 Plugin으로 분리

기존 Engine 또는 API에 직접 들어가 있던 내부 서비스 연동을 Plugin으로 분리한다.

예:

```text
executeAcraPermissionGrant()
→ connector.acra.grant_permission

executeNitIssueCreate()
→ connector.nit.create_issue

executeHrLookup()
→ connector.hr.lookup_user

executeSlackNotify()
→ connector.slack.send_message
```

#### 3단계: Plugin Registry 도입

MVP에서는 코드/JSON 기반 Registry로 시작한다.

```text
apps/api/src/plugins/builtin-plugins.ts
apps/api/src/plugins/connectors/acra.grant_permission.ts
apps/api/src/plugins/connectors/nit.create_issue.ts
apps/api/src/plugins/connectors/hr.lookup_user.ts
```

이후 DB 기반 Registry로 확장할 수 있다.

#### 4단계: Designer와 연결

Designer는 하드코딩된 노드 목록 대신 다음 API를 사용한다.

```http
GET /plugins
GET /plugins/{plugin_id}
GET /plugins/{plugin_id}/versions/{version}
```

Designer는 Plugin의 config_schema를 읽어서 노드 설정 패널을 구성한다.

#### 5단계: Engine Plugin Executor 연결

Engine에는 plugin_id 기반 executor dispatch 구조를 추가한다.

개념 예시:

```text
PluginExecutorRegistry
 ├─ builtin.http_request
 ├─ connector.acra.grant_permission
 ├─ connector.nit.create_issue
 ├─ connector.hr.lookup_user
 ├─ connector.slack.send_message
 └─ connector.jira.create_issue
```

Engine은 SERVICE Node를 실행할 때 다음 순서로 처리한다.

```text
1. process_nodes에서 node_type 확인
2. node_type == SERVICE이면 plugin_id 확인
3. plugin_id에 맞는 Executor/HTTP Spec 조회
4. config resolve
5. secret resolve
6. execute
7. output_mapping 적용
8. token 이동 / log 기록 / next job 생성
```

---

## 13. Plugin Registry 설계

### 13.1 역할

Plugin Registry는 사용 가능한 노드 정의 목록이다.

Designer는 Registry를 조회해서 Node Palette와 설정 패널을 구성한다.

Engine은 process_nodes에 저장된 plugin_id와 plugin_version을 기준으로 실행 정보를 확인한다.

### 13.2 MVP 방식

MVP에서는 코드 또는 JSON 기반 Registry로 시작한다.

예:

```text
apps/api/src/plugins/builtin-plugins.ts
apps/api/src/plugins/schemas/*.json
```

### 13.3 운영 확장 방식

운영 확장 단계에서는 DB 기반 plugin_registry 테이블을 사용할 수 있다.

필드 예:

```text
plugin_id
version
display_name
category
node_type
icon
config_schema
ui_schema
executor_type
executor_ref
auth_type
secrets_policy
input_schema
output_schema
help_url
is_active
created_at
updated_at
```

### 13.4 Plugin Spec 예시: ACRA Point 권한 부여

```json
{
  "plugin_id": "connector.acra.grant_permission",
  "version": "1.0.0",
  "display_name": "ACRA Point 권한 부여",
  "category": "Connector",
  "node_type": "SERVICE",
  "icon": "shield-key",
  "config_schema": {
    "type": "object",
    "properties": {
      "targetSystem": {
        "type": "string",
        "title": "대상 시스템"
      },
      "targetUser": {
        "type": "string",
        "title": "대상 사용자"
      },
      "permissionCode": {
        "type": "string",
        "title": "권한 코드"
      },
      "expireAt": {
        "type": "string",
        "title": "만료 시각"
      }
    },
    "required": ["targetSystem", "targetUser", "permissionCode"]
  },
  "executor_type": "HTTP_SPEC",
  "executor_ref": "acra.grant_permission.v1",
  "auth_type": "BEARER_TOKEN",
  "secrets_policy": {
    "acra_token": "secret://acra/api_token"
  }
}
```

### 13.5 Plugin Spec 예시: NIT 이슈 생성

```json
{
  "plugin_id": "connector.nit.create_issue",
  "version": "1.0.0",
  "display_name": "NIT 이슈 생성",
  "category": "Connector",
  "node_type": "SERVICE",
  "icon": "ticket",
  "config_schema": {
    "type": "object",
    "properties": {
      "projectKey": {
        "type": "string",
        "title": "프로젝트 키"
      },
      "issueType": {
        "type": "string",
        "title": "이슈 유형"
      },
      "title": {
        "type": "string",
        "title": "제목"
      },
      "description": {
        "type": "string",
        "title": "내용"
      },
      "assignee": {
        "type": "string",
        "title": "담당자"
      }
    },
    "required": ["projectKey", "issueType", "title"]
  },
  "executor_type": "HTTP_SPEC",
  "executor_ref": "nit.create_issue.v1",
  "auth_type": "BEARER_TOKEN",
  "secrets_policy": {
    "nit_token": "secret://nit/api_token"
  }
}
```

---

## 14. process_nodes 저장 설계

### 14.1 역할

`process_nodes`는 특정 프로세스에 실제 배치된 노드 정보를 저장한다.

Plugin Registry가 원본 스펙이라면, process_nodes는 프로세스에 배치된 노드의 설정값이다.

### 14.2 저장할 정보

```text
id
process_definition_id
node_id
plugin_id
plugin_version
node_type
display_name
category
position_x
position_y
width
height
config
input_mapping
output_mapping
secrets_ref
retry_policy
timeout_sec
is_active
created_at
updated_at
```

### 14.3 저장 원칙

- Plugin 스펙 전체를 process_nodes에 복사하지 않는다.
- plugin_id와 plugin_version으로 Registry를 참조한다.
- 사용자가 입력한 설정값은 config에 저장한다.
- Secret 값은 저장하지 않고 secrets_ref만 저장한다.
- Canvas 위치 정보는 Designer 복원을 위해 저장한다.
- plugin_version을 저장하여 기존 프로세스 호환성을 유지한다.

---

## 15. Connector 실행 방식

Connector는 외부 시스템과 연결되는 Plugin이다.

### 15.1 표준 실행 흐름

```text
Engine
→ node.config 로드
→ input_mapping 적용
→ secrets_ref 기반 Secret 조회
→ Request 구성
→ 외부 API 호출
→ Response 수신
→ 성공/실패 판단
→ output_mapping 적용
→ ctx 저장
→ execution_log 기록
→ event_outbox 기록
```

### 15.2 Secret 관리

Secret 값은 config에 저장하지 않는다.

금지:

```json
{
  "token": "real-token-value"
}
```

허용:

```json
{
  "secrets_ref": {
    "acra_token": "secret://acra/api_token@1"
  }
}
```

Engine은 실행 시점에 Secret Store에서 실제 값을 조회한다.

Secret 값은 다음 위치에 남기지 않는다.

- DB 일반 테이블
- process_nodes.config
- execution_log
- event_outbox
- API 응답
- 브라우저 화면

### 15.3 Retry / Timeout / Idempotency

Connector 실행에는 다음 정책이 필요하다.

```text
timeout_sec
max_attempts
initial_delay_sec
max_delay_sec
backoff
jitter
retry_on
retry_budget_sec
idempotency_key
```

재시도 대상 예:

```text
HTTP 429
HTTP 500
HTTP 502
HTTP 503
HTTP 504
Timeout
Connection Error
Rate Limit
```

재시도 제외 예:

```text
HTTP 400
HTTP 401
HTTP 403
Validation Error
Permission Denied
```

---

## 16. ACRA Point / NIT 적용 예시

주의:

> ACRA Point와 NIT는 Core 설계에 종속되는 대표 시나리오가 아니다.  
> 범용 BPM/PXM Core에 Plugin Connector로 붙는 주요 적용 사례이다.

### 16.1 ACRA Point 권한 신청 흐름 예시

```text
1. 사용자가 권한 신청 폼을 제출한다.
2. BPM 인스턴스가 생성된다.
3. HR 조회 Plugin이 사용자 부서/직무 정보를 조회한다.
4. Gateway가 요청 권한과 정책을 평가한다.
5. 팀장 승인 Task가 생성된다.
6. 운영계 서버 접근이면 보안팀 승인 Task가 추가된다.
7. 승인 완료 후 ACRA Point 권한 부여 Plugin이 실행된다.
8. ACRA Point API를 호출하여 실제 권한을 반영한다.
9. Slack/Email 알림 Plugin이 처리 결과를 안내한다.
10. execution_log와 event_outbox에 기록한다.
11. 인스턴스를 완료 처리한다.
```

### 16.2 NIT 이슈/위키 자동화 흐름 예시

```text
1. 사용자가 NIT 이슈 처리 완료를 트리거한다.
2. BPM 인스턴스가 생성된다.
3. NIT 이슈 조회 Plugin이 이슈 정보를 가져온다.
4. 조건에 따라 Wiki 후보 등록 여부를 판단한다.
5. 필요하면 승인 Task를 생성한다.
6. 승인 후 NIT Wiki 후보 등록 Plugin을 실행한다.
7. LLM Worker 또는 내부 API와 연계한다.
8. 완료 결과를 NIT에 업데이트한다.
9. 실행 로그와 이벤트를 기록한다.
```

---

## 17. Node API 계약

### 17.1 Template API

```http
GET /templates
POST /templates
GET /templates/{id}
PUT /templates/{id}
POST /templates/{id}/activate
GET /templates/{id}/versions
```

### 17.2 Plugin API

```http
GET /plugins
GET /plugins/{plugin_id}
GET /plugins/{plugin_id}/versions
GET /plugins/{plugin_id}/versions/{version}
```

### 17.3 Instance API

```http
POST /instances
GET /instances
GET /instances/{id}
GET /instances/{id}/graph
GET /instances/{id}/tokens
GET /instances/{id}/logs
```

### 17.4 Task API

```http
GET /inbox
GET /tasks/{task_id}
POST /tasks/{task_id}/approve
POST /tasks/{task_id}/reject
POST /tasks/{task_id}/hold
```

### 17.5 Runtime / Monitoring API

```http
GET /runtime/instances
GET /runtime/jobs
GET /runtime/failures
POST /runtime/jobs/{job_id}/retry
POST /runtime/instances/{id}/cancel
GET /runtime/workers
```

---

## 18. DB Schema 초안

### 18.1 process_definitions

```text
id
key
name
description
version
status
created_by
created_at
updated_at
activated_at
```

### 18.2 process_nodes

```text
id
process_definition_id
node_id
plugin_id
plugin_version
node_type
name
category
position_x
position_y
width
height
config
input_mapping
output_mapping
secrets_ref
retry_policy
timeout_sec
created_at
updated_at
```

### 18.3 process_edges

```text
id
process_definition_id
edge_id
from_node_id
to_node_id
condition
is_default
order_no
created_at
updated_at
```

### 18.4 process_instances

```text
id
process_definition_id
process_definition_version
business_key
status
ctx
created_by
started_at
ended_at
lock_owner
lock_until
heartbeat_at
created_at
updated_at
```

### 18.5 process_tokens

```text
id
instance_id
token_id
current_node_id
status
parent_token_id
branch_key
created_at
updated_at
```

### 18.6 engine_jobs

```text
id
instance_id
token_id
node_id
type
status
run_at
attempt
payload
locked_by
locked_at
last_error
created_at
updated_at
```

Job type:

```text
START
RESUME
TIMER
RETRY
```

### 18.7 tasks

```text
id
instance_id
token_id
node_id
task_type
status
assignee_type
assignee_id
candidate_group
title
description
form_data
decision
comment
completed_by
completed_at
created_at
updated_at
```

### 18.8 execution_logs

```text
id
instance_id
token_id
node_id
event_type
level
message
input_summary
output_summary
error_summary
duration_ms
created_at
```

### 18.9 event_outbox

```text
id
aggregate_type
aggregate_id
event_type
payload
created_at
processed_at
retry_count
last_error
```

### 18.10 plugin_registry

MVP에서는 코드/JSON으로 시작 가능하다.

DB화할 경우:

```text
plugin_id
version
display_name
category
node_type
icon
config_schema
ui_schema
executor_type
executor_ref
auth_type
secrets_policy
input_schema
output_schema
help_url
is_active
created_at
updated_at
```

---

## 19. Engine 실행 흐름

### 19.1 Job 처리

```text
1. Worker가 engine_jobs에서 실행 가능한 Job을 조회한다.
2. Adapter의 claim_due_job을 통해 Job을 선점한다.
3. Job 상태를 RUNNING으로 변경한다.
4. instance_id 기준 Lock을 획득한다.
5. process_instance의 lock_owner, lock_until, heartbeat_at을 갱신한다.
6. token의 current_node_id를 확인한다.
7. process_nodes에서 현재 Node 정보를 조회한다.
8. node_type에 따라 실행한다.
9. 상태 변경, 로그, outbox, 다음 job 생성을 처리한다.
10. Job을 COMPLETED 처리한다.
```

### 19.2 Node Type별 처리

```text
START:
- 초기 처리 후 다음 Node로 이동

FORM:
- 보통 인스턴스 생성 시 사용자 입력으로 이미 처리됨
- 필요 시 validation node로 동작 가능

SERVICE:
- plugin_id 기준 Executor/HTTP Spec 실행

GATEWAY:
- edge condition 평가
- true인 edge로 이동
- 없으면 default edge 사용

APPROVAL:
- Task 생성
- Token WAITING
- 사용자 승인 후 RESUME Job으로 재개

TIMER:
- TIMER Job 생성
- run_at 도달 후 재개

END:
- Token 완료
- 모든 Token 완료 시 Instance COMPLETED
```

### 19.3 Transaction 원칙

가능한 한 다음 작업은 하나의 상태 전이 단위로 묶는다.

```text
execution_log INSERT
process_token UPDATE/INSERT
process_instance UPDATE
tasks INSERT/UPDATE
engine_jobs INSERT
event_outbox INSERT
```

DB별 transaction 지원 방식은 Adapter에서 처리한다.

외부 API 호출 자체는 DB 트랜잭션에 포함할 수 없다.

따라서 외부 호출은 timeout, retry, idempotency key로 보호한다.

---

## 20. Lock / Lease 전략

같은 instance_id를 여러 Worker가 동시에 실행하면 안 된다.

### 20.1 추상 Lock

Core는 다음 의미만 사용한다.

```text
try_acquire(instance_id, worker_id, ttl)
renew(instance_id, worker_id, ttl)
release(instance_id, worker_id)
```

### 20.2 DB별 구현

PostgreSQL:

```text
Advisory Lock + Lease
```

MongoDB:

```text
lock_owner / lock_until 기반 findOneAndUpdate
```

MySQL/Oracle:

```text
row lock + lease field
```

### 20.3 Lease 컬럼

process_instances에 다음 컬럼을 둔다.

```text
lock_owner
lock_until
heartbeat_at
```

Worker는 실행 중 주기적으로 heartbeat_at과 lock_until을 갱신한다.

### 20.4 회수

`lock_until < now()`이면 다른 Worker가 회수할 수 있다.

Cleanup Worker는 오래된 Lock이나 비정상 상태를 정리할 수 있다.

---

## 21. Runtime Trace

MVP에서는 SSE를 필수로 하지 않는다.

우선 DB 조회 기반 Runtime Trace를 구현한다.

조회 대상:

- process_instance
- process_tokens
- execution_logs
- tasks
- event_outbox

화면 표시:

- 현재 단계
- 완료된 단계
- 대기 중인 승인
- 실패 노드
- 재시도 예정
- 실행 로그 타임라인

추후 Outbox + SSE로 확장 가능하다.

---

## 22. 구현 Phase

### Phase 1. 기존 PXM Engine 분석

작업:

- 기존 테이블 확인
- 기존 Engine 흐름 확인
- 기존 Job/Token 구조 확인
- 기존 Node 실행 방식 확인
- 기존 Approval/Gateway/Service 지원 여부 확인
- DB 의존 코드 확인
- Plugin 전환 가능 지점 확인

산출물:

```text
docs/engine-audit.md
docs/gap-analysis.md
docs/reuse-plan.md
docs/db-dependency-audit.md
docs/db-adapter-plan.md
docs/plugin-migration-audit.md
docs/plugin-conversion-plan.md
```

### Phase 2. Storage Port / Adapter 설계

작업:

- Repository Port 정의
- JobQueuePort 정의
- InstanceLockPort 정의
- TokenRepositoryPort 정의
- TaskRepositoryPort 정의
- OutboxPort 정의
- PostgreSQL Adapter 우선 구현
- MongoDB/MySQL/Oracle Adapter 확장 가능성 문서화

### Phase 3. 최소 DB Schema 정리

작업:

- 기존 테이블과 목표 테이블 매핑
- 부족한 컬럼 추가
- migration 계획 작성
- 기존 데이터 보존 전략 수립

### Phase 4. Node API 구현

작업:

- Template API
- Plugin API
- Instance API
- Task API
- Runtime 조회 API

### Phase 5. BPM Web 구현

작업:

- 역할별 메뉴
- 설계자 화면
- 신청자 화면
- 승인자 화면
- 운영자 화면
- Flow Designer
- 신청 폼
- 결재함
- Runtime Trace

### Phase 6. Plugin Connector 구현

MVP Connector:

- builtin.http_request
- connector.hr.lookup_user
- connector.acra.grant_permission
- connector.nit.create_issue
- connector.nit.register_wiki_candidate
- connector.slack.send_message
- connector.email.send
- connector.jira.create_issue

### Phase 7. Engine 연동

작업:

- SERVICE Node가 plugin_id로 executor를 찾도록 연결
- process_nodes.config 해석
- secrets_ref 해석
- output_mapping 적용
- retry_policy 적용
- execution_log/outbox 기록

### Phase 8. 테스트 시나리오

필수 테스트:

- 권한 신청 정상 흐름
- NIT 이슈 생성 흐름
- NIT Wiki 후보 등록 흐름
- 팀장 승인 후 완료
- 보안팀 승인 추가 흐름
- 반려 흐름
- 반려 후 수정 재신청
- ACRA API 실패 후 Retry
- ACRA API 중복 호출 방지
- Worker 재시작 후 재개
- Approval 대기 중 서버 재시작
- Secret 누락 시 실패 처리
- Gateway 조건 분기
- Runtime Trace 조회
- DB Adapter 교체 시 Core 영향 범위 확인

---

## 23. Codex 작업 지시문

아래 지시문은 Codex 또는 Claude Code에 직접 전달할 수 있다.

```text
이 프로젝트는 기존 PXM Workflow Engine을 기반으로 BPM Web + Plugin Connector 구조를 확장하는 작업이다.

먼저 기존 구현을 분석하라.
무조건 새로 만들지 말고, 기존 Engine에서 재사용 가능한 구조를 식별하라.

우선 확인할 것:

1. process definition / node / edge 구조
2. process instance 구조
3. token 또는 execution pointer 구조
4. engine job queue 구조
5. approval task 구조
6. service node 실행 구조
7. gateway 조건 평가 구조
8. retry / timer 구조
9. execution log / outbox 구조
10. locking / duplicate execution 방지 구조
11. 특정 DB에 직접 의존하는 코드
12. Plugin 전환 가능한 Service/Connector 코드

분석 후 다음 문서를 작성하라.

- docs/engine-audit.md
- docs/gap-analysis.md
- docs/reuse-plan.md
- docs/db-dependency-audit.md
- docs/db-adapter-plan.md
- docs/plugin-migration-audit.md
- docs/plugin-conversion-plan.md

그 다음 설계에 따라 BPM Web, Storage Port/Adapter, Plugin Registry 구조를 구현한다.

중요 원칙:

- DB가 Source of Truth이다.
- Core/Engine은 특정 DB에 직접 의존하지 않는다.
- Node API는 실행하지 않고 engine_jobs를 생성한다.
- Rust Engine은 engine_jobs를 가져와 Token 기반으로 실행한다.
- 외부 시스템 연동은 SERVICE Node + Plugin Connector 방식으로 처리한다.
- ACRA Point와 NIT는 Core에 결합하지 않고 connector.acra.*, connector.nit.* Plugin으로 구현한다.
- Secret 값은 config에 저장하지 않고 secrets_ref만 저장한다.
- Approval은 Task 생성 후 WAITING 상태로 멈추고, 승인/반려 후 RESUME Job으로 재개한다.
- 기존 PXM Engine에서 재사용 가능한 구조는 최대한 유지한다.
```

---

## 24. 최종 핵심 메시지

이 설계의 핵심은 다음과 같다.

```text
기존 PXM Engine은 최대한 살린다.
DB는 Source of Truth로 유지하되, Core/Engine은 특정 DB에 직접 의존하지 않는다.
BPM Web은 역할별 업무 포털로 제공한다.
신청자는 템플릿 기반 폼을 제출한다.
승인자는 결재함에서 Task를 처리한다.
설계자는 Flow Designer로 템플릿을 설계하고 배포한다.
운영자는 실행 상태와 실패를 모니터링한다.
외부 시스템 연동은 Plugin Connector로 확장한다.
ACRA Point와 NIT는 Core가 아니라 Plugin 적용 사례로 다룬다.
Engine Core는 안정적으로 유지하고, 업무 기능은 Plugin으로 유연하게 추가한다.
모든 상태의 기준은 DB이다.
```
