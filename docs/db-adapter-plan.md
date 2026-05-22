# 데이터베이스 독립을 위한 Port/Adapter 설계안 (DB Adapter Plan)

본 문서는 `db-dependency-audit.md`에서 진단된 데이터베이스 강결합 문제를 해소하기 위해, 소프트웨어 공학의 헥사고날 아키텍처(Hexagonal Architecture)를 도입하여 Core/Engine 영역을 특정 데이터베이스 구현 기술로부터 완벽하게 격리 차단하기 위한 DB 추상화(Port/Adapter) 설계 제안서이다.

---

## 1. Port/Adapter 아키텍처 토폴로지 (Topology)

Core/Engine은 비즈니스 전이 연산 및 논리 제어 규칙만 관리하며, 모든 외부 I/O는 추상 인터페이스인 **Port**만을 향한다. 실제 데이터 저장소 기술(PostgreSQL, MongoDB 등)은 Port를 상속받은 구체적 클래스인 **Adapter** 내에 완전히 밀봉 격리된다.

```text
  ┌──────────────────────────────────────────────────────────┐
  │                   Engine / Core Logic                    │
  └────────────────────────────┬─────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼ (Dependency Inversion)              ▼
  ┌──────────────────┐                  ┌──────────────────┐
  │  JobQueuePort    │ (Trait/Interface)│ InstanceLockPort │
  └─────────┬────────┘                  └─────────┬────────┘
            │                                     │
  ┌─────────┴────────┐                  ┌─────────┴────────┐
  │ Postgres Job     │ (Concrete        │ Postgres Lock    │
  │ Queue Adapter    │  Adapter)        │ Lease Adapter    │
  └─────────┬────────┘                  └─────────┬────────┘
            │                                     │
            ▼                                     ▼
     [ PostgreSQL ]                         [ PostgreSQL ]
```

---

## 2. 핵심 Port 추상 정의 (Rust)

Rust Engine Core 영역 내에 설계할 핵심 Port 트레이트(Trait) 상세 인터페이스는 다음과 같다. 모든 Port 함수는 데이터베이스 세션이나 커넥션을 외부에 직접 노출하지 않고 비동기(`async_trait`) 형태로 정의된다.

### 2.1 잡 큐 추상 Port (`JobQueuePort`)
```rust
use anyhow::Result;
use chrono::{DateTime, Utc};
use uuid::Uuid;
use super::types::{V2Job, JobError};

#[async_trait::async_trait]
pub trait JobQueuePort: Send + Sync {
    /// 실행 시간이 도달하고 READY 상태인 가장 우선순위가 높은 Job 1개를 안전하게 독점 선점(Claim)한다.
    /// 멀티 워커 충돌 방지를 위한 잠금 기법은 내부 구현체(Adapter)가 담당한다.
    async fn claim_due_job(&self, worker_id: &str, now: DateTime<Utc>) -> Result<Option<V2Job>>;

    /// Job이 정상 완료되었을 때 호출하여 완료 마킹(DONE/COMPLETED)을 수행한다.
    async fn complete_job(&self, job_id: i64) -> Result<()>;

    /// 치명적 오류 등으로 더 이상 재시도 불가한 경우 해당 Job을 FAILED 처리한다.
    async fn fail_job(&self, job_id: i64, error: JobError) -> Result<()>;

    /// 일시적 오류 시, 지수 백오프 지연이 가미된 미래 시간대로 새로운 RETRY Job을 스케줄링 적재한다.
    async fn schedule_retry(&self, job_id: i64, run_at: DateTime<Utc>, attempt: i32, payload: serde_json::Value) -> Result<()>;

    /// 승인 완료 등으로 엔진을 즉각 재개하기 위한 신규 Job을 큐에 삽입한다.
    async fn create_job(&self, instance_id: Uuid, job_type: &str, run_at: DateTime<Utc>, payload: serde_json::Value) -> Result<()>;
}
```

### 2.2 인스턴스 락 임차 Port (`InstanceLockPort`)
```rust
use anyhow::Result;
use std::time::Duration;
use uuid::Uuid;

#[async_trait::async_trait]
pub trait InstanceLockPort: Send + Sync {
    /// 인스턴스에 대한 분산 임차 락(Lease Lock) 획득을 시도한다.
    async fn try_acquire(&self, instance_id: Uuid, worker_id: &str, ttl: Duration) -> Result<bool>;

    /// 락 임차 유효 기간을 하트비트 세션 내에서 연장(Renew) 갱신한다.
    async fn renew(&self, instance_id: Uuid, worker_id: &str, ttl: Duration) -> Result<()>;

    /// 노드 처리가 정상 종료되었을 때, 독점 사용하던 임차 락을 즉각 릴리즈(Release) 반환한다.
    async fn release(&self, instance_id: Uuid, worker_id: &str) -> Result<()>;
}
```

