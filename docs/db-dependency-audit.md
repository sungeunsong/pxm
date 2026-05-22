# 데이터베이스 직접 의존성 분석 보고서 (DB Dependency Audit)

본 문서는 기존 PXM Engine 및 API 어플리케이션 소스 코드 전반을 스캔하여, 핵심 비즈니스 로직(Core Logic)과 특정 데이터베이스 시스템(PostgreSQL)의 드라이버, 라이브러리 및 전용 SQL 구문 간에 얽혀 있는 강결합(Tight Coupling) 지점을 낱낱이 파악한 데이터베이스 의존성 감사 보고서이다.

---

## 1. Rust Engine (`apps/engine`) 직접 의존 지점 분석

기존 Rust 엔진 소스 코드인 `apps/engine/src/main.rs`는 비즈니스 전이 규칙과 PostgreSQL 전용 데이터 접근 기술(sqlx)이 한 파일 내에 한 몸으로 묶여 있는 극심한 모놀리식 강결합 상태이다.

### 1.1 SQLX 직접 사용 및 Pool 결합
- **PgPool 직접 의존**:
  - `main` 함수와 각 실행 함수(`run_instance_job`, `fetch_and_mark_running`, `schedule_timer` 등)의 핵심 인자로 `&PgPool`이 직접 주입되어 사용된다.
  - sqlx 매크로인 `sqlx::query!` 및 `sqlx::query_as!`가 인라인 텍스트 문자열 형태로 비즈니스 연산 중간에 섞여 호출된다.
  - 트랜잭션 수명 주기(`pool.begin()`) 제어 API가 도메인 제어 흐름 내에 직접 노출되어 있다.

### 1.2 PostgreSQL 전용 특화 기능 및 SQL 구문 결합
- **SKIP LOCKED 문법을 활용한 잡 선점 (`fetch_and_mark_running`)**:
  ```sql
  select id, instance_id, type as "job_type!", attempt
  from engine_jobs
  where status = 'READY' and run_at <= now()
  order by id asc
  for update skip locked
  limit 1
  ```
  - `FOR UPDATE SKIP LOCKED` 구문은 동시 잡 선점 처리를 극도로 단순화해주나, 해당 쿼리문이 함수 몸체 안에 하드코딩되어 있어 MySQL이나 Oracle, MongoDB 등 타 이종 저장소로 전환 시 즉각 컴파일 에러를 야기한다.
- **DB Advisory Lock을 활용한 동시 실행 차단 (`try_advisory_lock` / `advisory_unlock`)**:
  ```rust
  sqlx::query!(r#"select pg_try_advisory_lock(hashtext($1)) as "locked!""#, instance_key)
  ```
  - PostgreSQL 고유 기능인 `pg_try_advisory_lock`과 `pg_advisory_unlock`에 직접 바인딩되어 동작하므로 다른 DBMS로 전환 시 호환성 보장이 아예 불가능하다.
- **날짜/시간 연산 기법 (Interval 연산)**:
  - `schedule_retry_v2` 및 `schedule_timer` 내의 시간차 Job 인서트 쿼리:
    ```sql
    insert into engine_jobs ... values (..., now() + ($2 * interval '1 millisecond'), ...)
    ```
    - `interval '1 millisecond'` 및 `interval '1 second'`는 PostgreSQL 특화 시간 타입 연산 구문이므로 타 RDBMS에서 쿼리 파싱 구문 분석 실패를 초래한다.
- **JSONB 전용 함수 남용 (`set_cursor`)**:
  ```sql
  update process_instance
  set ctx = jsonb_set(ctx, '{cursor}', to_jsonb($2::text), true), updated_at = now()
  where id = $1
  ```
  - `jsonb_set` 함수는 PostgreSQL 특유의 JSON 처리 기능으로, 정규화되지 않은 V1 구조에서 cursor를 편하게 업데이트하기 위해 사용되었으나 Core 로직이 관계형 DB의 벤더 종속 기능에 완전히 의존하고 있음을 뜻한다.

---

## 2. NestJS API (`apps/api`) 직접 의존 지점 분석

API 서버 서버 역시 데이터 레이어의 정규 패턴(Repository, DAO) 없이 컨트롤러와 서비스 레벨에서 PostgreSQL 드라이버(`pg`) 커넥션을 직접 주입받아 데이터 수정/조회 쿼리를 하드코딩으로 호출하는 수준이다.

### 2.1 pg Driver 커넥션 직접 의존
- `db/pg.provider.ts` 내에서 `pg.Pool`을 `PG_POOL` 심볼로 등록하여 내보낸다.
- `TemplatesService`, `InstancesService`, `TasksController` 생성자에서 `@Inject(PG_POOL) private readonly pool: Pool` 형태로 PostgreSQL 드라이버 레벨의 커넥션 객체를 직접 넘겨받아 사용한다.

### 2.2 하드코딩된 Raw SQL 직접 사용
- **Templates CRUD (`templates.service.ts`)**:
  - `INSERT INTO workflow_template`, `SELECT * FROM workflow_template`, `UPDATE workflow_template` 등 원천 SQL 문자열이 서비스 비즈니스 로직에 인라인으로 기술되어 있어, 타입 체킹이 불가하고 인젝션 위험이 있으며 비즈니스 변경 시 SQL 변경으로 이어지는 문제를 동반한다.
- **인스턴스 기동 트랜잭션 (`instances.service.ts`)**:
  - `const client = await this.pool.connect()`를 통해 실제 DB 커넥션을 강제로 꺼내어 `begin`, `commit`, `rollback` 커맨드를 raw 쿼리로 던진다.
- **Task 조회 시 JSONB 형변환 강결합 (`tasks.controller.ts`)**:
  - `tasks`와 `process_instance` 테이블을 조인하여 폼 데이터를 읽기 위해 pg 전용 캐스팅 연산자인 `(pi.ctx->'formData')::jsonb`를 직접 사용하고 있다.

---

## 3. 특정 DB 교체 시 영향 범위 진단 (Impact Assessment)

만약 현재 아키텍처 상태에서 PostgreSQL을 **MongoDB** 또는 **MySQL**로 단번에 교체하려 시도할 경우, 다음과 같은 파국적 재앙이 즉각적으로 도출된다.

1. **Rust Engine 전체 컴파일 불가**:
   - `&PgPool` 및 `Transaction<'_, Postgres>` 구조 타입을 의존하고 있는 모든 시그니처와 구현체가 즉각 붕괴하므로 엔진 소스 코드의 90% 이상을 수정해야 함.
2. **PostgreSQL 전용 함수 분석 실패에 따른 런타임 Crash**:
   - `pg_try_advisory_lock`, `jsonb_set`, `interval` 문법이 배제된 DBMS에서는 쿼리 전송 단계에서 전량 Syntax/Semantic 에러를 내뱉고 모든 흐름 작동이 정지됨.
3. **API 서버 재시작 실패**:
   - 드라이버 인젝션이 하드코딩되어 있으므로 MySQL 드라이버 라이브러리 및 커넥터 모듈 전체를 새로 짜서 컨트롤러/서비스 전체에 재주입해야 하는 전방위적 고통이 수반됨.

---

## 4. 제거 계획 요약

본 감사를 토대로, 다음 단계 문서인 `docs/db-adapter-plan.md`에서는 Core/Engine의 순수 도메인 비즈니스 연산에서 이 모든 pg/sqlx 종속성을 완전히 발라내고, 순수 메모리 상의 추상 트레이트(Port)에만 계약 의존하도록 설계 구조를 완전 격리할 계획이다.