### 2.3 토큰 제어 Port (`TokenRepositoryPort`)
```rust
use anyhow::Result;
use uuid::Uuid;
use super::types::{TokenStatus, V2Token};

#[async_trait::async_trait]
pub trait TokenRepositoryPort: Send + Sync {
    /// 인스턴스에 종속되어 구동 중인 토큰들의 목록을 조회한다.
    async fn load_tokens_by_instance(&self, instance_id: Uuid) -> Result<Vec<V2Token>>;

    /// 특정 토큰을 다음 노드로 물리 이동시키기 위한 생성/수정 트랜잭션을 내부에서 커밋한다.
    async fn move_token(&self, token_id: Uuid, next_node_id: &str, status: TokenStatus) -> Result<()>;

    /// 병렬 병합(Join) 노드 등에서 토큰을 소모(Consume) 처리한다.
    async fn consume_token(&self, token_id: Uuid) -> Result<()>;
}
```

### 2.4 승인 태스크 관리 Port (`TaskRepositoryPort`)
```rust
use anyhow::Result;
use uuid::Uuid;
use serde_json::Value;

#[async_trait::async_trait]
pub trait TaskRepositoryPort: Send + Sync {
    /// 신규 OPEN 상태의 인적 결재 승인 태스크를 영속화 적재한다.
    async fn create_task(&self, task_id: Uuid, instance_id: Uuid, node_id: &str, assignee: &str, payload: Value) -> Result<()>;

    /// 완료된 태스크가 있는지 여부를 확인한다 (APPROVED/REJECTED 여부).
    async fn find_completed_task(&self, instance_id: Uuid, node_id: &str) -> Result<Option<String>>;
}
```

---

## 3. DBMS별 어댑터(Adapter) 내부 구현 전략

각 RDBMS / NoSQL 벤더별로 상이한 동시성 제어 및 조회 최적화 기법은 Core의 간섭 없이 어댑터의 캡슐화된 내부 구현 영역으로 밀어 넣는다.

### 3.1 PostgreSQL Adapter 구현 방식 (기본)
- **JobQueue**: `SELECT ... FOR UPDATE SKIP LOCKED` 행 잠금을 트랜잭션 내에서 영리하게 수행하여 claim을 보장한다.
- **InstanceLock**: `process_instances` 테이블의 `lock_owner`, `lock_until` 업데이트 및 세션별 `pg_try_advisory_lock`을 이중으로 활용한다.
- **날짜 연산**: 표준 SQL 드라이버 바인딩을 통해 내부 `chrono` 객체를 timestamptz로 깔끔하게 전송한다.

### 3.2 MongoDB Adapter 구현 방식 (확장 가능성)
- **JobQueue**: `findOneAndUpdate` 쿼리의 아토믹 연산을 사용하여 `status: "QUEUED"` 도큐먼트 중 `run_at`이 도래한 대상을 안전하게 `status: "RUNNING"` 및 `lock_owner: worker_id`로 마킹 및 리턴(Claim) 처리한다.
- **InstanceLock**: Document 레벨의 원자적 `updatedAt` 및 유니크 인덱스 결합 조건문 갱신으로 분산 락/임차를 동일 지원한다.
- **날짜 연산**: ISO Date 내장 타입을 활용하여 직관적으로 저장한다.

---

## 4. 기존 코드 리팩토링 및 포팅 전략

- **1단계: Port 트레이트 선언 및 API 분리**:
  - `apps/engine/src/v2/` 하위에 `ports.rs` 파일을 새로 개설하여 모든 Port 추상 트레이트를 기술 선언한다.
- **2단계: PostgreSQL 전용 Adapter 코드 이전**:
  - 기존 `main.rs` 하단에 난잡하게 구현되어 있던 `fetch_and_mark_running`, `schedule_timer`, `advisory_lock` 등의 하드코딩된 쿼리 함수들을 포팅하여 `apps/engine/src/v2/infrastructure/postgres_adapter.rs` 내부 클래스로 완전 유폐시킨다.
- **3단계: Dependency Injection 주입 체계 완성**:
  - `main` 함수 기동 시점에 DB URL로부터 PgPool을 생성한 뒤, `PostgresJobQueueAdapter::new(pool.clone())` 처럼 구체 어댑터 인스턴스를 Core Engine 스레드로 의존성 주입(DI)하여, 엔진 Core logic은 오로지 `JobQueuePort` 트레이트 타입에만 바인딩되어 통신하게끔 교정한다.
- **4단계: NestJS API 측 Repository 패턴 도입**:
  - NestJS의 각 서비스 모듈도 직접 PG_POOL 의존을 차단하고, 인터페이스(Repository Port)를 경유해 TypeORM 데이터 접근 레이어로의 랩핑 전환을 완료한다.
